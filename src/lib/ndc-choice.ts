/**
 * Which NDC of a product to buy: the one that pays the most, not the one that costs the least.
 *
 * For one product — one group from product-groups.ts — every NDC has a cost per unit (its best
 * effective price across the suppliers, rebate off where it applies) and a NADAC per unit. What it
 * pays depends on who is paying. A plan that prices off NADAC pays each NDC by its own NADAC, so
 * a dear NDC with a high NADAC can be the better buy; a plan on a per-product schedule pays every
 * NDC the same, so only the cost matters. The pharmacy dispenses this product to a mix of plans,
 * and the units say how much each plan's way of paying weighs.
 *
 * So for each candidate NDC, for each plan in the mix:
 *
 *   expected paid per unit  =  NADAC(NDC) × the plan's ratio to NADAC      (NADAC-tracking, floor)
 *                           =  what the plan has paid per unit of the product   (flat per product)
 *                           =  cannot say                                      (unknown)
 *
 * and the margin per unit is that less the NDC's effective cost, weighted by the plan's share of
 * units. The candidate with the highest expected margin per unit is the recommendation — but only
 * when enough of the units can be priced, the gain over what is bought today is worth the change,
 * and every figure in it is known. Where any of that fails the answer is "cannot say" with the
 * reason, because a recommendation built on a guessed reimbursement is acted on once and trusted
 * afterwards.
 *
 * What this does not do: it never crosses a product group (a substitution the pharmacist did not
 * choose), never prices a plan it cannot read, never uses a short-dated price, and never counts
 * the rebate twice (the effective cost already has the tier off it; the band effect of the order
 * is ratio-effect.ts and is shown beside, not added in).
 *
 * Pure.
 */

import type { PayBasis } from "./pay-basis";

export type Candidate = {
  ndc11: string;
  name: string | null;
  /** Best non-short-dated effective price per unit, in micros. Null where nothing comparable is known. */
  effectiveUnitMicros: number | null;
  supplier: string | null;
  /** NADAC per unit, in micros. */
  nadacUnitMicros: number | null;
  /** False where the invoice pack could not be put on a per-unit footing. Nothing is concluded then. */
  comparable: boolean;
};

export type PlanShare = {
  planKey: string;
  /** Units of this product dispensed to the plan over the period the caller chose. */
  units: number;
  /**
   * "floor": the statutory floor applies (NADAC + fee) and the ingredient pays exactly NADAC.
   * Otherwise the empirical basis from pay-basis.ts.
   */
  basis: PayBasis | "floor";
  /** Median paid ÷ NADAC for the plan; 1 for the floor. Needed for the NADAC bases. */
  ratioToNadac: number | null;
  /** What the plan has paid per unit of this product, in micros, for a flat basis. */
  paidPerUnitMicros: number | null;
};

export type Scored = {
  ndc11: string;
  name: string | null;
  supplier: string | null;
  effectiveUnitMicros: number;
  nadacUnitMicros: number | null;
  /** Margin per unit across the units that could be priced, in micros. */
  marginPerUnitMicros: number;
  /** Share of the product's units that entered the margin. */
  pricedShare: number;
  /** Per plan: what it would pay per unit for this NDC, or why not. */
  byPlan: { planKey: string; units: number; expectedPaidMicros: number | null; why: string | null }[];
};

export type Choice = {
  verdict: "recommend" | "keep" | "cannot_say";
  /** The best candidate, where there is one. */
  best: Scored | null;
  /** What is bought today, where the caller said. */
  current: Scored | null;
  /** Gain per period from moving to `best`, in cents, on the units that could be priced. */
  gainCents: number | null;
  ranked: Scored[];
  reasons: string[];
};

export type ChoiceOptions = {
  /** Below this share of units priced, nothing is recommended. */
  minPricedShare?: number;
  /** Below this gain per period, keep what is bought. */
  materialityCents?: number;
};

const DEFAULTS: Required<ChoiceOptions> = { minPricedShare: 0.8, materialityCents: 500 };

function expectedPaid(c: Candidate, p: PlanShare): { micros: number | null; why: string | null } {
  if (p.basis === "floor" || p.basis === "nadac_tracking") {
    if (c.nadacUnitMicros === null) return { micros: null, why: "no NADAC for this NDC" };
    const ratio = p.basis === "floor" ? 1 : p.ratioToNadac;
    if (ratio === null) return { micros: null, why: "the plan's ratio to NADAC is not known" };
    return { micros: Math.round(c.nadacUnitMicros * ratio), why: null };
  }
  if (p.basis === "flat_per_product") {
    if (p.paidPerUnitMicros === null) return { micros: null, why: "the plan has not paid on this product" };
    return { micros: p.paidPerUnitMicros, why: null };
  }
  return { micros: null, why: "how the plan pays is not known" };
}

/** Scores one candidate against the plan mix. Null where it cannot be scored at all. */
export function scoreCandidate(c: Candidate, mix: PlanShare[]): Scored | null {
  if (!c.comparable || c.effectiveUnitMicros === null) return null;
  const total = mix.reduce((s, p) => s + p.units, 0);
  let pricedUnits = 0;
  let marginUnits = 0; // micros × units
  const byPlan: Scored["byPlan"] = [];
  for (const p of mix) {
    const e = expectedPaid(c, p);
    byPlan.push({ planKey: p.planKey, units: p.units, expectedPaidMicros: e.micros, why: e.why });
    if (e.micros === null) continue;
    pricedUnits += p.units;
    marginUnits += (e.micros - c.effectiveUnitMicros) * p.units;
  }
  return {
    ndc11: c.ndc11,
    name: c.name,
    supplier: c.supplier,
    effectiveUnitMicros: c.effectiveUnitMicros,
    nadacUnitMicros: c.nadacUnitMicros,
    marginPerUnitMicros: pricedUnits > 0 ? marginUnits / pricedUnits : 0,
    pricedShare: total > 0 ? pricedUnits / total : 0,
    byPlan,
  };
}

/**
 * Chooses among the NDCs of one product.
 *
 * `currentNdc` is what the pharmacy buys today, where known; the gain is measured against it and
 * "keep" is the answer when the best is the current or the gain is under the materiality line.
 */
export function chooseNdc(candidates: Candidate[], mix: PlanShare[], currentNdc: string | null, opts: ChoiceOptions = {}): Choice {
  const o = { ...DEFAULTS, ...opts };
  const reasons: string[] = [];
  const totalUnits = mix.reduce((s, p) => s + p.units, 0);
  if (totalUnits <= 0) reasons.push("nothing of this product has been dispensed in the period, so there is nothing to weigh the plans by");

  const scored: Scored[] = [];
  for (const c of candidates) {
    const s = scoreCandidate(c, mix);
    if (!s) {
      reasons.push(`${c.ndc11}: ${!c.comparable ? "its pack size is not known, so its price cannot be put per unit" : "no price is known"}`);
      continue;
    }
    scored.push(s);
  }
  // Only candidates priced on the same plans are compared; the margin is per priced unit, so an
  // NDC priced on fewer units would otherwise look better or worse for reasons that are not its own.
  const ranked = scored.filter((s) => s.pricedShare >= o.minPricedShare).sort((a, b) => b.marginPerUnitMicros - a.marginPerUnitMicros);
  for (const s of scored) if (s.pricedShare < o.minPricedShare) reasons.push(`${s.ndc11}: only ${(s.pricedShare * 100).toFixed(0)}% of the units could be priced (${o.minPricedShare * 100}% needed)`);

  const current = scored.find((s) => s.ndc11 === currentNdc) ?? null;
  if (ranked.length === 0 || totalUnits <= 0) return { verdict: "cannot_say", best: ranked[0] ?? null, current, gainCents: null, ranked, reasons };

  const best = ranked[0];
  if (!current) {
    if (currentNdc) reasons.push(`what is bought today (${currentNdc}) could not be priced, so no gain can be measured`);
    return { verdict: currentNdc ? "cannot_say" : "recommend", best, current: null, gainCents: null, ranked, reasons };
  }
  if (current.pricedShare < o.minPricedShare) return { verdict: "cannot_say", best, current, gainCents: null, ranked, reasons };

  const gainCents = Math.round(((best.marginPerUnitMicros - current.marginPerUnitMicros) * totalUnits * Math.min(best.pricedShare, current.pricedShare)) / 10_000);
  if (best.ndc11 === current.ndc11) return { verdict: "keep", best, current, gainCents: 0, ranked, reasons };
  if (gainCents < o.materialityCents) {
    reasons.push(`the best alternative gains $${(gainCents / 100).toFixed(2)} a period, under the $${(o.materialityCents / 100).toFixed(2)} line`);
    return { verdict: "keep", best, current, gainCents, ranked, reasons };
  }
  return { verdict: "recommend", best, current, gainCents, ranked, reasons };
}
