/**
 * Which NDCs to buy: the ones furthest under NADAC after the rebate, not the cheapest.
 *
 * The purchasing table says, per NDC, whether this pharmacy pays more or less than the benchmark.
 * The question the buyer asks is the other way round: across everything that can be bought —
 * every invoice line and every catalogue line, at every supplier — which NDCs sit furthest under
 * NADAC once the rebate is off, and which of them is the one to buy for each product. Under a
 * NADAC-based reimbursement the gap between NADAC and cost is the margin, so a dear NDC with a
 * high NADAC can beat a cheap one with a low NADAC, and the list is ordered by the gap, never by
 * the price.
 *
 * The rebate is already in the cost. `Buy.effectiveUnitMicros` (product-ledger.ts) is the printed
 * price less the tier rate the supplier actually pays on that line, and only where a document says
 * the line earns it. Where a line is marked rebated but no rate is on file it is compared gross and
 * the row says so; that understates the gap, which is the safe direction.
 *
 * What is refused: an NDC with no NADAC (nothing to be under), no per-unit price (a package
 * compared with a unit), or only short-dated stock. Each is listed with the reason, because a
 * list that is silently short reads as good news.
 *
 * Within a product (product-groups.ts) the NDC with the widest gap is the pick, and the gain is
 * what the pick's gap would be worth over the NDC dispensed most today, on the product's own
 * volume. That is the NADAC-payer answer; `ndc-choice.ts` refines it by what each plan actually
 * pays, where the claims have shown it.
 *
 * Pure.
 */

import type { Buy, LedgerRow } from "./product-ledger";

export type BuyRow = {
  ndc11: string;
  name: string | null;
  nadacMicros: number;
  nadacOn: string | null;
  /** The source to buy from: the cheapest effective price that is not short-dated. */
  buy: Buy;
  /** NADAC less the effective cost, per unit. Positive is under NADAC. */
  underNadacMicros: number;
  underNadacPercent: number;
  /** True where the rebate came off the price; false where the line is rebated but no rate is on file. */
  rebateApplied: boolean;
  rebateRateMissing: boolean;
  unitsDispensed: number;
  /** The gap on this NDC's own dispensed units, in cents. */
  worthCents: number;
  /** The gap on what is paid today, per unit, where an invoice price is held. Null where not bought yet. */
  paidUnderNadacMicros: number | null;
  groupKey: string | null;
};

export type Excluded = { ndc11: string; name: string | null; reason: string };

export type ProductPick = {
  groupKey: string;
  name: string | null;
  /** Units dispensed across every NDC of the product. */
  units: number;
  /** Every NDC of the product with a usable gap, widest first. */
  ndcs: BuyRow[];
  pick: BuyRow;
  /** The NDC dispensed most today, where one has been. */
  current: BuyRow | null;
  /** The pick's gap less the current NDC's gap, on the product's units, in cents. Zero when they are the same NDC. */
  gainCents: number;
  /** The pick's gap on the product's units, in cents: what buying it is worth against the benchmark. */
  worthOnProductCents: number;
  says: string;
};

export type UnderNadac = {
  /** Every usable NDC, widest gap first. */
  rows: BuyRow[];
  /** Products with more than one NDC, or one NDC and a different one dispensed today, ranked by what the pick is worth. */
  products: ProductPick[];
  excluded: Excluded[];
};

const MICROS = 1_000_000;
const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const perUnit = (m: number) => `$${(Math.abs(m) / MICROS).toFixed(4)}`;

/** One ledger row as a buy row, or the reason it cannot be one. */
export function buyRowOf(r: LedgerRow, groupKey: string | null): { row: BuyRow } | { excluded: Excluded } {
  const ex = (reason: string) => ({ excluded: { ndc11: r.ndc11, name: r.name, reason } });
  if (r.nadacMicros === null || r.nadacMicros <= 0) return ex("no NADAC for this NDC, so there is nothing to be under");
  if (r.flags.includes("pack_size_unknown")) return ex("the invoice pack size is not known, so its price cannot be put per unit");
  // The ledger sorts cheapest-effective first; sorted again here so this holds whatever built the row.
  const buy = [...r.buys].sort((a, b) => a.effectiveUnitMicros - b.effectiveUnitMicros).find((b) => !b.shortDated) ?? null;
  if (!buy) return ex(r.buys.length ? "only short-dated stock is offered" : "no price is known from any supplier");
  const rebateRateMissing = buy.rebated === true && buy.effectiveUnitMicros === buy.unitCostMicros;
  const under = r.nadacMicros - buy.effectiveUnitMicros;
  const paid = r.paid && !r.paid.shortDated ? r.paid : null;
  return {
    row: {
      ndc11: r.ndc11,
      name: r.name,
      nadacMicros: r.nadacMicros,
      nadacOn: r.nadacOn,
      buy,
      underNadacMicros: under,
      underNadacPercent: Math.round((under / r.nadacMicros) * 1000) / 10,
      rebateApplied: buy.rebated === true && !rebateRateMissing,
      rebateRateMissing,
      unitsDispensed: r.unitsDispensed,
      worthCents: Math.round((under * r.unitsDispensed) / 10_000),
      paidUnderNadacMicros: paid ? r.nadacMicros - paid.effectiveUnitMicros : null,
      groupKey,
    },
  };
}

/**
 * The list.
 *
 * `groupOf` places an NDC in its product (product-groups.ts); without it every NDC is its own
 * product and the product ranking says only what each NDC's own gap is worth.
 */
export function underNadac(rows: LedgerRow[], groupOf: (ndc11: string) => string | null = () => null): UnderNadac {
  const out: BuyRow[] = [];
  const excluded: Excluded[] = [];
  for (const r of rows) {
    const x = buyRowOf(r, groupOf(r.ndc11));
    if ("row" in x) out.push(x.row);
    else excluded.push(x.excluded);
  }
  out.sort((a, b) => b.underNadacMicros - a.underNadacMicros);

  const byGroup = new Map<string, BuyRow[]>();
  for (const b of out) {
    const k = b.groupKey ?? `ndc:${b.ndc11}`;
    byGroup.set(k, [...(byGroup.get(k) ?? []), b]);
  }
  const products: ProductPick[] = [];
  for (const [groupKey, ndcs] of byGroup) {
    const units = ndcs.reduce((s, n) => s + n.unitsDispensed, 0);
    const pick = ndcs[0];
    const dispensed = ndcs.filter((n) => n.unitsDispensed > 0).sort((a, b) => b.unitsDispensed - a.unitsDispensed);
    const current = dispensed[0] ?? null;
    const gainCents = current && current.ndc11 !== pick.ndc11 ? Math.round(((pick.underNadacMicros - current.underNadacMicros) * units) / 10_000) : 0;
    const worthOnProductCents = Math.round((pick.underNadacMicros * units) / 10_000);
    const gap = pick.underNadacMicros >= 0 ? `${perUnit(pick.underNadacMicros)} under NADAC` : `${perUnit(pick.underNadacMicros)} over NADAC`;
    let says: string;
    if (units <= 0) says = `${pick.name ?? pick.ndc11}: ${gap} a unit from ${pick.buy.supplier}; not dispensed in the period, so nothing to weigh it by.`;
    else if (!current || current.ndc11 === pick.ndc11) says = `${pick.name ?? pick.ndc11}: ${gap} a unit from ${pick.buy.supplier}, worth ${money(worthOnProductCents)} on ${units.toLocaleString()} units dispensed.`;
    else
      says = `${pick.name ?? pick.ndc11}: buy ${pick.ndc11} from ${pick.buy.supplier} (${gap} a unit) instead of ${current.ndc11} (${current.underNadacMicros >= 0 ? perUnit(current.underNadacMicros) + " under" : perUnit(current.underNadacMicros) + " over"}): ${money(gainCents)} more on ${units.toLocaleString()} units.`;
    if (pick.rebateRateMissing) says += " The rebate rate is not on file, so this is on the gross price and understates the gap.";
    products.push({ groupKey, name: pick.name, units, ndcs, pick, current, gainCents, worthOnProductCents, says });
  }
  products.sort((a, b) => b.worthOnProductCents - a.worthOnProductCents || b.pick.underNadacMicros - a.pick.underNadacMicros);
  return { rows: out, products, excluded };
}

/** The products where a different NDC than the one dispensed today would be worth at least `minGainCents`. */
export function switchNdc(u: UnderNadac, minGainCents = 500): ProductPick[] {
  return u.products.filter((p) => p.current && p.current.ndc11 !== p.pick.ndc11 && p.gainCents >= minGainCents).sort((a, b) => b.gainCents - a.gainCents);
}

/** NDCs offered under NADAC that the pharmacy has not bought or dispensed: the shelf it does not stock. */
export function notYetBought(u: UnderNadac, minUnderPercent = 20): BuyRow[] {
  return u.rows.filter((r) => r.paidUnderNadacMicros === null && r.unitsDispensed === 0 && r.underNadacPercent >= minUnderPercent);
}
