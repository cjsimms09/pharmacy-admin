/**
 * How old the daily count is, and whether that matters.
 *
 * The balance-on-hand report is the one file that arrives every day, and almost everything that
 * spends money reads it: what to order, how deep to buy, what is surplus, what the shelf is worth
 * in the accounts. Nothing on any of those screens said how old it was. A count from last Tuesday
 * looks exactly like this morning's, and an order placed against it either buys a second bottle of
 * something that landed on Wednesday or misses a line that has since run out.
 *
 * So the age is stated wherever the count is spent, in days, with what it means.
 *
 * ── Where the line falls ──
 *
 * Two days. One day old is normal: the report runs overnight and the pharmacy opens before anyone
 * looks. At two the shelf has taken a full day of dispensing and, usually, a delivery, and the
 * figures on the screen are no longer the figures on the shelf.
 */

export type CountAge = {
  /** Days between the count and today. */
  days: number;
  /** "today" and "yesterday" need no action; "stale" does. */
  state: "today" | "yesterday" | "stale";
  /** How old it is, in a phrase that can be dropped into a sentence. */
  says: string;
  /** What being this old means for the figures, or null where it means nothing. */
  warns: string | null;
};

const day = 86_400_000;

/** Whole days from one ISO date to another. */
function daysApart(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / day);
}

/**
 * What to say about a count taken on `countedOn`, as of `today`.
 *
 * A count dated ahead of today is treated as today's rather than reported as negative days: it
 * means the report ran on the pharmacy's clock and the site is reading a different one, which is
 * not something to put in front of anybody.
 */
export function countAge(countedOn: string, today: string): CountAge {
  const days = Math.max(0, daysApart(countedOn, today));
  if (days === 0) return { days, state: "today", says: "counted this morning", warns: null };
  if (days === 1) return { days, state: "yesterday", says: "counted yesterday", warns: null };
  return {
    days,
    state: "stale",
    says: `counted ${days} days ago`,
    warns:
      `The shelf has taken ${days} days of dispensing and any delivery since. What is on these screens is ` +
      `the shelf as it stood then, so an order built from it can buy a second bottle of something that has ` +
      `already landed. Upload today's count first.`,
  };
}
