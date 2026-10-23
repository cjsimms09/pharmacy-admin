/**
 * What this pharmacy bought over NADAC, for the buying group.
 *
 * NADAC is the national average of what pharmacies paid for an NDC. On every fill the Kansas floor
 * reaches, and on Medicaid, the plan pays that NDC's own NADAC plus the fee, so every unit bought
 * above NADAC is an ingredient dispensed at a loss, by exactly the gap. The buying group can take
 * a price up with the wholesaler; what it needs is the list, weekly, with the arithmetic on it.
 *
 * One row per NDC per supplier over the window: the units bought (invoice lines, put per unit by
 * the catalogue's pack size), the invoice price and the price after the rebate the line earns,
 * NADAC in force now, the gap per unit and in dollars over the window, the best price any other
 * supplier lists for the same NDC, and how many units of it went out on plans that pay NADAC by
 * law. Ranked by dollars over, because a cent over on a drug bought by the case outranks a dollar
 * over on one bought twice a year.
 *
 * The rebate comes off before the comparison, and the row says so: a line the wholesaler rebates
 * at the tier rate may be under NADAC net when the invoice says over, and a complaint about the
 * gross price would be answered with the rebate. Where the line is marked rebated but no rate is
 * on file it is compared gross and flagged, which overstates the gap; that is the direction a
 * complaint can survive being wrong in.
 *
 * Refused, and named: a line whose pack size no catalogue carries (a package compared with a unit
 * is the mistake this site has made before), and an NDC with no NADAC (nothing to be over). Pure.
 */
import { effectiveMicros } from "./product-ledger";

export type BoughtLine = {
  ndc11: string;
  supplier: string | null;
  description: string | null;
  itemNumber: string | null;
  invoiceDate: string | null;
  /** Packs on the line. */
  packs: number;
  /** Price per pack, cents, as invoiced. */
  packCostCents: number;
  rebated: boolean | null;
};

export type Offer = { ndc11: string; supplier: string; effectiveUnitMicros: number; itemNumber: string | null; shortDated: boolean };

export type OverNadacInput = {
  lines: BoughtLine[];
  /** Units in the pack each NDC is invoiced by, from the catalogues. */
  packQtyOf: (ndc11: string) => number | null;
  nadac: Map<string, { unitMicros: number; effectiveOn: string; description: string | null }>;
  /** The generic tier rate each supplier pays today, by lower-cased name. */
  rateOf: (supplier: string | null) => number | null;
  /** What every supplier lists now, so the row can say where the same NDC is cheaper. */
  offers: Offer[];
  /** Units of each NDC dispensed on plans that pay NADAC by law, over the same window. */
  lawUnitsOf: (ndc11: string) => number;
  from: string;
  to: string;
};

export type OverNadacRow = {
  ndc11: string;
  name: string | null;
  supplier: string;
  itemNumber: string | null;
  lastInvoice: string | null;
  packs: number;
  packQty: number;
  units: number;
  /** Per unit, micros. */
  invoiceUnitMicros: number;
  effectiveUnitMicros: number;
  nadacMicros: number;
  nadacOn: string;
  /** Effective cost less NADAC, per unit. Positive is over. */
  overMicros: number;
  overPercent: number;
  /** The gap on every unit bought in the window, cents. */
  overCents: number;
  /** The same gap on the invoice price before the rebate, for the wholesaler's own arithmetic. */
  overGrossCents: number;
  rebateApplied: boolean;
  rebateRateMissing: boolean;
  /** The cheapest other supplier listing this NDC, and whether it sits under NADAC. */
  elsewhere: { supplier: string; effectiveUnitMicros: number; itemNumber: string | null; underNadac: boolean } | null;
  /** Units dispensed on floor and Medicaid plans in the window: where the gap was paid out as a loss. */
  lawUnits: number;
  lawLossCents: number;
};

export type OverNadac = {
  from: string;
  to: string;
  rows: OverNadacRow[];
  /** Lines in the window that were under or at NADAC: the good outcome, counted so the list is believable. */
  underOrAt: { lines: number; units: number };
  excluded: { ndc11: string; name: string | null; supplier: string; reason: string }[];
  totals: { overCents: number; lawLossCents: number; suppliers: string[]; lines: number };
};

const key = (ndc: string, supplier: string) => `${ndc}|${supplier.trim().toLowerCase()}`;

export function overNadac(input: OverNadacInput): OverNadac {
  const inWindow = input.lines.filter((l) => l.invoiceDate !== null && l.invoiceDate >= input.from && l.invoiceDate <= input.to && l.packs > 0);
  const excluded: OverNadac["excluded"] = [];
  const underOrAt = { lines: 0, units: 0 };

  // Lines fold into one row per NDC per supplier: packs and units summed, the price the latest line's.
  const acc = new Map<string, { line: BoughtLine; packs: number; units: number; packQty: number; last: string | null }>();
  for (const l of inWindow) {
    const supplier = l.supplier ?? "our supplier";
    const packQty = input.packQtyOf(l.ndc11);
    if (packQty === null || packQty <= 0) {
      excluded.push({ ndc11: l.ndc11, name: l.description, supplier, reason: "no catalogue carries this NDC's pack size, so the invoice price cannot be put per unit" });
      continue;
    }
    if (!input.nadac.has(l.ndc11)) {
      excluded.push({ ndc11: l.ndc11, name: l.description, supplier, reason: "no NADAC is held for this NDC, so there is nothing to be over" });
      continue;
    }
    const k = key(l.ndc11, supplier);
    const a = acc.get(k) ?? { line: l, packs: 0, units: 0, packQty, last: null };
    a.packs += l.packs;
    a.units += l.packs * packQty;
    if ((l.invoiceDate ?? "") >= (a.last ?? "")) {
      a.last = l.invoiceDate;
      a.line = l;
    }
    acc.set(k, a);
  }

  const offersByNdc = new Map<string, Offer[]>();
  for (const o of input.offers) {
    if (o.shortDated) continue;
    offersByNdc.set(o.ndc11, [...(offersByNdc.get(o.ndc11) ?? []), o]);
  }

  const rows: OverNadacRow[] = [];
  for (const a of acc.values()) {
    const l = a.line;
    const supplier = l.supplier ?? "our supplier";
    const n = input.nadac.get(l.ndc11)!;
    const gross = Math.round((l.packCostCents * 10_000) / a.packQty);
    const rate = input.rateOf(l.supplier);
    const effective = effectiveMicros(gross, l.rebated, rate);
    const rebateRateMissing = l.rebated === true && rate === null;
    const over = effective - n.unitMicros;
    if (over <= 0) {
      underOrAt.lines++;
      underOrAt.units += a.units;
      continue;
    }
    const others = (offersByNdc.get(l.ndc11) ?? []).filter((o) => o.supplier.trim().toLowerCase() !== supplier.trim().toLowerCase()).sort((x, y) => x.effectiveUnitMicros - y.effectiveUnitMicros);
    const best = others[0] ?? null;
    const lawUnits = input.lawUnitsOf(l.ndc11);
    rows.push({
      ndc11: l.ndc11,
      name: l.description ?? n.description,
      supplier,
      itemNumber: l.itemNumber,
      lastInvoice: a.last,
      packs: a.packs,
      packQty: a.packQty,
      units: a.units,
      invoiceUnitMicros: gross,
      effectiveUnitMicros: effective,
      nadacMicros: n.unitMicros,
      nadacOn: n.effectiveOn,
      overMicros: over,
      overPercent: Math.round((over / n.unitMicros) * 1000) / 10,
      overCents: Math.round((over * a.units) / 10_000),
      overGrossCents: Math.round(((gross - n.unitMicros) * a.units) / 10_000),
      rebateApplied: l.rebated === true && !rebateRateMissing,
      rebateRateMissing,
      elsewhere: best ? { supplier: best.supplier, effectiveUnitMicros: best.effectiveUnitMicros, itemNumber: best.itemNumber, underNadac: best.effectiveUnitMicros < n.unitMicros } : null,
      lawUnits,
      lawLossCents: Math.round((over * Math.min(lawUnits, a.units)) / 10_000),
    });
  }
  rows.sort((a, b) => b.overCents - a.overCents || b.overPercent - a.overPercent);
  return {
    from: input.from,
    to: input.to,
    rows,
    underOrAt,
    excluded,
    totals: {
      overCents: rows.reduce((s, r) => s + r.overCents, 0),
      lawLossCents: rows.reduce((s, r) => s + r.lawLossCents, 0),
      suppliers: [...new Set(rows.map((r) => r.supplier))],
      lines: rows.length,
    },
  };
}

const perUnit = (m: number) => (m / 1_000_000).toFixed(4);
const dollars = (c: number) => (c / 100).toFixed(2);

/**
 * The file for the buying group, one row per NDC per supplier. Plain columns until the group's own
 * form arrives, at which point this is the one function to change.
 */
export function overNadacRows(o: OverNadac): Record<string, string | number>[] {
  return o.rows.map((r) => ({
    "NDC": r.ndc11,
    "Description": r.name ?? "",
    "Supplier": r.supplier,
    "Item number": r.itemNumber ?? "",
    "Last invoice": r.lastInvoice ?? "",
    "Packs bought": r.packs,
    "Pack size": r.packQty,
    "Units bought": r.units,
    "Invoice price per unit": perUnit(r.invoiceUnitMicros),
    "After rebate per unit": perUnit(r.effectiveUnitMicros),
    "NADAC per unit": perUnit(r.nadacMicros),
    "NADAC as of": r.nadacOn,
    "Over NADAC per unit": perUnit(r.overMicros),
    "Over NADAC %": r.overPercent,
    "Dollars over, window": dollars(r.overCents),
    "Dollars over on invoice price": dollars(r.overGrossCents),
    "Rebate": r.rebateApplied ? "taken off" : r.rebateRateMissing ? "marked rebated, rate not on file" : "none",
    "Cheaper elsewhere": r.elsewhere ? `${r.elsewhere.supplier} ${perUnit(r.elsewhere.effectiveUnitMicros)}${r.elsewhere.underNadac ? " (under NADAC)" : ""}` : "",
    "Units dispensed on NADAC-paid plans": r.lawUnits,
    "Loss on those fills": dollars(r.lawLossCents),
    "Window": `${o.from} to ${o.to}`,
  }));
}
