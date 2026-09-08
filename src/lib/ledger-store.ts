import "server-only";
import { accountsFor, accountMonths, type MonthlyPL } from "./profit-and-loss";
import { combineMonths, scriptCounts, pace, basisGap, periodOf, periodsBack, type Period, type PeriodPL, type ScriptCounts, type Pace, type BasisGap } from "./ledger";
import { countedTwiceOver, feedsInTheBooks, booksBalance, basisDifference, type CountedTwice, type Feed, type BasisDifference } from "./books-check";
import { todayIso } from "./dates";

/**
 * The books for a period, assembled from what the site holds.
 *
 * Nothing here computes; `profit-and-loss.ts` decides each month and `ledger.ts` adds the months.
 * This file reads once and hands over, so a year's statement costs one read of the claims rather
 * than twelve.
 *
 * The read itself is `accountsFor`, which the reports at `/money/report` go through as well. That
 * is the point rather than an economy: the books and the reports used to reach the same figures by
 * two different routes, and two routes to a number are two numbers eventually. One route, one
 * arithmetic, and a quarter here cannot disagree with the same quarter there.
 */

export type Books = {
  period: Period;
  accrual: PeriodPL;
  cash: PeriodPL;
  scripts: ScriptCounts;
  gap: BasisGap;
  /** Only for the current month: what it has done so far, scaled. */
  pace: Pace | null;
  /**
   * The owner's three requirements, answered for this period rather than asserted.
   *
   * *"needs to not double count things"* — `countedOnce`, the figures two records both know and
   * what the account kept out. *"needs to not forget about expenses or revenue it knows"* —
   * `feeds`, every feed that carries money and where it lands. *"should be able to operate on a
   * cash and accrual basis"* — `difference`, the gap between the two bottom lines in parts that add
   * to it exactly. And `balances`, which is the arithmetic under all three: every total the sum of
   * its own lines.
   */
  countedOnce: CountedTwice[];
  feeds: Feed[];
  difference: BasisDifference;
  balances: { accrual: ReturnType<typeof booksBalance>; cash: ReturnType<typeof booksBalance> };
  /** Where each figure's rows live, so the page can link every number to its records. */
  sources: Record<string, string>;
};

export async function booksFor(period: Period, today = todayIso()): Promise<Books> {
  const { held } = await import("./held");
  return held(`books:${period.key}:${today}`, () => loadBooks(period, today));
}

async function loadBooks(period: Period, today: string): Promise<Books> {
  /*
   * Only the months something has actually been recorded for.
   *
   * A month nobody has loaded a claim, a bill or a till report for is not a month that took
   * nothing; running it through the account anyway produces a column of noughts and a page of
   * "this is missing", and on a year eleven of them, which buries the months that really are short
   * of a line. `periodTotals` has always worked this way, and the books did not — so the same
   * quarter could contain different months on the two pages. It now names them: `emptyMonths`.
   */
  const have = new Set(await accountMonths());
  const wanted = period.months.filter((m) => have.has(m));
  if (wanted.length === 0) return emptyBooks(period);
  const [a, c] = await Promise.all([accountsFor(wanted, "accrual"), accountsFor(wanted, "cash")]);
  const accrualMonths: MonthlyPL[] = a.months;
  const accrual = combineMonths(period, accrualMonths);
  const cash = combineMonths(period, c.months);
  const scripts = scriptCounts(a.shared.fills.map((f) => ({ dateFilled: f.dateFilled, cashPlan: f.cashPlan, revenueCents: f.revenueCents })), period);

  const thisMonth = today.slice(0, 7);
  let paced: Pace | null = null;
  const current = accrualMonths.find((m) => m.month === thisMonth);
  if (period.kind === "month" && period.key === thisMonth && current) {
    // Days elapsed is the days with a fill in them, which is the pharmacy's own calendar rather than the wall's.
    const daysWithFills = new Set(a.shared.fills.filter((f) => f.dateFilled.startsWith(thisMonth)).map((f) => f.dateFilled)).size;
    paced = pace(current, Math.max(daysWithFills, Number(today.slice(8, 10))));
  }

  const q = `from=${period.from}&to=${period.to}`;
  return {
    period,
    accrual,
    cash,
    scripts,
    gap: basisGap(accrual, cash),
    pace: paced,
    countedOnce: countedTwiceOver(a.inputs.map((inputs, k) => ({ inputs, pl: a.months[k] }))),
    feeds: feedsInTheBooks(),
    difference: basisDifference(accrual, cash),
    balances: { accrual: booksBalance(accrual), cash: booksBalance(cash) },
    sources: {
      revenue: `/claims?${q}`,
      costOfGoods: `/claims?${q}`,
      purchases: `/inventory/invoices?${q}`,
      rebates: "/suppliers",
      expenses: `/expenses?${q}`,
      scripts: `/claims?${q}`,
      deliveries: `/deliveries?month=${period.months[period.months.length - 1]}`,
      sales: "/money/monthly",
    },
  };
}

/**
 * A period nothing has been recorded for, answered without reading anything.
 *
 * Not an error and not a blank screen: the period is real, its months are named as empty, and
 * every figure is nought because nought is what the site holds — which is a different sentence
 * from "the pharmacy took nothing", and the page says which.
 */
function emptyBooks(period: Period): Books {
  const accrual = combineMonths(period, []);
  const cash = combineMonths(period, []);
  return {
    period,
    accrual,
    cash: { ...cash, basis: "cash" },
    scripts: scriptCounts([], period),
    gap: basisGap(accrual, cash),
    pace: null,
    countedOnce: [],
    feeds: feedsInTheBooks(),
    difference: basisDifference(accrual, { ...cash, basis: "cash" }),
    balances: { accrual: booksBalance(accrual), cash: booksBalance({ ...cash, basis: "cash" }) },
    sources: {},
  };
}

/** The last n months' accrual accounts, for the chart. One read for all of them. */
export async function recentMonths(n: number, today = todayIso()): Promise<{ month: string; pl: MonthlyPL; scripts: number }[]> {
  const { held } = await import("./held");
  return held(`recent:${n}:${today}`, () => loadRecentMonths(n, today));
}

async function loadRecentMonths(n: number, today: string): Promise<{ month: string; pl: MonthlyPL; scripts: number }[]> {
  const months = periodsBack("month", today.slice(0, 7), n).map((p) => p.key);
  const { months: accounts, shared } = await accountsFor(months, "accrual");
  return accounts.map((pl) => ({ month: pl.month, pl, scripts: shared.fills.filter((f) => f.dateFilled.startsWith(pl.month)).length }));
}

export { periodOf };
