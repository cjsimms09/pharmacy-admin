/**
 * Replaying a year of dispensing through each wholesaler's contract.
 *
 * The McKesson agreement comes up in six months and the question is which wholesaler's terms
 * would have cost least on what this pharmacy actually dispensed. Not on a basket of sample items,
 * and not on the NDCs it happened to buy: on every fill of the period, priced at what each
 * supplier would have charged for the cheapest product it sells that is the *same product* — same
 * drug, strength, form, brand-or-generic, pricing unit — because that is what a pharmacy switching
 * wholesalers would buy.
 *
 * ── What "same product" means ──
 *
 * `product-groups.ts` keys NDCs off NADAC's description, its brand/generic flag and its pricing
 * unit, and refuses to key a description too thin to be safe. A brand is never replayed as its
 * generic: substitution is the pharmacist's and the plan's decision, not a price comparison's.
 *
 * ── What the rebate does ──
 *
 * Each supplier's ladder is applied to the replayed spend as its own terms say: the ratio that
 * drives the ladder is computed from the replayed month (generic spend over Rx spend, or
 * contract-flagged spend over the rest, per the programme), the tier at that ratio is looked up,
 * and the rate is taken off the spend the programme calls eligible. A supplier with no ladder on
 * file earns nothing here, and the result says so, because an invented rate is a recommendation to
 * sign a contract on a discount that does not exist.
 *
 * ── What it will not do ──
 *
 * It does not price what a supplier does not sell. A fill whose product no NDC at the supplier
 * matches is counted as unmatched, with its units and what it cost at the dispensed NDC's own
 * price where that is known, and shown beside the total rather than folded into it — a supplier
 * that is cheapest on ninety per cent of the dispensing and cannot supply the rest is a different
 * proposition from one that can supply all of it, and the page has to say which.
 *
 * Pure.
 */
import type { RebateTermsT } from "./supplier-terms";
import { rebateTierFor } from "./supplier-terms";

export type ReplayFill = {
  dateFilled: string;
  ndc11: string;
  quantityThousandths: number;
};

export type ReplayProduct = {
  ndc11: string;
  /** From product-groups.ts. Null where the NDC cannot be placed safely. */
  groupKey: string | null;
  classification: "B" | "G" | null;
};

export type ReplayOffer = {
  supplier: string;
  ndc11: string;
  /** Per dispensing unit, in micros. */
  unitCostMicros: number;
  /** The catalogue's contract/rebate mark, where it prints one. */
  rebated: boolean | null;
  description?: string | null;
};

export type ReplayContract = {
  supplier: string;
  supplierId: string | null;
  /** Every programme in force: a generic ladder, a brand factor, a flat rate. */
  programmes: { name: string; terms: RebateTermsT }[];
};

export type ReplayLine = {
  ndc11: string;
  /** The NDC the supplier would sell instead, where it differs. */
  boughtNdc11: string;
  unitsThousandths: number;
  costCents: number;
  classification: "B" | "G" | null;
  rebated: boolean | null;
};

export type ReplayMonth = {
  month: string;
  grossCents: number;
  genericCents: number;
  brandCents: number;
  flaggedCents: number;
  /** The ratio each programme measured, and the tier it landed on. */
  programmes: { name: string; ratioPercent: number | null; tierPercent: number | null; eligibleCents: number; rebateCents: number }[];
  rebateCents: number;
  netCents: number;
  unmatched: { fills: number; unitsThousandths: number };
};

export type SupplierReplay = {
  supplier: string;
  supplierId: string | null;
  months: ReplayMonth[];
  grossCents: number;
  rebateCents: number;
  netCents: number;
  /** Fills the supplier could supply, over all fills with a placeable product. */
  coverage: { fills: number; matched: number; share: number };
  unmatched: { fills: number; unitsThousandths: number; products: { groupKey: string; fills: number }[] };
  /** Where this supplier is cheapest and where it is dearest, per product, for the detail. */
  byProduct: { groupKey: string; name: string | null; unitsThousandths: number; costCents: number }[];
  hasTerms: boolean;
  says: string;
};

export type Replay = {
  from: string;
  to: string;
  fills: number;
  /** Fills whose product could not be keyed, and are in no supplier's figures. */
  unplaceable: number;
  suppliers: SupplierReplay[];
  /** Cheapest net first, among suppliers covering at least `minCoverage` of the fills. */
  ranking: { supplier: string; netCents: number; coverageShare: number; eligible: boolean }[];
  says: string;
};

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/** The cheapest NDC a supplier sells in a product group, by unit price. */
function cheapestBy(offers: ReplayOffer[], products: Map<string, ReplayProduct>): Map<string, Map<string, ReplayOffer>> {
  const out = new Map<string, Map<string, ReplayOffer>>();
  for (const o of offers) {
    const key = products.get(o.ndc11)?.groupKey;
    if (!key) continue;
    let bySupplier = out.get(o.supplier);
    if (!bySupplier) {
      bySupplier = new Map();
      out.set(o.supplier, bySupplier);
    }
    const have = bySupplier.get(key);
    if (!have || o.unitCostMicros < have.unitCostMicros) bySupplier.set(key, o);
  }
  return out;
}

/** What a programme's ladder measures, from the replayed month, and what it pays on. */
function programmeMonth(terms: RebateTermsT, m: { grossCents: number; genericCents: number; brandCents: number; flaggedCents: number }): { ratioPercent: number | null; tierPercent: number | null; eligibleCents: number; rebateCents: number } {
  const eligibleCents =
    terms.eligibility === "catalog_rebate_flag" ? m.flaggedCents : terms.eligibility === "all_generics" ? m.genericCents : terms.eligibility === "brand_purchases" ? m.brandCents : m.grossCents;
  if (terms.kind === "flat_percent") {
    const rate = terms.tiers[0]?.rebatePercent ?? 0;
    return { ratioPercent: null, tierPercent: rate, eligibleCents, rebateCents: Math.round((eligibleCents * rate) / 100) };
  }
  /*
   * The ratio the ladder is measured on, from the replayed spend itself. Generic compliance is the
   * contract-flagged (or generic) share of Rx spend; the generic purchase ratio is generic over Rx.
   * Neither is the wholesaler's scrubbed figure — exclusions the statement applies are not known
   * here — so the ratio is the unscrubbed one, which understates the band. Said in the result.
   */
  const numerator = terms.ratioMeasure === "generic_purchase_ratio" ? m.genericCents : terms.eligibility === "catalog_rebate_flag" ? m.flaggedCents : m.genericCents;
  const ratioPercent = m.grossCents > 0 ? Math.round((numerator / m.grossCents) * 10000) / 100 : null;
  const tier = ratioPercent === null ? null : rebateTierFor(terms, ratioPercent);
  const rate = tier?.rebatePercent ?? 0;
  return { ratioPercent, tierPercent: tier?.rebatePercent ?? null, eligibleCents, rebateCents: Math.round((eligibleCents * rate) / 100) };
}

export function replayContracts(input: {
  fills: ReplayFill[];
  products: ReplayProduct[];
  offers: ReplayOffer[];
  contracts: ReplayContract[];
  /** A supplier covering less than this share of fills is ranked but marked ineligible. */
  minCoverage?: number;
}): Replay {
  const minCoverage = input.minCoverage ?? 0.9;
  const products = new Map(input.products.map((p) => [p.ndc11, p]));
  const cheapest = cheapestBy(input.offers, products);
  const placeable = input.fills.filter((f) => products.get(f.ndc11)?.groupKey);
  const unplaceable = input.fills.length - placeable.length;
  const dates = input.fills.map((f) => f.dateFilled).sort();
  const from = dates[0] ?? "";
  const to = dates[dates.length - 1] ?? "";
  const months = [...new Set(placeable.map((f) => f.dateFilled.slice(0, 7)))].sort();
  const nameOf = new Map<string, string | null>();
  for (const o of input.offers) {
    const k = products.get(o.ndc11)?.groupKey;
    if (k && !nameOf.has(k)) nameOf.set(k, o.description ?? null);
  }

  const suppliers: SupplierReplay[] = input.contracts.map((c) => {
    const bySupplier = cheapest.get(c.supplier) ?? new Map<string, ReplayOffer>();
    const monthRows: ReplayMonth[] = [];
    const unmatchedBy = new Map<string, number>();
    const byProduct = new Map<string, { name: string | null; unitsThousandths: number; costCents: number }>();
    let matched = 0;
    let unmatchedFills = 0;
    let unmatchedUnits = 0;

    for (const month of months) {
      const m = { grossCents: 0, genericCents: 0, brandCents: 0, flaggedCents: 0 };
      const um = { fills: 0, unitsThousandths: 0 };
      for (const f of placeable.filter((x) => x.dateFilled.startsWith(month))) {
        const p = products.get(f.ndc11)!;
        const offer = bySupplier.get(p.groupKey!);
        if (!offer) {
          um.fills++;
          um.unitsThousandths += f.quantityThousandths;
          unmatchedFills++;
          unmatchedUnits += f.quantityThousandths;
          unmatchedBy.set(p.groupKey!, (unmatchedBy.get(p.groupKey!) ?? 0) + 1);
          continue;
        }
        matched++;
        // units (thousandths / 1000) × micros per unit, to cents: micros / 10,000.
        const cost = Math.round((f.quantityThousandths * offer.unitCostMicros) / 1000 / 10_000);
        m.grossCents += cost;
        if (p.classification === "B") m.brandCents += cost;
        else m.genericCents += cost;
        if (offer.rebated === true) m.flaggedCents += cost;
        const bp = byProduct.get(p.groupKey!) ?? { name: nameOf.get(p.groupKey!) ?? null, unitsThousandths: 0, costCents: 0 };
        bp.unitsThousandths += f.quantityThousandths;
        bp.costCents += cost;
        byProduct.set(p.groupKey!, bp);
      }
      const programmes = c.programmes.map((pr) => ({ name: pr.name, ...programmeMonth(pr.terms, m) }));
      const rebateCents = programmes.reduce((n, p) => n + p.rebateCents, 0);
      monthRows.push({ month, ...m, programmes, rebateCents, netCents: m.grossCents - rebateCents, unmatched: um });
    }

    const grossCents = monthRows.reduce((n, r) => n + r.grossCents, 0);
    const rebateCents = monthRows.reduce((n, r) => n + r.rebateCents, 0);
    const share = placeable.length > 0 ? matched / placeable.length : 0;
    const hasTerms = c.programmes.length > 0;
    return {
      supplier: c.supplier,
      supplierId: c.supplierId,
      months: monthRows,
      grossCents,
      rebateCents,
      netCents: grossCents - rebateCents,
      coverage: { fills: placeable.length, matched, share },
      unmatched: {
        fills: unmatchedFills,
        unitsThousandths: unmatchedUnits,
        products: [...unmatchedBy.entries()].map(([groupKey, fills]) => ({ groupKey, fills })).sort((a, b) => b.fills - a.fills).slice(0, 25),
      },
      byProduct: [...byProduct.entries()].map(([groupKey, v]) => ({ groupKey, ...v })).sort((a, b) => b.costCents - a.costCents),
      hasTerms,
      says:
        matched === 0
          ? `${c.supplier} prices none of the products dispensed. Load its catalogue first.`
          : `${c.supplier}: ${dollars(grossCents)} on the invoice for ${Math.round(share * 100)}% of the fills, ${hasTerms ? `${dollars(rebateCents)} back on its ladder, ${dollars(grossCents - rebateCents)} net` : "no rebate terms on file, so the net is the gross"}${unmatchedFills > 0 ? `; ${unmatchedFills} fills it could not supply` : ""}.`,
    };
  });

  const ranking = suppliers
    .filter((s) => s.coverage.matched > 0)
    .map((s) => ({ supplier: s.supplier, netCents: s.netCents, coverageShare: s.coverage.share, eligible: s.coverage.share >= minCoverage }))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.netCents - b.netCents);

  /*
   * Net cost is only comparable between suppliers that priced the same fills. Two suppliers that
   * each supply nine tenths of the dispensing are compared on the fills both can supply, below;
   * here the headline says which is cheapest among those that cover enough, and what the runner-up
   * would cost more.
   */
  const eligible = ranking.filter((r) => r.eligible);
  let says: string;
  if (eligible.length === 0) says = `No supplier covers ${Math.round(minCoverage * 100)}% of the fills from its catalogue, so no contract can be ranked yet. Load the missing catalogues.`;
  else if (eligible.length === 1) says = `Only ${eligible[0].supplier} covers ${Math.round(minCoverage * 100)}% of the fills; nothing to rank it against yet.`;
  else {
    const [a, b] = eligible;
    says = `${a.supplier} is cheapest at ${dollars(a.netCents)} net over ${months.length} month${months.length === 1 ? "" : "s"}; ${b.supplier} would cost ${dollars(b.netCents - a.netCents)} more. Ratios are unscrubbed, so every ladder is understated the same way.`;
  }

  return { from, to, fills: input.fills.length, unplaceable, suppliers, ranking, says };
}

/**
 * The same fills at two suppliers, restricted to the products both can supply, so the comparison
 * is of prices and not of catalogue coverage.
 */
export function headToHead(replay: Replay, a: string, b: string): { fills: number; aCents: number; bCents: number; products: { groupKey: string; name: string | null; aCents: number; bCents: number }[] } | null {
  const sa = replay.suppliers.find((s) => s.supplier === a);
  const sb = replay.suppliers.find((s) => s.supplier === b);
  if (!sa || !sb) return null;
  const bMap = new Map(sb.byProduct.map((p) => [p.groupKey, p]));
  const products = sa.byProduct
    .filter((p) => bMap.has(p.groupKey))
    .map((p) => ({ groupKey: p.groupKey, name: p.name, aCents: p.costCents, bCents: bMap.get(p.groupKey)!.costCents }))
    .sort((x, y) => Math.abs(y.aCents - y.bCents) - Math.abs(x.aCents - x.bCents));
  return { fills: products.length, aCents: products.reduce((n, p) => n + p.aCents, 0), bCents: products.reduce((n, p) => n + p.bCents, 0), products };
}
