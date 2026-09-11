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
  /** True where real bills from the same vendor reach the whole month's figure, and this line is dropped for them. */
  replacedByBill: boolean;
  /** What the account should add on top of the bills already in it. Nought where the bills cover the month. */
  toAccrueCents: number;
  /** What real bills against the same vendor or category already carry for the month. */
  billedCents: number;
  /** True where bills exist but fall short of the month's figure, so this line is the top-up. */
  partlyBilled: boolean;
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
 * Every standing cost that applies to the month, with its share, and how much of it a real bill
 * has already taken.
 *
 * A bill from the cost's vendor entered for the month is the fact; the standing figure was the
 * estimate of it, and both on the account would count payroll twice. A cost with no vendor is
 * matched by its category instead, for the same reason: payroll typed as a standing cost under
 * Wages and the payroll run entered under Wages are the same money. The bills passed in are
 * already on the basis asked for (by invoice date, or by the day paid).
 *
 * How much, not whether. This used to drop the whole estimate the moment any bill from that vendor
 * appeared, which is right where the bill is the month's payroll and badly wrong where it is one
 * run of two: $45,000 a month with a single $12,000 run entered showed $12,000 and dropped the
 * rest, understating the month by $33,000 with nothing on any screen to say so. An estimate exists
 * precisely because the real figure may not all be in yet, so it stands down by what has arrived
 * rather than for the first thing that arrives.
 *
 * So the estimate tops the bills up to what the month is expected to carry, and only disappears
 * once the bills reach it. A month billed above its estimate keeps the bills and adds nothing,
 * which is the same rule read from the other end.
 */
export function standingLines(
  costs: StandingCostInput[],
  month: string,
  today: string,
  billsInMonth: { vendorId: string | null; categoryId?: string | null; amountCents?: number }[],
  basis: Basis = "accrual",
): StandingLine[] {
  /* What has actually been billed against each vendor and each category, not merely that something was. */
  const byVendor = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const b of billsInMonth) {
    const cents = b.amountCents ?? 0;
    if (b.vendorId) byVendor.set(b.vendorId, (byVendor.get(b.vendorId) ?? 0) + cents);
    if (b.categoryId) byCategory.set(b.categoryId, (byCategory.get(b.categoryId) ?? 0) + cents);
  }
  /*
   * A bill with no amount given still counts as covering the whole estimate.
   *
   * Every caller in the application passes real amounts. Tests and older callers pass only the
   * vendor, and for those "there is a bill" has to keep meaning what it used to mean, or the change
   * would quietly start accruing payroll on top of a payroll bill it cannot measure.
   */
  const unmeasured = new Set(
    billsInMonth.filter((b) => b.amountCents === undefined).flatMap((b) => [b.vendorId, b.categoryId ?? null].filter((x): x is string => !!x)),
  );

  return costs
    .filter((c) => c.fromMonth <= month && (c.toMonth === null || c.toMonth >= month))
    .map((c) => {
      const { days, of } = shareOfMonth(month, today);
      const paidDay = c.paidDay ?? null;
      const against = c.vendorId !== null ? c.vendorId : c.categoryId;
      const billedCents = against === null ? 0 : (c.vendorId !== null ? byVendor.get(c.vendorId) : byCategory.get(c.categoryId ?? "")) ?? 0;
      const unmeasuredBill = against !== null && unmeasured.has(against);
      const expectedCents = basis === "cash" ? paidCents(c.amountCents, paidDay, month, today) : Math.round((c.amountCents * days) / of);
      /* Covered once the bills reach the whole month's figure — not the share accrued to today, which would drop it early. */
      const replacedByBill = unmeasuredBill || (billedCents > 0 && billedCents >= c.amountCents);
      return {
        id: c.id,
        name: c.name,
        categoryId: c.categoryId,
        vendorId: c.vendorId,
        amountCents: c.amountCents,
        /* The month's share of the standing figure, on its own terms and before any bill is considered. */
        accruedCents: expectedCents,
        /*
         * And what is left for it to actually put on the account once the bills are counted.
         *
         * Two figures because they answer two questions: the first is what this cost is expected to
         * come to by today, which the Spending page shows beside the cost itself, and the second is
         * what the account should add on top of the bills already in it. They differ only where a
         * bill has arrived and does not cover the whole month.
         */
        toAccrueCents: replacedByBill ? 0 : Math.max(0, expectedCents - billedCents),
        billedCents,
        partlyBilled: !replacedByBill && billedCents > 0,
        days,
        of,
        paidDay,
        replacedByBill,
        noPaidDay: basis === "cash" && paidDay === null,
      };
    });
}
