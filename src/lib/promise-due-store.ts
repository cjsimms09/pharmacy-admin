import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { daysBetween } from "./payer-owed";
import { graceFor, type Grace } from "./promise-due";

/**
 * How long the facilitator actually takes to pay, read off its own remittances.
 *
 * `promise-due.ts` decides when a promised payment is late; this is the one thing it needs from the
 * database, and it is deliberately the pharmacy's own measurement rather than a number anybody typed.
 *
 * ── Why the payer's stated terms are not used here, yet ──
 *
 * `graceFor` prefers a payer's own contracted cycle over any measurement, and it is given none.
 * That is a finding, not an oversight:
 *
 *  - `payment_routing` is the only table on the site that holds a payer's payment cycle at all. It
 *    has 29 rows; 20 state a cycle, and every one of them states it as the prose the contract
 *    printed ("Within fourteen (14) days of receipt of an electronically submitted Clean Claim").
 *    There is no column of days, and reading a number out of that prose is its own piece of work —
 *    several rows carry two cycles for two lines of business, and Caremark's states a sixty-day
 *    *reconciliation* cycle that says nothing about when a point-of-sale claim is paid.
 *  - None of those 29 rows is the facilitator. Every promise on file is a Medicare Transaction
 *    Facilitator payment, and the MTF is not a PBM and has no contract row here. The BIN on the
 *    claim belongs to whoever adjudicated it — Caremark, OptumRx, Humana, Prime — and none of them
 *    pays this money, so their cycles would be the wrong clock even once they are parsed.
 *
 * `suppliers.payment_terms_days` is a real number of days and is the wrong one: it is what this
 * pharmacy owes a wholesaler, not what a payer owes the pharmacy.
 *
 * ── Every remittance counts as evidence of timing, including the out-of-books ones ──
 *
 * 20 of the 31 facilitator payments on file are `outOfBooks` — received before 1 September, kept
 * because the owner pulls old remittances to prove the matcher works, and never counted as revenue:
 * *"these are test only and should not show up on any AR reports or anything."* They are excluded
 * from every money figure and they are included here, because this is not a money figure. How long
 * the facilitator took to pay a July fill is a true fact about the facilitator whether or not that
 * dollar belongs in the books, and dropping them would leave 11 observations where there are 31 —
 * below `OBSERVED_MINIMUM`, which would put the whole check on a default it does not need.
 */
export async function facilitatorGrace(source = "mtf"): Promise<Grace> {
  const rows = await db.query.claimPayments.findMany({
    where: eq(schema.claimPayments.source, source),
    columns: { dateFilled: true, receivedOn: true },
  });

  const observedDaysToPay = rows
    .map((r) => (r.dateFilled === null || r.receivedOn === null ? null : daysBetween(r.dateFilled, r.receivedOn)))
    .filter((d): d is number => d !== null && d >= 0);

  return graceFor({ payer: "the Medicare Transaction Facilitator", termsDays: null, observedDaysToPay });
}
