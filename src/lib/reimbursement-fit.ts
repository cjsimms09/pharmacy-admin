/**
 * Back-calculating how a plan prices a claim, from the claims it has paid.
 *
 * A PBM contract prices the ingredient one of a few ways, and the daily report does not say which
 * (no 522-FM). But the report gives the ingredient cost paid on every fill, the site holds NADAC
 * for the day and AWP off McKesson's invoices, and a formula leaves a signature across many fills
 * that a guess does not. So each plan's paid figures are tried against every formula the industry
 * actually uses, and the one that reproduces them with the smallest scatter is reported — with the
 * scatter, so nobody mistakes a fit for a contract:
 *
 *   NADAC + k%          paid ÷ (NADAC × qty) is one constant           (Medicaid, SB 20 plans, some commercial generics)
 *   AWP − d%            paid ÷ (AWP × qty) is one constant             (most brand contracts; some generics)
 *   MAC per product     paid per unit is one constant per product,      (commercial generics)
 *                       whatever the NDC's NADAC or AWP
 *
 * Brand and generic are fitted apart, because contracts price them apart, and a fit is only
 * offered on enough fills. The output is a sentence a person can hold up against the contract on
 * file ("AWP − 17.4%, ±1.2 points, on 212 brand fills") and a per-fill residual for the ones that
 * do not fit, which is where the underpayments and the DIR live.
 *
 * What this is not: it is not the plan's contract, and nothing downstream may treat it as one. It
 * is the plan's behaviour, measured, and it is labelled with how well it was measured.
 *
 * Pure.
 */

export type FitClaim = {
  planKey: string;
  ndc11: string;
  /** "B" or "G" from NADAC's classification; null where unknown. */
  classification: string | null;
  /** The product key, for the MAC test. */
  productKey: string | null;
  quantityThousandths: number;
  ingredientPaidCents: number;
  nadacUnitMicros: number | null;
  awpUnitMicros: number | null;
};

export type Formula = "nadac_plus" | "awp_minus" | "mac_per_product";

export type Fit = {
  planKey: string;
  classification: "B" | "G" | "?";
  fills: number;
  formula: Formula | null;
  /** The fitted constant: k for NADAC + k% (may be negative), d for AWP − d%. Null for MAC. */
  percent: number | null;
  /** Scatter of the fitted ratio: the interquartile range in percentage points. */
  spreadPoints: number | null;
  /** The best fit's scatter against the next best, so a close call is not reported as a finding. */
  margin: number | null;
  says: string;
  /** Per fill, what the fitted formula says it should have paid, and the gap. */
  residuals: { ndc11: string; expectedCents: number; paidCents: number; gapCents: number }[];
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function iqr(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return at(0.75) - at(0.25);
}

type Candidate = { formula: Formula; percent: number | null; spreadPoints: number; expected: (c: FitClaim) => number | null; n: number };

/**
 * Fits one plan and one class. `minFills` is the floor below which nothing is said; `minMargin`
 * is how much better, in points of scatter, the best fit must be than the runner-up to be named
 * rather than called a close call.
 */
export function fitPlan(claims: FitClaim[], opts: { minFills?: number; minMargin?: number } = {}): Fit[] {
  const minFills = opts.minFills ?? 12;
  const minMargin = opts.minMargin ?? 1;
  const byKey = new Map<string, FitClaim[]>();
  for (const c of claims) {
    if (c.quantityThousandths <= 0 || c.ingredientPaidCents <= 0) continue;
    const cls = c.classification === "B" || c.classification === "G" ? c.classification : "?";
    const k = `${c.planKey}|${cls}`;
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }

  const out: Fit[] = [];
  for (const [k, cs] of byKey) {
    const [planKey, cls] = k.split("|") as [string, "B" | "G" | "?"];
    const perUnit = (c: FitClaim) => (c.ingredientPaidCents * 10_000) / (c.quantityThousandths / 1000); // micros per unit
    const candidates: Candidate[] = [];

    // NADAC + k%
    const nad = cs.filter((c) => c.nadacUnitMicros && c.nadacUnitMicros > 0);
    if (nad.length >= minFills) {
      const ratios = nad.map((c) => (perUnit(c) / c.nadacUnitMicros!) * 100);
      const k1 = median(ratios) - 100;
      candidates.push({ formula: "nadac_plus", percent: k1, spreadPoints: iqr(ratios), n: nad.length, expected: (c) => (c.nadacUnitMicros ? Math.round((c.nadacUnitMicros * (1 + k1 / 100) * c.quantityThousandths) / 1000 / 10_000) : null) });
    }
    // AWP − d%
    const awp = cs.filter((c) => c.awpUnitMicros && c.awpUnitMicros > 0);
    if (awp.length >= minFills) {
      const ratios = awp.map((c) => (perUnit(c) / c.awpUnitMicros!) * 100);
      const d = 100 - median(ratios);
      candidates.push({ formula: "awp_minus", percent: d, spreadPoints: iqr(ratios), n: awp.length, expected: (c) => (c.awpUnitMicros ? Math.round((c.awpUnitMicros * (1 - d / 100) * c.quantityThousandths) / 1000 / 10_000) : null) });
    }
    // MAC per product: within each product the per-unit paid is one constant; scatter is measured
    // as each fill's deviation from its product's median, in percent, over products with two or more fills.
    const byProduct = new Map<string, FitClaim[]>();
    for (const c of cs) if (c.productKey) byProduct.set(c.productKey, [...(byProduct.get(c.productKey) ?? []), c]);
    const macMedian = new Map<string, number>();
    const devs: number[] = [];
    let macN = 0;
    for (const [pk, list] of byProduct) {
      if (list.length < 2) continue;
      const m = median(list.map(perUnit));
      macMedian.set(pk, m);
      for (const c of list) { devs.push(((perUnit(c) - m) / m) * 100); macN++; }
    }
    if (macN >= minFills) {
      candidates.push({ formula: "mac_per_product", percent: null, spreadPoints: iqr(devs), n: macN, expected: (c) => (c.productKey && macMedian.has(c.productKey) ? Math.round((macMedian.get(c.productKey)! * c.quantityThousandths) / 1000 / 10_000) : null) });
    }

    if (candidates.length === 0) {
      out.push({ planKey, classification: cls, fills: cs.length, formula: null, percent: null, spreadPoints: null, margin: null, says: `${cs.length} fill${cs.length === 1 ? "" : "s"}; ${minFills} with a benchmark are needed before a formula is tried.`, residuals: [] });
      continue;
    }
    candidates.sort((a, b) => a.spreadPoints - b.spreadPoints);
    const best = candidates[0];
    const runner = candidates[1] ?? null;
    const margin = runner ? runner.spreadPoints - best.spreadPoints : null;
    const clsWord = cls === "B" ? "brand" : cls === "G" ? "generic" : "unclassified";
    const name =
      best.formula === "nadac_plus" ? `NADAC ${best.percent! >= 0 ? "+" : "−"} ${Math.abs(best.percent!).toFixed(1)}%` :
      best.formula === "awp_minus" ? `AWP − ${best.percent!.toFixed(1)}%` : "a MAC per product";
    const closeCall = margin !== null && margin < minMargin;
    const says = closeCall
      ? `${clsWord}: ${name} fits best (±${(best.spreadPoints / 2).toFixed(1)} points on ${best.n} fills) but ${runner!.formula === "nadac_plus" ? "NADAC-based" : runner!.formula === "awp_minus" ? "AWP-based" : "a MAC"} fits nearly as well; not settled.`
      : `${clsWord}: ${name}, ±${(best.spreadPoints / 2).toFixed(1)} points, on ${best.n} fills.`;
    const residuals = cs
      .map((c) => { const e = best.expected(c); return e === null ? null : { ndc11: c.ndc11, expectedCents: e, paidCents: c.ingredientPaidCents, gapCents: c.ingredientPaidCents - e }; })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.gapCents - b.gapCents);
    out.push({ planKey, classification: cls, fills: cs.length, formula: closeCall ? null : best.formula, percent: closeCall ? null : best.percent, spreadPoints: best.spreadPoints, margin, says, residuals });
  }
  return out.sort((a, b) => b.fills - a.fills);
}
