/**
 * The rules a feed is judged by. Pure, so they are tested without a database.
 *
 * A feed is late when its newest arrival is older than the longest silence its cadence allows —
 * a daily report gets two days and a bit so a closed Sunday is not a false alarm, a Monday file
 * gets nine days for a bank holiday. It is never judged from a job's own claim to have run: the
 * newest row in the table it fills is the only evidence that counts.
 */

export type FeedState = "on_time" | "late" | "never" | "off" | "broken" | "unproven";

export function judgeFeed(a: { maxQuietHours: number; lastAt: string | null; now: Date; enabled: boolean }): FeedState {
  if (!a.enabled) return "off";
  if (!a.lastAt) return "never";
  const t = Date.parse(a.lastAt.length === 10 ? `${a.lastAt}T23:59:59Z` : a.lastAt);
  if (Number.isNaN(t)) return "never";
  const ageHours = (a.now.getTime() - t) / 3_600_000;
  return ageHours > a.maxQuietHours ? "late" : "on_time";
}

/**
 * The days between `from` and `to` (inclusive) that carry nothing.
 *
 * Sundays are left out: this pharmacy is closed, and a day it never dispenses on is not a
 * missing report. A Saturday with nothing is listed — it may be a half day, but it is an open one.
 */
export function missingDays(present: string[], from: string, to: string): string[] {
  const have = new Set(present.map((d) => d.slice(0, 10)));
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (d.getTime() <= end) {
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && !have.has(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** In words, for a badge: "today", "yesterday", "3 days ago", "never". */
export function agoWords(lastAt: string | null, now: Date): string {
  if (!lastAt) return "never";
  const t = Date.parse(lastAt.length === 10 ? `${lastAt}T12:00:00Z` : lastAt);
  if (Number.isNaN(t)) return "never";
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** How long the facilitator's feed may go without a pull that worked before it is called stopped. */
export const MTF_QUIET_DAYS = 14;

/**
 * How the facilitator's pull is judged.
 *
 * Its payments come in bursts and some months not at all, so the newest payment says nothing about whether the channel works; the
 * evidence is a pull that worked. The pull is tried about once a day and each try looks three weeks back, so one that fails loses
 * nothing and a long run of them loses money. The clock is therefore the last pull that worked. A pull that failed does not move it,
 * and the feed is called stopped, as before, after `MTF_QUIET_DAYS` without one. What a failure does is get said, in words, beside the
 * badge, so a green badge never sits over a pull that is not working. Before any pull has been recorded as working the clock is the
 * newest payment received, as it was.
 */
export function mtfPull(a: { lastOk: string | null; lastFailed: string | null; lastResult: string | null; newestPaymentOn: string | null; now: Date }): {
  clockAt: string | null;
  failing: boolean;
  says: string;
} {
  const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  const failing = a.lastFailed !== null && (a.lastOk === null || a.lastFailed > a.lastOk);
  const last = `Last pull: ${sentence(a.lastResult ?? "never")}`;
  const worked = a.lastOk
    ? `The last pull that worked was ${agoWords(a.lastOk, a.now)}; this feed is called stopped after ${MTF_QUIET_DAYS} days without one.`
    : a.newestPaymentOn
      ? `No pull has been recorded as working yet, so this feed is judged on its newest payment, and is called stopped after ${MTF_QUIET_DAYS} days without one.`
      : "No pull has been recorded as working yet, and no payment has arrived through it.";
  return {
    clockAt: a.lastOk ?? a.newestPaymentOn,
    failing,
    says: failing ? `${last} ${worked}` : last,
  };
}
