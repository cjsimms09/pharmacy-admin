import "server-only";
import { and, eq, like } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { getSettings } from "./settings";
import { readAccessHealthPayment, type AccessHealthPayment } from "./accesshealth-payment";

/**
 * Posts a Health Mart Atlas AccessHealth payment report: the claim payments inside one EFT, and nothing else.
 *
 * The reading is `accesshealth-payment.ts`, which refuses a report whose rows, sections and total do not agree. This
 * is the side that touches the database, and three decisions here are the ones that matter.
 *
 * ── It banks nothing ──
 *
 * The deposit is already on the cash account, banked by the portal's payer payment report or the Health Mart Atlas
 * EFT notice under `payer-payment|health mart atlas|EFT-…`. This report is the same money itemised. So its total is
 * compared with that receipt, and never banked beside it. A report whose total differs from the receipt of its own
 * EFT is refused: one of the two documents is wrong, and posting claims against a disputed total would hide which.
 *
 * ── Revenue nought ──
 *
 * A plan's payment settles the claim; the claim already carries its remittance as revenue. `recordClaimPayment`
 * defaults revenue to the amount paid, which would count the plan's money a second time on the accrual account. So
 * every payment is posted with revenue 0, exactly as `importRemittance` posts a plan's 835.
 *
 * ── Once, whichever of this report and the 835 arrives first ──
 *
 * ProviderPay's 835 for a Health Mart Atlas EFT names the EFT as its trace and posts each claim under the reference
 * `EFT-…/<rx>`. This posts under the same reference. Before posting, the rows already held under that EFT are counted
 * by prescription and amount, and only rows beyond that count are posted. The same prescription can legitimately be
 * paid, taken back and paid again for the same amount inside one EFT, so this is a count and not a set: a re-read
 * posts nothing, and an 835 read afterwards finds its rows already held (`importOneRemittance` keys the same way).
 *
 * Rows that paid nothing are not posted, as `payableOnly` skips them in an 835.
 *
 * ── The remittance-level adjustments ──
 *
 * The "Adj-" rows (AH, CS and the rest of the report's glossary) are money the plan held back from the EFT, belonging
 * to no claim. How each code should reach the accounts is written in the money map as a proposal and not yet agreed.
 * Until it is, they are kept as data on the report's document and in the inbox line, on neither account.
 */
export async function fileAccessHealthPayment(
  input: { text: string; documentId: string | null; fileName?: string },
  by: { name: string; id?: string },
): Promise<{ says: string; stored: boolean; refused: boolean; posted: number; alreadyHeld: number }> {
  const s = await getSettings();
  const read = readAccessHealthPayment(input.text, s.pharmacy_ncpdp || null);
  if (!read.ok) return { says: read.why, stored: false, refused: true, posted: 0, alreadyHeld: 0 };
  const p = read.report;
  const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  /* The deposit this report itemises, banked by the payer payment report or the EFT notice. */
  const receipt = await db.query.cashReceipts.findFirst({ where: eq(schema.cashReceipts.sourceKey, `payer-payment|health mart atlas|${p.eftNumber}`) });
  if (receipt && receipt.amountCents !== p.totalPaidCents) {
    const says = `${p.says} But the deposit already banked for ${p.eftNumber} is ${money(receipt.amountCents)}, not ${money(p.totalPaidCents)}. One of the two documents is wrong, so no claim payment was posted from this report.`;
    await audit({ action: "claims.accesshealth_payment_refused", userId: by.id ?? null, userName: by.name, entity: "document", entityId: input.documentId ?? undefined, details: says });
    return { says, stored: false, refused: true, posted: 0, alreadyHeld: 0 };
  }

  /*
   * The day the money arrived, which is what decides whether it is inside the books (books-start.ts).
   *
   * The report is dated the day Health Mart Atlas paid; the deposit lands one to four days later (measured on the
   * nine real reports). Where the deposit is on file its date is used, so a report of 31 August whose money reached
   * the bank on 1 September is September's money, as its deposit already is. Otherwise the report's own date.
   */
  const receivedOn = receipt?.receivedOn ?? p.paidOn;
  const held = await heldUnder(p.eftNumber);
  const { recordClaimPayment } = await import("./claim-payments");
  let posted = 0;
  let alreadyHeld = 0;
  let matched = 0;
  let postedCents = 0;
  for (const section of p.sections) {
    for (const c of section.claims) {
      if (c.amountCents === 0) continue;
      const k = `${c.rxNumber}|${c.amountCents}`;
      const n = held.get(k) ?? 0;
      if (n > 0) {
        held.set(k, n - 1);
        alreadyHeld++;
        continue;
      }
      const r = await recordClaimPayment(
        {
          rxNumber: c.rxNumber,
          dateFilled: c.fillDate,
          source: "plan",
          payer: "Health Mart Atlas",
          amountCents: c.amountCents,
          revenueCents: 0,
          receivedOn,
          reference: `${p.eftNumber}/${c.rxNumber}`,
          documentId: input.documentId,
          notes: `From the AccessHealth payment report for ${p.eftNumber}, ${section.plan}${c.rejection ? `, rejection code ${c.rejection}` : ""}.`,
        },
        by,
      );
      posted++;
      postedCents += c.amountCents;
      if (r.matched) matched++;
    }
  }

  const adjustments = p.sections.flatMap((sec) => sec.adjustments.map((a) => ({ plan: sec.plan, ...a })));
  const adjustmentText = adjustments.length
    ? `Remittance-level adjustments, kept as data and on neither account until their posting is agreed: ${adjustments.map((a) => `${a.plan} ${a.code}${a.reference ? ` ${a.reference}` : ""} ${money(a.amountCents)}`).join("; ")}.`
    : "";
  if (input.documentId && adjustments.length) {
    await db.update(schema.documents).set({ notes: adjustmentText }).where(eq(schema.documents.id, input.documentId));
  }

  const says = [
    p.says,
    receipt ? `The deposit banked for it on ${receipt.receivedOn} agrees, ${money(receipt.amountCents)}.` : `No deposit for ${p.eftNumber} is on file yet; the payer payment report or the EFT notice banks it.`,
    `${posted} claim payment${posted === 1 ? "" : "s"} posted (${money(postedCents)}), ${matched} matched to a claim on this site${alreadyHeld ? `; ${alreadyHeld} already held under ${p.eftNumber}` : ""}. Nothing banked.`,
    adjustmentText,
  ].filter(Boolean).join(" ");
  await audit({ action: "claims.accesshealth_payment_read", userId: by.id ?? null, userName: by.name, entity: "document", entityId: input.documentId ?? undefined, details: says });
  return { says, stored: posted > 0 || alreadyHeld > 0, refused: false, posted, alreadyHeld };
}

/** Plan payments already held under this EFT, counted by prescription and amount. */
async function heldUnder(eftNumber: string): Promise<Map<string, number>> {
  const rows = await db.query.claimPayments.findMany({
    where: and(eq(schema.claimPayments.source, "plan"), like(schema.claimPayments.reference, `${eftNumber}/%`)),
    columns: { rxNumber: true, amountCents: true },
  });
  const held = new Map<string, number>();
  for (const r of rows) held.set(`${r.rxNumber}|${r.amountCents}`, (held.get(`${r.rxNumber}|${r.amountCents}`) ?? 0) + 1);
  return held;
}

export type { AccessHealthPayment };
