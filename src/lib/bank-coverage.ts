/**
 * What stretch of a month the bank lines on file actually cover.
 *
 * "All 70 bank lines are accounted for" reads as a statement about the month. For October 2026 the only bank record is the Emprise export
 * of 15 October (2 to 15 Oct), and nothing after it exists to be had ("I dont have another file for october, going to have to use what we
 * have"). So the lines can all be placed and the month still has a fortnight with no bank record, and the books should say so rather than
 * let a count stand in for the month. It is said, not asked for: the owner has none to supply, and a month that waits on a file that does not
 * exist never closes.
 *
 * Pure.
 */

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** A statement that ends within this many days of month end covers the month: the last days of a month often have no posting. */
export const TOLERANCE_DAYS = 4;

export type BankCoverage = { first: string; last: string; coversMonth: boolean; says: string };

const label = (iso: string) => {
  const m = new Date(`${iso}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${Number(iso.slice(8, 10))} ${m}`;
};

/** Null where there are no lines at all. */
export function bankCoverage(month: string, lineDates: string[], monthEnd: string): BankCoverage | null {
  const inMonth = lineDates.filter((d) => d.startsWith(month)).sort();
  if (inMonth.length === 0) return null;
  const first = inMonth[0];
  const last = inMonth[inMonth.length - 1];
  const coversMonth = last >= addDays(monthEnd, -TOLERANCE_DAYS);
  return {
    first,
    last,
    coversMonth,
    says: coversMonth
      ? `${label(first)} to ${label(last)}`
      : `${label(first)} to ${label(last)}; there is no bank record after ${label(last)}, so ${label(addDays(last, 1))} to ${label(monthEnd)} is not proved against the bank`,
  };
}
