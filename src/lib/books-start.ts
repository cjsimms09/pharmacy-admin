/**
 * The day this site's books begin, and the one rule that keeps older money out of them.
 *
 * The owner, 8 September 2026: *"i will not be uploading claims from before sept.. or anything.
 * this site is starting clean as of 09/01/.."* — and again on 11 September, of the remittances he
 * was about to pull for April and June: *"I want to make sure these are only tests.. I do not want
 * to track or keep track of payments from before 09/01.. these are test only and should not show up
 * on any AR reports or anything."*
 *
 * Both sentences describe one boundary, so it is written once here and imported everywhere rather
 * than repeated. It used to live inside the copay-remit reader, where only that reader could see
 * it — which is exactly why remittance import and payment-report import both ignored it.
 *
 * ── Why the received date and not the fill date ──
 *
 * His words are "payments from before 09/01": the test is when the money arrived. That is also the
 * safe reading. A September remittance settling an August fill is real money in these books, and a
 * fill-date rule would throw it out — quietly losing revenue in the name of tidiness. The reverse
 * error is harmless by comparison: a June payment for a June fill is out either way.
 *
 * ── A fill-date exception was tried on 15 September and withdrawn the same day. Do not re-add it ──
 *
 * The paragraph above was overridden that morning. Fourteen Medicare Transaction Facilitator
 * refunds ($1,572.90) arrived in September for fills dated in August, and none of the claims they
 * settle is in this site, so they can never be matched. The reasoning went: a payment settles a
 * claim, the claim is not in these books, so the payment should not be either — and a payment that
 * named a fill date was judged on that date instead of on the day the money arrived.
 *
 * That was accrual reasoning applied to a flag the **cash** account also reads. `profit-and-loss.ts`
 * counts MTF refunds received in a month as that month's facilitator cash wherever nobody has typed a
 * facilitator receipt, and nobody had. So the change took real September cash out of the September
 * cash account — $2,789.08 by that afternoon, including a $1,216.18 refund that arrived the same day
 * and was shut out on arrival — and it would have gone on removing cash every day the August fills'
 * refunds kept landing. It was also reported as "neither bottom line moved", which nobody had
 * measured.
 *
 * The paragraph above was right, and for exactly the reason it gives: "a fill-date rule would throw it
 * out — quietly losing revenue in the name of tidiness." Money received in September is September
 * cash, whatever fill it paid for. The accrual account never reads these payments, so nothing needed
 * protecting there. That the refunds cannot be matched to a claim is a matching question, and the
 * owner answered it the same morning: *"the mtf payments are probably for claims before when we
 * started this site.. that is okay.. they should match going forward."*
 *
 * The lesson in the shape of the fault: before changing what a flag means, find every reader of the
 * flag. The costliest faults here have been two correct things meeting.
 *
 * ── Why the rows are kept at all ──
 *
 * Deleting them would test nothing. The whole point of pulling a real month is to prove that an 835
 * matches down to the claim, so the rows must exist and must be matchable. They are simply never
 * counted: every query that adds money up excludes them.
 */
export const SITE_STARTS_ON = "2026-09-01";

/**
 * Whether money received on this date belongs to the books, or is test data from before they began.
 *
 * An unknown date is treated as **in** the books. A remittance that names no date is far more
 * likely to be this month's — it is here, now, being read — than a deliberate pull of an old month,
 * and the failure that matters is silently dropping real revenue. Anything pulled as a test comes
 * with its dates, because that is what a portal export is.
 */
export function isOutOfBooks(receivedOn: string | null | undefined): boolean {
  if (!receivedOn) return false;
  return receivedOn < SITE_STARTS_ON;
}

/** The same question asked of a "YYYY-MM" month, for the cash side which is kept by month. */
export function monthIsOutOfBooks(month: string | null | undefined): boolean {
  if (!month) return false;
  return month < SITE_STARTS_ON.slice(0, 7);
}
