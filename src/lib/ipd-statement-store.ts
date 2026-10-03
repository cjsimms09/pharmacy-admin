import "server-only";
import { and, eq, like } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { readIpdStatement } from "./ipd-statement";
import { rxRescueMemoKey } from "./rxrescue-credit";

/**
 * Files IPD's statement of account: the settlements it prints, and the credit that paid them.
 *
 * Two things come off this page and nothing else does.
 *
 * ── The invoices it settled ──
 *
 * One supplier payment per settlement, carrying what it put against each invoice, so an invoice paid across two offsets
 * counts in each month for what it really was (`supplier-payments.ts`, `cash-cogs.ts`). Most of the invoices on the
 * sample are older than the invoice feed and are not on the site at all; those are said and not invented.
 *
 * ── The credit that paid them ──
 *
 * Banked once, on the memo's own day, through the key the memo import uses (`rxRescueMemoKey`, keyed on day and amount)
 * so whichever document arrives first banks it and the other does not. The day comes from the memo's id — the 19 August
 * settlement is paid by a memo issued on the 18th — never from the settlement's date.
 *
 * It books NO revenue. The top-off is already revenue per fill when the memo itself is read
 * (`claim-payments.ts`, importRxRescueCredit); booking it again here would be the same money twice.
 */

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bare = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "").replace(/^0+/, "");

export async function fileIpdStatement(
  input: { text: string; documentId: string | null; fileName?: string },
  by: { name: string; id?: string },
): Promise<{ says: string; refused: boolean; payments: number; alreadyHeld: number; banked: number }> {
  const read = readIpdStatement(input.text);
  if (!read.ok) {
    await audit({ action: "supplier.ipd_statement_refused", userId: by.id ?? null, userName: by.name, entity: "document", entityId: input.documentId ?? undefined, details: read.why });
    return { says: read.why, refused: true, payments: 0, alreadyHeld: 0, banked: 0 };
  }
  const s = read.statement;

  /*
   * Filed as what it is: IPD's statement of account, dated the day it is as of.
   *
   * The owner, 22 September 2026: "we need to be filing as a statement so we can use when we need
   * to match payment". The statement that arrived on the 20th was read correctly — two settlements
   * recorded, three due dates taken — and then sat in the drawer as a "report" with no date, among
   * everything the site has no better word for. The mailbox decides the drawer from the document's
   * wording before this reader runs, and IPD's page does not say "statement" the way that test
   * wants. By the time the file reaches here there is no doubt left what it is, so this is where
   * the drawer is settled — and every route that reads one, not only the mailbox, files it alike.
   *
   * Only a document still in the catch-all drawer is moved. One somebody has filed by hand stays
   * where they put it.
   */
  if (input.documentId) {
    await db
      .update(schema.documents)
      .set({
        category: "supplier_statement",
        title: `IPD statement of account${s.asOf ? ` as of ${s.asOf}` : ""}`,
        ...(s.asOf ? { effectiveOn: s.asOf } : {}),
      })
      .where(and(eq(schema.documents.id, input.documentId), eq(schema.documents.category, "report")));
  }

  const { recordSupplierPayment } = await import("./supplier-payments");
  const { addCashReceipt } = await import("./expenses");

  const held = await db.query.supplierInvoices.findMany({ columns: { id: true, supplier: true, invoiceNumber: true, totalCents: true, dueOn: true } });
  const ipd = held.filter((v) => /ipd|independent pharmacy distributor/i.test(v.supplier ?? ""));
  const byNumber = new Map(ipd.map((v) => [bare(v.invoiceNumber), v]));

  const said: string[] = [s.says];
  let payments = 0;
  let alreadyHeld = 0;
  let banked = 0;
  let notOnSite = 0;

  for (const settlement of s.settlements) {
    const mine = settlement.invoices.map((v) => ({ row: byNumber.get(bare(v.invoiceNumber)), paid: v })).filter((x) => x.row);
    notOnSite += settlement.invoices.length - mine.length;
    const recorded = await recordSupplierPayment(
      {
        supplier: ipd[0]?.supplier ?? "IPD",
        paidOn: settlement.checkDate,
        amountCents: Math.abs(settlement.creditMemo?.cents ?? settlement.paidCents),
        method: "offset",
        reference: settlement.reference,
        creditMemo: settlement.creditMemo?.id ?? null,
        source: "ipd_statement",
        basis: "document",
        sourceKey: `ipd_statement|${settlement.reference}|${settlement.checkDate}|${settlement.creditMemo?.id ?? ""}`,
        documentId: input.documentId,
        notes:
          `From IPD's statement${input.fileName ? ` (${input.fileName})` : ""}: ${settlement.invoices.length} invoice${settlement.invoices.length === 1 ? "" : "s"} ` +
          `settled by credit memo ${settlement.creditMemo?.id ?? "(none)"}, issued ${settlement.creditMemo?.issuedOn ?? "?"}.`,
        allocations: mine.map((x) => ({ invoiceId: x.row!.id, amountCents: Math.abs(x.paid.paidCents) })),
        /* The invoices this site does not hold are the difference, and they are counted rather than invented. */
        acceptDifference: true,
      },
      by,
    );
    if (!recorded.ok) said.push(`The ${settlement.checkDate} settlement was not recorded: ${recorded.why}`);
    else if (recorded.alreadyHeld) alreadyHeld++;
    else payments++;

    /*
     * The credit, banked on the memo's own day, whether or not the settlement above could be written. The money arrived
     * either way; refusing to bank it because the invoices it paid are not on this site would lose real cash.
     *
     * A receipt already on file for that day with a different amount is named rather than added to: two credits of
     * different sizes on one day is a question, not a sum (session 1's rule).
     */
    const memo = settlement.creditMemo;
    if (memo) {
      const onThatDay = await db.query.cashReceipts.findFirst({
        where: and(like(schema.cashReceipts.sourceKey, `rxrescue-memo|${memo.issuedOn}|%`), eq(schema.cashReceipts.outOfBooks, false)),
        columns: { amountCents: true, sourceKey: true },
      });
      const key = rxRescueMemoKey(memo.issuedOn, memo.cents);
      if (onThatDay && onThatDay.sourceKey !== key) {
        said.push(
          `A credit of ${money(onThatDay.amountCents)} is already banked for ${memo.issuedOn} and this memo is ${money(Math.abs(memo.cents))}. Nothing was banked: one of the two is not what it says.`,
        );
      } else {
        const receipt = await addCashReceipt({
          month: memo.issuedOn.slice(0, 7),
          kind: "third_party",
          amountCents: Math.abs(memo.cents),
          payer: "Aytu / IPD (RxRescue)",
          receivedOn: memo.issuedOn,
          reference: memo.id,
          documentId: input.documentId,
          sourceKey: key,
          createdBy: by.name,
          notes: `RxRescue credit memo ${memo.id}, applied by IPD against its invoices on ${settlement.checkDate}, so it reaches no bank account. Read from IPD's statement.`,
        });
        if (receipt.duplicate) said.push(`The ${memo.issuedOn} credit was already banked; it is not banked twice.`);
        else banked++;
      }
    }
  }

  /* The due dates it prints, for the invoices the site holds: what says which invoices one payment covers. */
  let dueDates = 0;
  for (const open of s.openInvoices) {
    const row = byNumber.get(bare(open.invoiceNumber));
    if (!row || row.dueOn) continue;
    await db.update(schema.supplierInvoices).set({ dueOn: open.dueOn }).where(eq(schema.supplierInvoices.id, row.id));
    dueDates++;
  }

  said.push(
    `${payments} settlement${payments === 1 ? "" : "s"} recorded as payments${alreadyHeld ? `, ${alreadyHeld} already held` : ""}; ` +
      `${banked} credit${banked === 1 ? "" : "s"} banked on the memo's own day; ${dueDates} due date${dueDates === 1 ? "" : "s"} taken from it.` +
      (notOnSite ? ` ${notOnSite} of the invoices it settles are not on this site — older than the invoice feed — so their money is recorded against the payment and against no invoice.` : ""),
  );
  said.push("No revenue is booked here: the top-off is revenue per fill when the credit memo itself is read.");
  const says = said.join(" ");
  await audit({ action: "supplier.ipd_statement_read", userId: by.id ?? null, userName: by.name, entity: "document", entityId: input.documentId ?? undefined, details: says });
  return { says, refused: false, payments, alreadyHeld, banked };
}

/**
 * Move the IPD statements already filed as reports into supplier statements, dated.
 *
 * `fileIpdStatement` settles the drawer for every statement read from now on. This is for the ones
 * read before it did — the 20 September statement among them — found through the inbox line that
 * says what the router called them, and dated from the page itself rather than from when it arrived.
 * Money is not touched: the settlements and due dates were recorded correctly the first time.
 */
export async function refileIpdStatements(): Promise<{ moved: number }> {
  const items = await db.query.inboxItems.findMany({
    where: eq(schema.inboxItems.routedAs, "ipd_statement"),
    columns: { documentId: true },
  });
  const ids = [...new Set(items.map((i) => i.documentId).filter((d): d is string => !!d))];
  if (ids.length === 0) return { moved: 0 };

  const { readFile } = await import("./files");
  const { pdfText } = await import("./pdf-text");
  let moved = 0;
  for (const id of ids) {
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, id), columns: { category: true, storageKey: true } });
    if (!doc || doc.category !== "report") continue;
    let asOf: string | null = null;
    try {
      const read = readIpdStatement(pdfText(await readFile(doc.storageKey)));
      if (read.ok) asOf = read.statement.asOf;
    } catch {
      // The bytes are gone or unreadable; still file it as what the router already knew it was.
    }
    await db
      .update(schema.documents)
      .set({ category: "supplier_statement", title: `IPD statement of account${asOf ? ` as of ${asOf}` : ""}`, ...(asOf ? { effectiveOn: asOf } : {}) })
      .where(and(eq(schema.documents.id, id), eq(schema.documents.category, "report")));
    moved++;
  }
  return { moved };
}
