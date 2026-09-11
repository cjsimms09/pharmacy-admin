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
