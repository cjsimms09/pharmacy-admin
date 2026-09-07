import "server-only";
import { loadShared, monthInputs, monthlyPL, type MonthlyPL } from "./profit-and-loss";
import { combineMonths, scriptCounts, pace, basisGap, periodOf, periodsBack, type Period, type PeriodPL, type ScriptCounts, type Pace, type BasisGap } from "./ledger";
import { todayIso } from "./dates";

/**
 * The books for a period, assembled from what the site holds.
 *
 * Nothing here computes; `profit-and-loss.ts` decides each month and `ledger.ts` adds the months.
 * This file reads once and hands over, so a year's statement costs one read of the claims rather
 * than twelve.
 */

export type Books = {
  period: Period;
  accrual: PeriodPL;
  cash: PeriodPL;
  scripts: ScriptCounts;
  gap: BasisGap;
  /** Only for the current month: what it has done so far, scaled. */
  pace: Pace | null;
  /** Where each figure's rows live, so the page can link every number to its records. */
  sources: Record<string, string>;
};

export async function booksFor(period: Period, today = todayIso()): Promise<Books> {
  const { held } = await import("./held");
  return held(`books:${period.key}:${today}`, () => loadBooks(period, today));
}

async function loadBooks(period: Period, today: string): Promise<Books> {
  const [accrualShared, cashShared] = await Promise.all([loadShared(period.months, "accrual"), loadShared(period.months, "cash")]);
  const accrualMonths: MonthlyPL[] = period.months.map((m) => monthlyPL(monthInputs(m, "accrual", accrualShared)));
  const cashMonths: MonthlyPL[] = period.months.map((m) => monthlyPL(monthInputs(m, "cash", cashShared)));
  const accrual = combineMonths(period, accrualMonths);
  const cash = combineMonths(period, cashMonths);
  const scripts = scriptCounts(accrualShared.fills.map((f) => ({ dateFilled: f.dateFilled, cashPlan: f.cashPlan, revenueCents: f.revenueCents })), period);

  const thisMonth = today.slice(0, 7);
  let paced: Pace | null = null;
  if (period.kind === "month" && period.key === thisMonth) {
    const current = accrualMonths[0];
    // Days elapsed is the days with a fill in them, which is the pharmacy's own calendar rather than the wall's.
    const daysWithFills = new Set(accrualShared.fills.filter((f) => f.dateFilled.startsWith(thisMonth)).map((f) => f.dateFilled)).size;
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

/** The last n months' accrual accounts, for the chart. One read for all of them. */
export async function recentMonths(n: number, today = todayIso()): Promise<{ month: string; pl: MonthlyPL; scripts: number }[]> {
  const { held } = await import("./held");
  return held(`recent:${n}:${today}`, () => loadRecentMonths(n, today));
}

async function loadRecentMonths(n: number, today: string): Promise<{ month: string; pl: MonthlyPL; scripts: number }[]> {
  const periods = periodsBack("month", today.slice(0, 7), n);
  const months = periods.map((p) => p.key);
  const shared = await loadShared(months, "accrual");
  return months.map((m) => ({
    month: m,
    pl: monthlyPL(monthInputs(m, "accrual", shared)),
    scripts: shared.fills.filter((f) => f.dateFilled.startsWith(m)).length,
  }));
}

export { periodOf };
