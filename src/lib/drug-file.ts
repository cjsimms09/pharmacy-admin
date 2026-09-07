import "server-only";
import { packUnits, problemsWith, type Problem } from "./catalogue-check";
import { substitutable, isARated } from "./drug-directory";

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
  /**
   * The supplier's own number for this item.
   *
   * An NDC identifies the drug; this is what the order has to carry. Nobody can place an order,
   * ring a wholesaler about a line, or check a confirmation without it, and it was being read out
   * of the price file and dropped before it reached any screen.
   */
  itemNumber: string | null;
  packSize: string | null;
  /** Units the pack size gives, or null where it gives none. */
  packUnits: number | null;
  /** As printed in the price file, before any rebate. */
  unitCostMicros: number | null;
  /**
   * What the unit really costs after the rebate this line earns — the only figure two suppliers
   * can honestly be compared on.
   *
   * A wholesaler that pays a tier rebate on contract items is cheaper than its printed price by
   * exactly that rate, and comparing its printed price against a wholesaler who pays none sends
   * the order to the wrong place. Equal to the printed price where the line earns no rebate, or
   * where the line is marked as earning one but no rate is on file — which understates the
   * saving, and is the safe direction to be wrong in.
   */
  netUnitMicros: number | null;
  /** True where a rebate was actually applied above, so a screen can say the figure is net. */
  rebateApplied: boolean;
  packCostCents: number | null;
  awpCents: number | null;
  contractFlag: string | null;
  pricedOn: string | null;
  availability: string | null;
  /** True where the pharmacy has corrected this supplier's row. */
  corrected: boolean;
  /**
   * Why this supplier's price is withheld from every comparison, or null where it is not.
   *
   * The row stays — the supplier does carry the item, and the item number is still what an order
   * has to say — but its price does not decide anything until somebody settles the package. Said
   * out loud here because a price that simply vanished would be the same failure one level up.
   */
  withheld: string | null;
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

/** One other NDC of the same drug, with what it would cost to buy instead. */
export type Equivalent = {
  ndc11: string;
  name: string | null;
  /** Who makes it, from the FDA's directory rather than a wholesaler's description. */
  labeler: string | null;
  /** The cheapest net unit price anyone offers it at, and who offers it. */
  netUnitMicros: number | null;
  supplier: string | null;
  /** The supplier's own number for it, so the switch can actually be ordered. */
  itemNumber: string | null;
  packSize: string | null;
  /** True where the pharmacy already has this one on the shelf. */
  onShelf: boolean;
};

/**
 * What else is the same drug, and whether one of them is cheaper.
 *
 * The pharmacy stocks one labeller's amlodipine because that is what the wholesaler shipped the
 * first time. Six other labellers make the same tablet, the FDA rates them interchangeable, and
 * they are not the same price — the spread between labellers on one generic is routinely larger
 * than the margin on the fill. Nothing in the site said so, because grouping was done on the words
 * in a wholesaler's description, which carry the labeller and so put every labeller in its own
 * group.
 *
 * `others` is only ever NDCs the Orange Book actually rates interchangeable with this one: the
 * same ingredients, strength, form and route, and the same A-rating including its subgroup. An
 * AB1 is not offered in place of an AB2. Where the directory does not cover an NDC, or rates it
 * nothing, `why` says that and `others` is empty — a guess here is a substitution error.
 */
export type Equivalence = {
  /** Ingredients, strength, form and route, as the FDA normalises them. */
  key: string;
  teCode: string | null;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  labeler: string | null;
  /** Every interchangeable NDC the site holds a price for, cheapest first. */
  others: Equivalent[];
  /** The cheapest of those that actually beats what this NDC costs. Null where none does. */
  cheaper: Equivalent | null;
  /** What a unit saves by switching to it. */
  savesPerUnitMicros: number | null;
  /**
   * What the fills already on file would have cost less at that price.
   *
   * Stated as what has happened rather than as a year, because the claim archive is not a year and
   * calling it one would be a number nobody could check.
   */
  savesOnFilledCents: number | null;
  /** Why there is nothing to show, where there is nothing. */
  why: string | null;
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
  /**
   * The same drug from other labellers, and the cheapest of them. Null until the FDA directory is
   * loaded, which is the one thing that can say two NDCs are the same drug.
   */
  equivalence: Equivalence | null;
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
  /** Only NDCs an interchangeable NDC is cheaper than. */
  switchableOnly?: boolean;
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
    // Filled by withEquivalents once every row is built: it is a fact about the set, not about one row.
    equivalence: null,
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

/* ── The same drug from someone else ── */

/** What the directory says about one NDC, as `directoryKeys()` holds it. */
export type DirectoryFact = { key: string; teCode: string | null; genericName: string; strength: string; form: string; labeler: string };

/**
 * The cheapest a row can actually be bought for, and from whom.
 *
 * Net of the rebate, because that is the only figure two wholesalers can honestly be compared on,
 * and paired with the supplier's own item number, because a switch nobody can order is not an
 * answer.
 */
function bestBuy(r: DrugRow): { netUnitMicros: number; supplier: string; itemNumber: string | null; packSize: string | null } | null {
  let best: { netUnitMicros: number; supplier: string; itemNumber: string | null; packSize: string | null } | null = null;
  for (const o of r.offers) {
    if (o.netUnitMicros === null || o.netUnitMicros <= 0) continue;
    if (best === null || o.netUnitMicros < best.netUnitMicros)
      best = { netUnitMicros: o.netUnitMicros, supplier: o.supplier, itemNumber: o.itemNumber, packSize: o.packSize };
  }
  return best;
}

/** A price the site itself says is wrong is not a price to switch on. */
const priceIsTrusted = (r: DrugRow): boolean => !(r.packDisagreement && !r.packFix);

/**
 * Fills in every row's equivalents, once every row exists.
 *
 * Two NDCs are put beside each other only where `substitutable` says the FDA does: the same
 * ingredients, strength, form and route, and the same A-rating down to its subgroup. That is a
 * deliberately narrow test. The looser ones — same generic name, same words in the description —
 * are what produce a screen that offers a 24-hour tablet in place of a 12-hour one.
 *
 * The comparison is per unit and needs no conversion: an equivalence key fixes the strength and
 * the form, so one unit of either is the same amount of the same drug. It is drawn from the net
 * price, so a rebate that makes a dearer printed price the cheaper buy is not lost, and it skips
 * any NDC whose sources still disagree about the package — a saving computed from a pack size the
 * site has already flagged as wrong is exactly the false comparison this page exists to remove.
 */
export function withEquivalents(rows: DrugRow[], directory: Map<string, DirectoryFact>): DrugRow[] {
  if (directory.size === 0) {
    return rows.map((r) => ({
      ...r,
      equivalence: null,
    }));
  }

  const byKey = new Map<string, DrugRow[]>();
  for (const r of rows) {
    const d = directory.get(r.ndc11);
    if (!d) continue;
    byKey.set(d.key, [...(byKey.get(d.key) ?? []), r]);
  }

  return rows.map((r) => {
    const mine = directory.get(r.ndc11);
    if (!mine) {
      return {
        ...r,
        equivalence: {
          key: "", teCode: null, genericName: null, strength: null, form: null, labeler: null,
          others: [], cheaper: null, savesPerUnitMicros: null, savesOnFilledCents: null,
          why: "The FDA's directory does not list this NDC, so nothing can be rated interchangeable with it.",
        },
      };
    }

    const others: Equivalent[] = [];
    let untrusted = 0;
    for (const other of byKey.get(mine.key) ?? []) {
      if (other.ndc11 === r.ndc11) continue;
      const theirs = directory.get(other.ndc11);
      // The grouping already shares the key; this is the rating test, subgroup and all.
      if (!theirs || !substitutable({ equivalenceKey: mine.key, teCode: mine.teCode }, { equivalenceKey: theirs.key, teCode: theirs.teCode })) continue;
      if (!priceIsTrusted(other)) {
        untrusted++;
        continue;
      }
      const buy = bestBuy(other);
      others.push({
        ndc11: other.ndc11,
        name: other.name,
        labeler: theirs.labeler || null,
        netUnitMicros: buy?.netUnitMicros ?? null,
        supplier: buy?.supplier ?? null,
        itemNumber: buy?.itemNumber ?? null,
        packSize: buy?.packSize ?? null,
        onShelf: other.shelf !== null,
      });
    }
    others.sort((a, b) => (a.netUnitMicros ?? Infinity) - (b.netUnitMicros ?? Infinity));

    const myBuy = bestBuy(r);
    let cheaper: Equivalent | null = null;
    let savesPerUnitMicros: number | null = null;
    let savesOnFilledCents: number | null = null;
    let why: string | null = null;

    if (!isARated(mine.teCode)) {
      why =
        mine.teCode === null
          ? "The Orange Book gives this NDC no therapeutic equivalence rating, so nothing here is offered in its place."
          : `The Orange Book rates this ${mine.teCode}, which is not a rating that says another product may be dispensed for it.`;
    } else if (others.length === 0) {
      why = `Nothing else on file is rated ${mine.teCode} against the same ingredient, strength and form.`;
    } else if (myBuy === null) {
      why = "No supplier on file prices this NDC, so there is nothing to compare a switch against.";
    } else if (!priceIsTrusted(r)) {
      why = "The sources still disagree about what a package of this holds, so its unit price is not a figure to switch on. Settle the package below first.";
    } else {
      const priced = others.filter((o) => o.netUnitMicros !== null && o.netUnitMicros < myBuy.netUnitMicros);
      if (priced.length > 0) {
        cheaper = priced[0];
        savesPerUnitMicros = myBuy.netUnitMicros - (cheaper.netUnitMicros as number);
        const units = r.reimbursement?.unitsThousandths ?? 0;
        // Micros are millionths of a dollar and quantity is in thousandths, so the pair divides to cents.
        savesOnFilledCents = units > 0 ? Math.round((savesPerUnitMicros * units) / 10_000_000) : null;
      } else {
        why = `Nothing rated ${mine.teCode} against it is cheaper. This is already the buy.`;
      }
    }
    if (untrusted > 0) {
      const note = `${untrusted} other NDC${untrusted === 1 ? " is" : "s are"} the same drug but ${untrusted === 1 ? "its" : "their"} package is still in dispute, so ${untrusted === 1 ? "it is" : "they are"} left out.`;
      why = why ? `${why} ${note}` : note;
    }

    return {
      ...r,
      equivalence: {
        key: mine.key,
        teCode: mine.teCode,
        genericName: mine.genericName || null,
        strength: mine.strength || null,
        form: mine.form || null,
        labeler: mine.labeler || null,
        others,
        cheaper,
        savesPerUnitMicros,
        savesOnFilledCents,
        why,
      },
    };
  });
}
