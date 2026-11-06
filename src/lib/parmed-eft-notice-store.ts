import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { readParmedEftNotice } from "./parmed-eft-notice";

/**
 * What Parmed's EFT debit notice writes: one supplier payment, holding the invoices it names.
 *
 * The notice is the only document that says what a Parmed ACH is for. Without it the debit reaches the bank statement
 * as a figure equal to no single invoice, and `placeLine` leaves it unplaced — the case `docs/HANDOFF.md` describes
 * from 15 September, and the reason `supplier_payments` exists at all.
 *
 * ── The day it is counted ──
 *
 * `paidOn` is the notice's own date, not a day guessed forward from it. The notice says the bank entry appears "upon
 * processing the next business day", so the debit will be dated one or two days later on the statement — and
 * `placeLine` already allows three days between a payment and its bank line, because the portal dates a payment the
 * day it is entered and the bank dates it the day it leaves. Writing the notice's date keeps the one fact the document
 * states; writing a date it does not state would be inferring where a document could say it, and the bank statement is
 * the document that will say it.
 *
 * ── The invoices it names that this site does not hold ──
 *
 * The first notice, 26 September 2026, named twelve invoices for $2,825.92, every one of them dated in August. The
 * invoice feed here begins on 9 September, so the site holds none of them. Nothing is invented for them: no invoice row
 * is created from a payment notice, because a notice says an invoice number and an amount and not one word about what
 * was received, and `supplier_invoices` is a receipt record.
 *
 * So they are counted and named. `acceptDifference` lets the payment exceed what it put against invoices, and the
 * difference is the money whose purchases this site never saw. Their cost reaches no month, which is right: those
 * purchases were never counted either, so counting the payment for them would put an August cost into September with
 * nothing on the other side of it. The notes on the payment say how many, and `says` says it out loud.
 *
 * Re-reading the same notice writes nothing: the source key is the notice's day and its total.
 */

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Invoice numbers are compared with punctuation and leading zeroes taken off, as everywhere else that matches them. */
const bare = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "").replace(/^0+/, "");

export type FiledEftNotice = {
  says: string;
  refused: boolean;
  /** True where this notice was already on file, so nothing was written a second time. */
  alreadyHeld: boolean;
  /** How many of the invoices it names this site holds, and how many it does not. */
  matched: number;
  notCaptured: number;
  totalCents: number;
};

export async function fileParmedEftNotice(
  input: { text: string; documentId: string | null; fileName?: string },
  by: { name: string; id?: string },
): Promise<FiledEftNotice> {
  const notice = readParmedEftNotice(input.text);
  if (!notice) {
    const why =
      "This reads as a Parmed debit notice but its invoice rows do not add up to the total it prints, so nothing was " +
      "written from it. The document is filed and waiting for somebody to look at it.";
    await audit({
      action: "supplier.parmed_eft_notice_refused",
      userId: by.id ?? null,
      userName: by.name,
      entity: "document",
      entityId: input.documentId ?? undefined,
      details: why,
    });
    return { says: why, refused: true, alreadyHeld: false, matched: 0, notCaptured: 0, totalCents: 0 };
  }

  /*
   * Filed as a statement, not an invoice.
   *
   * A debit notice records no receipt of goods, so it does not belong in the filing that answers "every invoice for
   * these goods" — the distinction `DOCUMENT_CATEGORIES` spells out. Only a document still in the catch-all drawer is
   * moved; one somebody filed by hand stays where they put it.
   */
  if (input.documentId) {
    await db
      .update(schema.documents)
      .set({
        category: "supplier_statement",
        title: `Parmed EFT debit notice ${notice.noticeOn} — ${money(notice.totalCents)}`,
        effectiveOn: notice.noticeOn,
      })
      .where(and(eq(schema.documents.id, input.documentId), eq(schema.documents.category, "report")));
  }

  const { recordSupplierPayment } = await import("./supplier-payments");

  const held = await db.query.supplierInvoices.findMany({ columns: { id: true, supplier: true, invoiceNumber: true, totalCents: true } });
  const parmed = held.filter((v) => /par\s*med/i.test(v.supplier ?? ""));
  const byNumber = new Map(parmed.map((v) => [bare(v.invoiceNumber), v]));

  const mine = notice.invoices.map((v) => ({ row: byNumber.get(bare(v.invoiceNumber)), named: v })).filter((x) => x.row);
  const notCaptured = notice.invoices.length - mine.length;

  const recorded = await recordSupplierPayment(
    {
      supplier: parmed[0]?.supplier ?? "Parmed",
      paidOn: notice.noticeOn,
      amountCents: notice.totalCents,
      method: "ach",
      reference: notice.customerNumber,
      source: "parmed_eft_notice",
      basis: "document",
      sourceKey: `parmed_eft|${notice.noticeOn}|${notice.totalCents}`,
      documentId: input.documentId,
      notes:
        `From Parmed's EFT debit notice of ${notice.noticeOn}${input.fileName ? ` (${input.fileName})` : ""}: ` +
        `${notice.invoices.length} invoice${notice.invoices.length === 1 ? "" : "s"}, ` +
        `${mine.length} held here and ${notCaptured} not on file. ` +
        `The notice's own total and the sum of its rows agree at ${money(notice.totalCents)}.`,
      allocations: mine.map((x) => ({ invoiceId: x.row!.id, amountCents: x.named.cents })),
      /* The invoices this site does not hold are the difference, and they are counted rather than invented. */
      acceptDifference: true,
    },
    by,
  );

  if (!recorded.ok) {
    return { says: `The notice was read but the payment was not recorded: ${recorded.why}`, refused: true, alreadyHeld: false, matched: mine.length, notCaptured, totalCents: notice.totalCents };
  }

  const dates = notice.invoices.map((v) => v.invoiceDate).sort();
  const span = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
  const says = recorded.alreadyHeld
    ? `This notice is already on file: ${money(notice.totalCents)} to Parmed on ${notice.noticeOn}. Nothing was written again.`
    : `Parmed is taking ${money(notice.totalCents)} by ACH on or just after ${notice.noticeOn}, for ${notice.invoices.length} invoices dated ${span}. ` +
      `Its rows add up to the total it prints, so the figure is proved and not merely read. ` +
      (notCaptured === 0
        ? `All ${mine.length} are on file and now carry this payment.`
        : mine.length === 0
          ? `None of the ${notice.invoices.length} is on file here — the invoice feed for Parmed begins later than they are dated — so the payment is recorded whole with nothing against it, and no cost reaches the month, because no cost was ever counted for them.`
          : `${mine.length} are on file and now carry this payment; ${notCaptured} are not on file, and the money for those reaches no month, because nothing was ever counted for them.`) +
      ` When the debit appears on the bank statement it will place itself against this payment.`;

  await audit({
    action: "supplier.parmed_eft_notice_read",
    userId: by.id ?? null,
    userName: by.name,
    entity: "document",
    entityId: input.documentId ?? undefined,
    details: says,
  });

  return { says, refused: false, alreadyHeld: recorded.alreadyHeld, matched: mine.length, notCaptured, totalCents: notice.totalCents };
}
