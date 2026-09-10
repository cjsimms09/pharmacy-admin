import "server-only";
import { rateForSupplier } from "./supplier-match";

/**
 * One row per drug, with everything the pharmacy knows about it in the same place.
 *
 * Four separate records answer four separate halves of the same question, and none of them answers
 * it alone. The invoices say what was actually paid, and whether the line earned the rebate. The
 * supplier catalogues say what every other wholesaler would have charged for the same NDC, and
 * which of them rebate it. NADAC says what the government thinks the drug costs, which is both the
 * reimbursement floor and the only external benchmark on the buying side. The claims say what was
 * dispensed and what came back for it.
 *
 * Held apart, each is a page somebody has to read and reconcile in their head. Together they
 * answer the questions the pharmacy actually has: which drugs am I buying above the benchmark
 * everyone else is paid against, where should I be buying them instead, and what am I holding that
 * I should send back.
 *
 * ── The rebate, and why it is the whole difficulty ──
 *
 * A McKesson generic bought on the OneStop contract earns the tier rate — twenty-nine percent at
 * this pharmacy's current tier — and that rebate is paid months later on a report, not taken off
 * the invoice. So the invoice price of a rebated line is not what the drug cost, and comparing it
 * with a competitor's price is comparing the wrong two numbers. Every comparison here therefore
 * works on an effective cost: the invoice price less the tier rate where, and only where, the line
 * was marked as rebated.
 *
 * The direction of the error matters. Treating an unmarked line as rebated invents a discount and
 * recommends staying put; treating a rebated line as unmarked invents a saving and recommends
 * moving spend off the contract, which can cost more in a lost tier than it saves on the invoice.
 * So a rebate is applied only where a document says so, never inferred, and a comparison that
 * cannot tell says it cannot tell rather than picking a side.
 *
 * ── Everything is per unit, and that is not a detail ──
 *
 * An invoice prices a package: one Ozempic pen, $996.68. A catalogue prices a unit inside it:
 * $332.2267 per millilitre, three millilitres to the pen. Those are the same price. Compared
 * without converting, the catalogue looks two thirds cheaper and the pharmacy is told to switch
 * supplier to save ninety-nine thousand dollars on a drug whose price has not moved — which is
 * what the first version of this said, on real invoices, until the figures were checked against
 * the source documents.
 *
 * So every price here is per unit, converted using the pack size the catalogue prints, and where
 * no pack size is known for an NDC the comparison is not made at all. A recommendation nobody can
 * check is worse than no recommendation, because it is acted on once and trusted afterwards.
 */

export type Buy = {
  supplier: string;
  /** As printed on the invoice or catalogue, before any rebate. */
  unitCostMicros: number;
  /** After the tier rate, where the line is marked rebated. Equal to the gross where it is not. */
  effectiveUnitMicros: number;
  rebated: boolean | null;
  /** "invoice" is what was actually paid; "catalogue" is what the supplier lists. */
  source: "invoice" | "catalogue";
  on: string | null;
  shortDated: string | null;
};

export type LedgerRow = {
  ndc11: string;
  name: string | null;
  /** Every price known for this NDC, cheapest effective first. */
  buys: Buy[];
  /** What this pharmacy last actually paid, from an invoice. */
  paid: Buy | null;
  /** The cheapest source known, whatever it is. */
  best: Buy | null;
  /** NADAC per unit at the latest effective date held. */
  nadacMicros: number | null;
  nadacOn: string | null;
  /** Units dispensed across the claims held, which is what scales every figure to this pharmacy. */
  unitsDispensed: number;
  /** What the plans and patients paid, across those claims. */
  receivedCents: number;
  claims: number;
  /** paid − NADAC, per unit. Negative is buying below the benchmark, which is the good side. */
  vsNadacMicros: number | null;
  /** What moving to the cheapest source would have saved on what was actually dispensed. */
  switchSavingCents: number | null;
  flags: Flag[];
};

export type Flag =
  | "buying_above_nadac"
  | "cheaper_elsewhere"
  | "no_nadac"
  | "not_dispensed"
  | "short_dated_only"
  | "rebate_unknown"
  | "pack_size_unknown";

/**
 * What each supplier takes off a rebated line, as a fraction, never guessed.
 *
 * Per supplier, because rebates are. One global rate applied McKesson's contract discount to an
 * IPC line the moment IPC's catalogue marked something rebated, and a comparison then preferred
 * the supplier with the discount it had borrowed from somebody else. `bySupplier` is keyed on the
 * supplier's name folded to lower case, which is how invoices and catalogues both name them.
 *
 * `fallback` covers a line whose supplier is not named at all. Null everywhere means gross prices
 * and a flag saying so, which understates the pharmacy's position rather than inventing a discount.
 */
export type Contract = {
  bySupplier?: Record<string, number>;
  /** The rate for a line whose supplier nothing names. */
  genericRebateRate: number | null;
};

/** The rate that applies to a line, by who sold it. */
function rateFor(contract: Contract, supplier: string | null): number | null {
  if (!supplier) return contract.genericRebateRate;
  // One matcher for the whole site; see supplier-match.ts for why the first hit is the wrong answer.
  const hit = rateForSupplier(contract.bySupplier ?? {}, supplier);
  if (hit !== null) return hit;
  // A named supplier with no rate on file earns nothing here, rather than borrowing another's.
  return contract.bySupplier && Object.keys(contract.bySupplier).length > 0 ? null : contract.genericRebateRate;
}

const MICROS = 1_000_000;

/**
 * The effective cost of a line: the printed price less the tier rate, where the line earns it.
 *
 * Where the rebate applies but the rate is not on file, the gross price is used unchanged and the
 * row is flagged — an estimated rate would put a made-up number into a purchasing recommendation.
 */
export function effectiveMicros(grossMicros: number, rebated: boolean | null, rate: number | null): number {
  if (rebated !== true || rate === null) return grossMicros;
  return Math.round(grossMicros * (1 - rate));
}

export type LedgerInput = {
  invoiceLines: { ndc11: string; supplier: string | null; description: string | null; unitCostCents: number; rebated: boolean | null; invoiceDate: string | null }[];
  /** `packQty` is how many units are in the package the invoice prices. Without it nothing compares. */
  catalogue: { ndc11: string; supplier: string; description: string | null; unitCostMicros: number | null; packQty: number | null; contractFlag: string | null; pricedOn: string | null; availability: string | null }[];
  /**
   * Pack sizes from somewhere other than a catalogue — today, the pharmacy's own inventory count,
   * which prints "Package Info: 180 EA" against every item it holds.
   *
   * An invoice prices a package and everything else here prices a unit inside it, so without a
   * pack size a line cannot be compared to NADAC at all and drops out of the buying screens
   * silently. The catalogue answers it for anything a supplier lists; this answers it for the
   * rest, and only where the catalogue did not, so a supplier's own pack size always wins.
   */
  packFallback?: { ndc11: string; packQty: number }[];
  nadac: { ndc11: string; unitMicros: number; effectiveOn: string; description: string | null }[];
  claims: { ndc11: string | null; itemName: string | null; quantityThousandths: number | null; remitCents: number | null; copayCents: number | null; status?: string }[];
  contract: Contract;
  /** Below this, a saving is noise rather than a reason to change where you buy. */
  materialityCents: number;
};

/**
 * Builds the ledger. Pure: everything it needs is passed in, so it can be tested against figures
 * taken off real invoices rather than only against whatever is in the database today.
 */
export function buildLedger(input: LedgerInput): LedgerRow[] {
  const contract = input.contract;
  const rows = new Map<string, LedgerRow>();

  const row = (ndc11: string): LedgerRow => {
    let r = rows.get(ndc11);
    if (!r) {
      r = {
        ndc11, name: null, buys: [], paid: null, best: null, nadacMicros: null, nadacOn: null,
        unitsDispensed: 0, receivedCents: 0, claims: 0, vsNadacMicros: null, switchSavingCents: null, flags: [],
      };
      rows.set(ndc11, r);
    }
    return r;
  };

  /*
   * How many units are in the package an invoice prices, per NDC.
   *
   * Taken from the catalogues, which print it, and used to put the invoice on the same footing as
   * everything else. Where two suppliers disagree about the pack for one NDC the larger is not
   * safer than the smaller — either could be right — so the first is taken and the disagreement is
   * not something this pretends to settle.
   */
  const packOf = new Map<string, number>();
  for (const c of input.catalogue) {
    if (c.packQty && c.packQty > 0 && !packOf.has(c.ndc11)) packOf.set(c.ndc11, c.packQty);
  }
  // Only where no catalogue said: a supplier's own pack size is the better authority on what it
  // sells, and this is here to answer the NDCs no catalogue covers.
  for (const f of input.packFallback ?? []) {
    if (f.packQty > 0 && !packOf.has(f.ndc11)) packOf.set(f.ndc11, f.packQty);
  }

  // ── What was actually paid ──
  // The most recent invoice line for an NDC is what the pharmacy pays today; earlier ones are
  // history. Sorted by date so "most recent" means it rather than whichever the database returned.
  const byNdcInvoice = new Map<string, LedgerInput["invoiceLines"][number]>();
  for (const l of [...input.invoiceLines].sort((a, b) => (a.invoiceDate ?? "").localeCompare(b.invoiceDate ?? ""))) {
    byNdcInvoice.set(l.ndc11, l);
  }
  for (const [ndc, l] of byNdcInvoice) {
    const r = row(ndc);
    if (!r.name && l.description) r.name = l.description;
    // The invoice prices a package; everything else here prices a unit inside it.
    const pack = packOf.get(ndc) ?? null;
    if (pack === null) r.flags.push("pack_size_unknown");
    const gross = Math.round((l.unitCostCents * 10_000) / (pack ?? 1));
    const buy: Buy = {
      supplier: l.supplier ?? "our supplier",
      unitCostMicros: gross,
      effectiveUnitMicros: effectiveMicros(gross, l.rebated, rateFor(contract, l.supplier)),
      rebated: l.rebated,
      source: "invoice",
      on: l.invoiceDate,
      shortDated: null,
    };
    r.paid = buy;
    r.buys.push(buy);
  }

  // ── What every supplier lists ──
  for (const c of input.catalogue) {
    if (c.unitCostMicros === null) continue;
    const r = row(c.ndc11);
    if (!r.name && c.description) r.name = c.description;
    const rebated = c.contractFlag === "rebated" ? true : c.contractFlag === "not rebated" ? false : null;
    r.buys.push({
      supplier: c.supplier,
      unitCostMicros: c.unitCostMicros,
      effectiveUnitMicros: effectiveMicros(c.unitCostMicros, rebated, rateFor(contract, c.supplier)),
      rebated,
      source: "catalogue",
      on: c.pricedOn,
      shortDated: /short-dated only/i.test(c.availability ?? "") ? (c.availability ?? "").trim() : null,
    });
  }

  // ── The benchmark ──
  for (const n of input.nadac) {
    const r = rows.get(n.ndc11);
    if (!r) continue; // A benchmark for a drug we neither buy nor dispense is not a row.
    if (!r.nadacOn || n.effectiveOn > r.nadacOn) {
      r.nadacOn = n.effectiveOn;
      r.nadacMicros = n.unitMicros;
    }
    if (!r.name && n.description) r.name = n.description;
  }

  // ── What we dispensed, which scales everything to this pharmacy ──
  for (const c of input.claims) {
    if (!c.ndc11 || c.status === "reversed") continue;
    const r = rows.get(c.ndc11);
    if (!r) continue;
    r.claims++;
    r.unitsDispensed += (c.quantityThousandths ?? 0) / 1000;
    r.receivedCents += (c.remitCents ?? 0) + (c.copayCents ?? 0);
    if (!r.name && c.itemName) r.name = c.itemName;
  }

  // ── The conclusions ──
  for (const r of rows.values()) {
    // Nothing at all is concluded where the invoice price could not be put on a per-unit footing:
    // a package compared with a unit is the error that produced a hundred-thousand-dollar saving
    // on a drug whose price had not moved.
    const comparable = !r.flags.includes("pack_size_unknown");
    r.buys.sort((a, b) => a.effectiveUnitMicros - b.effectiveUnitMicros);
    // A short-dated lot is never the recommendation. It is a real price and stays in the list, but
    // it is stock expiring inside the return window, and a comparison that does not know the
    // difference recommends it every time.
    r.best = r.buys.find((b) => !b.shortDated) ?? null;

    if (comparable && r.paid && r.nadacMicros !== null) r.vsNadacMicros = r.paid.effectiveUnitMicros - r.nadacMicros;

    if (comparable && r.paid && r.best && r.best.effectiveUnitMicros < r.paid.effectiveUnitMicros && r.unitsDispensed > 0) {
      const perUnit = r.paid.effectiveUnitMicros - r.best.effectiveUnitMicros;
      r.switchSavingCents = Math.round((perUnit * r.unitsDispensed) / 10_000);
    }

    if (comparable && r.nadacMicros === null) r.flags.push("no_nadac");
    else if (r.vsNadacMicros !== null && r.vsNadacMicros > 0) r.flags.push("buying_above_nadac");
    if ((r.switchSavingCents ?? 0) >= input.materialityCents) r.flags.push("cheaper_elsewhere");
    if (r.claims === 0 && r.paid) r.flags.push("not_dispensed");
    if (r.buys.length > 0 && r.buys.every((b) => b.shortDated)) r.flags.push("short_dated_only");
    // Named where it matters: a rebated line whose rate is unknown is being compared at its gross
    // price, which understates the pharmacy's position rather than overstating it.
    if (r.buys.some((b) => b.rebated === true && rateFor(contract, b.supplier) === null)) r.flags.push("rebate_unknown");
  }

  return [...rows.values()];
}

/**
 * How many units a stored pack size describes: "30 EA" is thirty, "(10) 100 EA" is a hundred.
 *
 * The leading bracket is the order multiple — how many packs one order line buys — and is not part
 * of the pack. Reading it as the pack size would divide every price by ten.
 */
export function packQtyOf(packSize: string | null): number | null {
  if (!packSize) return null;
  /*
   * A bracket means this pack was never levelled, and the answer is refused rather than guessed.
   *
   * McKesson, ANDA and ParMed write a multi-pack as "(5) 1 ML", and the package is five: settled by
   * the catalogue proof on 9 September against NADAC, on 1,593 of 2,147 multi-pack rows. Every
   * caller here is supposed to be reading `catalogueRows()`, where `wholePackage` has already
   * turned that into "5 ML" and there is no bracket left — so a bracket arriving means the caller
   * read the raw table, or read a row printing no pack total that levelling could not settle.
   *
   * This used to skip the bracket and answer with the inner pack: 1, for a package of 5. It is the
   * wrong number and it does not look wrong, and what is done with it is division — the invoice's
   * per-package price over this — so the cost comes out five times too high with nothing to show
   * for it. `appeals.ts` divided by it to state what a drug cost the pharmacy, in the document that
   * exists to state what a drug cost the pharmacy.
   *
   * Null is the answer every caller already handles, and handles by not comparing: this module's
   * own rule is that where no pack size is known the comparison is not made at all, because a
   * recommendation nobody can check is worse than no recommendation.
   */
  const br = /\((\d+)\)\s*[\d.]+\s*(?:EA|ML|GM)\b/i.exec(packSize);
  /*
   * A bracket of one is not a multi-pack and is answered normally: one carton of a hundred is a
   * hundred, the printed unit cost is per that hundred, and there was never anything for levelling
   * to settle. `wholePackage` leaves those rows untouched for the same reason, which is why they
   * reach here still carrying the bracket.
   */
  if (br && Number(br[1]) > 1) return null;
  const m = /([\d.]+)\s*(EA|ML|GM)\b/i.exec(packSize);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The rows worth acting on, most valuable first. */
export function opportunities(rows: LedgerRow[]): LedgerRow[] {
  return rows
    .filter((r) => r.flags.includes("cheaper_elsewhere") || r.flags.includes("buying_above_nadac") || r.flags.includes("not_dispensed"))
    .sort((a, b) => (b.switchSavingCents ?? 0) - (a.switchSavingCents ?? 0));
}

/** Loads everything the ledger needs and builds it. */
export async function productLedger(): Promise<{ rows: LedgerRow[]; rate: number | null; materialityCents: number }> {
  const { held } = await import("./held");
  return held("ledger", loadProductLedger);
}

/** The ledger built from the tables. Held between requests (held.ts); read it, never write into it. */
async function loadProductLedger(): Promise<{ rows: LedgerRow[]; rate: number | null; materialityCents: number }> {
  const { db, schema } = await import("@/db");
  const { getSettings } = await import("./settings");
  const { eq } = await import("drizzle-orm");

  const [lines, catalogue, nadac, fills, s, shelf] = await Promise.all([
    db.query.invoiceLines.findMany(),
    // Held between requests: forty-five thousand rows that change once a week. See catalogue-cache.
    (await import("./catalogue-cache")).catalogueRows(),
    // The newest price per drug, asked for in SQL and held between requests. Loading every NADAC
    // row ever published to keep one per NDC is what made this page unusable. See nadac-latest.
    (await import("./nadac-latest")).nadacNow(),
    // The fills, already grouped and held (claims.ts): the same rows this used to scan and group itself.
    (await import("./claims")).allFills(),
    getSettings(),
    // The latest count, for the pack sizes it carries against everything actually on the shelf.
    (async () => {
      const imp = await db.query.onHandImports.findFirst({ orderBy: (i, { desc }) => [desc(i.countedOn)] });
      if (!imp) return [] as { ndc11: string; packQty: number }[];
      const rows = await db.query.onHand.findMany({
        where: eq(schema.onHand.countedOn, imp.countedOn),
        columns: { ndc11: true, packQty: true },
      });
      return rows.flatMap((r) => (r.ndc11 && r.packQty && r.packQty > 0 ? [{ ndc11: r.ndc11, packQty: r.packQty }] : []));
    })(),
  ]);

  /*
   * One row per dispensing, not per transmission — the same rule the claims screens use.
   *
   * A fill billed to a primary plan and then a secondary is two claim rows for one bottle. Summed
   * as claims, its quantity is counted twice and its revenue is split across the two rows, so this
   * page said a drug was dispensed twice as often as it was and every saving worked out on those
   * quantities was overstated by the same factor. The same question was getting two answers
   * depending on which screen it was asked from, which is worse than either answer being wrong.
   */
  const claims = fills.map((f) => ({
    ndc11: f.ndc11,
    itemName: f.itemName,
    quantityThousandths: f.quantityThousandths,
    // The whole fill's revenue on one row: every plan's remit plus what the patient actually paid,
    // plus money that reached the fill later. A Part D brand whose facilitator refund has landed
    // is not dispensed at a loss, and this page used to say it was on every one of them.
    remitCents: f.remitCents + f.laterPaymentsCents,
    copayCents: f.patientPaidCents,
    status: "paid" as const,
  }));

  /*
   * The discount each supplier is giving today, worked out rather than typed.
   *
   * It was a percentage copied off last month's statement into a settings box and applied to every
   * supplier alike. Now it comes from each supplier's own ladders and the ratio they are currently
   * in — from this morning's drill down where there is one. A supplier with no ladder on file
   * discounts nothing here and the row says so.
   */
  const { contractRatesBySupplier } = await import("./rebate-rates");
  const bySupplier = await contractRatesBySupplier();
  const anyRate = Object.values(bySupplier).sort((a, b) => b - a)[0] ?? null;
  const materialityCents = Number(s.floor_materiality_cents ?? "") || 500;

  const rows = buildLedger({
    invoiceLines: lines,
    packFallback: shelf,
    catalogue: catalogue.map((c) => ({
      ndc11: c.ndc11, supplier: c.supplier, description: c.description,
      unitCostMicros: c.unitCostMicros, packQty: packQtyOf(c.packSize), contractFlag: c.contractFlag, pricedOn: c.pricedOn, availability: c.availability,
    })),
    nadac,
    claims,
    contract: { bySupplier, genericRebateRate: null },
    materialityCents,
  });
  void eq;
  return { rows, rate: anyRate, materialityCents };
}

export { MICROS };

/**
 * What each drug actually earns: what came in against what it truly cost.
 *
 * The comparison table answers "am I paying too much"; this answers the question the pharmacist
 * asked next, which is "which of these is worth dispensing". They are not the same question and
 * one does not imply the other — a drug bought well below NADAC can still be dispensed at a loss
 * if the plan reimburses below acquisition, and a drug bought above NADAC can be the best margin
 * on the shelf.
 *
 * The cost side is the *effective* cost: what the invoice charged, less the rebate that supplier
 * actually pays on that line. A margin worked out on gross invoice prices understates every
 * contract generic by the tier rate, which for this pharmacy is thirty percent — enough to turn a
 * profitable drug into an apparent loss and get it dropped.
 *
 * Where the true cost is not known, no margin is produced. Not zero, not a guess from NADAC: NADAC
 * is what pharmacies on average paid, not what this one paid, and a margin computed from it is a
 * statement about somebody else's business.
 */
export type Margin = {
  ndc11: string;
  name: string | null;
  claims: number;
  unitsDispensed: number;
  /** What plans and patients paid, across the claims held. */
  receivedCents: number;
  /** Units dispensed times the effective cost per unit. */
  costCents: number;
  marginCents: number;
  /** Margin as a percentage of what came in. Null where nothing came in. */
  marginPercent: number | null;
  /** Per unit, so a drug dispensed once can be compared with one dispensed a hundred times. */
  marginPerUnitMicros: number;
  /** What this pharmacy pays against the benchmark, per unit. Negative is buying below it. */
  vsNadacMicros: number | null;
  supplier: string | null;
  rebated: boolean | null;
};

export function margins(rows: LedgerRow[]): Margin[] {
  const out: Margin[] = [];
  for (const r of rows) {
    // No dispensing, or no price this pharmacy actually paid, and there is no margin to state.
    if (r.unitsDispensed <= 0 || r.claims === 0 || !r.paid) continue;
    if (r.flags.includes("pack_size_unknown")) continue;
    const costCents = Math.round((r.paid.effectiveUnitMicros * r.unitsDispensed) / 10_000);
    const marginCents = r.receivedCents - costCents;
    out.push({
      ndc11: r.ndc11,
      name: r.name,
      claims: r.claims,
      unitsDispensed: r.unitsDispensed,
      receivedCents: r.receivedCents,
      costCents,
      marginCents,
      marginPercent: r.receivedCents > 0 ? Math.round((marginCents / r.receivedCents) * 1000) / 10 : null,
      marginPerUnitMicros: Math.round((marginCents * 10_000) / r.unitsDispensed),
      vsNadacMicros: r.vsNadacMicros,
      supplier: r.paid.supplier,
      rebated: r.paid.rebated,
    });
  }
  return out.sort((a, b) => b.marginCents - a.marginCents);
}

/**
 * The ones dispensed at a loss, worst first.
 *
 * Separated out rather than left at the bottom of a long list, because they are a different kind
 * of fact: everything above the line is a question of degree, and everything below it is money
 * going the wrong way every time the drug is dispensed.
 */
export function losers(rows: Margin[]): Margin[] {
  return rows.filter((m) => m.marginCents < 0).sort((a, b) => a.marginCents - b.marginCents);
}
