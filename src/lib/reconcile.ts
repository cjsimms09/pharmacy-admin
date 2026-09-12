/**
 * Every figure has a source, and the ones with two sources are checked against each other.
 *
 * This is the principle the claims screen already runs on — the site works out a month's margin,
 * PioneerRx works out the same month's margin from the same rows, and a disagreement is raised on
 * the page rather than discovered a quarter later. It applies to the whole account, and cost of
 * goods is where it matters most, because there are three plausible sources and they answer three
 * different questions.
 *
 * ── Where cost of goods comes from ──
 *
 * **The claims.** Each dispensing carries the acquisition cost of the bottle it came out of. Sum
 * it over the month and that is the accrual cost of goods: cost matched to the revenue it
 * produced, with no stocktake needed and no dependence on when the stock was bought or paid for.
 * This is the figure the account uses.
 *
 * **The wholesaler invoices.** What was bought. This is *not* cost of goods and must never be used
 * as it — in a month of building stock it is far larger, in a month of running stock down far
 * smaller, and the difference is not an error. It is the stock moving, and it belongs on the
 * balance sheet rather than in the profit.
 *
 * **Opening stock + purchases − closing stock.** The classical method, and the independent check.
 * It uses none of the claims' cost figures, so agreeing with them means two separate records of
 * the same month reached the same answer.
 *
 * ── What a difference means ──
 *
 * Purchases against cost of goods: a difference is expected and is stock movement. Reported, never
 * flagged.
 *
 * The stock identity against cost of goods: a difference is a real finding. Something was bought
 * and not recorded, something went back and was not logged, something walked, or a dispensing
 * carries no cost. Each is worth knowing and none announces itself.
 *
 * Pure.
 */

export type Source = {
  /** The figure, in cents. Null where the source is not held for this month. */
  cents: number | null;
  /** Where it came from, in the words somebody would use. */
  from: string;
  /** Why it is missing, where it is. */
  missing?: string;
};

export type Check = {
  what: string;
  /** Null where one side is not held, which is not the same as agreeing. */
  differenceCents: number | null;
  agrees: boolean | null;
  /** Whether a difference is a fault or an ordinary fact about the month. */
  expected: boolean;
  says: string;
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Below this, a difference is rounding rather than a finding. */
export const TOLERANCE_CENTS = 100;

export type CogsSources = {
  /** Acquisition cost of everything dispensed in the month, from the claims. */
  dispensed: Source;
  /** What the wholesalers invoiced in the month. */
  purchases: Source;
  /** Stock on hand at the first count of the month, and at the last. */
  openingStock: Source;
  closingStock: Source;
};

/**
 * The two comparisons worth making about a month's cost of goods.
 *
 * Returns what each source says as well as the checks, so a page can show its working rather than
 * only its verdict — a reconciliation nobody can inspect is one nobody will believe the second
 * time it disagrees.
 */
export function reconcileCogs(s: CogsSources): { checks: Check[]; impliedCogsCents: number | null; stockMovementCents: number | null } {
  const checks: Check[] = [];

  /*
   * Purchases against cost of goods. Different by design: the gap is the stock the month built up
   * or ran down, and calling that an error would cry wolf every month a big order landed.
   */
  const stockMovementCents =
    s.purchases.cents !== null && s.dispensed.cents !== null ? s.purchases.cents - s.dispensed.cents : null;
  checks.push({
    what: "Bought against dispensed",
    differenceCents: stockMovementCents,
    agrees: stockMovementCents === null ? null : Math.abs(stockMovementCents) <= TOLERANCE_CENTS,
    expected: true,
    says:
      stockMovementCents === null
        ? "One of the two is not held for this month, so nothing can be said."
        : stockMovementCents > TOLERANCE_CENTS
          ? `${money(stockMovementCents)} more was bought than dispensed, so the shelf grew by that much. Not an error — it is cash converted into stock, and it belongs on the balance sheet rather than in the profit.`
          : stockMovementCents < -TOLERANCE_CENTS
            ? `${money(stockMovementCents)} more was dispensed than bought, so the month ran the shelf down by that much and turned stock back into cash.`
            : "The month bought almost exactly what it dispensed.",
  });

  /*
   * The independent one. Opening + purchases − closing uses no figure from the claims, so agreement
   * means two separate records of the same month arrived at the same cost.
   */
  const impliedCogsCents =
    s.openingStock.cents !== null && s.purchases.cents !== null && s.closingStock.cents !== null
      ? s.openingStock.cents + s.purchases.cents - s.closingStock.cents
      : null;
  const gap = impliedCogsCents !== null && s.dispensed.cents !== null ? impliedCogsCents - s.dispensed.cents : null;
  checks.push({
    what: "The shelf against the claims",
    differenceCents: gap,
    agrees: gap === null ? null : Math.abs(gap) <= TOLERANCE_CENTS,
    expected: false,
    says:
      gap === null
        ? "Needs a count at each end of the month and the month's invoices. Without all three there is nothing to check the claims' own cost against."
        : Math.abs(gap) <= TOLERANCE_CENTS
          ? "Opening stock plus purchases less closing stock comes to what the claims say was dispensed. Two separate records of the month agree."
          : gap > 0
            ? `The shelf says ${money(gap)} more left than the claims account for. Something went out without being dispensed — stock returned and not logged, breakage, or a count taken on the wrong day.`
            : `The claims account for ${money(gap)} more than the shelf lost. Something arrived without an invoice, or a dispensing carries a cost it should not.`,
  });

  return { checks, impliedCogsCents, stockMovementCents };
}

export type RevenueSources = {
  /** Every plan's remittance plus what the patient paid, from the claims. */
  claims: Source;
  /** The System Sales Summary's prescription total for the month. */
  tillRx: Source;
  /** What actually reached the bank. */
  banked: Source;
};

/**
 * Revenue has two independent records of the same prescriptions, and they should agree.
 *
 * The claims are what was adjudicated; the till report is what PioneerRx rang up. A gap is a real
 * finding: a fill sold and never billed, a claim billed and never sold, or a day of one report
 * missing. What is *not* a finding is the bank differing from either — that is timing, and a plan
 * that pays three weeks later is not a discrepancy.
 */
export function reconcileRevenue(s: RevenueSources): Check[] {
  const rxGap = s.claims.cents !== null && s.tillRx.cents !== null ? s.claims.cents - s.tillRx.cents : null;
  const bankGap = s.banked.cents !== null && s.claims.cents !== null ? s.banked.cents - s.claims.cents : null;

  return [
    {
      what: "The claims against the till",
      differenceCents: rxGap,
      agrees: rxGap === null ? null : Math.abs(rxGap) <= TOLERANCE_CENTS,
      expected: false,
      says:
        rxGap === null
          ? "Needs both the claims and the System Sales Summary for the month."
          : Math.abs(rxGap) <= TOLERANCE_CENTS
            ? "What was adjudicated and what was rung up agree."
            : rxGap > 0
              ? `The claims are ${money(rxGap)} ahead of the till. Something was billed and not sold — a fill still on the will-call shelf, or a claim that should have been reversed.`
              : `The till is ${money(rxGap)} ahead of the claims. Something was sold that this site has no claim for — a missing day of the transaction report, most likely.`,
    },
    {
      what: "The bank against the claims",
      differenceCents: bankGap,
      agrees: null,
      expected: true,
      says:
        bankGap === null
          ? "Needs what reached the bank this month as well as the claims."
          : `${money(bankGap)} ${bankGap >= 0 ? "more" : "less"} reached the bank than the month earned. Expected: a plan pays weeks after it adjudicates, so the bank is always answering a different month's question. It is not a discrepancy and is never treated as one.`,
    },
  ];
}
