/**
 * A cash plan: one the pharmacy bills through, and which never sends any money.
 *
 * The owner: "There is no third party remit from pharmd. Whatever the copay is is the only money
 * we receive."
 *
 * This looks like a small distinction and is not. A claim on Pharm D — RxLocal, BIN 028249 — is
 * adjudicated, transmitted and paid like any other, and ends up in the claims table beside a
 * Medicare Part D claim with the same shape. But there is no payer behind it. Three consequences,
 * each of which the site had wrong before this module existed:
 *
 * 1. **It is never a receivable.** `payerShares` gives every payer a receivable of its own remit,
 *    settled only by its own 835. On a cash plan that is money owed by nobody, waiting for a
 *    remittance that will never arrive, ageing quietly on a report of what is outstanding.
 * 2. **A remit on one is not revenue.** September had three: an Omnipod, a Mounjaro and a Wegovy,
 *    $418.22 between them. In each the patient's payment and the "remit" add exactly to the price of
 *    the fill — so the figure is not money arriving, it is the part of the price the patient was not
 *    charged. Booking it overstates the month by $418.22 and books it against a payer who will never
 *    pay it.
 * 3. **The copay is the whole revenue**, collected at the register on the day, which is the same on
 *    both the accrual and the cash basis. There is nothing outstanding to reconcile.
 *
 * Which plans these are is data, not a constant: `cash_plans` holds them, seeded with the
 * pharmacy's own. Matching is on BIN, and on PCN as well where the row names one, because a BIN can
 * carry more than one plan and only some of them are cash.
 *
 * Pure, so it is tested.
 */

export type CashPlan = {
  bin: string;
  /** Null matches every PCN on the BIN; a value matches only that PCN. */
  pcn: string | null;
  name: string;
};

const norm = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase();

/** The cash plan a BIN and PCN belong to, or null. The most specific row wins. */
export function cashPlanFor(bin: string | null | undefined, pcn: string | null | undefined, plans: CashPlan[]): CashPlan | null {
  const b = norm(bin);
  if (!b) return null;
  const p = norm(pcn);
  const onBin = plans.filter((c) => norm(c.bin) === b);
  /*
   * A row naming a PCN is a statement about that plan; a row without one is a statement about the
   * whole BIN. So the PCN match is preferred, and the BIN-wide row is the fallback — never the
   * other way round, or a BIN-wide row would swallow a plan somebody had deliberately narrowed.
   */
  return onBin.find((c) => norm(c.pcn) !== "" && norm(c.pcn) === p) ?? onBin.find((c) => norm(c.pcn) === "") ?? null;
}

export function isCashPlan(bin: string | null | undefined, pcn: string | null | undefined, plans: CashPlan[]): boolean {
  return cashPlanFor(bin, pcn, plans) !== null;
}

export type PayerMoney = {
  bin: string | null;
  pcn: string | null;
  remitCents: number | null;
  copayCents: number | null;
};

export type CashPlanReading<T extends PayerMoney> = {
  /** The payer as it should be booked: on a cash plan, nothing remitted. */
  payer: T;
  plan: CashPlan | null;
  /**
   * What the claim said the plan paid, on a plan that pays nothing. Not revenue and not a
   * receivable — the part of the price the patient was not charged. Nought where there was none.
   */
  discountGivenCents: number;
};

/**
 * Read one payer's money with the cash plans in mind.
 *
 * The remit is zeroed rather than left alone and flagged, because every caller that adds up remits
 * would otherwise have to remember to exclude these, and one that forgets is a month overstated
 * with nothing to show for it. The copay is untouched: it is the money, and it was collected.
 */
export function readPayerMoney<T extends PayerMoney>(payer: T, plans: CashPlan[]): CashPlanReading<T> {
  const plan = cashPlanFor(payer.bin, payer.pcn, plans);
  if (!plan) return { payer, plan: null, discountGivenCents: 0 };
  const remit = payer.remitCents ?? 0;
  /*
   * A reversal is left exactly as it is.
   *
   * A negative remit is not a payment, it is the cancellation of one, and it is paired with the
   * claim it cancels by a key built from that very figure. Zeroing it would strand its partner and
   * leave the original standing as revenue — the opposite of the point. It costs nothing to leave:
   * a reversed claim and its reversal already net to nought, and neither is counted as revenue.
   */
  if (remit < 0) return { payer, plan, discountGivenCents: 0 };
  return { payer: { ...payer, remitCents: 0 }, plan, discountGivenCents: remit };
}
