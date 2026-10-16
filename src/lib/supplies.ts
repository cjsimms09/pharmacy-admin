/**
 * How fast the pharmacy gets through vials, bags, labels and receipt tape — learned from counts.
 *
 * Drugs have a claims feed that says what left the shelf. Supplies have nothing: a box of 30 dram
 * vials is opened, used and thrown away without a single record, so the only evidence of how fast
 * they go is the difference between two counts. That difference is the whole of this module, and
 * getting it slightly wrong is what makes a reorder alert useless.
 *
 * ── The arithmetic, and the mistake it exists to avoid ──
 *
 *     used = opening + received − closing
 *
 * Not `opening − closing`. Between two counts a delivery usually arrives, and subtracting the
 * counts alone reports a week where four boxes were used and five arrived as a week where nothing
 * was used at all. Every reorder date built on that is late, and it is late by exactly as much as
 * the pharmacy orders — so the busiest items fail worst.
 *
 * ── What it refuses to do ──
 *
 * An interval where the count rose with no delivery recorded is not usage of a negative number of
 * boxes. It is a delivery nobody logged, and the honest response is to say so and leave that
 * interval out of the rate, rather than to average a nonsense figure into it. Same for two counts
 * on the same day, and for a count entered before the one it follows.
 *
 * A single count is not a rate. Two counts a day apart are barely one. So the confidence is
 * reported alongside every figure — how many usable intervals and how many days of evidence — and
 * a page showing "order this on Friday" from one weekend's observation is required to say so.
 *
 * Pure.
 */

/** One physical count, in whatever the item is kept in — boxes of vials, rolls of tape. */
export type Count = { on: string; quantity: number };

/** A delivery that arrived and was put away, so the counts either side of it make sense. */
export type Receipt = { on: string; quantity: number };

export type Interval = {
  from: string;
  to: string;
  days: number;
  opening: number;
  closing: number;
  received: number;
  /** opening + received − closing. Never negative; a negative is a symptom, not a quantity. */
  used: number;
  perDay: number;
  /** Why this interval was left out of the rate. Null where it counts. */
  excluded: string | null;
};

export type Rate = {
  /** Units used per day. Null where nothing can be said. */
  perDay: number | null;
  /** Intervals that counted, and the days of evidence behind them. */
  intervals: number;
  daysObserved: number;
  /** Every interval, excluded ones included, so the page can show its working. */
  all: Interval[];
  /** How much to trust it, in one word. */
  confidence: "none" | "weak" | "fair" | "good";
  /** What is wrong, where something is. */
  problems: string[];
};

const DAY = 86_400_000;

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

export function addDays(on: string, days: number): string {
  return new Date(Date.parse(`${on}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/**
 * How much arrived strictly after one count and up to and including the next.
 *
 * The boundary matters and only one choice is right. A delivery on the day of a count is already
 * in that count if it was put away first, and the pharmacy counts what is on the shelf — so it
 * belongs to the interval ending on that day, not the one starting there. Counting it in both
 * doubles it; counting it in neither reports it as usage.
 */
export function receivedBetween(receipts: Receipt[], from: string, to: string): number {
  return receipts.filter((r) => r.on > from && r.on <= to).reduce((n, r) => n + r.quantity, 0);
}

/**
 * How long an interval can be and still say anything about today.
 *
 * A count from two years ago against one from last week describes a pharmacy that no longer
 * exists. Six months is long enough to smooth out a quiet fortnight and short enough to follow a
 * change in how busy the place is.
 */
export const RATE_WINDOW_DAYS = 180;

/** Works out the burn rate from the counts, showing every interval and why any was dropped. */
export function usageRate(counts: Count[], receipts: Receipt[] = [], today?: string): Rate {
  const problems: string[] = [];
  const sorted = [...counts].sort((a, b) => a.on.localeCompare(b.on));
  if (sorted.length === 0) return { perDay: null, intervals: 0, daysObserved: 0, all: [], confidence: "none", problems: ["Nothing has been counted yet."] };
  if (sorted.length === 1) {
    return {
      perDay: null, intervals: 0, daysObserved: 0, all: [], confidence: "none",
      problems: ["Only one count on file. A rate needs a second one — the first count is a starting point, not a measurement."],
    };
  }

  const now = today ?? new Date().toISOString().slice(0, 10);
  const cutoff = addDays(now, -RATE_WINDOW_DAYS);

  const all: Interval[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const days = daysBetween(a.on, b.on);
    const received = receivedBetween(receipts, a.on, b.on);
    const used = a.quantity + received - b.quantity;

    let excluded: string | null = null;
    if (days <= 0) excluded = "Two counts on the same day say nothing about a rate.";
    else if (used < 0) {
      excluded = `The count rose by ${b.quantity - a.quantity - received} with no delivery recorded for it. That is stock arriving unlogged, not usage — log the delivery and this interval starts counting.`;
    } else if (a.on < cutoff) {
      /*
       * Judged on where the interval *starts*, not where it ends.
       *
       * Excluding on the end date lets one enormous interval survive — an ancient count paired
       * with a recent one — and that interval then dominates the weighting, because it is weighted
       * by days and it has more days than everything else put together. It describes a pharmacy
       * that has not existed for a year.
       */
      excluded = `Starts more than ${RATE_WINDOW_DAYS} days ago.`;
    }

    all.push({
      from: a.on, to: b.on, days,
      opening: a.quantity, closing: b.quantity, received,
      used: Math.max(0, used),
      perDay: days > 0 ? Math.max(0, used) / days : 0,
      excluded,
    });
  }

  const good = all.filter((x) => x.excluded === null);
  const unlogged = all.filter((x) => x.excluded?.startsWith("The count rose"));
  if (unlogged.length > 0) {
    problems.push(
      `${unlogged.length} ${unlogged.length === 1 ? "interval was" : "intervals were"} left out because the count went up with no delivery logged against it. Logging deliveries as they arrive is what makes the rest of this accurate.`,
    );
  }
  if (good.length === 0) {
    return { perDay: null, intervals: 0, daysObserved: 0, all, confidence: "none", problems: [...problems, "No interval between counts can be trusted yet."] };
  }

  /*
   * Weighted by days, because a fortnight of evidence says more than an afternoon of it.
   *
   * A plain mean of the per-day figures gives a two-day interval the same say as a two-month one,
   * and short intervals are exactly where a single busy morning distorts everything. Weighting by
   * days is the same as dividing total usage by total days, which is also the figure anybody
   * checking this by hand would work out.
   */
  const daysObserved = good.reduce((n, x) => n + x.days, 0);
  const usedTotal = good.reduce((n, x) => n + x.used, 0);
  const perDay = usedTotal / daysObserved;

  /*
   * Days of evidence decides it, with a second interval required before anything is called good.
   *
   * One long interval can be a fair measurement and cannot be a reliable one: a single unusual
   * month looks exactly like a rate until a second month disagrees with it. So thirty days seen
   * once is "fair", and "good" needs the pattern to have repeated.
   */
  const confidence: Rate["confidence"] =
    daysObserved >= 45 && good.length >= 2 ? "good" : daysObserved >= 14 ? "fair" : "weak";

  return { perDay, intervals: good.length, daysObserved, all, confidence, problems };
}

export type SupplyPolicy = {
  /** Days from sending the order to it being on the shelf. */
  leadTimeDays: number;
  /** Cover to hold beyond the lead time, so a slow week is not a stockout. */
  safetyDays: number;
  /** Days of stock an order should bring the shelf up to. */
  targetDays: number;
  /** Order in whole cases where the supplier sells that way. */
  orderMultiple: number | null;
};

export const DEFAULT_POLICY: SupplyPolicy = { leadTimeDays: 5, safetyDays: 7, targetDays: 45, orderMultiple: null };

export type Position = {
  onHand: number;
  countedOn: string | null;
  perDay: number | null;
  /** How long what is here will last. Infinity where nothing is being used. */
  daysRemaining: number;
  /** The day the order has to be sent for stock to arrive before the safety cushion is eaten. */
  orderBy: string | null;
  /** The day it runs out entirely, if nothing is ordered. */
  runsOutOn: string | null;
  /** How many to order today to reach the target, in whole order multiples. */
  suggested: number;
  state: "unknown" | "ok" | "order soon" | "order now" | "out";
  says: string;
};

/**
 * Where one item stands, and what to do about it.
 *
 * `orderBy` is the number the pharmacist actually needs: not "you have eleven days left" but "send
 * this on Tuesday". It is the day the stock falls to the point where the lead time plus the safety
 * cushion is all that is left — order later than that and the cushion is being spent.
 */
export function position(a: {
  onHand: number;
  countedOn: string | null;
  rate: Rate;
  policy: SupplyPolicy;
  /** Already ordered and not yet arrived. Counts as stock for deciding, never for counting. */
  onOrder?: number;
  today?: string;
}): Position {
  const today = a.today ?? new Date().toISOString().slice(0, 10);
  const perDay = a.rate.perDay;
  const onOrder = a.onOrder ?? 0;

  /*
   * Stock is depleted from the day it was counted, not from today.
   *
   * A count taken three weeks ago against a rate of two a day is six boxes out of date, and a page
   * that ignores that reports a comfortable position on an empty shelf.
   */
  const elapsed = a.countedOn ? Math.max(0, daysBetween(a.countedOn, today)) : 0;
  const projected = perDay === null ? a.onHand : Math.max(0, a.onHand - perDay * elapsed);
  const available = projected + onOrder;

  if (perDay === null || perDay <= 0) {
    return {
      onHand: projected, countedOn: a.countedOn, perDay, daysRemaining: Infinity,
      orderBy: null, runsOutOn: null, suggested: 0,
      state: a.countedOn === null ? "unknown" : projected <= 0 ? "out" : "unknown",
      says:
        a.countedOn === null
          ? "Never counted. One count gives a position; a second gives a rate."
          : perDay === 0
            ? "Nothing has been used between counts, so there is no rate to project. Left alone."
            : "Not enough counts yet to say how fast this goes.",
    };
  }

  const daysRemaining = available / perDay;
  const cushion = a.policy.leadTimeDays + a.policy.safetyDays;
  const runsOutOn = addDays(today, Math.floor(daysRemaining));
  const orderBy = addDays(today, Math.floor(daysRemaining - cushion));

  const need = Math.max(0, a.policy.targetDays * perDay - available);
  const multiple = a.policy.orderMultiple && a.policy.orderMultiple > 0 ? a.policy.orderMultiple : 1;
  const suggested = need <= 0 ? 0 : Math.ceil(need / multiple) * multiple;

  /*
   * Out is about the shelf, not the order.
   *
   * This decided "out" on what is available including stock on order, so an empty shelf with a
   * delivery due in five days read "ok" for those five days — while the technician had nothing to
   * put a prescription in. What is on a truck settles when to order again; it does not fill a vial
   * today. So the state is decided on what is here, and the days left still count what is coming,
   * because that is the question the reorder date turns on.
   */
  const state: Position["state"] =
    projected <= 0 ? "out" : daysRemaining <= cushion ? "order now" : daysRemaining <= cushion + 7 ? "order soon" : "ok";

  const round = (n: number) => Math.round(n * 10) / 10;

  const says =
    state === "out"
      ? onOrder > 0
        ? `Out on the shelf, with ${round(onOrder)} on order — ${round(daysRemaining)} days' cover once it lands.${suggested > 0 ? ` ${suggested} more to reach ${a.policy.targetDays} days.` : ""}`
        : `Out, or as near as makes no difference. ${suggested} to bring it back to ${a.policy.targetDays} days.`
      : state === "order now"
        ? `${round(daysRemaining)} days left and ${cushion} of those are the lead time and cushion. Send it today — ${suggested} covers ${a.policy.targetDays} days.`
        : state === "order soon"
          ? `${round(daysRemaining)} days left. Order by ${orderBy} to keep the cushion intact.`
          : `${round(daysRemaining)} days left. Nothing to do until ${orderBy}.`;

  return { onHand: projected, countedOn: a.countedOn, perDay, daysRemaining, orderBy, runsOutOn, suggested, state, says };
}

/** Order the worst first: out, then order now, then soonest to run out. */
export function urgencyOrder(a: Position, b: Position): number {
  const rank = { out: 0, "order now": 1, "order soon": 2, ok: 3, unknown: 4 } as const;
  if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
  return a.daysRemaining - b.daysRemaining;
}
