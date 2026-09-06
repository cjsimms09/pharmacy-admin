/**
 * How fast each drug actually leaves the shelf.
 *
 * Every purchasing question this pharmacy has — how much to buy, whether a bulk buy to reach a
 * supplier's minimum is a saving or a freezer, how many days of stock is on the shelf, what can
 * safely go back — reduces to one number nobody was measuring: units off the shelf per day. It
 * needs no new report. The claims already say what was dispensed, of what, on what day, in what
 * quantity.
 *
 * Pure. Claims come in as plain rows so the arithmetic can be checked against a real week rather
 * than against whatever the database holds today.
 *
 * ── Three decisions that decide whether the number is any use ──
 *
 * **The window is the claims held, not the drug's own history.** A drug first dispensed on the
 * last day of a thirty-day window has one fill over thirty days, not one fill over one day. Dating
 * the window from the drug's first fill turns every new item into an emergency reorder. So the
 * window is stated by the caller — the span of claim days actually held — and every drug is
 * divided by the same denominator.
 *
 * **A reversed fill did not leave the shelf.** It was billed and unbilled. Counting it inflates
 * demand on exactly the drugs most likely to have been re-run at a different quantity, which are
 * the expensive ones where an overbuy hurts most.
 *
 * **A mean is not a forecast when one fill is most of the volume.** Ninety tablets dispensed in a
 * month is three a day if six patients take one a day, and it is nothing at all if it was one
 * ninety-day fill for one patient who will not be back for three months. Those need opposite
 * purchasing decisions and they produce the same average, so both are reported: the rate, and how
 * concentrated it is. Anything that recommends buying deep has to refuse the concentrated ones.
 *
 * ── Days supply, and why it is the leading indicator ──
 *
 * Units per calendar day says what has to be replaced. Days supply says when the patient comes
 * back. A drug with four patients each on a thirty-day supply moves four packs a month forever;
 * one with four patients who each filled once and stopped moves four packs and then nothing. The
 * refill horizon — the latest date the last fill's days supply runs to — is the difference, and it
 * is the honest answer to "will this keep moving".
 */

/** One dispensing, as the claims hold it. */
export type DispenseEvent = {
  ndc11: string | null;
  itemName: string | null;
  /** ISO date, YYYY-MM-DD. */
  dateFilled: string;
  /** Units dispensed, in thousandths, so a half tablet or 0.5 mL is exact. */
  quantityThousandths: number | null;
  daysSupply: number | null;
  rxNumber?: string | null;
  status?: string | null;
};

export type Velocity = {
  ndc11: string;
  name: string | null;
  /** Units dispensed across the window, in thousandths. */
  unitsThousandths: number;
  fills: number;
  /** Distinct prescriptions, which is closer to "patients" than the fill count is. */
  prescriptions: number;
  /** Calendar days the window covers. The same for every row. */
  windowDays: number;
  /** Units off the shelf per calendar day, in thousandths. */
  perDayThousandths: number;
  firstOn: string;
  lastOn: string;
  /** Distinct days on which anything was dispensed. */
  activeDays: number;
  /**
   * The largest single fill as a share of the window's units, 0 to 1.
   *
   * The spike detector. At 1 the whole of the demand is one fill and the daily rate is fiction.
   */
  concentration: number;
  /**
   * The furthest date any fill's days supply runs to.
   *
   * Null where no fill carried a days supply. A horizon already in the past means every patient
   * this drug had is due back or gone, and neither is a reason to buy deep.
   */
  refillHorizon: string | null;
  /**
   * True where the rate is worth acting on: dispensed on enough separate days, by enough separate
   * prescriptions, without one fill carrying most of it.
   */
  steady: boolean;
};

/** Whole days from `a` to `b`, both ISO dates. Negative where b precedes a. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** `date` moved on by `days`, as an ISO date. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * What counts as steady enough to buy against.
 *
 * Deliberately conservative, and the direction matters: calling a lumpy drug steady recommends
 * buying deep on demand that will not repeat, which is the failure that fills a shelf with money.
 * Calling a steady drug lumpy only means the site declines to recommend a bulk buy, which costs a
 * discount and nothing else.
 */
export const STEADY = {
  /** Dispensed on at least this many separate days. */
  minActiveDays: 3,
  /** By at least this many separate prescriptions. */
  minPrescriptions: 2,
  /** And no single fill carrying more than this share of the volume. */
  maxConcentration: 0.6,
};

export type WindowInput = {
  /** The first and last claim day held. Every rate is divided by this span, not by the drug's own. */
  from: string;
  to: string;
};

/**
 * Units per day per NDC across the window.
 *
 * `window` is the span of claim days the caller actually holds. Where it is omitted the span of the
 * events themselves is used, which is right when the events are the whole archive and wrong when
 * they are a filtered slice — so callers holding a slice should say so.
 */
export function velocity(events: DispenseEvent[], window?: WindowInput): Velocity[] {
  const live = events.filter((e) => e.ndc11 && e.status !== "reversed" && (e.quantityThousandths ?? 0) > 0);
  if (live.length === 0) return [];

  const days = live.map((e) => e.dateFilled).sort();
  const from = window?.from ?? days[0];
  const to = window?.to ?? days[days.length - 1];
  // Inclusive of both ends: a single day of claims is one day of demand, never zero.
  const windowDays = Math.max(1, daysBetween(from, to) + 1);

  type Acc = {
    name: string | null;
    units: number;
    fills: number;
    rxNumbers: Set<string>;
    dates: Set<string>;
    largest: number;
    first: string;
    last: string;
    horizon: string | null;
  };
  const acc = new Map<string, Acc>();

  for (const e of live) {
    const ndc = e.ndc11 as string;
    const qty = e.quantityThousandths as number;
    let a = acc.get(ndc);
    if (!a) {
      a = {
        name: e.itemName ?? null, units: 0, fills: 0, rxNumbers: new Set(), dates: new Set(),
        largest: 0, first: e.dateFilled, last: e.dateFilled, horizon: null,
      };
      acc.set(ndc, a);
    }
    if (!a.name && e.itemName) a.name = e.itemName;
    a.units += qty;
    a.fills += 1;
    if (e.rxNumber) a.rxNumbers.add(e.rxNumber);
    a.dates.add(e.dateFilled);
    if (qty > a.largest) a.largest = qty;
    if (e.dateFilled < a.first) a.first = e.dateFilled;
    if (e.dateFilled > a.last) a.last = e.dateFilled;
    if (e.daysSupply && e.daysSupply > 0) {
      const runsTo = addDays(e.dateFilled, e.daysSupply);
      if (a.horizon === null || runsTo > a.horizon) a.horizon = runsTo;
    }
  }

  const out: Velocity[] = [];
  for (const [ndc11, a] of acc) {
    const concentration = a.units > 0 ? a.largest / a.units : 0;
    // A prescription number is not always exported; where none was, each fill is counted as one.
    const prescriptions = a.rxNumbers.size > 0 ? a.rxNumbers.size : a.fills;
    out.push({
      ndc11,
      name: a.name,
      unitsThousandths: a.units,
      fills: a.fills,
      prescriptions,
      windowDays,
      perDayThousandths: a.units / windowDays,
      firstOn: a.first,
      lastOn: a.last,
      activeDays: a.dates.size,
      concentration,
      refillHorizon: a.horizon,
      steady:
        a.dates.size >= STEADY.minActiveDays &&
        prescriptions >= STEADY.minPrescriptions &&
        concentration <= STEADY.maxConcentration,
    });
  }
  out.sort((x, y) => y.perDayThousandths - x.perDayThousandths);
  return out;
}

/**
 * How long what is on the shelf will last, in days.
 *
 * Infinity where the drug does not move at all — which is a real answer, and the one that matters:
 * stock with no velocity is not "well supplied", it is money that will expire. Callers should test
 * for it rather than print it.
 */
export function daysOfStock(onHandThousandths: number, perDayThousandths: number): number {
  if (perDayThousandths <= 0) return Infinity;
  return onHandThousandths / perDayThousandths;
}

/**
 * How many units to buy to hold `targetDays` of stock once the order arrives.
 *
 * Lead time is part of the target, not a separate cushion: an order placed today against a
 * two-day target, arriving tomorrow, has to cover the day it is in transit as well. Rounded up to
 * whole units — a supplier does not ship a third of a tablet — and never negative.
 */
export function toOrderThousandths(args: {
  onHandThousandths: number;
  onOrderThousandths?: number;
  perDayThousandths: number;
  targetDays: number;
  leadTimeDays?: number;
}): number {
  const cover = args.targetDays + (args.leadTimeDays ?? 0);
  const need = args.perDayThousandths * cover;
  const have = args.onHandThousandths + (args.onOrderThousandths ?? 0);
  const gap = need - have;
  if (gap <= 0) return 0;
  return Math.ceil(gap / 1000) * 1000;
}

/** Units, from thousandths, for display. */
export function units(thousandths: number): number {
  return Math.round(thousandths) / 1000;
}

/** Velocity keyed by NDC, for joining against on hand, catalogues and returns. */
export function byNdc(rows: Velocity[]): Map<string, Velocity> {
  return new Map(rows.map((r) => [r.ndc11, r]));
}
