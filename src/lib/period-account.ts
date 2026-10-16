import type { MonthlyPL } from "./profit-and-loss";
import { parsePeriod, quarterOf, periodsFor, previousPeriod, periodOf, type Period, type PeriodKind } from "./ledger";

/**
 * A quarter or a year, added up from the months that make it.
 *
 * The owner asked for the ability to run quarter and year reports and to see the months move. Both
 * come from the same place: this adds months that have already been computed, and never recomputes
 * anything, so a quarter cannot disagree with the three months printed inside it.
 *
 * ── Two rules that decide every figure here ──
 *
 * **A rate is computed from the period's totals, never averaged from the months'.** Three months at
 * 22%, 24% and 19% do not make a quarter at 21.67%: the quarter's margin is its own gross profit
 * over its own net revenue, and the difference between the two answers grows with the difference in
 * size between the months. The same goes for revenue per script, which is the period's revenue over
 * the period's scripts and not the mean of three monthly averages.
 *
 * **A month that cannot be trusted is named, never quietly added.** `monthlyAccount` marks a month
 * unusable when something material is missing from it — no payroll, no sales figures — and adding
 * such a month into a quarter produces a quarter that looks slightly optimistic rather than one
 * that is obviously incomplete. So they are summed in, because leaving them out understates just as
 * badly, and listed by name so the total is read for what it is.
 */

/*
 * A period is named in one place, and this is not it.
 *
 * Two modules used to define `Period` and `parsePeriod` — this one and `ledger.ts` — with the same
 * keys, nearly the same labels, and no way for either to know the other had drifted. Two
 * definitions of "Q3 2026" is exactly how a quarter comes to disagree with the three months
 * printed inside it, which is the failure this file's own doc comment promises never happens. So
 * the naming lives in `ledger.ts`, which was the richer of the two — its periods carry `from` and
 * `to` as well — and is re-exported here so every reader of this module keeps working.
 */
export { parsePeriod, quarterOf, periodsFor, previousPeriod, periodOf };
export type { Period, PeriodKind };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type PeriodTotals = {
  period: Period;
  basis: "accrual" | "cash";
  /** Every month in the period that had anything recorded, in order. */
  months: MonthlyPL[];
  scripts: number;
  revenueCents: number;
  netRevenueCents: number;
  costOfGoodsCents: number;
  grossProfitCents: number;
  operatingCents: number;
  netProfitCents: number;
  /** Computed on the period's own totals, never averaged from the months'. */
  grossMarginPercent: number | null;
  netMarginPercent: number | null;
  revenuePerScriptCents: number | null;
  grossProfitPerScriptCents: number | null;
  /** Months in the period with nothing recorded at all. */
  emptyMonths: string[];
  /** Months that were counted but are known to be short of something material. */
  unusableMonths: string[];
  /** Everything the months said was missing, said once. */
  missing: string[];
  /** Everything the months computed and knew leaned, said once. See MonthlyPL.caveats. */
  caveats: string[];
};

const share = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

const per = (total: number, count: number): number | null => (count > 0 ? Math.round(total / count) : null);

export function periodTotals(period: Period, basis: "accrual" | "cash", months: MonthlyPL[]): PeriodTotals {
  const inPeriod = period.months
    .map((m) => months.find((x) => x.month === m))
    .filter((x): x is MonthlyPL => x !== undefined);

  const add = (f: (m: MonthlyPL) => number) => inPeriod.reduce((n, m) => n + f(m), 0);
  const scripts = add((m) => m.claimsCount);
  const revenueCents = add((m) => m.revenueCents);
  const netRevenueCents = add((m) => m.netRevenueCents);
  const costOfGoodsCents = add((m) => m.costOfGoodsCents);
  const grossProfitCents = add((m) => m.grossProfitCents);
  const operatingCents = add((m) => m.operatingCents);
  const netProfitCents = add((m) => m.netProfitCents);

  return {
    period,
    basis,
    months: inPeriod,
    scripts,
    revenueCents,
    netRevenueCents,
    costOfGoodsCents,
    grossProfitCents,
    operatingCents,
    netProfitCents,
    grossMarginPercent: share(grossProfitCents, netRevenueCents),
    netMarginPercent: share(netProfitCents, netRevenueCents),
    revenuePerScriptCents: per(netRevenueCents, scripts),
    grossProfitPerScriptCents: per(grossProfitCents, scripts),
    emptyMonths: period.months.filter((m) => !inPeriod.some((x) => x.month === m)),
    unusableMonths: inPeriod.filter((m) => !m.usable).map((m) => m.month),
    missing: [...new Set(inPeriod.flatMap((m) => m.missing))],
    caveats: [...new Set(inPeriod.flatMap((m) => m.caveats ?? []))],
  };
}

export type TrendPoint = {
  month: string;
  /** "Sep 26", short enough to sit under a bar. */
  label: string;
  scripts: number;
  netRevenueCents: number;
  grossProfitCents: number;
  netProfitCents: number;
  grossMarginPercent: number | null;
  netRevenuePerScriptCents: number | null;
  grossProfitPerScriptCents: number | null;
  /** False where the month is known to be short of something material, so a dip can be read right. */
  usable: boolean;
};

/**
 * The months as a series, oldest first, for the charts.
 *
 * Oldest first because that is the direction a trend is read in, and the tables elsewhere in the
 * site are newest first — so the order is stated here rather than left to whoever draws it.
 */
export function trend(months: MonthlyPL[]): TrendPoint[] {
  return [...months]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month: m.month,
      label: `${MONTH_NAMES[Number(m.month.slice(5, 7)) - 1].slice(0, 3)} ${m.month.slice(2, 4)}`,
      scripts: m.claimsCount,
      netRevenueCents: m.netRevenueCents,
      grossProfitCents: m.grossProfitCents,
      netProfitCents: m.netProfitCents,
      grossMarginPercent: m.grossMarginPercent,
      netRevenuePerScriptCents: per(m.netRevenueCents, m.claimsCount),
      grossProfitPerScriptCents: per(m.grossProfitCents, m.claimsCount),
      usable: m.usable,
    }));
}

/**
 * The change from one period to the one before, for the sentence beside each figure.
 *
 * Percent change is refused where the earlier figure is nought or negative rather than reported as
 * infinity or as a sign-flipped nonsense — "up 300%" from a loss of $100 to a profit of $200 is not
 * a fact about the business.
 */
export function changeFrom(now: number, before: number): { deltaCents: number; percent: number | null } {
  const deltaCents = now - before;
  return { deltaCents, percent: before > 0 ? Math.round((deltaCents / before) * 1000) / 10 : null };
}
