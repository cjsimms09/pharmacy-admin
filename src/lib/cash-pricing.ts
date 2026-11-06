/**
 * Cash pricing against cost and against what a plan would have to pay.
 *
 * A cash fill is a price the pharmacy set, so nothing here is owed by anybody and nothing is an
 * appeal. It is a different question: is the price right? Two figures answer it. What the drug
 * cost, below which every cash fill is a gift; and what a plan would have to pay for the same
 * fill under the Kansas floor — NADAC plus the dispensing fee — which is the fairest public
 * yardstick for a cash price, because it is what the state says a pharmacy needs to dispense a
 * generic without losing money. A cash price under the floor is charity the pharmacy did not
 * decide on; one under cost is a loss on every bottle. Both are listed per product with the
 * fills a month, so the monthly figure is what raising the price is actually worth. Pure.
 */

export type CashFill = {
  key: string;
  ndc11: string;
  name: string | null;
  dateFilled: string;
  quantityThousandths: number | null;
  /** What the patient paid: the cash price, the whole of the fill's revenue. */
  chargedCents: number;
  /** What the drug cost, from the invoice where the fill carries it. Null where not known. */
  acquisitionCents: number | null;
};

export type CashPricingInput = {
  fills: CashFill[];
  /** NADAC per unit, micros, by NDC. Absent where no NADAC is held. */
  nadacMicros: Map<string, number>;
  /** The dispensing fee the floor adds: the greater of $10.50 and the Kansas Medicaid fee. */
  feeCents: number;
  /** Months the fills span, so fills become fills a month. */
  months: number;
  /** Below this a month, a row is noise. */
  materialityCents?: number;
};

export type CashPricingRow = {
  ndc11: string;
  name: string | null;
  fills: number;
  fillsPerMonth: number;
  /** Median units per fill, thousandths. */
  typicalThousandths: number;
  /** Medians, per fill of the typical quantity. */
  chargedCents: number;
  costCents: number | null;
  floorCents: number | null;
  /** Charged less cost. Null where cost is not known. */
  marginCents: number | null;
  /** The price to move to and why: the floor, or cost plus the fee where the floor cannot be priced. */
  targetCents: number | null;
  reason: "under_cost" | "under_floor" | null;
  /** (target − charged) × fills a month. */
  gainPerMonthCents: number;
  why: string;
};

export type CashPricing = {
  rows: CashPricingRow[];
  /** Products with a cash price under cost or under the floor, and what raising them is worth a month. */
  underPriced: CashPricingRow[];
  gainPerMonthCents: number;
  /** Cash fills read, and how many carried a cost. */
  fills: number;
  withCost: number;
  /** Products that could not be judged: no cost and no NADAC. */
  unjudged: number;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

export function cashPricing(input: CashPricingInput): CashPricing {
  const months = Math.max(0.25, input.months);
  const materiality = input.materialityCents ?? 500;
  const byNdc = new Map<string, CashFill[]>();
  let withCost = 0;
  for (const f of input.fills) {
    if (!f.ndc11 || (f.quantityThousandths ?? 0) <= 0 || f.chargedCents <= 0) continue;
    if (f.acquisitionCents !== null) withCost++;
    byNdc.set(f.ndc11, [...(byNdc.get(f.ndc11) ?? []), f]);
  }

  const rows: CashPricingRow[] = [];
  let unjudged = 0;
  for (const [ndc11, fills] of byNdc) {
    const typical = median(fills.map((f) => f.quantityThousandths as number));
    // Every fill scaled to the typical quantity, so a 90-day fill does not read as a dearer price.
    const scale = (cents: number, qty: number) => Math.round((cents * typical) / qty);
    const charged = median(fills.map((f) => scale(f.chargedCents, f.quantityThousandths as number)));
    const costs = fills.filter((f) => f.acquisitionCents !== null && f.acquisitionCents > 0).map((f) => scale(f.acquisitionCents as number, f.quantityThousandths as number));
    const cost = costs.length ? median(costs) : null;
    const nadac = input.nadacMicros.get(ndc11);
    const floor = nadac ? Math.round((nadac * typical) / 1000 / 10_000) + input.feeCents : null;
    if (cost === null && floor === null) {
      unjudged++;
      continue;
    }
    const fillsPerMonth = fills.length / months;
    const margin = cost === null ? null : charged - cost;
    let reason: CashPricingRow["reason"] = null;
    let target: number | null = null;
    if (cost !== null && charged < cost) {
      reason = "under_cost";
      target = Math.max(floor ?? 0, cost + input.feeCents);
    } else if (floor !== null && charged < floor) {
      reason = "under_floor";
      target = floor;
    }
    const gain = reason && target !== null ? Math.round((target - charged) * fillsPerMonth) : 0;
    const name = fills.find((f) => f.name)?.name ?? null;
    const why =
      reason === "under_cost"
        ? `Charged ${dollars(charged)} against a cost of ${dollars(cost as number)}: ${dollars((cost as number) - charged)} lost on every fill. ${floor !== null ? `A plan would have to pay ${dollars(floor)} for this fill under the Kansas floor.` : "No NADAC is held, so the target is cost plus the dispensing fee."}`
        : reason === "under_floor"
          ? `Charged ${dollars(charged)}; a plan would have to pay at least ${dollars(floor as number)} for this fill (NADAC plus the ${dollars(input.feeCents)} fee). ${cost !== null ? `It costs ${dollars(cost)}, so the price clears cost but gives away ${dollars((floor as number) - charged)} a fill against the public yardstick.` : "Cost is not on the fill."}`
          : cost !== null
            ? `Charged ${dollars(charged)} against a cost of ${dollars(cost)}${floor !== null ? ` and a floor of ${dollars(floor)}` : ""}: priced above both.`
            : `Charged ${dollars(charged)}, above the ${dollars(floor as number)} floor; cost is not on the fill.`;
    rows.push({ ndc11, name, fills: fills.length, fillsPerMonth, typicalThousandths: typical, chargedCents: charged, costCents: cost, floorCents: floor, marginCents: margin, targetCents: target, reason, gainPerMonthCents: gain, why });
  }
  rows.sort((a, b) => b.gainPerMonthCents - a.gainPerMonthCents || b.fills - a.fills);
  const underPriced = rows.filter((r) => r.reason !== null && r.gainPerMonthCents >= materiality);
  return { rows, underPriced, gainPerMonthCents: underPriced.reduce((n, r) => n + r.gainPerMonthCents, 0), fills: input.fills.length, withCost, unjudged };
}
