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
 * newest payment received, and the sentence says so whether or not a pull has failed: a clock that has not been measured yet is
 * said to be unmeasured, and is not left to read as one that was.
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
    says: failing || a.lastOk === null ? `${last} ${worked}` : last,
  };
}

/** CMS ends an MTF API key this many days after it is made. */
export const MTF_KEY_LIFE_DAYS = 90;

/**
 * How long the stored key has left, counted from the day on record for it.
 *
 * CMS expires MTF API keys 90 days after generation and gives no notice. A scheduled pull would
 * simply start failing. The day on record is the day the key was pasted in, unless a day was
 * entered for it by hand. A key pasted in some days after it was made has a real deadline
 * earlier than this count says, so the count errs late by those days, not early; it is right to
 * the day when the key is stored as it is made. Zero is the day it lapses; below zero it already
 * has. No day on record, one that is not a date, one that does not exist (30 February), or one
 * that has not come yet is null: the key's age has not been measured, and callers say so.
 */
export function keyDaysLeft(setOn: string | null, today = new Date().toISOString().slice(0, 10)): number | null {
  const m = setOn ? /^\d{4}-\d{2}-\d{2}/.exec(setOn) : null;
  if (!m) return null;
  const from = Date.parse(`${m[0]}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  if (new Date(from).toISOString().slice(0, 10) !== m[0] || from > to) return null;
  return MTF_KEY_LIFE_DAYS - Math.floor((to - from) / 86_400_000);
}

/**
 * What to say about a day typed in for the key, before it is saved: nothing when it is empty (that
 * clears the record) or a usable day, and a plain instruction when it is not. The judge is
 * keyDaysLeft, the same function the feed reads it with, so a day this accepts is a day the feed
 * can count from, and one it refuses is one the feed would have called not on record.
 */
export function keyMadeOnProblem(typed: string, today?: string): string | null {
  if (typed === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(typed) && keyDaysLeft(typed, today) !== null) return null;
  return "Write the day the key was made as year-month-day, for example 2026-01-31. It has to be a day that exists and has already come.";
}

/**
 * What the facilitator feed says of its key: nothing until two weeks are left, then the days, and
 * once the count has gone below zero that the key has run out. It must not print the count there,
 * where "expires in -7 days" was the sentence for a key that had already lapsed.
 */
export function keyExpirySays(left: number | null): string | null {
  if (left === null || left > 14) return null;
  if (left > 0) return `The API key expires in ${left} ${left === 1 ? "day" : "days"}.`;
  if (left === 0) return "The API key expires today.";
  return `The API key is dated ${MTF_KEY_LIFE_DAYS - left} days ago and CMS ends a key ${MTF_KEY_LIFE_DAYS} days after it is made, so it has run out; a new one has to be made at CMS and stored on the Connections page.`;
}

/**
 * What the facilitator feed says of its key's age. A key is stored and no usable day is on record
 * for it: its age has never been measured, which is not the same as a long time left, and the
 * feed says so and names what settles it. Both acts named are on the Connections page, which shows
 * the MTF card whenever a key is stored. Without a key there is no age to say; the feed has its own
 * sentence for that.
 */
export function keyAgeSays(hasKey: boolean, setOn: string | null, today?: string): string | null {
  if (!hasKey) return null;
  const left = keyDaysLeft(setOn, today);
  if (left === null) {
    return `The day this key was made is not on record, so the site cannot say how long it has left. CMS ends a key ${MTF_KEY_LIFE_DAYS} days after it is made and gives no warning. Enter the day on the Connections page, or make a new key at CMS and store it there, which records the day.`;
  }
  return keyExpirySays(left);
}

/** The figures over the feed list. A row that nothing is expected to arrive on is counted beside the others, not among those that did not arrive. */
export function arrivalCounts(states: FeedState[]): { onTime: number; expected: number; notProved: number; off: number } {
  const count = (s: FeedState) => states.filter((x) => x === s).length;
  const off = count("off");
  const notProved = count("unproven");
  return { onTime: count("on_time"), expected: states.length - off - notProved, notProved, off };
}

/** The line under the number of feeds that arrived on time: out of those switched on, with the ones nothing could prove beside that, not inside it. */
export function arrivalSaid(c: { expected: number; notProved: number }): string {
  return `of ${c.expected} switched on${c.notProved > 0 ? `; ${c.notProved} more ${c.notProved === 1 ? "is" : "are"} not proved` : ""}`;
}

/** The notice after a live check, naming only the rows that were checked, so it cannot claim a check that had no key or account to run with. */
export function liveChecksSaid(ran: string[]): string {
  if (ran.length === 0) return "No live check ran, so no row was checked live.";
  const names = ran.length === 1 ? ran[0] : `${ran.slice(0, -1).join(", ")} and ${ran[ran.length - 1]}`;
  return `${ran.length === 1 ? "A live check ran" : "Live checks ran"} against ${names}. What ${ran.length === 1 ? "it" : "each"} said is on its row. No other row was checked live.`;
}
