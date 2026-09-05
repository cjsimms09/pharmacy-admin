/**
 * How each plan actually pays, worked out from what it paid.
 *
 * Whether it is worth choosing one NDC over another of the same product depends on the payer. A
 * plan that prices off NADAC pays more for the NDC with the higher NADAC, so the right buy is the
 * one with the widest gap between its NADAC and its cost. A plan that pays a MAC pays the same for
 * every NDC of the product, so the right buy is simply the cheapest. Get that wrong and the
 * comparison recommends a dearer NDC for a payer that will not pay a cent more for it.
 *
 * The claim does not say which it is. PioneerRx's report carries no basis-of-reimbursement field
 * (NCPDP 522-FM), and until it does the basis has to be read off the money. Two readings, both
 * from claims the site already holds:
 *
 *   1. **How paid relates to NADAC.** For every paid claim, the ingredient cost paid divided by
 *      NADAC in force for that NDC on that day, times the quantity. A plan paying NADAC plus a
 *      little produces ratios that cluster tightly (1.00, 1.03, 0.98…). A MAC plan produces
 *      ratios all over the place, because its schedule was set on some other basis.
 *
 *   2. **Whether paid moves with the NDC.** Where one plan has paid on two NDCs of the same
 *      product whose NADACs differ, a NADAC-based plan pays them differently and in the same
 *      order; a MAC plan pays them the same. This is the direct test, and it outranks the first.
 *
 * The output is a basis and the evidence for it: how many claims, how tight the cluster, how many
 * products were tested directly and which way they went. "Unknown" is a real answer and the
 * default; a plan with six claims is not classified on six claims, because the NDC comparison
 * downstream then treats that plan's units as "cannot say" instead of guessing.
 *
 * None of this is the statutory floor. Whether SB 20 reaches a plan is decided in `plans.ts` by
 * a person with evidence; this is only the empirical shape of what the plan has been paying.
 *
 * Pure.
 */

import { nadacInForce, type NadacRecord } from "./reimbursement-rules";

export type PayBasis = "nadac_tracking" | "flat_per_product" | "unknown";

export type PaidClaim = {
  /** Which plan: `planKey(bin, group)` from plans.ts, or any stable key the caller prefers. */
  planKey: string;
  ndc11: string | null;
  dateFilled: string;
  quantityThousandths: number | null;
  /** Plan paid + patient paid − dispensing fee, as the transaction reader derives it. */
  ingredientPaidCents: number | null;
  status?: string;
};

export type PlanBasis = {
  planKey: string;
  basis: PayBasis;
  /** Paid claims with a NADAC in force that entered the reading. */
  claims: number;
  /** Median of paid ÷ (NADAC × quantity). 1.00 is exactly NADAC. Null under the minimum. */
  medianRatio: number | null;
  /** Interquartile range of that ratio divided by its median: how tight the cluster is. */
  spread: number | null;
  /** Products on which the plan paid two NDCs with different NADACs, and which way each went. */
  direct: { tracks: number; flat: number; mixed: number };
  why: string;
};

export type PayBasisOptions = {
  /** Below this many claims a plan stays "unknown". */
  minClaims?: number;
  /** A cluster no wider than this (IQR ÷ median) reads as NADAC-tracking. */
  maxSpread?: number;
  /** Two NADACs closer than this fraction are not a test of anything. */
  minNadacGap?: number;
  /** Two paid-per-unit figures within this fraction of each other are "the same". */
  sameWithin?: number;
};

const DEFAULTS: Required<PayBasisOptions> = { minClaims: 10, maxSpread: 0.15, minNadacGap: 0.1, sameWithin: 0.02 };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quartiles(xs: number[]): { q1: number; q3: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return { q1: at(0.25), q3: at(0.75) };
}

/**
 * Reads every plan's basis from its paid claims.
 *
 * `groupOf` maps an NDC to its product key (product-groups.ts); without it only the first reading
 * is possible and no plan can be called flat, because flatness is only ever shown across NDCs.
 */
export function payBasisByPlan(
  claims: PaidClaim[],
  nadac: NadacRecord[],
  groupOf: (ndc11: string) => string | null = () => null,
  opts: PayBasisOptions = {},
): PlanBasis[] {
  const o = { ...DEFAULTS, ...opts };
  type Obs = { ndc11: string; ratio: number; paidPerUnitMicros: number; nadacMicros: number; group: string | null };
  const byPlan = new Map<string, Obs[]>();

  for (const c of claims) {
    if (c.status === "reversed") continue;
    if (!c.ndc11 || c.ingredientPaidCents === null || !c.quantityThousandths || c.quantityThousandths <= 0) continue;
    if (c.ingredientPaidCents <= 0) continue; // a zero or negative ingredient payment says nothing about a formula
    const n = nadacInForce(nadac, c.ndc11, c.dateFilled);
    if (!n || n.unitMicros <= 0) continue;
    const units = c.quantityThousandths / 1000;
    const paidPerUnitMicros = (c.ingredientPaidCents * 10_000) / units;
    const ratio = paidPerUnitMicros / n.unitMicros;
    const list = byPlan.get(c.planKey) ?? [];
    list.push({ ndc11: c.ndc11, ratio, paidPerUnitMicros, nadacMicros: n.unitMicros, group: groupOf(c.ndc11) });
    byPlan.set(c.planKey, list);
  }

  const out: PlanBasis[] = [];
  for (const [planKey, obs] of byPlan) {
    const ratios = obs.map((x) => x.ratio);
    const med = ratios.length ? median(ratios) : null;
    const { q1, q3 } = ratios.length ? quartiles(ratios) : { q1: 0, q3: 0 };
    const spread = med && med > 0 ? (q3 - q1) / med : null;

    // The direct test: same product, two NDCs, NADACs far enough apart to tell anything.
    const direct = { tracks: 0, flat: 0, mixed: 0 };
    const byGroup = new Map<string, Map<string, { paid: number[]; nadac: number }>>();
    for (const x of obs) {
      if (!x.group) continue;
      const g = byGroup.get(x.group) ?? new Map();
      const e = g.get(x.ndc11) ?? { paid: [], nadac: x.nadacMicros };
      e.paid.push(x.paidPerUnitMicros);
      g.set(x.ndc11, e);
      byGroup.set(x.group, g);
    }
    for (const g of byGroup.values()) {
      const ndcs = [...g.values()].map((e) => ({ paid: median(e.paid), nadac: e.nadac })).sort((a, b) => a.nadac - b.nadac);
      if (ndcs.length < 2) continue;
      let tracks = 0;
      let flat = 0;
      for (let i = 1; i < ndcs.length; i++) {
        const lo = ndcs[i - 1];
        const hi = ndcs[i];
        if (hi.nadac - lo.nadac < lo.nadac * o.minNadacGap) continue;
        const same = Math.abs(hi.paid - lo.paid) <= Math.max(hi.paid, lo.paid) * o.sameWithin;
        if (same) flat++;
        else if (hi.paid > lo.paid) tracks++;
        else flat++; // paid the dearer NDC less: whatever it is, it is not following NADAC
      }
      if (tracks && flat) direct.mixed++;
      else if (tracks) direct.tracks++;
      else if (flat) direct.flat++;
    }

    let basis: PayBasis = "unknown";
    let why: string;
    if (obs.length < o.minClaims) {
      why = `${obs.length} claim${obs.length === 1 ? "" : "s"} with a NADAC in force; ${o.minClaims} are needed before anything is concluded.`;
    } else if (direct.flat > 0 && direct.tracks === 0) {
      basis = "flat_per_product";
      why = `On ${direct.flat} product${direct.flat === 1 ? "" : "s"} the plan paid the same per unit for NDCs whose NADACs differ: a schedule per product, not per NDC.`;
    } else if (direct.tracks > 0 && direct.flat === 0 && direct.mixed === 0) {
      basis = "nadac_tracking";
      why = `On ${direct.tracks} product${direct.tracks === 1 ? "" : "s"} the plan paid more for the NDC with the higher NADAC; median paid is ${(med! * 100).toFixed(0)}% of NADAC.`;
    } else if (direct.tracks === 0 && direct.flat === 0 && spread !== null && spread <= o.maxSpread) {
      basis = "nadac_tracking";
      why = `Paid clusters at ${(med! * 100).toFixed(0)}% of NADAC across ${obs.length} claims (spread ${(spread * 100).toFixed(0)}%); no product tested directly.`;
    } else {
      why =
        direct.mixed > 0 || (direct.tracks > 0 && direct.flat > 0)
          ? `Products disagree: ${direct.tracks} track NADAC, ${direct.flat} are flat, ${direct.mixed} mixed. Left unclassified.`
          : `Paid is ${(med! * 100).toFixed(0)}% of NADAC on average but scattered (spread ${((spread ?? 0) * 100).toFixed(0)}%); nothing tested directly.`;
    }
    out.push({ planKey, basis, claims: obs.length, medianRatio: med, spread, direct, why });
  }
  return out.sort((a, b) => b.claims - a.claims);
}
