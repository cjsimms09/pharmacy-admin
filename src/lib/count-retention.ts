/**
 * Which daily counts to keep, and which have done their job.
 *
 * The balance-on-hand report arrives every day and is 2,239 items. A year of them is eight hundred
 * thousand rows for a question almost nobody asks: what the shelf held on a Tuesday in March. The
 * site already learned what a large table does to it — the NADAC benchmark had grown to a million
 * and a half rows and made every page take fourteen seconds — and this one grows the same way, only
 * slower and with less reason.
 *
 * ── What is actually needed ──
 *
 * Two things, and only two.
 *
 * Today's count, because everything that spends money reads it: what to order, how deep, what is
 * surplus, what the shelf is worth.
 *
 * And the last count of each month, because the accounts close on it. The cost of goods is opening
 * stock plus purchases less closing stock, and that is the one genuinely independent check on the
 * gross profit the claims report — so a month whose closing count has been thrown away is a month
 * whose figures cannot be checked against anything.
 *
 * Everything between those is a snapshot of a shelf that has since moved.
 *
 * ── The week that is kept anyway ──
 *
 * A count is also kept if it is within the last week. Not because anything reads it, but because
 * the wrong file gets uploaded sometimes, and a rule that deleted yesterday the moment today landed
 * would make that unrecoverable. A week of daily counts is fifteen thousand rows, which is nothing,
 * and it is the difference between an annoyance and a lost month.
 */

/** How many days of daily counts are kept regardless, as a way back from a bad upload. */
export const KEEP_RECENT_DAYS = 7;

const day = 86_400_000;

function daysApart(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / day);
}

export type Retention = {
  /** The dates to keep, oldest first. */
  keep: string[];
  /** The dates whose rows can go, oldest first. */
  drop: string[];
  /** Why each kept date is kept, for a screen that has to explain itself. */
  why: Map<string, "recent" | "month end">;
};

/**
 * Sorts the counts held into the ones to keep and the ones to drop.
 *
 * The newest count in any month is that month's closing position, so the newest count overall is
 * always kept — even where it is months old, because a pharmacy that has not uploaded since June
 * must not have June deleted for being stale. There is no case in which this empties the table.
 */
export function countsToKeep(dates: string[], today: string, recentDays = KEEP_RECENT_DAYS): Retention {
  const sorted = [...new Set(dates)].sort();
  // The last count in each calendar month: the position the accounts for that month close on.
  const lastOfMonth = new Map<string, string>();
  for (const d of sorted) lastOfMonth.set(d.slice(0, 7), d);
  const monthEnds = new Set(lastOfMonth.values());

  const keep: string[] = [];
  const drop: string[] = [];
  const why = new Map<string, "recent" | "month end">();
  for (const d of sorted) {
    const recent = daysApart(d, today) < recentDays;
    if (monthEnds.has(d)) {
      keep.push(d);
      // A date that is both is named as the month's end, because that is the reason it is permanent.
      why.set(d, "month end");
    } else if (recent) {
      keep.push(d);
      why.set(d, "recent");
    } else {
      drop.push(d);
    }
  }
  return { keep, drop, why };
}

/** What the rule does, in a sentence a person can check against what they see. */
export function retentionRule(): string {
  return (
    `Every count from the last ${KEEP_RECENT_DAYS} days is kept, and the last count of every month is kept for good ` +
    `because the accounts close on it. The days in between are removed once they are older than that — they are a ` +
    `picture of a shelf that has since moved.`
  );
}
