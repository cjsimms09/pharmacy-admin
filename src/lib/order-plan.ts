/**
 * Which supplier gets which line, and what to add so a secondary's minimum is worth meeting.
 *
 * This is the game the pharmacy actually plays. A secondary wholesaler is cheaper on eleven items
 * this morning, but will not ship under $500, and those eleven items come to $180. The three ways
 * out are: buy the eleven from the primary and lose the saving; buy $320 of other things from the
 * secondary and hope they were things worth having; or find, among everything the secondary is
 * *also* cheaper on, the items that move fast enough that buying two weeks of them is not a
 * freezer. Only the third is a decision. The other two are what happens when nobody has the
 * numbers.
 *
 * ── The rule that keeps this honest ──
 *
 * A top-up is never justified by the discount alone. Money spent on stock is money that is not in
 * the account until the drug is dispensed, and stock that does not move is not a saving at any
 * discount — it is a write-off with a delay. So every top-up is capped by *velocity*: at most
 * `maxDaysOfStock` days of what the claims show actually leaves the shelf, and never on an item
 * whose rate is one big fill rather than a rate (usage.ts explains why those look identical in an
 * average). An item with no velocity is refused outright, whatever the price.
 *
 * ── What "cheaper" means here ──
 *
 * The effective price: the printed price less the supplier's rebate rate where a document says the
 * line earns it (product-ledger.ts). Comparing gross prices recommends leaving a contract for a
 * discount the pharmacy already has.
 *
 * And a saving on the invoice is not a saving on the year. Moving generic spend off the primary
 * lowers the compliance ratio there, and the ratio picks the band the rebate is paid at on *every*
 * contract generic in the period — so a $14 saving can cost several hundred. That arithmetic lives
 * in ratio-effect.ts, and this takes it as a function rather than repeating it, so the planner and
 * the order screen can never disagree about it.
 *
 * ── What it will not do ──
 *
 * It will not round a line up to a pack the pharmacy did not need and call the excess a top-up:
 * pack rounding is stated separately from the top-ups, because one is unavoidable and the other is
 * a choice. It will not recommend short-dated stock as a bulk buy. And where the shortfall cannot
 * be filled with items that pass all of that, it says so and prices the alternative — move the
 * basket to the primary and lose the saving — rather than inventing a basket to reach the number.
 *
 * Pure.
 */

import { daysOfStock } from "./usage";

/** How a supplier will and will not take an order. */
export type SupplierTerms = {
  supplier: string;
  supplierId?: string | null;
  /** The order value they will not ship under, in cents. Null where they have none. */
  minimumCents: number | null;
  /** Above this they ship free; below it `freightCents` is added. Null where freight never applies. */
  freeFreightCents?: number | null;
  freightCents?: number | null;
  /** Days from order to shelf, which is part of how much cover an order has to buy. */
  leadTimeDays?: number | null;
  /** True for the wholesaler whose rebate ratio moving spend away from would cost a band. */
  primary?: boolean;
};

/** One NDC the shelf is short of. */
export type Need = {
  ndc11: string;
  name: string | null;
  /** Units short, in thousandths, after on hand and on order (usage.toOrderThousandths). */
  needThousandths: number;
};

/** What one supplier will sell one NDC for. */
export type Offer = {
  ndc11: string;
  supplier: string;
  /** The supplier's item number, carried onto the line so the order can be placed from it. */
  itemNumber?: string | null;
  /** Printed, per unit, in micros. */
  unitCostMicros: number;
  /** After the rebate where the line earns it. Equal to the gross where it does not. */
  effectiveUnitMicros: number;
  rebated?: boolean | null;
  /** Units in the pack they ship. Null means the pack is unknown and the offer cannot be ordered. */
  packQty: number | null;
  /** "07/26" where the price is a short-dated lot. Never a bulk buy. */
  shortDated?: string | null;
  /** What kind of line this is for the ratio. Only meaningful at the primary. */
  kind?: "onestop_generic" | "other_generic" | "brand" | "excluded";
  description?: string | null;
};

/** What the claims say the drug does, from usage.ts. */
export type Movement = {
  ndc11: string;
  perDayThousandths: number;
  steady: boolean;
  /**
   * Which steadiness test failed, where one did.
   *
   * `steady` is three tests wearing one boolean, and the refusal printed downstream used to name
   * only one of them — the least likely on a thin archive. The reason is carried rather than
   * re-derived because the figures it is built from live in `usage.ts` and were being discarded at
   * this boundary. Null where the drug is steady, or where the caller has not worked it out.
   */
  whyNotSteady?: string | null;
  /**
   * Used enough to be an add-on: two days or two prescriptions in the window (usage.ts). Where
   * the caller has not worked it out, `steady` stands in. The days-of-stock cap bounds the cost.
   */
  usedEnough?: boolean;
  whyNotUsed?: string | null;
  /** Units on the shelf now, in thousandths. Zero where no count is held. */
  onHandThousandths: number;
};

/**
 * How much of a basket the primary would have invoiced as a contract generic, and how much could
 * not be answered either way — read off the primary's own catalogue by band-share.ts. Set by the
 * buy list after the baskets exist; the band guard prices only the contract part.
 */
export type BasketContractShare = {
  contractCents: number;
  nonContractCents: number;
  unflaggedCents: number;
  notStockedCents: number;
  atPrimaryCents: number;
  unknownShare: number;
  says: string;
};

export type PlannedLine = {
  ndc11: string;
  name: string | null;
  supplier: string;
  itemNumber?: string | null;
  packs: number;
  packQty: number;
  unitsThousandths: number;
  /** What was needed, before rounding to whole packs. */
  neededThousandths: number;
  /** Units bought beyond the need because a pack cannot be split. Not a top-up; nobody chose it. */
  packOverageThousandths: number;
  effectiveUnitMicros: number;
  costCents: number;
  /** What the same units would have cost at the next-best supplier. Null where there is no other. */
  alternativeCostCents: number | null;
  savingCents: number;
  reason: "need" | "top_up";
  /** Days of stock this line leaves on the shelf, counting what is already there. */
  daysOfStockAfter: number;
  /**
   * Why this line is for this quantity — not why the drug is on the list.
   *
   * Every row used to read "Short of the target", which explains why phentermine is listed and says
   * nothing about why the quantity is a thousand. It is a thousand because the smallest pack is a
   * thousand, and that is the fact a person needs to decide anything.
   */
  why: string;
  /**
   * A need whose smallest pack carries the shelf past the days-of-stock ceiling, and the way out.
   *
   * A need cannot be refused the way a top-up can — the drug is short and the pack is the pack. But
   * it can be said out loud, because 144 days of one drug is a decision somebody should make on
   * purpose, and where another supplier ships a smaller pack that is the decision to make.
   */
  overCap: {
    days: number;
    cap: number;
    /** A supplier whose smaller pack lands nearer the ceiling, where one exists. */
    smallerPack: { supplier: string; packQty: number; days: number; costCents: number } | null;
  } | null;
};

export type Refusal = { ndc11: string; name: string | null; supplier: string; why: string };

export type Basket = {
  supplier: string;
  supplierId: string | null;
  lines: PlannedLine[];
  /** The needed lines only, before any top-up. */
  needCents: number;
  /** Everything in the basket, top-ups included. */
  subtotalCents: number;
  /** The contract part of this basket at the primary, set by the buy list; the band guard prices only that. */
  contractShare?: BasketContractShare;
  minimumCents: number | null;
  /** How far the needed lines fall short of the minimum. Zero where they meet it. */
  shortfallCents: number;
  /** What remains short after the top-ups this could justify. */
  shortfallAfterTopUpsCents: number;
  meetsMinimum: boolean;
  freightCents: number;
  /** What this basket saves against the next-best supplier, freight included. */
  savingCents: number;
  /** Cash committed to stock beyond the immediate need. */
  topUpCents: number;
  /** What the ratio band costs or earns if this basket is placed. Negative is a band lost. */
  bandDeltaCents: number | null;
  verdict: "order" | "top_up_to_order" | "move_to_primary" | "hold";
  why: string;
  refusals: Refusal[];
};

export type PlanInput = {
  needs: Need[];
  offers: Offer[];
  terms: SupplierTerms[];
  movement: Movement[];
  /** The most days of stock a top-up may create. The pharmacy runs lean; this is the lever. */
  maxDaysOfStock: number;
  /** Below this a saving is not a reason to split an order across suppliers. */
  materialityCents: number;
  /** See topUpCandidates: the product an NDC belongs to, so an add-on may be an equivalent. */
  groupOf?: (ndc11: string) => string | null;
  /**
   * What moving this basket off the primary does to the rebate band, in cents. Negative is a cost.
   * Supplied by the caller from ratio-effect.ts so there is one such calculation in the site.
   */
  bandDelta?: (basket: { supplier: string; lines: PlannedLine[] }) => number | null;
};

export type Plan = {
  baskets: Basket[];
  /** Needs no supplier could fill, with the reason. */
  unfilled: Refusal[];
  totalCents: number;
  totalSavingCents: number;
  totalTopUpCents: number;
};

const MICROS_PER_CENT = 10_000;

/** The cost of `packs` packs of an offer, in cents. */
export function packCostCents(offer: Offer, packs: number): number {
  const qty = offer.packQty ?? 0;
  return Math.round((offer.effectiveUnitMicros * qty * packs) / MICROS_PER_CENT);
}

/** Whole packs needed to cover `thousandths` units. Zero units is zero packs; anything else is at least one. */
export function packsFor(thousandths: number, packQty: number): number {
  if (packQty <= 0 || thousandths <= 0) return 0;
  return Math.ceil(thousandths / (packQty * 1000));
}

/** The cheapest offer per supplier for one NDC, cheapest supplier first. Short-dated last, never first. */
/**
 * The cheapest sound lot per supplier across every NDC of the dispensed product, where a group is
 * known; the dispensed NDC alone where it is not. A supplier's row is its cheapest equivalent, so a
 * dearer NDC it also carries never hides the cheaper one.
 */
export function offersForProduct(offers: Offer[], ndc11: string, groupOf?: (ndc11: string) => string | null): Offer[] {
  const group = groupOf?.(ndc11) ?? null;
  if (!group) return offersFor(offers, ndc11);
  const ndcs = ndcsByGroup(offers, groupOf!).get(group) ?? [ndc11];
  const best = new Map<string, Offer>();
  for (const n of ndcs) for (const o of offersFor(offers, n)) {
    const held = best.get(o.supplier);
    if (!held || o.effectiveUnitMicros < held.effectiveUnitMicros) best.set(o.supplier, o);
  }
  return [...best.values()];
}

/*
 * The offer table indexed by NDC, and the NDCs of each product, built once per array.
 *
 * Both lookups below used to be scans. `offersFor` walked every offer to find one NDC's, and
 * `offersForProduct` walked them all again to find a product's equivalents and then called
 * `offersFor` once per equivalent — so pricing one dispensed drug cost a pass over the whole
 * catalogue for every NDC in its group, and the planner prices two thousand drugs against fifty
 * thousand catalogue rows. On 8 September that pinned a core for minutes at a time and the site
 * answered nothing at all while it ran: a CPU profile of the live process put 93% of its samples
 * inside these two functions and the equivalence lookup they call.
 *
 * Keyed on the array itself, so nothing has to be invalidated: the catalogue cache builds a new
 * array whenever it reloads, and a WeakMap lets an old index go with the rows it indexed. The
 * group index is keyed on the grouping function too, because each caller passes its own.
 */
const offerIndexes = new WeakMap<Offer[], Map<string, Offer[]>>();
const groupIndexes = new WeakMap<Offer[], WeakMap<(ndc11: string) => string | null, Map<string, string[]>>>();

function offersByNdc(offers: Offer[]): Map<string, Offer[]> {
  const held = offerIndexes.get(offers);
  if (held) return held;
  const index = new Map<string, Offer[]>();
  for (const o of offers) {
    const list = index.get(o.ndc11);
    if (list) list.push(o);
    else index.set(o.ndc11, [o]);
  }
  offerIndexes.set(offers, index);
  return index;
}

function ndcsByGroup(offers: Offer[], groupOf: (ndc11: string) => string | null): Map<string, string[]> {
  let perFunction = groupIndexes.get(offers);
  if (!perFunction) {
    perFunction = new WeakMap();
    groupIndexes.set(offers, perFunction);
  }
  const held = perFunction.get(groupOf);
  if (held) return held;
  const index = new Map<string, string[]>();
  for (const ndc11 of offersByNdc(offers).keys()) {
    const group = groupOf(ndc11);
    if (!group) continue;
    const list = index.get(group);
    if (list) list.push(ndc11);
    else index.set(group, [ndc11]);
  }
  perFunction.set(groupOf, index);
  return index;
}

export function offersFor(offers: Offer[], ndc11: string): Offer[] {
  const best = new Map<string, Offer>();
  for (const o of offersByNdc(offers).get(ndc11) ?? []) {
    if (o.packQty === null || o.packQty <= 0) continue;
    const held = best.get(o.supplier);
    /*
     * A supplier is represented by its cheapest *sound* lot, not simply its cheapest lot.
     *
     * Taking the cheapest of anything threw away the answer before the comparison below could make
     * it. A wholesaler with a short-dated lot at 4c and a good lot at 10c was represented by the 4c
     * one, which the sort then pushed to the back for being short-dated — so the 10c lot, the
     * cheapest sound price on the table, never competed at all and the order went to a supplier at
     * 11c. The comment below says a short-dated lot never wins a comparison it would otherwise win;
     * it was also losing comparisons its supplier would otherwise have won.
     */
    const better =
      !held ||
      (Boolean(held.shortDated) && !o.shortDated) ||
      (Boolean(held.shortDated) === Boolean(o.shortDated) && o.effectiveUnitMicros < held.effectiveUnitMicros);
    if (better) best.set(o.supplier, o);
  }
  return [...best.values()].sort((a, b) => {
    // A short-dated lot is not a price; it never wins a comparison it would otherwise win.
    const sd = Number(Boolean(a.shortDated)) - Number(Boolean(b.shortDated));
    if (sd !== 0) return sd;
    return a.effectiveUnitMicros - b.effectiveUnitMicros;
  });
}

/**
 * Builds the plan.
 *
 * Needs go to the cheapest supplier that can actually ship the NDC. Baskets that fall short of a
 * minimum are then offered top-ups — items that supplier also beats the field on — ranked by how
 * much each dollar committed saves, and each capped at `maxDaysOfStock` days of real movement.
 */
export function planOrder(input: PlanInput): Plan {
  const termsBy = new Map(input.terms.map((t) => [t.supplier, t]));
  const moveBy = new Map(input.movement.map((m) => [m.ndc11, m]));
  const unfilled: Refusal[] = [];

  const nameOf = new Map<string, string | null>();
  for (const n of input.needs) nameOf.set(n.ndc11, n.name);

  type Draft = { terms: SupplierTerms; lines: PlannedLine[]; refusals: Refusal[] };
  const drafts = new Map<string, Draft>();
  const draftFor = (supplier: string): Draft => {
    let d = drafts.get(supplier);
    if (!d) {
      d = { terms: termsBy.get(supplier) ?? { supplier, minimumCents: null }, lines: [], refusals: [] };
      drafts.set(supplier, d);
    }
    return d;
  };

  const lineFor = (
    ndc11: string,
    name: string | null,
    offer: Offer,
    alternative: Offer | null,
    neededThousandths: number,
    reason: PlannedLine["reason"],
  ): PlannedLine => {
    const packQty = offer.packQty as number;
    const packs = packsFor(neededThousandths, packQty);
    const unitsThousandths = packs * packQty * 1000;
    const costCents = packCostCents(offer, packs);
    const alternativeCostCents =
      alternative && alternative.packQty
        ? // Priced on the same units, not on the alternative's own pack rounding, so the comparison
          // is of prices rather than of pack sizes.
          Math.round((alternative.effectiveUnitMicros * unitsThousandths) / 1000 / MICROS_PER_CENT)
        : null;
    const m = moveBy.get(ndc11);
    const onHand = m?.onHandThousandths ?? 0;
    const perDay = m?.perDayThousandths ?? 0;
    const daysOfStockAfter = daysOfStock(onHand + unitsThousandths, perDay);
    const overage = Math.max(0, unitsThousandths - neededThousandths);

    /*
     * A need over the ceiling, and whether anybody ships a smaller pack.
     *
     * Only needs: a top-up is already refused above the cap where it would breach it, and the
     * refusal says so. Cheapest first among the packs small enough to help, because the point is to
     * buy less, not to buy dearer.
     */
    let overCap: PlannedLine["overCap"] = null;
    if (reason === "need" && perDay > 0 && daysOfStockAfter > input.maxDaysOfStock) {
      const smaller = offersFor(input.offers, ndc11)
        .filter((o) => (o.packQty ?? 0) > 0 && (o.packQty as number) < packQty && !o.shortDated)
        .map((o) => {
          const q = o.packQty as number;
          const units = packsFor(neededThousandths, q) * q * 1000;
          return { supplier: o.supplier, packQty: q, days: daysOfStock(onHand + units, perDay), costCents: packCostCents(o, packsFor(neededThousandths, q)) };
        })
        .filter((o) => o.days < daysOfStockAfter)
        .sort((a, b) => a.days - b.days || a.costCents - b.costCents);
      overCap = { days: daysOfStockAfter, cap: input.maxDaysOfStock, smallerPack: smaller[0] ?? null };
    }

    const round = (t: number) => Math.round(t / 1000);
    /*
     * A need filled from an expiring lot says so on the line.
     *
     * A top-up is refused outright when it is short-dated, but a need is not: the drug is wanted and
     * this may be the only lot anybody has. That is a decision to commit to stock expiring inside
     * the return window, and it is the pharmacist's to make rather than one to discover on delivery.
     */
    const dated = offer.shortDated ? ` ${offer.supplier} has it only as ${offer.shortDated} — it expires inside the return window.` : "";
    const why =
      reason === "top_up"
        ? `Added to reach ${offer.supplier}'s minimum: it is cheaper here and it moves.`
        : overage <= 0
          ? `Short ${round(neededThousandths)} and the pack is ${packQty}, so this is exactly the need.${dated}`
          : `Short ${round(neededThousandths)}; the smallest pack here is ${packQty}, so ${packs} pack${packs === 1 ? "" : "s"} is ${round(unitsThousandths)} — ${round(overage)} more than the need.${dated}`;

    return {
      ndc11,
      name,
      supplier: offer.supplier,
      itemNumber: offer.itemNumber ?? null,
      packs,
      packQty,
      unitsThousandths,
      neededThousandths,
      packOverageThousandths: overage,
      effectiveUnitMicros: offer.effectiveUnitMicros,
      costCents,
      alternativeCostCents,
      savingCents: alternativeCostCents === null ? 0 : alternativeCostCents - costCents,
      reason,
      daysOfStockAfter,
      why,
      overCap,
    };
  };

  // ── The needs, each to the supplier that sells it cheapest ──
  for (const need of input.needs) {
    if (need.needThousandths <= 0) continue;
    const ranked = offersFor(input.offers, need.ndc11);
    if (ranked.length === 0) {
      unfilled.push({ ndc11: need.ndc11, name: need.name, supplier: "—", why: "No supplier offers this NDC at a price with a known pack size." });
      continue;
    }
    const pick = ranked[0];
    /*
     * The saving is measured against a price this planner would actually pay.
     *
     * `ranked[1]` can be a short-dated lot, and a short-dated lot is not a price — the sort puts it
     * last for exactly that reason. Measured against it the arithmetic went wrong in both
     * directions: a cheap short-dated alternative made a sound pick look like a *loss*, dragging
     * the basket's total saving down and able to flip the verdict on it; and where the pick itself
     * was the only sound lot, the figure quoted the pharmacist a saving against stock nobody would
     * buy.
     *
     * So the comparison is against the next offer of the same kind: sound against sound, and — where
     * every lot on the market is short-dated — short-dated against short-dated.
     */
    const next = ranked.slice(1).find((o) => Boolean(o.shortDated) === Boolean(pick.shortDated)) ?? null;
    draftFor(pick.supplier).lines.push(lineFor(need.ndc11, need.name, pick, next, need.needThousandths, "need"));
  }

  // ── Top-ups, only where a minimum is short and only on things that move ──
  const baskets: Basket[] = [];
  for (const [supplier, draft] of drafts) {
    const needCents = draft.lines.reduce((n, l) => n + l.costCents, 0);
    const minimum = draft.terms.minimumCents;
    const shortfall = minimum === null ? 0 : Math.max(0, minimum - needCents);

    if (shortfall > 0) {
      const candidates = topUpCandidates({
        supplier,
        offers: input.offers,
        movement: input.movement,
        names: nameOf,
        alreadyOrdered: new Set(draft.lines.map((l) => l.ndc11)),
        maxDaysOfStock: input.maxDaysOfStock,
        materialityCents: input.materialityCents,
        groupOf: input.groupOf,
      });
      draft.refusals.push(...candidates.refused);

      let filled = 0;
      for (const c of candidates.ranked) {
        if (filled >= shortfall) break;
        /*
         * Only as many packs as the shortfall needs, never the whole cap. The cap is what the shelf
         * could absorb; the shortfall is what the order needs — seven packs of a $300 pod to cover a
         * $169 gap was the cap standing in for the need. One pack that alone overshoots is still
         * allowed: the alternative is not reaching the minimum at all.
         */
        const perPack = packCostCents(c.offer, 1);
        const packUnits = (c.offer.packQty as number) * 1000;
        const capPacks = Math.max(1, Math.floor(c.capThousandths / packUnits));
        const packs = Math.max(1, Math.min(capPacks, Math.ceil((shortfall - filled) / Math.max(1, perPack))));
        const line = lineFor(c.ndc11, nameOf.get(c.ndc11) ?? c.name, c.offer, c.alternative, packs * packUnits, "top_up");
        draft.lines.push(line);
        filled += line.costCents;
      }
    }

    const subtotal = draft.lines.reduce((n, l) => n + l.costCents, 0);
    const topUpCents = draft.lines.filter((l) => l.reason === "top_up").reduce((n, l) => n + l.costCents, 0);
    const meets = minimum === null || subtotal >= minimum;
    const freeAt = draft.terms.freeFreightCents ?? null;
    const freightCents = freeAt !== null && subtotal < freeAt ? (draft.terms.freightCents ?? 0) : 0;
    const saving = draft.lines.reduce((n, l) => n + l.savingCents, 0) - freightCents;
    const bandDeltaCents = input.bandDelta ? input.bandDelta({ supplier, lines: draft.lines }) : null;

    baskets.push({
      supplier,
      supplierId: draft.terms.supplierId ?? null,
      lines: draft.lines,
      needCents,
      subtotalCents: subtotal,
      minimumCents: minimum,
      shortfallCents: shortfall,
      shortfallAfterTopUpsCents: minimum === null ? 0 : Math.max(0, minimum - subtotal),
      meetsMinimum: meets,
      freightCents,
      savingCents: saving,
      topUpCents,
      bandDeltaCents,
      ...verdictFor({
        meets, shortfall, topUpCents, saving, bandDeltaCents,
        materialityCents: input.materialityCents,
        primary: draft.terms.primary === true,
        shortfallAfter: minimum === null ? 0 : Math.max(0, minimum - subtotal),
      }),
      refusals: draft.refusals,
    });
  }

  baskets.sort((a, b) => b.savingCents - a.savingCents);
  return {
    baskets,
    unfilled,
    totalCents: baskets.reduce((n, b) => n + b.subtotalCents + b.freightCents, 0),
    totalSavingCents: baskets.reduce((n, b) => n + b.savingCents + (b.bandDeltaCents ?? 0), 0),
    totalTopUpCents: baskets.reduce((n, b) => n + b.topUpCents, 0),
  };
}

/**
 * What to say about a basket, in one sentence, and which of the four things to do.
 *
 * Separated out because it is the sentence the pharmacist reads and acts on, and a sentence that
 * says "order" over a basket that loses money is worse than no sentence.
 */
export function verdictFor(a: {
  meets: boolean;
  shortfall: number;
  shortfallAfter: number;
  topUpCents: number;
  saving: number;
  bandDeltaCents: number | null;
  materialityCents: number;
  primary: boolean;
}): { verdict: Basket["verdict"]; why: string } {
  const net = a.saving + (a.bandDeltaCents ?? 0);
  if (a.bandDeltaCents !== null && a.bandDeltaCents < 0 && net <= 0) {
    return {
      verdict: "move_to_primary",
      why: `Saves $${(a.saving / 100).toFixed(2)} on the invoice but costs $${(Math.abs(a.bandDeltaCents) / 100).toFixed(2)} in rebate band. Buy it at the primary.`,
    };
  }
  if (!a.meets) {
    return {
      verdict: "hold",
      why: `Short of the minimum by $${(a.shortfallAfter / 100).toFixed(2)} with nothing worth buying deep. Move these lines to the primary or wait for the next need.`,
    };
  }
  if (!a.primary && a.saving < a.materialityCents) {
    return { verdict: "move_to_primary", why: `Saves only $${(a.saving / 100).toFixed(2)}. Not worth a second order.` };
  }
  if (a.topUpCents > 0) {
    return {
      verdict: "top_up_to_order",
      why: `Needed lines were $${(a.shortfall / 100).toFixed(2)} short of the minimum. Adding $${(a.topUpCents / 100).toFixed(2)} of fast movers meets it and keeps the saving.`,
    };
  }
  return { verdict: "order", why: `Meets the minimum on the needed lines alone. Saves $${(a.saving / 100).toFixed(2)}.` };
}

export type Candidate = {
  /** The NDC to buy — an AB-rated equivalent of the dispensed one where that is cheaper, else the same. */
  ndc11: string;
  /** The NDC the pharmacy dispenses, whose rate this add-on is sized on. */
  dispensedNdc11: string;
  name: string | null;
  offer: Offer;
  alternative: Offer | null;
  /** Units to top up by, in thousandths: whole packs fitting inside the days-of-stock cap. */
  capThousandths: number;
  /** What buying the cap here saves against the next-best supplier, in cents. */
  savingCents: number;
  /** Cents committed to reach that saving. */
  costCents: number;
  /** Saving per dollar committed. The ranking. */
  savingPerDollar: number;
};

/**
 * Everything this supplier is cheapest on, that moves, that can safely be bought deep.
 *
 * Ranked by saving per dollar committed rather than by saving, because the shortfall is a budget:
 * the question is not which item saves most but which items save most per dollar of the pharmacy's
 * cash that has to sit on a shelf to get there.
 */
const fold = (s: string) => s.trim().toLowerCase();

export function topUpCandidates(a: {
  supplier: string;
  offers: Offer[];
  movement: Movement[];
  names: Map<string, string | null>;
  alreadyOrdered: Set<string>;
  maxDaysOfStock: number;
  materialityCents: number;
  /**
   * The product an NDC belongs to, for generics: every AB-rated equivalent the pharmacy could buy
   * instead. The owner, 8 September: the page told him to buy the $38 Sun cipro/dex bottle when ANDA
   * and McKesson sell equivalents at $19.93 and $19.75 and Kansas Medicaid pays the same NADAC on
   * all of them. Null (or a null answer) keeps the comparison to the same NDC.
   */
  groupOf?: (ndc11: string) => string | null;
}): { ranked: Candidate[]; refused: Refusal[] } {
  const ranked: Candidate[] = [];
  const refused: Refusal[] = [];
  const name = (ndc: string, fallback: string | null) => a.names.get(ndc) ?? fallback;

  for (const m of a.movement) {
    if (a.alreadyOrdered.has(m.ndc11)) continue;
    const priced = offersForProduct(a.offers, m.ndc11, a.groupOf);
    // Folded: the register says "Parmed", the catalogue "ParMed", and a raw === lists nothing for it.
    const mine = fold(a.supplier);
    const ours = priced.find((o) => fold(o.supplier) === mine);
    if (!ours) continue;
    const label = name(m.ndc11, ours.description ?? null);

    if (ours.shortDated) {
      refused.push({ ndc11: m.ndc11, name: label, supplier: a.supplier, why: `Short-dated (${ours.shortDated}). Never a bulk buy.` });
      continue;
    }
    if (m.perDayThousandths <= 0) {
      refused.push({ ndc11: m.ndc11, name: label, supplier: a.supplier, why: "Nothing dispensed in the window. Stock with no velocity is a write-off with a delay." });
      continue;
    }
    if (!(m.usedEnough ?? m.steady)) {
      // The reason names the test that actually failed. One sentence for three tests printed the
      // wrong one 103 times out of 103 on this pharmacy's data.
      refused.push({
        ndc11: m.ndc11,
        name: label,
        supplier: a.supplier,
        why: m.whyNotUsed ?? m.whyNotSteady ?? "The rate is one large fill, not a rate. Buying deep on it is buying for a patient who may not return.",
      });
      continue;
    }

    const alternative = priced.find((o) => fold(o.supplier) !== mine) ?? null;
    if (!alternative) {
      refused.push({ ndc11: m.ndc11, name: label, supplier: a.supplier, why: "Only this supplier prices it, so there is no saving to bank — buy it when it is needed." });
      continue;
    }
    // The same price is allowed: reaching a minimum on it costs nothing. Dearer is not.
    if (ours.effectiveUnitMicros > alternative.effectiveUnitMicros) {
      continue; // Not cheaper here. Silent: this is most of the catalogue.
    }

    // The cap: days of stock, less what is already on the shelf, then rounded to whole packs.
    const room = Math.max(0, a.maxDaysOfStock * m.perDayThousandths - m.onHandThousandths);
    if (room <= 0) {
      refused.push({ ndc11: m.ndc11, name: label, supplier: a.supplier, why: `Already holding more than ${a.maxDaysOfStock} days of stock.` });
      continue;
    }
    /*
     * Whole packs that fit *inside* the cap, so it is a floor and not a ceiling.
     *
     * Rounding up here would breach the cap on almost every item, because a pack size has no
     * reason to divide into a fortnight of demand. Rounding down buys slightly less than the
     * budget allows, which costs a little discount; rounding up buys stock the pharmacy decided
     * it did not want, which is the thing this whole module exists to prevent.
     */
    const packQty = ours.packQty as number;
    const packUnits = packQty * 1000;
    const packs = Math.floor(room / packUnits);
    if (packs < 1) {
      const wouldBe = daysOfStock(m.onHandThousandths + packUnits, m.perDayThousandths);
      refused.push({
        ndc11: m.ndc11, name: label, supplier: a.supplier,
        why: `The smallest pack is ${Math.round(wouldBe)} days of stock, over the ${a.maxDaysOfStock}-day cap.`,
      });
      continue;
    }
    const unitsThousandths = packs * packUnits;

    const costCents = packCostCents(ours, packs);
    const alternativeCents = Math.round((alternative.effectiveUnitMicros * unitsThousandths) / 1000 / MICROS_PER_CENT);
    const savingCents = alternativeCents - costCents;
    // An add-on exists to reach a minimum, so a saving of nothing is allowed; a loss is not. The
    // ranking below still puts the real savings first.
    if (savingCents < 0) continue;

    ranked.push({
      ndc11: ours.ndc11, dispensedNdc11: m.ndc11, name: label, offer: ours, alternative,
      capThousandths: unitsThousandths, savingCents, costCents,
      savingPerDollar: costCents > 0 ? savingCents / costCents : 0,
    });
  }

  ranked.sort((x, y) => y.savingPerDollar - x.savingPerDollar || y.savingCents - x.savingCents);
  return { ranked, refused };
}
