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
 * ── Except where the payment names a fill these books do not contain ──
 *
 * The paragraph above rests on *"a September remittance settling an August fill is real money in
 * these books"*, and on 14 September that sentence turned out to have an unexamined word in it:
 * **these**. It is real money in these books only if the fill is in these books.
 *
 * Fourteen Medicare Transaction Facilitator refunds, $1,572.90, arrived between 1 and 14 September
 * for fills dated 10 to 24 August, and every one was counted by the rule above. Not one of the
 * claims they settle exists in this site at all — not in the books, not out of them, never imported,
 * because the claims feed begins on 1 September. So they credited September with revenue whose fill
 * it had never recorded, against a cost it had never carried, and could never be matched to anything
 * for as long as they were kept.
 *
 * So a payment that **names** a fill date is judged on that date. The rule above stands untouched
 * wherever a payment names none: a remittance with no date is far likelier to be this month's, and
 * silently dropping real revenue is still the failure that matters there.
 *
 * Nothing is lost by the narrower rule, and that is what makes it safe rather than merely tidier —
 * the revenue was never counted, because the claim was never loaded. The claim and its payment go
 * out together or stay together. Before this they came apart.
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
export function isOutOfBooks(receivedOn: string | null | undefined, dateFilled?: string | null): boolean {
  /*
   * The fill wins where the payment names a **credible** one: a payment settles a claim, and a claim
   * these books never loaded cannot be settled inside them. See the third section above for the
   * $1,572.90 that found this.
   *
   * Credible means not after the day the money arrived. Nobody is paid for a fill that has not
   * happened, so a later fill date is not a fill date — it is a placeholder, and this pharmacy has
   * 58 of them: ProviderPay rows stamped 2026-12-31, received 27 August, which read as "filled in
   * the future, therefore after 1 September, therefore in the books" and would have pulled $580 of
   * August test money in. That is the same fault as the one being fixed, pointing the other way, and
   * it was caught by a dry run rather than by the reasoning.
   *
   * The test is against the received date rather than against today, so this stays pure and needs no
   * clock. Where no fill is named, or the one named is not credible, the original received-date rule
   * is unchanged.
   */
  if (dateFilled && (!receivedOn || dateFilled <= receivedOn)) return dateFilled < SITE_STARTS_ON;
  if (!receivedOn) return false;
  return receivedOn < SITE_STARTS_ON;
}

/** The same question asked of a "YYYY-MM" month, for the cash side which is kept by month. */
export function monthIsOutOfBooks(month: string | null | undefined): boolean {
  if (!month) return false;
  return month < SITE_STARTS_ON.slice(0, 7);
}
