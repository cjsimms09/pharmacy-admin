import "server-only";
import { packUnits, problemsWith, type Problem } from "./catalogue-check";

/**
 * Everything the site knows about one drug, gathered under its NDC.
 *
 * Until now each file was readable only through the screen built for it: the supplier catalogue on
 * the purchasing page, the count on the shelf page, the claims on the claims page, NADAC nowhere at
 * all. Nothing put them beside each other, so the questions that only make sense across files could
 * not be asked — what does this actually reimburse, does the wholesaler agree with the shelf about
 * what a package holds, is a second wholesaler cheaper for the same bottle.
 *
 * An NDC is the right key for that. It names a specific package of a specific drug from a specific
 * labeller, which is exactly what every one of those files is talking about.
 *
 * ── What each file contributes ──
 *
 * The supplier catalogues say what can be bought, at what pack size and price, from whom. The daily
 * count says what is on the shelf and — importantly — what PioneerRx believes a package holds, which
 * is the pharmacy's own answer rather than a wholesaler's. NADAC is the federal benchmark. The
 * claims say what it actually reimburses, which is the only figure here nobody can look up.
 */

export type SupplierOffer = {
  supplier: string;
  packSize: string | null;
  /** Units the pack size gives, or null where it gives none. */
  packUnits: number | null;
  unitCostMicros: number | null;
  packCostCents: number | null;
  awpCents: number | null;
  contractFlag: string | null;
  pricedOn: string | null;
  availability: string | null;
  /** True where the pharmacy has corrected this supplier's row. */
  corrected: boolean;
  /** What is wrong with this supplier's row on its own terms. */
  problems: Problem[];
};

export type Reimbursement = {
  /** Fills counted: coordinated legs are one fill, reversals are not counted at all. */
  fills: number;
  unitsThousandths: number;
  /** What the plans remitted, added across every payer on the fill. */
  remitCents: number;
  /** Remit plus what the patient handed over plus anything that arrived later. */
  revenueCents: number;
  /** The figure this exists for: what a unit reimburses, on average, in cents. */
  perUnitCents: number | null;
  /** What a fill reimburses, on average. */
  perFillCents: number | null;
  lastFilledOn: string | null;
  /** The pharmacy's own cash price, kept apart: it is a price set, not a rate paid. */
  cashFills: number;
  cashRevenueCents: number;
};

export type PackDisagreement = {
  /** Every distinct reading, and who says it. */
  says: { units: number; from: string }[];
  /** What the row reads on screen, with the figures in it. */
  text: string;
};

export type DrugRow = {
  ndc11: string;
  name: string | null;
  offers: SupplierOffer[];
  /** The dispensing shelf, where this drug is stocked. */
  shelf: { packQty: number | null; onHandThousandths: number; valueCents: number | null } | null;
  nadacUnitMicros: number | null;
  nadacPricingUnit: string | null;
  reimbursement: Reimbursement | null;
  /** What the pharmacy has settled the package at, applying to every supplier. */
  packFix: { packSize: string; note: string | null; correctedBy: string; correctedAt: string } | null;
  /** Sources that disagree about what a package holds. Null where they agree or only one speaks. */
  packDisagreement: PackDisagreement | null;
  /** Everything wrong with this drug, across every supplier. */
  problems: Problem[];
  /** The cheapest pack cost offered, for ranking and for the buy decision. */
  bestPackCostCents: number | null;
};

export type DrugSearch = {
  /** NDC, name, or part of either. */
  text?: string;
  supplier?: string;
  /** Only NDCs whose sources disagree about the package. */
  mismatchOnly?: boolean;
  /** Only NDCs with something wrong. */
  problemsOnly?: boolean;
  /** Only NDCs the claims have reimbursed. */
  dispensedOnly?: boolean;
  /** Only NDCs the pharmacy has settled. */
  fixedOnly?: boolean;
  limit?: number;
};

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The two numbers a pack size can mean, because wholesalers write the same package both ways.
 *
 * McKesson writes a carton of three 30 mL bottles as "(3) 30 ML". ABC writes the same NDC as
 * "90 ML". Smith Drug writes a six-pack of 28 tablets as "168 EA" where McKesson writes "(6) 28 EA".
 * Neither is wrong and neither is a fault to report — they are two notations for one package.
 *
 * So a pack size gives an inner figure (what one bottle or card holds) and a whole figure (what the
 * package holds altogether). Two suppliers agree when any one number satisfies both of them.
 */
export function packReadings(packSize: string | null): { inner: number | null; whole: number | null } {
  if (!packSize) return { inner: null, whole: null };
  const m = /(?:\((\d+)\)\s*)?([\d.]+)\s*(EA|ML|GM)\b/i.exec(packSize);
  if (!m) return { inner: null, whole: null };
  const inner = Number(m[2]);
  if (!Number.isFinite(inner) || inner <= 0) return { inner: null, whole: null };
  const cartons = m[1] ? Number(m[1]) : 1;
  return { inner, whole: inner * cartons };
}

/**
 * Which sources disagree about what a package of this NDC holds, and whether it is a real fault.
 *
 * An NDC names one package, so two different readings of it are one error rather than two products.
 * Across the pharmacy's twenty-four supplier catalogues, 41,528 NDCs are carried by more than one
 * of them and 1,195 read differently — but 539 of those are only the bracket notation above, and
 * reporting them would bury the 656 that are real under noise nobody can act on.
 *
 * A disagreement is therefore only reported when no single number satisfies every source. Where one
 * does, the sources agree and that number is the package.
 *
 * The shelf count is included as a source but treated as what it is: PioneerRx counts in dispensing
 * units, so it will often report the inner figure where a wholesaler reports the whole carton. That
 * is the same notation difference and is resolved the same way.
 */
export function packDisagreement(
  offers: { supplier: string; packSize: string | null }[],
  shelf: { packQty: number | null } | null,
): PackDisagreement | null {
  const sources: { from: string; inner: number; whole: number; text: string }[] = [];
  for (const o of offers) {
    const r = packReadings(o.packSize);
    if (r.inner !== null && r.whole !== null) sources.push({ from: o.supplier, inner: r.inner, whole: r.whole, text: o.packSize ?? "" });
  }
  if (shelf?.packQty !== null && shelf?.packQty !== undefined && shelf.packQty > 0) {
    sources.push({ from: "the shelf count", inner: shelf.packQty, whole: shelf.packQty, text: String(shelf.packQty) });
  }
  if (sources.length < 2) return null;

  /*
   * A package has two levels, and different files quote different ones.
   *
   * McKesson writes a 25-vial carton of 3 mL as "(25) 3 ML", API writes the same NDC as "75 ML",
   * and PioneerRx counts the shelf in single 3 mL vials. All three are describing one package from
   * a different height, and none of them is wrong. So agreement is not one number every source
   * shares — it is one *pair*, an inner and a whole, that every source's reading lands on.
   *
   * A genuine fault cannot be covered by any pair: three wholesalers saying 6.7 GM, 6 GM and 7 GM
   * are three different answers to one question, and ABC calling a 168-tablet pack "1 EA" is not a
   * level of anything.
   */
  /*
   * The pair has to be one a source actually asserts, not one assembled to paper over a difference.
   *
   * Any two numbers can be called an inner and a whole after the fact, which would make every pair
   * of sources agree by construction and report nothing ever. A file that writes "(25) 3 ML" is
   * asserting that this package is 3 to a vial and 75 altogether; that assertion is what the other
   * sources are then tested against.
   */
  for (const claim of sources) {
    if (sources.every((s) => s.inner === claim.inner || s.inner === claim.whole || s.whole === claim.inner || s.whole === claim.whole))
      return null;
  }

  return {
    says: sources.map((s) => ({ units: s.whole, from: s.from })),
    text: sources.map((s) => `${s.from} says ${s.text}`).join(", "),
  };
}

/** The average reimbursement figures, from fills rather than claims. */
export function reimbursementFrom(
  fills: { quantityThousandths: number | null; remitCents: number; revenueCents: number; dateFilled: string; cashPlan: boolean }[],
): Reimbursement | null {
  if (fills.length === 0) return null;
  /*
   * The pharmacy's own cash price is kept out of the average.
   *
   * A cash fill is a price the pharmacy set, not a rate a plan paid. Averaged in, it moves a figure
   * whose whole purpose is to say what plans reimburse — and the two are used for opposite
   * decisions: one is a rate to argue about, the other is a price to reconsider.
   */
  const paid = fills.filter((f) => !f.cashPlan);
  const cash = fills.filter((f) => f.cashPlan);
  const units = paid.reduce((n, f) => n + (f.quantityThousandths ?? 0), 0);
  const remit = paid.reduce((n, f) => n + f.remitCents, 0);
  const revenue = paid.reduce((n, f) => n + f.revenueCents, 0);
  const dates = fills.map((f) => f.dateFilled).sort();
  return {
    fills: paid.length,
    unitsThousandths: units,
    remitCents: remit,
    revenueCents: revenue,
    // Quantity is in thousandths, so the division carries the factor back out.
    perUnitCents: units > 0 ? (remit * 1000) / units : null,
    perFillCents: paid.length > 0 ? remit / paid.length : null,
    lastFilledOn: dates.length > 0 ? dates[dates.length - 1] : null,
    cashFills: cash.length,
    cashRevenueCents: cash.reduce((n, f) => n + f.revenueCents, 0),
  };
}

/**
 * The disagreement as a problem, so it sorts and reads like every other fault.
 *
 * It is `wrong` rather than `check` because it is arithmetic: one of the readings is false, and
 * whichever screen used the false one has been ordering or valuing against a package that does not
 * exist. What it costs is a pack of the drug, because that is the size of the error in a single buy.
 */
export function disagreementProblem(d: PackDisagreement, packCostCents: number | null): Problem {
  return {
    kind: "pack_size_unreadable",
    says: `The sources disagree about what a package holds: ${d.text}.`,
    todo:
      "An NDC names one package, so one of these is wrong. Check the bottle and set the pack size below — " +
      "it applies to every supplier and survives the next file.",
    level: "wrong",
    costCents: packCostCents ?? 0,
  };
}

/** Everything about one drug, for the page that has to show it. */
export function buildDrugRow(a: {
  ndc11: string;
  name: string | null;
  offers: SupplierOffer[];
  shelf: DrugRow["shelf"];
  nadacUnitMicros: number | null;
  nadacPricingUnit: string | null;
  reimbursement: Reimbursement | null;
  packFix: DrugRow["packFix"];
}): DrugRow {
  const disagreement = packDisagreement(a.offers, a.shelf);
  const costs = a.offers.map((o) => o.packCostCents).filter((c): c is number => c !== null);
  const bestPackCostCents = costs.length > 0 ? Math.min(...costs) : null;

  /*
   * Every supplier's own faults, plus the one that only exists across them.
   *
   * A fault named by two suppliers is named once here: the reader wants to know the drug has a
   * problem, not to read the same sentence per wholesaler.
   */
  const problems: Problem[] = [];
  if (disagreement && !a.packFix) problems.push(disagreementProblem(disagreement, bestPackCostCents));
  const seen = new Set<string>();
  for (const o of a.offers) {
    for (const p of o.problems) {
      const key = `${p.kind}|${p.says}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push(a.offers.length > 1 ? { ...p, says: `${o.supplier}: ${p.says}` } : p);
    }
  }

  return {
    ndc11: a.ndc11,
    name: a.name,
    offers: a.offers,
    shelf: a.shelf,
    nadacUnitMicros: a.nadacUnitMicros,
    nadacPricingUnit: a.nadacPricingUnit,
    reimbursement: a.reimbursement,
    packFix: a.packFix,
    packDisagreement: disagreement,
    problems,
    bestPackCostCents,
  };
}

/**
 * What a drug earns against what it costs, where both are known.
 *
 * The reason the two belong on one row: a reimbursement is only good or bad next to what the bottle
 * cost, and neither file says the other's number.
 */
export function marginOf(row: DrugRow): { perUnitCents: number; percent: number | null } | null {
  const reimb = row.reimbursement?.perUnitCents ?? null;
  if (reimb === null) return null;
  const cheapest = row.offers
    .map((o) => o.unitCostMicros)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b)[0];
  if (cheapest === undefined) return null;
  const costCents = cheapest / 10_000;
  const margin = reimb - costCents;
  return { perUnitCents: margin, percent: reimb > 0 ? margin / reimb : null };
}

export { money as formatMoney };
