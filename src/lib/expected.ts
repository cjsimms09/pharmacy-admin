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

import { learnCadence } from "./cadence-learn";

export type Cadence =
  | { kind: "daily"; skipSundays?: boolean }
  | { kind: "weekly"; weekday: number }
  /** Monthly, arriving after the period it covers closes: `dayOfMonth` is the day it is due in the following month. */
  | { kind: "monthly"; dayOfMonth: number }
  /** Twice a month — IPD's statement, the wholesaler's half-month cut. */
  | { kind: "semimonthly"; days: [number, number] }
  /** No calendar: it comes when an event happens. Never late, only "last seen". */
  | { kind: "on_event"; says: string }
  /**
   * No calendar, but a measured rhythm: the usual gap, and the longest the sender normally goes.
   *
   * Only `cadence-learn.ts` produces this, and only from a sender's own arrivals. It is how a
   * voucher remittance or a wholesaler credit gets judged without inventing a date nobody promised:
   * past the usual gap is "due", past the longest it normally goes is "stopped".
   */
  | { kind: "irregular"; typicalDays: number; longestDays: number };

export type ExpectedState = "arriving" | "not_yet_due" | "due_now" | "overdue" | "never_arrived" | "not_expected";

export type Expectation = {
  key: string;
  label: string;
  /** Who sends it. Named, because "chase it" is useless without this. */
  from: string;
  /** What breaks in the books without it — one clause, in his words where he has given them. */
  whyItMatters: string;
  /**
   * What this was expected to do before anybody measured it. A fallback, not the answer.
   *
   * Where `arrivals` holds enough history, the rhythm measured from it wins and this is not used at
   * all. It survives for the rows that have never arrived — which cannot be measured by definition,
   * and are exactly the rows that matter most.
   */
  cadence: Cadence;
  /**
   * Every arrival on file, so the rhythm can be measured rather than declared.
   *
   * The owner: "this tool needs to be smart and know when to expect things.. and adjust as needed".
   * Ten arrivals of McKesson's drill-down say more about McKesson's rhythm than any number typed
   * into this file, and they keep saying it better as more arrive. See `cadence-learn.ts`.
   */
  arrivals?: string[];
  /**
   * The hour of the day this normally arrives, measured from its own arrivals.
   *
   * The owner, 17 September 2026, looking at three rows marked Due: "whats wrong?? you havent gotten
   * claims?" Nothing was wrong. Two of the three were the page measuring a day against a calendar and
   * ignoring the clock.
   *
   * The Rx transaction report runs at 23:31 every night. Judged on the day alone, today's is "due"
   * from one minute past midnight and stays amber through the whole working day, every day, until it
   * arrives after he has gone home. A row that is amber all day and green while nobody is looking is
   * not telling anyone anything.
   *
   * So a daily feed is not due until the hour it usually comes has passed. Measured, like the rhythm
   * itself — nothing is typed here, and a feed with no measurable hour is judged on the day as before.
   */
  arrivesByHour?: number | null;
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
  /**
   * Counted by the event that owes the document, not by the calendar. Supplier invoices.
   *
   * The owner, 16 September 2026: "we are getting receipts from pioneer. so for invoices it should
   * use those for alerts.. but only on companies that are set to receive invoices". A wholesaler's
   * silence says nothing on its own — no delivery, no invoice, nothing wrong. What says something is
   * a delivery booked in at the counter with no invoice behind it: then the document exists and the
   * pharmacy has not got it.
   *
   * Where this is set it settles the verdict outright, because no number of days elapsed can
   * improve on knowing exactly how many documents are outstanding.
   */
  owing?: { outstanding: number; of: number; says: string };
  /**
   * Messages this sender sent that the site turned away at the door.
   *
   * On 15 September 2026 Veridikal sent both of its monthly reports. The mailbox refused both —
   * .xlsx on the extension list, `application/x-msexcel` not on the type list — and this page then
   * told the owner Veridikal had never sent anything. Two true statements, one screen, and the
   * conclusion it invited was to go and chase a sender who had done nothing wrong.
   *
   * A document that arrived and was refused is the opposite of one that never came: the fault is
   * here, and nobody outside this building can fix it. It must never be able to read as absence.
   */
  refused?: { count: number; last: string; why: string };
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
  /** The cadence actually used — measured where there was enough history, declared where there was not. */
  using: Cadence;
  /**
   * Which of the two it is, said out loud on every row.
   *
   * A measured rhythm and a typed one look identical once they are both a date on a screen, and only
   * one of them is evidence. Rule 6: ask what the number would make him do. "Overdue since the 5th"
   * should make him ring the bank; it should not, if the 5th was a number I invented.
   */
  basis: "measured" | "declared";
  /** How the rhythm was arrived at, for the row: "Measured: 10 arrivals, 80% on a Monday." */
  basisSays: string;
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
    /*
     * An irregular rhythm is counted from the last arrival, not from the calendar, so it is judged
     * in `judge` where that date is known. Here it has no calendar answer, and saying so is right.
     */
    case "irregular":
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
    case "irregular":
      return `no fixed date — usually every ${c.typicalDays} day${c.typicalDays === 1 ? "" : "s"}, not normally beyond ${c.longestDays}`;
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
export function judge(e: Expectation, today: string, nowHour: number | null = null): Judged {
  /*
   * Measured beats declared, every time there is enough to measure.
   *
   * The declared cadence is mine; the measured one is the sender's. Where the arrivals can answer
   * the question, the number I typed has no business overriding them — and as more arrive the
   * answer sharpens without anybody editing this file.
   */
  const learned = learnCadence(e.arrivals ?? []);
  const using = learned?.cadence ?? e.cadence;
  const basis: "measured" | "declared" = learned ? "measured" : "declared";
  const basisSays =
    learned?.says ??
    (e.arrivals?.length
      ? `Declared, not measured: ${e.arrivals.length} arrival${e.arrivals.length === 1 ? "" : "s"} on file is too few to read a rhythm from.`
      : "Declared, not measured: nothing has ever arrived, so there is no rhythm to read.");

  /*
   * Today's is not due until the hour it usually arrives has passed.
   *
   * Only for a daily feed, and only where its own arrivals say what that hour is. The effect is that
   * a report which reliably lands at 23:31 stops being "due" at nine in the morning — its due date is
   * yesterday's until tonight, which is the truth and is also the only version of it that says
   * anything when he looks.
   */
  const dueDay = (() => {
    const d = dueDates(using, today);
    if (using.kind !== "daily" || e.arrivesByHour === null || e.arrivesByHour === undefined || nowHour === null) return d;
    if (nowHour >= e.arrivesByHour || d.last === null) return d;
    /* Before the hour: the most recent one owed is the previous run, not today's. */
    const previous = dueDates(using, iso(parse(d.last) - DAY));
    return { last: previous.last, next: d.last };
  })();
  const { last, next } = dueDay;
  const lastDay = e.lastAt ? e.lastAt.slice(0, 10) : null;
  /*
   * One lateness, used by the verdict and by the figure beside it.
   *
   * For a daily feed it is days since it last came, less the run not yet owed; for everything else it
   * is days past the date it was due. Computed once, because the first version had the state saying
   * "stopped" and the number beside it saying "1 day" — two answers to one question, from two
   * formulas, on the same row.
   */
  const lateDays =
    using.kind === "daily"
      ? lastDay
        ? Math.max(0, daysBetween(lastDay, today) - 1)
        : null
      : last
        ? daysBetween(last, today)
        : null;
  const base = { ...e, using, basis, basisSays, dueOn: last, nextDueOn: next, daysLate: lateDays };

  if (!e.expected) {
    return { ...base, state: "not_expected", says: e.note ?? "Not expected here, so nothing is waiting on it." };
  }

  /*
   * Turned away at the door beats every other verdict, including "never arrived".
   *
   * Checked before anything else because it is the only state whose remedy is here rather than with
   * the sender, and because the verdict it displaces — absence — would send him to chase somebody
   * who did their part.
   */
  if (e.refused && e.refused.count > 0) {
    return {
      ...base,
      state: "overdue",
      says:
        `${e.from} sent ${e.refused.count === 1 ? "this" : `${e.refused.count} of these`}, most recently ${e.refused.last.slice(0, 10)}, ` +
        `and the site turned ${e.refused.count === 1 ? "it" : "them"} away: ${e.refused.why} Nothing is wrong at their end. ` +
        /*
         * The remedy, on the row, because the obvious one does not work.
         *
         * A refused attachment is never stored — the refusal happens before storing — so there are
         * no bytes to read again, and the sweep reads only unread mail AND skips any message id it
         * has already recorded. Marking the original unread therefore does nothing at all, which is
         * exactly the sort of instruction that costs somebody an afternoon. A forward carries a new
         * message id, so it comes in clean and is read with today's rules.
         */
        `Forward the message to the pharmacy mailbox again and it will be read — marking the original unread will not work, ` +
        `because the sweep has already recorded that message.`,
    };
  }

  /*
   * Counted, not timed. Nothing outstanding is silence, however long ago the last one was.
   *
   * This is the ANDA rule, and it is silent by construction rather than by a threshold somebody has
   * to keep tuning: a supplier that has not delivered owes nothing, so its row says so and stops.
   */
  if (e.owing) {
    const { outstanding, of, says } = e.owing;
    return {
      ...base,
      dueOn: null,
      nextDueOn: null,
      daysLate: null,
      state: outstanding === 0 ? "arriving" : "overdue",
      says:
        outstanding === 0
          ? `Nothing outstanding. All ${of} deliver${of === 1 ? "y" : "ies"} PioneerRx booked in ${of === 1 ? "has" : "have"} an invoice behind ${of === 1 ? "it" : "them"}, so their silence since is not a gap.`
          : `${outstanding} deliver${outstanding === 1 ? "y" : "ies"} of ${of} with no invoice behind ${outstanding === 1 ? "it" : "them"}. ${says}`,
    };
  }
  if (e.startsOn && parse(today) < parse(e.startsOn) && !lastDay) {
    return { ...base, state: "not_yet_due", says: `Not expected before ${e.startsOn}. ${e.note ?? ""}`.trim() };
  }
  if (!lastDay || e.everCount === 0) {
    return {
      ...base,
      state: "never_arrived",
      says: `Never arrived — not once. ${e.from} ${using.kind === "on_event" ? "has sent nothing" : `should send ${cadenceWords(using)}`}, and nothing has been set up for it.`,
    };
  }

  /*
   * A measured rhythm with no calendar, judged from the last arrival rather than from a date.
   *
   * "Usually every 9 days, never longer than 19" is a real statement about a real sender, and it
   * answers the only question being asked of an irregular one: has this stopped. Past the usual gap
   * is due; past the longest it has ever taken, plus the grace, is stopped. No invented date.
   */
  if (using.kind === "irregular") {
    const quiet = daysBetween(lastDay, today);
    const usual = Math.max(1, using.typicalDays);
    const outside = using.longestDays + e.graceDays;
    const nextExpected = iso(parse(lastDay) + usual * DAY);
    const irr = { ...base, dueOn: nextExpected, nextDueOn: nextExpected, daysLate: quiet - usual };
    if (quiet <= usual) {
      return { ...irr, state: "arriving", says: `Last one ${lastDay}, ${quiet} day${quiet === 1 ? "" : "s"} ago. This sender usually goes ${usual} days between, so the next is due about ${nextExpected}.` };
    }
    if (quiet <= outside) {
      return { ...irr, state: "due_now", says: `Nothing for ${quiet} days, and this sender usually goes ${usual}. Still inside the ${using.longestDays} days it normally stays within, so it is due rather than stopped.` };
    }
    return { ...irr, state: "overdue", says: `Nothing for ${quiet} days. This sender does not normally go beyond ${using.longestDays}, so it has stopped, or it is going somewhere else.` };
  }

  if (using.kind === "on_event") {
    return { ...base, state: "arriving", says: `Last one ${lastDay}. ${capitalise(using.says)}, so there is no date to be late against.` };
  }
  if (!last) return { ...base, state: "arriving", says: `Last one ${lastDay}.` };

  /*
   * The early allowance is a share of the period, never a flat five days.
   *
   * Five days is right for a monthly statement, where arriving on the 3rd for the 5th is ordinary.
   * On a daily feed it is absurd: the card batch of the 14th was covering the run of the 16th, so two
   * days of silence read as "arriving" and the missing batch of the 15th vanished off the screen.
   * A third of the period, capped at five: nought for a daily feed, two for a weekly one.
   */
  const period = using.kind === "daily" ? 1 : using.kind === "weekly" ? 7 : using.kind === "semimonthly" ? 15 : 30;
  const early = Math.min(e.earlyDays ?? 5, Math.floor(period / 3));
  if (parse(lastDay) >= parse(last) - early * DAY) {
    return { ...base, state: "arriving", says: `Arrived ${lastDay} for the ${last} run${next ? `; next due ${next}` : ""}.` };
  }
  /*
   * Nothing is accused of having stopped on a rhythm nobody measured.
   *
   * The owner, 16 September 2026: "needs to not alert me to dumb things.. mckesson is about the only
   * invoice we receive daily.. dont alert me we havent gotten an anda invoice in 7 days". The general
   * form of that is this rule. To say a sender has stopped is to say it broke its own habit, and a
   * habit I typed into a file is not its habit. Where the arrivals were too few to measure, the worst
   * this will say is that something is due — which is a note, not an accusation.
   *
   * It costs nothing real: a sender with enough history to be worth chasing has enough history to be
   * measured, and the ones without it are exactly the ANDAs.
   */
  /*
   * For a daily feed, lateness is days since it last came — not days since the last date it was due.
   *
   * Found by a test asserting that a nightly feed silent since the 13th should read as stopped on the
   * 17th. It did not, and could not: a daily feed is due every day, so the most recent due date is
   * always today or yesterday and "days since the due date" is never more than one. With a day of
   * grace, **a daily feed could never be reported as stopped at all** — the claims export could go
   * quiet for a week and the row would say "due" every morning, exactly as it says on a normal day.
   *
   * The one shape where the calendar answers the wrong question, because it is the one where the
   * calendar has a date every day. Counted from the last arrival, less the run not yet owed.
   */
  const late = lateDays ?? 0;
  if (late <= e.graceDays || basis === "declared") {
    return {
      ...base,
      state: "due_now",
      says:
        late > e.graceDays
          ? `Due ${last}, ${late} days ago, and the last one was ${lastDay}. Nothing stronger is said than that: ${e.from} has not sent often enough for the site to know its habits, so it cannot be told it broke one.`
          : `Due ${last}, and ${late === 0 ? "today is that day" : `${late} day${late === 1 ? "" : "s"} past it`} — inside the ${e.graceDays} days allowed. Last one ${lastDay}.`,
    };
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

export function judgeAll(list: Expectation[], today: string, nowHour: number | null = null): Judged[] {
  return list.map((e) => judge(e, today, nowHour)).sort((a, b) => RANK[a.state] - RANK[b.state] || (b.daysLate ?? -999) - (a.daysLate ?? -999) || a.label.localeCompare(b.label));
}

/** The one-line summary for the tab itself: what a person needs to know without opening it. */
export function expectedSummary(judged: Judged[]): { overdue: number; dueNow: number; never: number; arriving: number; measured: number; says: string } {
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
  return { overdue, dueNow, never, arriving, measured: judged.filter((j) => j.basis === "measured").length, says: parts.join(", ") };
}
