/**
 * What an order does to the rebate ratio, and what that is worth.
 *
 * A McKesson invoice line has two prices. The one printed, and the one it costs or earns through
 * the compliance ratio: the ratio picks the band, the band sets the rate, and the rate is paid on
 * the *whole* period's contract generics. So a generic bought $14 cheaper at a secondary can cost
 * more than $14 if it was the purchase that would have carried the month over a band edge, and a
 * brand bought at a secondary for a dollar more can be worth doing if it keeps a band. The
 * arithmetic is simple; what makes it dangerous is doing it in one's head at the order screen.
 *
 * ── What the ratio is, from the report itself ──
 *
 * McKesson's daily Purchase Drill Down prints three ratios and the money under each, and the money
 * settles what they are (checked to the cent on six months of the pharmacy's own report):
 *
 *   GCR    = generic Rx purchases (excluding MPB) ÷ (total Rx purchases − exclusions)
 *   OS/Rx  = OneStop purchases ÷ total Rx purchases
 *   OS/Gx  = OneStop purchases ÷ generic Rx purchases
 *
 * So the *generic compliance ratio is the generic share of what the pharmacy buys at McKesson*.
 * Every generic bought there lifts it, contract or not; every brand bought there drags it; and
 * OneStop does not enter into it at all — OneStop is the base the band's rate is then paid on,
 * and the figure the second ladder (GPR) is measured by, as OS/Gx. Two levers, then: the generic
 * share picks the rate, the OneStop purchases are what the rate is paid on.
 *
 * ── The scrub ──
 *
 * The denominator has exclusions. The drill-down applies whichever the report was scheduled with
 * ("GCR Denominator Exclusions is Flu or Dropship" on the pharmacy's); the rebate statement's
 * "scrubbed GCR" applies McKesson's own list, which is wider (GLP-1s among them), and the two can
 * differ by a factor of two on the same month. The band is selected by the statement's figure. So
 * a position built from the drill-down carries the exclusions the drill-down was run with, and
 * `withScrub` restates it to the statement's basis where a same-month pair is held. Which one the
 * position rests on is recorded and shown, never silently mixed.
 *
 * Pure.
 */

export type RatioDefinition = "generics_over_rx" | "onestop_over_rx" | "onestop_over_generics";

export type Position = {
  /** The ratio in percent, on the basis stated. */
  ratioPercent: number;
  /** The denominator in cents: total Rx less exclusions for GCR, total Rx for OS/Rx, generics for OS/Gx. */
  denominatorCents: number;
  definition: RatioDefinition;
  /** Which exclusions the figure carries. "statement" is McKesson's own scrub, the one that selects the band. */
  scrub: "drill-down" | "statement" | "estimated";
};

export type OrderLine = {
  cents: number;
  /** True when bought from the supplier whose ratio this is. A line bought elsewhere moves nothing. */
  atPrimary: boolean;
  kind: "onestop_generic" | "other_generic" | "brand" | "excluded";
};

export type Band = { thresholdPercent: number; rebatePercent: number };

export type Projection = {
  beforePercent: number;
  afterPercent: number;
  numeratorCents: number;
  denominatorCents: number;
  scrub: Position["scrub"];
};

/** Whether a line of this kind counts in the numerator and the denominator, under each definition. */
export function counts(kind: OrderLine["kind"], def: RatioDefinition): { num: boolean; den: boolean } {
  if (kind === "excluded") return { num: false, den: false };
  switch (def) {
    case "generics_over_rx":
      return kind === "brand" ? { num: false, den: true } : { num: true, den: true };
    case "onestop_over_rx":
      return { num: kind === "onestop_generic", den: true };
    case "onestop_over_generics":
      return kind === "brand" ? { num: false, den: false } : { num: kind === "onestop_generic", den: true };
  }
}

/** The numerator and denominator the position implies, in cents. */
export function positionCents(p: Position): { numeratorCents: number; denominatorCents: number } {
  const denominatorCents = Math.max(0, p.denominatorCents);
  return { numeratorCents: Math.round((denominatorCents * p.ratioPercent) / 100), denominatorCents };
}

/**
 * Restates a drill-down position on the statement's scrub.
 *
 * The same month's figure on both reports gives the factor: if May's drill-down GCR was 10.13% and
 * May's statement said 20.64% scrubbed, McKesson's exclusions roughly halve the denominator. The
 * numerator is the same generic purchases either way, so the denominator is restated and the
 * ratio with it. An estimate, labelled as one: the scrub list is not published and the mix of
 * excluded products moves month to month.
 */
export function withScrub(p: Position, sameMonth: { drillDownPercent: number; statementPercent: number }): Position {
  if (p.definition !== "generics_over_rx" || sameMonth.drillDownPercent <= 0 || sameMonth.statementPercent <= 0) return p;
  const factor = sameMonth.statementPercent / sameMonth.drillDownPercent;
  const { numeratorCents } = positionCents(p);
  const denominatorCents = Math.round(p.denominatorCents / factor);
  return { ratioPercent: denominatorCents > 0 ? (numeratorCents / denominatorCents) * 100 : p.ratioPercent, denominatorCents, definition: p.definition, scrub: "estimated" };
}

/** Where the ratio lands after these lines are bought, and where it was. */
export function projectRatio(p: Position, lines: OrderLine[]): Projection {
  let { numeratorCents, denominatorCents } = positionCents(p);
  for (const l of lines) {
    if (!l.atPrimary) continue;
    const c = counts(l.kind, p.definition);
    if (c.num) numeratorCents += l.cents;
    if (c.den) denominatorCents += l.cents;
  }
  const afterPercent = denominatorCents > 0 ? (numeratorCents / denominatorCents) * 100 : p.ratioPercent;
  return { beforePercent: p.ratioPercent, afterPercent, numeratorCents, denominatorCents, scrub: p.scrub };
}

/** The band a ratio lands in: the highest threshold it reaches. Null below the lowest. */
export function bandAt(bands: Band[], ratioPercent: number): Band | null {
  let found: Band | null = null;
  for (const b of [...bands].sort((a, b) => a.thresholdPercent - b.thresholdPercent)) if (ratioPercent >= b.thresholdPercent) found = b;
  return found;
}

export type TierEffect = {
  projection: Projection;
  before: Band | null;
  after: Band | null;
  /** The rebate at the band before and after, on the same base, so the difference isolates the band. */
  rebateBeforeCents: number;
  rebateAfterCents: number;
  /** The change in rebate the order causes through the band alone. Negative is a band lost. */
  bandDeltaCents: number;
  /** The next band up from where the order leaves things, and what it would take to reach it. */
  next: { band: Band; numeratorNeededCents: number; worthCents: number } | null;
  /** How far the ratio can fall before the current band is lost, in cents of denominator-only spend at the primary. */
  headroom: { percentPoints: number; denominatorRoomCents: number } | null;
};

/**
 * What the order does to the band, in money.
 *
 * `baseCents` is what the band's rate is paid on — the period's OneStop purchases, projected to
 * include the order's OneStop lines — and it is not the numerator: on the GCR the numerator is all
 * generics and the base is only the contract ones. Both rebate figures use the same base so the
 * difference isolates the band; the rebate a line earns on itself is the ordinary effective price
 * (`effectiveMicros` in product-ledger.ts) and is not counted again here.
 */
export function tierEffect(p: Position, bands: Band[], lines: OrderLine[], baseCents: number): TierEffect {
  const projection = projectRatio(p, lines);
  const before = bandAt(bands, projection.beforePercent);
  const after = bandAt(bands, projection.afterPercent);
  const base = Math.max(0, baseCents);
  const rate = (b: Band | null) => (b ? b.rebatePercent / 100 : 0);
  const rebateBeforeCents = Math.round(base * rate(before));
  const rebateAfterCents = Math.round(base * rate(after));

  const sorted = [...bands].sort((a, b) => a.thresholdPercent - b.thresholdPercent);
  const nextBand = sorted.find((b) => b.thresholdPercent > projection.afterPercent) ?? null;
  let next: TierEffect["next"] = null;
  if (nextBand) {
    // Spending x that counts on both sides lifts (N + x) / (D + x) to t: x = (tD − N) / (1 − t).
    const t = nextBand.thresholdPercent / 100;
    if (t < 1) {
      const x = Math.max(0, (t * projection.denominatorCents - projection.numeratorCents) / (1 - t));
      next = { band: nextBand, numeratorNeededCents: Math.round(x), worthCents: Math.round(base * (rate(nextBand) - rate(after))) };
    }
  }

  let headroom: TierEffect["headroom"] = null;
  if (after) {
    // The ratio falls to the band's floor when the denominator grows to N / t; the room is the difference.
    const t = after.thresholdPercent / 100;
    const room = t > 0 ? projection.numeratorCents / t - projection.denominatorCents : Infinity;
    headroom = { percentPoints: projection.afterPercent - after.thresholdPercent, denominatorRoomCents: Number.isFinite(room) ? Math.max(0, Math.round(room)) : Number.MAX_SAFE_INTEGER };
  }

  return { projection, before, after, rebateBeforeCents, rebateAfterCents, bandDeltaCents: rebateAfterCents - rebateBeforeCents, next, headroom };
}

/**
 * The effect of one line on its own, for the sentence beside it at the order screen.
 *
 * "Buying this here lifts the ratio 0.04 points", or "buying this brand here lowers it 0.09 points
 * and loses the 24% band, which is $336 on the month's contract generics". `otherLines` is the rest
 * of the order, so the line is judged where it will actually land.
 */
export function lineEffect(p: Position, bands: Band[], line: OrderLine, baseCents: number, otherLines: OrderLine[] = []): {
  deltaPoints: number;
  bandLost: boolean;
  bandGained: boolean;
  bandDeltaCents: number;
} {
  const without = tierEffect(p, bands, otherLines, baseCents);
  const withIt = tierEffect(p, bands, [...otherLines, line], baseCents);
  return {
    deltaPoints: withIt.projection.afterPercent - without.projection.afterPercent,
    bandLost: (without.after?.thresholdPercent ?? -1) > (withIt.after?.thresholdPercent ?? -1),
    bandGained: (withIt.after?.thresholdPercent ?? -1) > (without.after?.thresholdPercent ?? -1),
    bandDeltaCents: withIt.rebateAfterCents - without.rebateAfterCents,
  };
}

/**
 * The most a dearer supplier may cost before reaching the next band stops paying.
 *
 * The owner's question, in his words: "if I am close to a higher tier and it's worth $500, I might
 * want to order generics from McKesson even if more expensive." Both halves of that are already
 * here — `next.numeratorNeededCents` is how much more contract-generic spend the band needs, and
 * `next.worthCents` is what the band pays once reached — and the decision is the ratio between
 * them.
 *
 * Buying that spend at the primary instead of the cheaper supplier costs the premium on it. So the
 * band pays as long as
 *
 *     premium × spend needed  <  what the band is worth
 *
 * and the break-even premium is simply worth ÷ needed. Above it, moving the buying loses money
 * even though the ratio improves; below it, a dearer invoice is the cheaper month.
 *
 * Returned as a percentage. Null where nothing is needed (the band is already reached, and the
 * question does not arise) or where the band is worth nothing.
 */
export function breakEvenPremiumPercent(worthCents: number, neededCents: number): number | null {
  if (neededCents <= 0 || worthCents <= 0) return null;
  return Math.round((worthCents / neededCents) * 10_000) / 100;
}

/**
 * The next band as an instruction: what it takes, what it pays, and when it stops paying.
 *
 * Pure, because it is the sentence the owner acts on and the arithmetic behind it should be
 * provable without a database. `nextTierNow` in shelf.ts loads the position and hands it here.
 */
export type NextTierAdvice = {
  nextThresholdPercent: number;
  nextRatePercent: number;
  currentRatePercent: number | null;
  ratioPercent: number;
  neededCents: number;
  worthCents: number;
  breakEvenPremiumPercent: number | null;
  says: string;
};

export function nextTierAdvice(a: {
  effect: TierEffect;
  supplier: string;
  /** Days left in the month, counting today. Nought once the month has closed. */
  daysLeft: number;
}): NextTierAdvice | null {
  const { effect, supplier, daysLeft } = a;
  if (!effect.next) return null;
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const breakEven = breakEvenPremiumPercent(effect.next.worthCents, effect.next.numeratorNeededCents);
  const says =
    effect.next.worthCents <= 0
      ? `The ${effect.next.band.rebatePercent}% band pays no more than the one ${supplier} is in on this month's contract generics, so reaching it is worth nothing.`
      : `${money(effect.next.numeratorNeededCents)} more of contract generics at ${supplier} carries the ratio from ` +
        `${effect.projection.afterPercent.toFixed(2)}% past ${effect.next.band.thresholdPercent}% and into the ` +
        `${effect.next.band.rebatePercent}% band, worth ${money(effect.next.worthCents)} on the month's contract generics` +
        (breakEven === null
          ? "."
          : `. That pays as long as ${supplier} is less than ${breakEven.toFixed(2)}% dearer on those items` +
            (daysLeft === 0 ? ", and the month is closed." : `, and there ${daysLeft === 1 ? "is 1 day" : `are ${daysLeft} days`} left to do it.`));
  return {
    nextThresholdPercent: effect.next.band.thresholdPercent,
    nextRatePercent: effect.next.band.rebatePercent,
    currentRatePercent: effect.after?.rebatePercent ?? null,
    ratioPercent: effect.projection.afterPercent,
    neededCents: effect.next.numeratorNeededCents,
    worthCents: effect.next.worthCents,
    breakEvenPremiumPercent: breakEven,
    says,
  };
}
