/**
 * The McKesson question, answered by arithmetic: where to draw the line between the cheapest
 * product and the rebate.
 *
 * The owner's framing is exact. Generics are often dearer at McKesson but lift the compliance
 * ratio; brands are cheaper at McKesson but drag it. Ignore the ratio and buy cheapest? Chase the
 * ratio and buy brands elsewhere at a premium? Some mixture, and if so which?
 *
 * The answer is not a fixed mixture. It is two rules, and the second is decided fresh each month
 * by the numbers:
 *
 * **Rule 1, line by line: buy every line where its effective cost is lowest.** Effective means
 * after the rebate *that line itself earns* — a OneStop generic at McKesson at the band rate, a
 * brand at McKesson at the brand factor, anything elsewhere at its gross. This already answers
 * "McKesson generics are dearer": they are dearer gross and often cheaper effective, and the
 * ledger compares effective. It also answers "brands are cheaper at McKesson": then buy them
 * there. Rule 1 alone is what "ignore the rebate game" would get wrong, because the rebate is not
 * a game on top of the price, it is part of the price of each line.
 *
 * **Rule 2, once a month: the band is a step, and a step is worth crossing only when what it pays
 * on the whole base exceeds what it costs to get there.** The ratio is generic dollars over all
 * Rx dollars at McKesson. Two levers move it: brand off McKesson (the denominator shrinks) and
 * generic on to McKesson (both sides grow). Each lever has a price per dollar moved — the brand
 * premium at the secondary plus the brand factor forgone; the generic premium of McKesson's
 * effective price over the secondary's — and a supply (how much brand or generic is actually
 * available to move this month). Reaching the next band needs a computable amount of movement,
 * and the band is worth a computable amount: the rate difference on the month's OneStop base. So:
 *
 *     move only if   (rate_next − rate_now) × base   >   cost of the cheapest way to get there
 *
 * and, the other way round, protect the current band only while the cost of protecting it is
 * less than what it pays. Where the arithmetic says no, Rule 1 stands alone and the ratio lands
 * where it lands.
 *
 * Which products are excluded from the ratio (the flu pre-book, drop-ship, and McKesson's own
 * scrub, GLP-1s among them) matters: moving a scrubbed brand changes nothing, so the brand lever's
 * supply is the *unscrubbed* brand spend only. Rule 2 also never sees the month it is in from the
 * drill-down's unscrubbed figure; `ratio-effect.ts` says which basis the position rests on.
 *
 * Pure.
 */

import { bandAt, positionCents, type Band, type Position } from "./ratio-effect";

export type Lever = {
  /** How much can actually be moved this month, in cents of purchases. */
  availableCents: number;
  /** What moving one dollar costs, as a fraction: premium paid at the other supplier plus any factor forgone. Negative means it saves. */
  costFraction: number;
};

export type Levers = {
  /** Brand spend that could go to a secondary instead of McKesson: unscrubbed brands only. */
  brandOff: Lever;
  /** Generic spend that could come to McKesson instead of a secondary. */
  genericOn: Lever;
  /** Of generics moved on, the share that would be OneStop and so widen the base. 0..1. */
  oneStopShare: number;
};

export type Move = { lever: "brandOff" | "genericOn"; cents: number; costCents: number };

export type BandPlan = {
  bandNow: Band | null;
  target: Band;
  /** The cheapest set of moves that reaches the target, or null if it cannot be reached with what is available. */
  moves: Move[] | null;
  costCents: number | null;
  /** (rate_target − rate_now) on the base after the moves. */
  worthCents: number | null;
  netCents: number | null;
  verdict: "do it" | "not worth it" | "out of reach";
  says: string;
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Cents of brand that must leave McKesson for G ÷ (D − x) to reach t. */
export function brandOffToReach(numeratorCents: number, denominatorCents: number, targetPercent: number): number {
  const t = targetPercent / 100;
  if (t <= 0) return 0;
  return Math.max(0, denominatorCents - numeratorCents / t);
}

/** Cents of generic that must come to McKesson for (G + y) ÷ (D + y) to reach t. */
export function genericOnToReach(numeratorCents: number, denominatorCents: number, targetPercent: number): number {
  const t = targetPercent / 100;
  if (t >= 1) return Number.POSITIVE_INFINITY;
  return Math.max(0, (t * denominatorCents - numeratorCents) / (1 - t));
}

/**
 * The cheapest way to reach `target` from `position`, on the levers available.
 *
 * Both levers are linear in cost and the ratio is monotone in each, so the cheapest path is
 * greedy: use the lever with the lower cost *per point of ratio* first, as far as it goes, then
 * the other. Cost per point is not the same as cost per dollar — a dollar of brand off moves the
 * ratio more than a dollar of generic on when the ratio is low, and less when it is high — so it
 * is worked out at the starting position and again after the first lever is exhausted.
 */
export function planForBand(p: Position, bands: Band[], baseCents: number, levers: Levers, target: Band): BandPlan {
  const { numeratorCents: G0, denominatorCents: D0 } = positionCents(p);
  const bandNow = bandAt(bands, p.ratioPercent);
  const rateNow = bandNow ? bandNow.rebatePercent / 100 : 0;
  const rateTarget = target.rebatePercent / 100;
  const t = target.thresholdPercent;

  // What each lever would cost to get all the way, ignoring supply, to order them.
  const costPerPoint = (lever: "brandOff" | "genericOn", G: number, D: number) => {
    const need = lever === "brandOff" ? brandOffToReach(G, D, t) : genericOnToReach(G, D, t);
    if (!Number.isFinite(need) || need <= 0) return { need, perPoint: 0 };
    const pointsGained = t - (G / D) * 100;
    return { need, perPoint: (need * levers[lever].costFraction) / Math.max(pointsGained, 1e-9) };
  };
  const order: ("brandOff" | "genericOn")[] = [];
  const a = costPerPoint("brandOff", G0, D0);
  const b = costPerPoint("genericOn", G0, D0);
  order.push(...(a.perPoint <= b.perPoint ? (["brandOff", "genericOn"] as const) : (["genericOn", "brandOff"] as const)));

  let G = G0;
  let D = D0;
  const moves: Move[] = [];
  let reached = (G / D) * 100 >= t;
  for (const lever of order) {
    if (reached) break;
    const need = lever === "brandOff" ? brandOffToReach(G, D, t) : genericOnToReach(G, D, t);
    if (!Number.isFinite(need)) continue;
    const cents = Math.min(need, levers[lever].availableCents);
    if (cents <= 0) continue;
    moves.push({ lever, cents: Math.round(cents), costCents: Math.round(cents * levers[lever].costFraction) });
    if (lever === "brandOff") D -= cents;
    else { G += cents; D += cents; }
    reached = (G / D) * 100 >= t - 1e-9;
  }

  const bandsBelowTarget = bandAt(bands, t) === target;
  if (!reached || !bandsBelowTarget) {
    return { bandNow, target, moves: null, costCents: null, worthCents: null, netCents: null, verdict: "out of reach", says: `The ${t}% band cannot be reached this month with ${money(levers.brandOff.availableCents)} of brand that could move and ${money(levers.genericOn.availableCents)} of generic that could come.` };
  }
  const genericMoved = moves.filter((m) => m.lever === "genericOn").reduce((n, m) => n + m.cents, 0);
  const baseAfter = baseCents + Math.round(genericMoved * levers.oneStopShare);
  const costCents = moves.reduce((n, m) => n + m.costCents, 0);
  const worthCents = Math.round(baseAfter * (rateTarget - rateNow));
  const netCents = worthCents - costCents;
  const how = moves.map((m) => (m.lever === "brandOff" ? `${money(m.cents)} of brand to the secondary` : `${money(m.cents)} of generics to McKesson`)).join(" and ");
  const verdict: BandPlan["verdict"] = netCents > 0 ? "do it" : "not worth it";
  const says =
    verdict === "do it"
      ? `Reach the ${t}% band: move ${how}. It costs ${money(costCents)} in premiums and pays ${money(worthCents)} on the month's contract generics: ${money(netCents)} net.`
      : `The ${t}% band is reachable by moving ${how}, but that costs ${money(costCents)} to earn ${money(worthCents)}. Buy each line where it is cheapest and let the ratio land.`;
  return { bandNow, target, moves, costCents, worthCents, netCents, verdict, says };
}

export type Strategy = {
  bandNow: Band | null;
  /** Plans for every band above the current one, nearest first, each judged on its own. */
  up: BandPlan[];
  /** The one to act on, if any: the reachable band with the largest net. */
  best: BandPlan | null;
  /** How much brand can still go through McKesson this month without losing the current band. */
  brandHeadroomCents: number | null;
  says: string;
};

/**
 * The month's answer. Every band above the current one is costed; the best net, if positive, is
 * the recommendation; otherwise the recommendation is Rule 1 alone, with the brand headroom so the
 * current band is not lost by accident.
 */
export function bandStrategy(p: Position, bands: Band[], baseCents: number, levers: Levers): Strategy {
  const bandNow = bandAt(bands, p.ratioPercent);
  const sorted = [...bands].sort((a, b) => a.thresholdPercent - b.thresholdPercent);
  const above = sorted.filter((b) => b.thresholdPercent > p.ratioPercent);
  const up = above.map((b) => planForBand(p, bands, baseCents, levers, b));
  const doable = up.filter((x) => x.verdict === "do it").sort((a, b) => (b.netCents ?? 0) - (a.netCents ?? 0));
  const best = doable[0] ?? null;
  const { numeratorCents: G, denominatorCents: D } = positionCents(p);
  const brandHeadroomCents = bandNow && bandNow.thresholdPercent > 0 ? Math.max(0, Math.round(G / (bandNow.thresholdPercent / 100) - D)) : null;
  const says = best
    ? best.says
    : bandNow
      ? `No band above ${bandNow.thresholdPercent}% pays for the moves it would take this month. Buy each line where its effective cost is lowest${brandHeadroomCents !== null ? `, and keep brand through McKesson under ${money(brandHeadroomCents)} more this month to hold the ${bandNow.thresholdPercent}% band` : ""}.`
      : `Below the lowest band. Buy each line where its effective cost is lowest.`;
  return { bandNow, up, best, brandHeadroomCents, says };
}
