/**
 * The month's share of a standing cost, by the day.
 *
 * Thirty thousand of payroll is ten thousand by the tenth of a thirty-day month and the whole
 * thirty thousand once the month is over. The share is by calendar days, not working days: the
 * owner sets one figure for the month and the question the account answers is "how far through
 * the month are we", which the calendar answers. Pure, so it is tested.
 */

export type StandingLine = {
  id: string;
  name: string;
  categoryId: string | null;
  vendorId: string | null;
  /** The whole month's figure. */
  amountCents: number;
  /** What this month carries so far. */
  accruedCents: number;
  days: number;
  of: number;
  /** True where a real bill from the same vendor is entered for the month, and this line is dropped for it. */
  replacedByBill: boolean;
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
 * Every standing cost that applies to the month, with its share, and whether a real bill has
 * taken its place. A bill from the cost's vendor entered for the month is the fact; the standing
 * figure was the estimate of it, and both on the account would count payroll twice.
 */
export function standingLines(
  costs: { id: string; name: string; categoryId: string | null; vendorId: string | null; amountCents: number; fromMonth: string; toMonth: string | null }[],
  month: string,
  today: string,
  billsInMonth: { vendorId: string | null }[],
): StandingLine[] {
  const billed = new Set(billsInMonth.map((b) => b.vendorId).filter((v): v is string => !!v));
  return costs
    .filter((c) => c.fromMonth <= month && (c.toMonth === null || c.toMonth >= month))
    .map((c) => {
      const { days, of } = shareOfMonth(month, today);
      return {
        id: c.id,
        name: c.name,
        categoryId: c.categoryId,
        vendorId: c.vendorId,
        amountCents: c.amountCents,
        accruedCents: Math.round((c.amountCents * days) / of),
        days,
        of,
        replacedByBill: c.vendorId !== null && billed.has(c.vendorId),
      };
    });
}
