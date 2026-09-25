/**
 * Working out when a sender actually sends, from the dates they have actually sent.
 *
 * ── Why the declared cadence is not good enough ──
 *
 * The owner, 16 September 2026: "this tool needs to be smart and know when to expect things.. and
 * adjust as needed".
 *
 * The first version of the expectations page carried a cadence per row, typed by hand — the bank
 * statement due about the 5th, Veridikal about the 15th, RedSail "cadence not settled". Every one of
 * those numbers was a guess of mine dressed as a fact, and three of them were admissions that I had
 * no idea. A guess typed into a table is worse than no number at all: it produces a red mark on a
 * day nothing was owed, and the cost is not the wrong pixel, it is that the next red mark is ignored
 * too.
 *
 * But the pharmacy holds the answer already. McKesson's drill-down has arrived ten times; the dates
 * of those ten arrivals say what McKesson's rhythm is far better than anything I would type. So the
 * rhythm is measured from the arrivals, the declared cadence becomes a fallback for senders with too
 * little history to measure, and every row says which of the two it is using. As more arrive the
 * measurement sharpens on its own — that is the "adjust as needed".
 *
 * ── What it will not do ──
 *
 * It will not invent a pattern out of three arrivals that happen to be a week apart. A pattern
 * claimed from too little evidence is the same fault as a guess, wearing a measurement's clothes.
 * Below the thresholds here it returns null and the row falls back to what was declared, saying so.
 *
 * And where the gaps are genuinely irregular — a wholesaler credit, a voucher remittance — it does
 * NOT force them into a calendar. It reports the rhythm as a range: the usual gap, and the longest
 * the sender normally goes. That is enough to answer the only question being asked, which is "has
 * this stopped", without pretending to a date the sender never promised.
 *
 * Pure. `expected.ts` judges with it; `expected-store.ts` feeds it the arrival dates.
 */

import type { Cadence } from "./expected";

export type Learned = {
  cadence: Cadence;
  /** How many arrivals it was measured from, and over what span. For the row: the reader can weigh it. */
  n: number;
  from: string;
  to: string;
  /** The usual gap between arrivals, in days. */
  typicalDays: number;
  /**
   * The longest this sender normally goes — what "it has stopped" is measured against.
   *
   * Not the longest ever: once there are six gaps to look at, the single worst is discounted, so one
   * freak silence cannot make a sender permanently unaccountable. Below six it is the plain maximum,
   * because there is nothing to discount from.
   */
  longestDays: number;
  says: string;
};

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const dayOfWeek = (iso: string) => new Date(at(iso)).getUTCDay();
const dayOfMonth = (iso: string) => new Date(at(iso)).getUTCDate();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** The value n of the way up the sorted list — 0.9 being "the ninth-longest gap in ten". */
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

/** The value that occurs most often, and how much of the list it accounts for. */
function modal(xs: number[]): { value: number; share: number } {
  const count = new Map<number, number>();
  for (const x of xs) count.set(x, (count.get(x) ?? 0) + 1);
  let value = xs[0];
  let best = 0;
  for (const [k, n] of count) if (n > best) ((best = n), (value = k));
  return { value, share: best / xs.length };
}

/**
 * How far back the measurement looks, counted from the newest arrival rather than from today.
 *
 * Measured against real data, 16 September 2026, and both faults it fixes were on the screen:
 * NADAC's table holds CMS file dates back to 2022, so the newest sixty produced "usually every 7
 * days, the longest gap 1106" — a true sentence about a fact nobody asked about. The 835s reached
 * back to April and reported a 95-day gap that was the site not yet existing.
 *
 * A sender's rhythm is a fact about now. Four months is long enough to see a monthly document three
 * or four times and short enough that a pattern from the spring cannot hold a verdict about today.
 */
export const WINDOW_DAYS = 120;

/**
 * The rhythm of a sender, or null where there is not enough to say.
 *
 * `dates` may be timestamps or dates, in any order, with repeats — two invoices on one day is one
 * arrival for this purpose, because the question is when the sender sends, not how much.
 */
export function learnCadence(dates: (string | null | undefined)[]): Learned | null {
  const all = [...new Set(dates.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)).map((d) => d.slice(0, 10)))].sort();
  if (all.length < 4) return null;
  const newest = at(all[all.length - 1]);
  const days = all.filter((d) => at(d) >= newest - WINDOW_DAYS * DAY);
  if (days.length < 4) return null;

  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(Math.round((at(days[i]) - at(days[i - 1])) / DAY));
  const typical = Math.max(1, median(gaps));
  const from = days[0];
  const to = days[days.length - 1];

  /*
   * Erratic beats any calendar, whatever the average says.
   *
   * A sender whose silences are wildly uneven does not have a rhythm — it has an average, and an
   * average is exactly the thing that produces a confident wrong date. Gaps of 28, 31, 4 and 96
   * average to something plausible and mean nothing.
   *
   * Judged on the ninth-longest-in-ten gap once there are enough of them, not the single longest.
   * The claims export is daily and was reading as irregular off one 13-day hole that was the site
   * not yet existing in August — one hole in twenty-two, which is a startup, not a rhythm. Below six
   * gaps there is no room to discount anything and the longest stands, which is why the 28/31/4/96
   * sender is still called erratic.
   *
   * One number, one meaning: this same figure decides "erratic", is what an irregular sender is
   * judged as stopped against, and is the one printed on the row. A sentence on the screen and the
   * verdict beside it reading from two different figures is the fault that costs the most here, and
   * it costs it quietly.
   */
  const longest = gaps.length >= 6 ? percentile(gaps, 0.9) : Math.max(...gaps);
  const base = { n: days.length, from, to, typicalDays: typical, longestDays: longest };
  const erratic = longest > typical * 3 && gaps.length >= 3;

  if (!erratic && typical <= 2) {
    const sundays = days.filter((d) => dayOfWeek(d) === 0).length;
    const skipSundays = sundays === 0;
    return {
      ...base,
      cadence: { kind: "daily", skipSundays },
      says: `Measured: ${days.length} arrivals${skipSundays ? ", none on a Sunday" : ""}, usually ${typical === 1 ? "every day" : `every ${typical} days`}.`,
    };
  }

  if (!erratic && typical >= 6 && typical <= 8) {
    const dow = modal(days.map(dayOfWeek));
    if (dow.share >= 0.6) {
      return {
        ...base,
        cadence: { kind: "weekly", weekday: dow.value },
        says: `Measured: ${days.length} arrivals, ${Math.round(dow.share * 100)}% of them on a ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dow.value]}.`,
      };
    }
  }

  if (!erratic && typical >= 12 && typical <= 18 && days.length >= 5) {
    const early = days.map(dayOfMonth).filter((d) => d < 16);
    const late = days.map(dayOfMonth).filter((d) => d >= 16);
    if (early.length >= 2 && late.length >= 2) {
      const pair: [number, number] = [median(early), median(late)];
      return {
        ...base,
        cadence: { kind: "semimonthly", days: pair },
        says: `Measured: ${days.length} arrivals, clustered around the ${pair[0]}th and the ${pair[1]}th.`,
      };
    }
  }

  if (!erratic && typical >= 26 && typical <= 35) {
    const dom = median(days.map(dayOfMonth));
    return {
      ...base,
      cadence: { kind: "monthly", dayOfMonth: dom },
      says: `Measured: ${days.length} arrivals, typically around the ${dom}th.`,
    };
  }

  /*
   * No calendar, but a rhythm all the same.
   *
   * This is the answer for a voucher remittance or a wholesaler credit: nobody promised a date, so
   * none is invented, but "usually within 9 days, never longer than 19" is a real statement about a
   * real sender and it is enough to tell a quiet week from a sender who has stopped.
   */
  return {
    ...base,
    cadence: { kind: "irregular", typicalDays: typical, longestDays: longest },
    says: `Measured: ${days.length} arrivals between ${from} and ${to} — usually ${typical} day${typical === 1 ? "" : "s"} apart, and it does not normally go beyond ${longest}.`,
  };
}

/**
 * The hour of the day a feed usually lands, from its own arrivals.
 *
 * Null unless the arrivals carry a time and cluster tightly enough to mean anything. A feed that
 * arrives at 04:00 one day and 18:00 the next has no usual hour, and pretending it does would put a
 * row amber for half of every day on no evidence.
 *
 * The median rather than the latest, and a spread test rather than a confidence interval: this is
 * deciding whether to draw a row amber, not pricing a bond.
 */
export function arrivalHour(dates: (string | null | undefined)[]): number | null {
  const hours = dates
    .filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}/.test(d))
    .map((d) => Number(d.slice(11, 13)))
    .filter((h) => Number.isFinite(h));
  if (hours.length < 4) return null;
  const sorted = [...hours].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)]!;
  /* Most of them within three hours of the middle, or there is no usual hour to speak of. */
  const close = hours.filter((h) => Math.abs(h - mid) <= 3).length;
  return close / hours.length >= 0.7 ? mid : null;
}
