/**
 * For every drug this pharmacy dispenses: how its payers actually pay for it, and therefore which
 * NDC to buy, from where, to earn the most on it.
 *
 * The owner's brief: "not just the cheapest drug — the drug with the most profit based on my
 * payers and claims. If I have a lot of claims for omeprazole paid NADAC + $10.50, the goal for
 * omeprazole is the NDC I can buy for the most under NADAC. Do this for each drug we dispense."
 *
 * The cheapest NDC is only the most profitable one when the reimbursement does not move with the
 * NDC. Under a MAC or a flat price it does not, so the cheapest wins. Under NADAC-plus-a-fee the
 * plan pays each NDC's own NADAC, so the NDC to buy is the one whose price sits furthest *below
 * its own NADAC* — which is often not the cheapest one. Under AWP-less-a-discount the plan pays a
 * share of each NDC's own AWP, so a dearer NDC with a much higher AWP can earn more. The model is
 * the whole question, and it is read off the claims — the basis-of-reimbursement code the PBM
 * returns where the export carries it, and the arithmetic of what was paid against the benchmarks
 * where it does not — never assumed.
 *
 * Everything here is per fill of the typical quantity, so a drug filled fifty times a month at
 * thirty tablets is compared on thirty tablets fifty times, not on a bottle of a thousand. Pure.
 */

export type Model = "NADAC" | "AWP" | "MAC" | "UC" | "WAC" | "FUL" | "flat" | "unknown";

/** One payer's adjudication of one fill. Only the pricing leg of a coordinated fill is used. */
export type ClaimLeg = {
  fillKey: string;
  ndc11: string;
  dateFilled: string;
  payer: string | null;
  /** NCPDP 522-FM, as the PBM returned it. Null where the export does not carry it. */
  basisCode: string | null;
  quantityThousandths: number | null;
  /** What this payer remitted in all: ingredient plus fee. */
  remitCents: number;
  ingredientPaidCents: number | null;
  feePaidCents: number | null;
  /** The AWP the PBM priced this quantity at, where the export carries it. A total, not per unit. */
  awpCents: number | null;
  cashPlan: boolean;
};

export type Price = {
  ndc11: string;
  supplier: string;
  /** Per unit after the rebate this line earns, micros. */
  effectiveUnitMicros: number;
  source: "invoice" | "catalogue";
  itemNumber?: string | null;
};

export type Bench = {
  ndc11: string;
  description: string | null;
  /** Per unit, micros. Null where the benchmark is not held for this NDC. */
  nadacMicros: number | null;
  awpMicros: number | null;
};

export type ProfitInput = {
  legs: ClaimLeg[];
  prices: Price[];
  bench: Bench[];
  /** The product each NDC belongs to. Null places the NDC in a group of its own. */
  groupOf: (ndc11: string) => string | null;
  /** How many months the claims span, so fills become fills a month. */
  months: number;
};

export type Candidate = {
  ndc11: string;
  name: string | null;
  supplier: string;
  itemNumber: string | null;
  source: Price["source"];
  unitMicros: number;
  /** Per fill of the typical quantity. */
  revenueCents: number;
  costCents: number;
  marginCents: number;
};

export type DrugProfit = {
  group: string;
  name: string | null;
  fills: number;
  fillsPerMonth: number;
  /** Units per fill, thousandths: the median. */
  typicalThousandths: number;
  model: Model;
  /** Share of fills paid on the dominant model. */
  modelShare: number;
  /** How the dominant model pays, in words: "NADAC + $10.50", "AWP − 17% + $1.00", "$0.0421 a unit + $1.50". */
  modelSays: string;
  payers: { payer: string; fills: number; model: Model }[];
  /** The NDC most dispensed today, and what it earns on the price it is bought at. */
  current: { ndc11: string; name: string | null; supplier: string | null; marginCents: number | null } | null;
  best: Candidate | null;
  candidates: Candidate[];
  /** best − current, per fill and per month. Null where the current cannot be priced. */
  gainPerFillCents: number | null;
  gainPerMonthCents: number | null;
  /** Why some NDCs could not be placed: no price, no benchmark under this model. */
  leftOut: { noPrice: number; noBenchmark: number };
  why: string;
};

/**
 * NCPDP 522-FM: what the PBM said it priced the ingredient on. Only the codes that decide the
 * question are read; the rest are a flat price as far as choosing an NDC goes.
 */
export function modelFromBasis(code: string | null): Model | null {
  const c = (code ?? "").trim().replace(/^0+(?=\d)/, "");
  if (!c) return null;
  switch (c) {
    case "1": return "AWP";
    case "6": return "MAC";
    case "7": return "UC";
    case "12": return "WAC";
    case "15": return "FUL";
    case "20": return "NADAC";
    case "3": case "4": case "5": case "8": case "9": case "10": case "11": case "13": case "14": return "flat";
    default: return null;
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const cents = (micros: number, thousandths: number) => Math.round((micros * thousandths) / 1000 / 10_000);
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
const perUnit = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

type Read = { model: Model; fee: number; ratio: number | null; discount: number | null; unitPaidMicros: number | null; qty: number; payer: string };

/** How one leg was paid: the code where there is one, the arithmetic where there is not. */
function readLeg(l: ClaimLeg, bench: Map<string, Bench>): Read | null {
  const qty = l.quantityThousandths ?? 0;
  if (qty <= 0 || l.remitCents <= 0) return null;
  const ing = l.ingredientPaidCents ?? (l.feePaidCents !== null ? l.remitCents - l.feePaidCents : null);
  const fee = l.feePaidCents ?? (l.ingredientPaidCents !== null ? l.remitCents - l.ingredientPaidCents : 0);
  const paid = ing ?? l.remitCents - fee;
  const b = bench.get(l.ndc11);
  const nadacCents = b?.nadacMicros ? cents(b.nadacMicros, qty) : null;
  const awpTotal = l.awpCents ?? (b?.awpMicros ? cents(b.awpMicros, qty) : null);
  const payer = l.payer?.trim() || "unnamed";

  let model = modelFromBasis(l.basisCode);
  if (model === null) {
    // Within three per cent of the NDC's own NADAC is NADAC; a stable fraction of AWP is AWP; else flat.
    if (nadacCents !== null && nadacCents > 0 && Math.abs(paid - nadacCents) <= Math.max(2, nadacCents * 0.03)) model = "NADAC";
    else if (awpTotal !== null && awpTotal > 0 && paid / awpTotal >= 0.05 && paid / awpTotal <= 0.95) model = "AWP";
    else model = ing === null && l.feePaidCents === null ? "unknown" : "flat";
  }
  return {
    model,
    fee,
    ratio: nadacCents !== null && nadacCents > 0 ? paid / nadacCents : null,
    discount: awpTotal !== null && awpTotal > 0 ? 1 - paid / awpTotal : null,
    unitPaidMicros: Math.round((paid * 10_000 * 1000) / qty),
    qty,
    payer,
  };
}

/** What a fill of `qty` would pay for `ndc` under the model, or null where the benchmark it needs is not held. */
function revenueFor(model: Model, p: { fee: number; ratio: number; discount: number; unitPaidMicros: number }, qty: number, b: Bench | undefined): number | null {
  if (model === "NADAC") return b?.nadacMicros ? Math.round(cents(b.nadacMicros, qty) * p.ratio) + p.fee : null;
  if (model === "AWP") return b?.awpMicros ? Math.round(cents(b.awpMicros, qty) * (1 - p.discount)) + p.fee : null;
  return cents(p.unitPaidMicros, qty) + p.fee;
}

export function drugProfit(input: ProfitInput): DrugProfit[] {
  const bench = new Map(input.bench.map((b) => [b.ndc11, b]));
  const months = Math.max(0.25, input.months);

  // The pricing leg of every fill: the one that paid the most. A secondary pays the residual.
  const byFill = new Map<string, ClaimLeg>();
  for (const l of input.legs) {
    if (l.cashPlan || l.remitCents <= 0) continue;
    const have = byFill.get(l.fillKey);
    if (!have || l.remitCents > have.remitCents) byFill.set(l.fillKey, l);
  }

  const groups = new Map<string, { legs: { leg: ClaimLeg; read: Read }[]; ndcs: Set<string> }>();
  for (const leg of byFill.values()) {
    const read = readLeg(leg, bench);
    if (!read) continue;
    const key = input.groupOf(leg.ndc11) ?? `ndc:${leg.ndc11}`;
    const g = groups.get(key) ?? { legs: [], ndcs: new Set<string>() };
    g.legs.push({ leg, read });
    g.ndcs.add(leg.ndc11);
    groups.set(key, g);
  }

  // Every NDC that could be dispensed in place of one in the group: the same product, priced anywhere.
  const ndcsByGroup = new Map<string, Set<string>>();
  for (const p of input.prices) {
    const key = input.groupOf(p.ndc11);
    if (!key) continue;
    const set = ndcsByGroup.get(key) ?? new Set<string>();
    set.add(p.ndc11);
    ndcsByGroup.set(key, set);
  }
  const pricesByNdc = new Map<string, Price[]>();
  for (const p of input.prices) pricesByNdc.set(p.ndc11, [...(pricesByNdc.get(p.ndc11) ?? []), p]);
  const nameOf = (ndc: string, fallback: string | null) => bench.get(ndc)?.description ?? fallback;

  const out: DrugProfit[] = [];
  for (const [group, g] of groups) {
    const fills = g.legs.length;
    const tally = new Map<Model, number>();
    for (const { read } of g.legs) tally.set(read.model, (tally.get(read.model) ?? 0) + 1);
    const [model, modelCount] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const on = g.legs.filter((x) => x.read.model === model).map((x) => x.read);
    const params = {
      fee: median(on.map((r) => r.fee)),
      ratio: on.some((r) => r.ratio !== null) ? median(on.filter((r) => r.ratio !== null).map((r) => Math.round((r.ratio as number) * 10_000))) / 10_000 : 1,
      discount: on.some((r) => r.discount !== null) ? median(on.filter((r) => r.discount !== null).map((r) => Math.round((r.discount as number) * 10_000))) / 10_000 : 0,
      unitPaidMicros: median(on.map((r) => r.unitPaidMicros as number)),
    };
    const typical = median(g.legs.map((x) => x.read.qty));

    const payerTally = new Map<string, { fills: number; models: Map<Model, number> }>();
    for (const { read } of g.legs) {
      const p = payerTally.get(read.payer) ?? { fills: 0, models: new Map<Model, number>() };
      p.fills++;
      p.models.set(read.model, (p.models.get(read.model) ?? 0) + 1);
      payerTally.set(read.payer, p);
    }
    const payers = [...payerTally.entries()]
      .sort((a, b) => b[1].fills - a[1].fills)
      .slice(0, 4)
      .map(([payer, p]) => ({ payer, fills: p.fills, model: [...p.models.entries()].sort((a, b) => b[1] - a[1])[0][0] }));

    // Candidates: every NDC in the product with a price, under the dominant model.
    const ndcs = new Set<string>([...g.ndcs, ...(ndcsByGroup.get(group) ?? [])]);
    const candidates: Candidate[] = [];
    const leftOut = { noPrice: 0, noBenchmark: 0 };
    for (const ndc of ndcs) {
      const prices = pricesByNdc.get(ndc) ?? [];
      if (prices.length === 0) {
        leftOut.noPrice++;
        continue;
      }
      const revenue = revenueFor(model, params, typical, bench.get(ndc));
      if (revenue === null) {
        leftOut.noBenchmark++;
        continue;
      }
      for (const p of prices) {
        const cost = cents(p.effectiveUnitMicros, typical);
        candidates.push({ ndc11: ndc, name: nameOf(ndc, null), supplier: p.supplier, itemNumber: p.itemNumber ?? null, source: p.source, unitMicros: p.effectiveUnitMicros, revenueCents: revenue, costCents: cost, marginCents: revenue - cost });
      }
    }
    candidates.sort((a, b) => b.marginCents - a.marginCents || a.costCents - b.costCents);
    const best = candidates[0] ?? null;

    // Today: the NDC dispensed most, at the price it was last bought for, else the cheapest listed.
    const dispensed = new Map<string, number>();
    for (const { leg } of g.legs) dispensed.set(leg.ndc11, (dispensed.get(leg.ndc11) ?? 0) + 1);
    const currentNdc = [...dispensed.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const currentPrices = pricesByNdc.get(currentNdc) ?? [];
    const currentPrice = currentPrices.find((p) => p.source === "invoice") ?? [...currentPrices].sort((a, b) => a.effectiveUnitMicros - b.effectiveUnitMicros)[0] ?? null;
    const currentCandidate = currentPrice ? candidates.find((c) => c.ndc11 === currentNdc && c.supplier === currentPrice.supplier) ?? null : null;
    const current = { ndc11: currentNdc, name: nameOf(currentNdc, g.legs.find((x) => x.leg.ndc11 === currentNdc)?.leg.ndc11 ?? null), supplier: currentPrice?.supplier ?? null, marginCents: currentCandidate?.marginCents ?? null };

    const gainPerFillCents = best && current.marginCents !== null ? best.marginCents - current.marginCents : null;
    const fillsPerMonth = fills / months;
    const gainPerMonthCents = gainPerFillCents === null ? null : Math.round(gainPerFillCents * fillsPerMonth);

    const modelSays =
      model === "NADAC"
        ? `NADAC${params.ratio !== 1 ? ` × ${params.ratio.toFixed(2)}` : ""} + ${dollars(params.fee)}`
        : model === "AWP"
          ? `AWP − ${(params.discount * 100).toFixed(1)}% + ${dollars(params.fee)}`
          : `${perUnit(params.unitPaidMicros)} a unit + ${dollars(params.fee)}${model === "MAC" ? " (MAC)" : model === "UC" ? " (usual and customary)" : model === "unknown" ? " (basis not on the export)" : ""}`;
    const why =
      model === "NADAC"
        ? "Paid on each NDC's own NADAC, so the NDC to buy is the one priced furthest under its own NADAC — not the cheapest."
        : model === "AWP"
          ? "Paid as a share of each NDC's own AWP, so an NDC with a higher AWP earns more even when it costs more."
          : "The price paid does not move with the NDC, so the cheapest NDC after rebate earns the most.";

    out.push({
      group,
      name: nameOf(currentNdc, null),
      fills,
      fillsPerMonth,
      typicalThousandths: typical,
      model,
      modelShare: modelCount / fills,
      modelSays,
      payers,
      current,
      best,
      candidates,
      gainPerFillCents,
      gainPerMonthCents,
      leftOut,
      why,
    });
  }
  out.sort((a, b) => (b.gainPerMonthCents ?? -1) - (a.gainPerMonthCents ?? -1) || b.fills - a.fills);
  return out;
}
