/**
 * Everything the pharmacy expects somebody else to send it, how often, and whether it came.
 *
 * ── Why this is separate from `feeds.ts` ──
 *
 * `feeds.ts` asks whether the machinery is running: is the mailbox sweeping, did the claims export
 * land, is the backup taking. It judges every feed the same way — hours since the newest row,
 * against a ceiling. That rule cannot describe most of what this pharmacy waits on. A bank statement
 * is not late on the 16th; it does not exist yet. IPD's statement covers a half-month and comes
 * after it closes. Veridikal reports monthly. Judging those by "hours since" produces a screen that
 * is red for three weeks out of four and right for one, which is the same as a screen nobody reads.
 *
 * The owner, 16 September 2026: "you need to make a tab that tracks EVERYTHING we are expecting,
 * how often we expect it, and if we are receiving it, or last time we have.. this need to be smart,
 * IE shouldnt expect bank statement until end of month".
 *
 * So a cadence here is a calendar, not a duration. Each expectation can say the date it was last
 * due, and everything else follows from comparing that with the date it last arrived.
 *
 * ── The states, and why "missing" is not one ──
 *
 * CLAUDE.md clause 5. A thing that has never come and a thing that is one day late are different
 * facts with different answers, and the word "missing" hides which one you have:
 *
 *   arriving        came on or after the last date it was due
 *   not_yet_due     its next date has not arrived; nothing is wrong
 *   due_now         its date has passed, but inside the grace a real sender takes
 *   overdue         past its date and past grace, and it has come before, so somebody stopped
 *   never_arrived   expected, and not once has one come through. Not "late" — nothing to be late from
 *   not_expected    the pharmacy does not get this. A feed nobody switched on is not a failure
 *
 * `never_arrived` is deliberately not sorted as the worst thing on the page. A document that has
 * never once arrived usually needs somebody set up to send it, which is a job to do on a quiet
 * afternoon; a monthly statement that has stopped after four months is a thing that broke this week.
 *
 * Pure: `expected-store.ts` reads the arrivals and hands them here.
 */

export type Cadence =
  | { kind: "daily"; skipSundays?: boolean }
  | { kind: "weekly"; weekday: number }
  /** Monthly, arriving after the period it covers closes: `dayOfMonth` is the day it is due in the following month. */
  | { kind: "monthly"; dayOfMonth: number }
  /** Twice a month — IPD's statement, the wholesaler's half-month cut. */
  | { kind: "semimonthly"; days: [number, number] }
  /** No calendar: it comes when an event happens. Never late, only "last seen". */
  | { kind: "on_event"; says: string };

export type ExpectedState = "arriving" | "not_yet_due" | "due_now" | "overdue" | "never_arrived" | "not_expected";

export type Expectation = {
  key: string;
  label: string;
  /** Who sends it. Named, because "chase it" is useless without this. */
  from: string;
  /** What breaks in the books without it — one clause, in his words where he has given them. */
  whyItMatters: string;
  cadence: Cadence;
  /** Days after the due date a real sender may take before this is called overdue. */
  graceDays: number;
  /**
   * Days before the due date an arrival still counts for it. Default 5.
   *
   * Senders are early as often as they are late, and a due date is an estimate of theirs, not a
   * deadline of ours. Without this, August's bank statement arriving on 3 September reads as
   * overdue from 5 September — the document is on the site, in front of the person being told it
   * never came, which is the fastest way to lose a screen's credibility.
   */
  earlyDays?: number;
  /**
   * The first day this is expected at all. Before it, nothing is late.
   *
   * Two of these are real: Aytu's credit memos ("you will get them going forward", 15 September
   * 2026) and IPD moving to ACH on 1 October. A thing the pharmacy has arranged but not yet begun
   * receiving is not a failure, and must not sit in the same state as one that stopped.
   */
  startsOn?: string;
  /** Newest arrival, ISO date or timestamp. Null where none has ever come. */
  lastAt: string | null;
  /** How many have come, ever. Nought and `lastAt` null is `never_arrived`. */
  everCount: number;
  /** False where the pharmacy does not get this at all — then no date makes it late. */
  expected: boolean;
  /** A note of fact: "ACH only from 1 October", "the owner will not forward these". */
  note?: string;
  href: string;
};

export type Judged = Expectation & {
  state: ExpectedState;
  /** The most recent date it should have arrived by, or null for `on_event`. */
  dueOn: string | null;
  /** The next date one is due. Null for `on_event`. */
  nextDueOn: string | null;
  /** Days past the due date. Negative where it is not due yet. */
  daysLate: number | null;
  /** The whole judgement in a sentence, for the row. */
  says: string;
};

const DAY = 86_400_000;
const parse = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((parse(to) - parse(from)) / DAY);
const lastDayOf = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The day of a month a monthly thing is due, clamped: "the 31st" in February is the 28th or 29th. */
function onDay(year: number, month: number, day: number): string {
  const d = Math.min(day, lastDayOf(year, month));
  return iso(Date.UTC(year, month, d));
}

/**
 * The most recent date this should have arrived by, on or before `today`, and the next one after it.
 *
 * `on_event` has neither: a supplier invoice arrives when a delivery does, and no calendar says when
 * that is. Calling one late on a day nothing was ordered is the error this avoids.
 */
export function dueDates(c: Cadence, today: string): { last: string | null; next: string | null } {
  const t = parse(today);
  switch (c.kind) {
    case "on_event":
      return { last: null, next: null };
    case "daily": {
      if (!c.skipSundays) return { last: today, next: iso(t + DAY) };
      const back = new Date(t);
      while (back.getUTCDay() === 0) back.setUTCDate(back.getUTCDate() - 1);
      const fwd = new Date(t + DAY);
      while (fwd.getUTCDay() === 0) fwd.setUTCDate(fwd.getUTCDate() + 1);
      return { last: iso(back.getTime()), next: iso(fwd.getTime()) };
    }
    case "weekly": {
      const dow = new Date(t).getUTCDay();
      const backBy = (dow - c.weekday + 7) % 7;
      const last = iso(t - backBy * DAY);
      return { last, next: iso(parse(last) + 7 * DAY) };
    }
    case "monthly": {
      const d = new Date(t);
      const here = onDay(d.getUTCFullYear(), d.getUTCMonth(), c.dayOfMonth);
      if (parse(here) <= t) {
        return { last: here, next: onDay(d.getUTCFullYear(), d.getUTCMonth() + 1, c.dayOfMonth) };
      }
      return { last: onDay(d.getUTCFullYear(), d.getUTCMonth() - 1, c.dayOfMonth), next: here };
    }
    case "semimonthly": {
      const d = new Date(t);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const all = [
        onDay(y, m - 1, c.days[0]),
        onDay(y, m - 1, c.days[1]),
        onDay(y, m, c.days[0]),
        onDay(y, m, c.days[1]),
        onDay(y, m + 1, c.days[0]),
        onDay(y, m + 1, c.days[1]),
      ].sort();
      const past = all.filter((x) => parse(x) <= t);
      const ahead = all.filter((x) => parse(x) > t);
      return { last: past[past.length - 1] ?? null, next: ahead[0] ?? null };
    }
  }
}

/** The cadence in words, for the row. */
export function cadenceWords(c: Cadence): string {
  switch (c.kind) {
    case "daily":
      return c.skipSundays ? "every day the pharmacy is open" : "every day";
    case "weekly":
      return `every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][c.weekday]}`;
    case "monthly":
      return `monthly, due about the ${ordinal(c.dayOfMonth)}`;
    case "semimonthly":
      return `twice a month, the ${ordinal(c.days[0])} and the ${ordinal(c.days[1])}`;
    case "on_event":
      return c.says;
  }
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * One expectation against the calendar.
 *
 * The order of the tests is the whole design. `not_expected` first, because a thing the pharmacy
 * does not receive cannot be late however old it is. Then `never_arrived`, because a thing with no
 * arrivals has no "since" to measure and reporting it as "48 days late" invents a date it was
 * working. Only then does the calendar get used, and only for things that have a calendar.
 */
export function judge(e: Expectation, today: string): Judged {
  const { last, next } = dueDates(e.cadence, today);
  const lastDay = e.lastAt ? e.lastAt.slice(0, 10) : null;
  const base = { ...e, dueOn: last, nextDueOn: next, daysLate: last ? daysBetween(last, today) : null };

  if (!e.expected) {
    return { ...base, state: "not_expected", says: e.note ?? "Not expected here, so nothing is waiting on it." };
  }
  if (e.startsOn && parse(today) < parse(e.startsOn) && !lastDay) {
    return { ...base, state: "not_yet_due", says: `Not expected before ${e.startsOn}. ${e.note ?? ""}`.trim() };
  }
  if (!lastDay || e.everCount === 0) {
    return {
      ...base,
      state: "never_arrived",
      says: `Never arrived — not once. ${e.from} ${e.cadence.kind === "on_event" ? "has sent nothing" : `should send ${cadenceWords(e.cadence)}`}, and nothing has been set up for it.`,
    };
  }
  if (e.cadence.kind === "on_event") {
    return { ...base, state: "arriving", says: `Last one ${lastDay}. ${capitalise(e.cadence.says)}, so there is no date to be late against.` };
  }
  if (!last) return { ...base, state: "arriving", says: `Last one ${lastDay}.` };

  const early = e.earlyDays ?? 5;
  if (parse(lastDay) >= parse(last) - early * DAY) {
    return { ...base, state: "arriving", says: `Arrived ${lastDay} for the ${last} run${next ? `; next due ${next}` : ""}.` };
  }
  const late = daysBetween(last, today);
  if (late <= e.graceDays) {
    return { ...base, state: "due_now", says: `Due ${last}, and ${late === 0 ? "today is that day" : `${late} day${late === 1 ? "" : "s"} past it`} — inside the ${e.graceDays} days ${e.from} usually takes. Last one ${lastDay}.` };
  }
  return { ...base, state: "overdue", says: `Due ${last}, ${late} days ago, and the last one was ${lastDay}. ${e.from} has stopped or it is going somewhere else.` };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Worst first, and "never arrived" deliberately below "overdue".
 *
 * A monthly statement that stopped in August is news; a report nobody has ever set up is a task.
 * Sorting the second above the first puts the permanent list at the top of the screen for ever,
 * which is how a list stops being read.
 */
const RANK: Record<ExpectedState, number> = { overdue: 0, due_now: 1, never_arrived: 2, arriving: 3, not_yet_due: 4, not_expected: 5 };

export function judgeAll(list: Expectation[], today: string): Judged[] {
  return list.map((e) => judge(e, today)).sort((a, b) => RANK[a.state] - RANK[b.state] || (b.daysLate ?? -999) - (a.daysLate ?? -999) || a.label.localeCompare(b.label));
}

/** The one-line summary for the tab itself: what a person needs to know without opening it. */
export function expectedSummary(judged: Judged[]): { overdue: number; dueNow: number; never: number; arriving: number; says: string } {
  const n = (s: ExpectedState) => judged.filter((j) => j.state === s).length;
  const overdue = n("overdue");
  const dueNow = n("due_now");
  const never = n("never_arrived");
  const arriving = n("arriving");
  const parts = [
    overdue ? `${overdue} overdue` : null,
    dueNow ? `${dueNow} due now` : null,
    never ? `${never} never once arrived` : null,
    `${arriving} arriving on time`,
  ].filter(Boolean);
  return { overdue, dueNow, never, arriving, says: parts.join(", ") };
}
