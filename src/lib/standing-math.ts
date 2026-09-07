/**
 * The month's share of a standing cost, by the day — and, on the cash basis, by the day it is paid.
 *
 * Thirty thousand of payroll is ten thousand by the tenth of a thirty-day month and the whole
 * thirty thousand once the month is over. The share is by calendar days, not working days: the
 * owner sets one figure for the month and the question the accrual account answers is "how far
 * through the month are we", which the calendar answers.
 *
 * The cash account asks a different question — has the money left the bank — and by-the-day is
 * the wrong answer to it: payroll accrued to the 10th has not left anything. So on the cash basis
 * a standing cost counts in full on the day it is paid (`paidDay`) and not at all before it, and
 * a cost with no paid day is left out and named, never estimated. Pure, so it is tested.
 */

export type Basis = "accrual" | "cash";

export type StandingLine = {
  id: string;
  name: string;
  categoryId: string | null;
  vendorId: string | null;
  /** The whole month's figure. */
  amountCents: number;
  /** What this month carries so far on the basis asked for. */
  accruedCents: number;
  days: number;
  of: number;
  /** The day of the month the money leaves, where the owner has said. */
  paidDay: number | null;
  /** True where a real bill from the same vendor is entered for the month, and this line is dropped for it. */
  replacedByBill: boolean;
  /** Cash basis only: true where the cost has no paid day, so the cash account cannot place it. */
  noPaidDay: boolean;
};

function daysIn(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** How much of a month has passed by a day: 0 of 31 before it starts, 31 of 31 once it is over. */
export function shareOfMonth(month: string, today: string): { days: number; of: number } {
  const of = daysIn(month);
  const todayMonth = today.slice(0, 7);
  if (todayMonth < month) return { days: 0, of };
  if (todayMonth > month) return { days: of, of };
  return { days: Math.min(of, Math.max(1, Number(today.slice(8, 10)))), of };
}

export function accruedCents(amountCents: number, month: string, today: string): number {
  const { days, of } = shareOfMonth(month, today);
  return Math.round((amountCents * days) / of);
}

/**
 * On the cash basis: the whole figure once the paid day has passed, nothing before it.
 *
 * A paid day past the end of a short month (the 31st in February) is the last day of it, which is
 * what a bank does with it.
 */
export function paidCents(amountCents: number, paidDay: number | null, month: string, today: string): number {
  if (paidDay === null) return 0;
  const { days, of } = shareOfMonth(month, today);
  return days >= Math.min(paidDay, of) ? amountCents : 0;
}

export type StandingCostInput = {
  id: string;
  name: string;
  categoryId: string | null;
  vendorId: string | null;
  amountCents: number;
  fromMonth: string;
  toMonth: string | null;
  paidDay?: number | null;
};

/**
 * Every standing cost that applies to the month, with its share, and whether a real bill has
 * taken its place.
 *
 * A bill from the cost's vendor entered for the month is the fact; the standing figure was the
 * estimate of it, and both on the account would count payroll twice. A cost with no vendor is
 * replaced by a bill in its category instead, for the same reason: payroll typed as a standing
 * cost under Wages and the payroll run entered under Wages are the same money. The bills passed
 * in are already on the basis asked for (by invoice date, or by the day paid).
 */
export function standingLines(
  costs: StandingCostInput[],
  month: string,
  today: string,
  billsInMonth: { vendorId: string | null; categoryId?: string | null }[],
  basis: Basis = "accrual",
): StandingLine[] {
  const billed = new Set(billsInMonth.map((b) => b.vendorId).filter((v): v is string => !!v));
  const billedCategories = new Set(billsInMonth.map((b) => b.categoryId ?? null).filter((c): c is string => !!c));
  return costs
    .filter((c) => c.fromMonth <= month && (c.toMonth === null || c.toMonth >= month))
    .map((c) => {
      const { days, of } = shareOfMonth(month, today);
      const paidDay = c.paidDay ?? null;
      const replacedByBill = c.vendorId !== null ? billed.has(c.vendorId) : c.categoryId !== null && billedCategories.has(c.categoryId);
      return {
        id: c.id,
        name: c.name,
        categoryId: c.categoryId,
        vendorId: c.vendorId,
        amountCents: c.amountCents,
        accruedCents: basis === "cash" ? paidCents(c.amountCents, paidDay, month, today) : Math.round((c.amountCents * days) / of),
        days,
        of,
        paidDay,
        replacedByBill,
        noPaidDay: basis === "cash" && paidDay === null,
      };
    });
}
