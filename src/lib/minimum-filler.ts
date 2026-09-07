/**
 * Meeting a supplier's order minimum with the right generics.
 *
 * A secondary wholesaler is cheapest on a dozen things this week and will not ship under $500;
 * the dozen come to $180. The pharmacy fills the gap either with whatever is to hand, which is
 * how a shelf fills with stock that does not move, or with the items this supplier is genuinely
 * the best place to buy, in quantities the next two months will use. This module finds the second
 * list, per supplier, every day.
 *
 * ── What qualifies ──
 *
 * A line is added only when all of this is true: it is a generic (CMS's own flag, never a guess
 * from the name); it is not a controlled substance (the supplier's class letter on an invoice, or
 * the name lists, either one suffices to exclude); it moves at a steady rate rather than in one
 * large fill; this supplier's effective price — after the rebate where the line earns one — is the
 * lowest of every supplier who prices it, so buying it here is the best way to buy it and not just
 * a way to reach a number; and the quantity fits inside the days-of-stock cap after what is on the
 * shelf and on order.
 *
 * ── What "projected usage" means here ──
 *
 * The rate off the shelf over the lookback, carried forward over the horizon (sixty days by
 * default), less what is on hand and on order. Nothing seasonal is assumed — the site has no
 * evidence for it yet — and the horizon is a cap, not a target: the fill takes whole packs inside
 * it, never one more to reach the minimum.
 *
 * ── Ranking ──
 *
 * Two lists come out for each supplier with a minimum.
 *
 * `candidates` is the one the page shows: every generic that qualifies, one pack each, ranked by
 * how soon the shelf will need it — fewest days on hand first, and between two equally close the
 * one that saves more per dollar. It is built whether or not the planner's own lines reach the
 * minimum, because what the site thinks is going to a wholesaler and what is actually in the cart
 * at their website are two different things, and the pharmacist choosing from a ranked list can
 * reconcile them where a fixed basket cannot.
 *
 * `picks` is the greedy fill: by saving per dollar committed, then by velocity, until the
 * shortfall is met. Whole packs only, so the last pick may overshoot the minimum by less than one
 * pack, and it says by how much. Where the eligible list cannot reach the minimum, it says so and
 * by how much, rather than inventing a basket.
 *
 * Pure.
 */
import { topUpCandidates, packCostCents, type Offer, type Movement, type SupplierTerms, type Refusal, type Candidate } from "./order-plan";
import { daysOfStock } from "./usage";

export type Eligibility = {
  /** CMS's B/G flag per NDC. An NDC with no flag is not a known generic and is left out, and counted. */
  generic: Map<string, "B" | "G">;
  /** NDCs known to be controlled, from invoice class letters or the name lists. */
  controlled: Set<string>;
};

export type FillPick = {
  ndc11: string;
  name: string | null;
  /** The supplier's item number, off their catalogue, so the pick can be ordered as printed. */
  itemNumber: string | null;
  packs: number;
  packQty: number;
  unitsThousandths: number;
  costCents: number;
  /** Against the next-best supplier for the same units. */
  savingCents: number;
  perDayThousandths: number;
  /** Days the shelf would hold after the pick, counting what is already there. */
  daysOfStockAfter: number;
  /** Units the horizon is projected to use, so the pick can be read against it. */
  projectedThousandths: number;
  why: string;
};

/**
 * One generic this supplier is the best place to buy, priced by the pack, so a person can add
 * packs of it to an order until the minimum is met.
 */
export type FillCandidate = {
  ndc11: string;
  name: string | null;
  /** The supplier's own item number, so it can be ordered as printed. */
  itemNumber: string | null;
  packQty: number;
  /** One pack, at this supplier's price after its rebate. */
  packCostCents: number;
  /** What one pack saves against the next-best supplier for the same units. Never negative. */
  savingPerPackCents: number;
  /** Whole packs that fit inside the horizon after what is on the shelf and on order. At least one. */
  maxPacks: number;
  perDayThousandths: number;
  /** Days the shelf holds today, counting what is on order. */
  daysOnHand: number;
  /** Days it would hold after one more pack. */
  daysAfterOnePack: number;
  unitMicros: number;
  alternative: { supplier: string; unitMicros: number } | null;
};

export type SupplierFill = {
  supplier: string;
  supplierId: string | null;
  minimumCents: number | null;
  /** What is already going to this supplier today: the lines the shelf is short of and it is cheapest on. */
  basketCents: number;
  shortfallCents: number;
  /** Everything that qualifies, one pack each, soonest needed first. Empty where there is no minimum. */
  candidates: FillCandidate[];
  picks: FillPick[];
  addedCents: number;
  /** Cents over the minimum after the last whole pack, or short of it where it could not be met. */
  overshootCents: number;
  meets: boolean;
  /** Why the next candidates were not used, so a person can see what was considered. */
  refused: Refusal[];
  leftOut: { notGeneric: number; controlled: number; unknownClass: number };
  says: string;
};

export type FillInput = {
  suppliers: SupplierTerms[];
  /** What each supplier's basket already comes to today, by supplier name. */
  basketCentsBySupplier: Map<string, number>;
  /** NDCs already on today's order, by supplier, so nothing is added twice. */
  orderedBySupplier: Map<string, Set<string>>;
  offers: Offer[];
  movement: Movement[];
  /** On order per NDC, thousandths, counted as cover like stock on the shelf. */
  onOrderThousandths?: Map<string, number>;
  names: Map<string, string | null>;
  eligibility: Eligibility;
  /** Days of usage a pick may cover at most, on-hand and on-order included. */
  horizonDays?: number;
  materialityCents?: number;
};

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The generics this pharmacy could safely buy deep at one supplier, and what stops the rest. */
function eligible(movement: Movement[], e: Eligibility): { rows: Movement[]; leftOut: SupplierFill["leftOut"] } {
  const leftOut = { notGeneric: 0, controlled: 0, unknownClass: 0 };
  const rows: Movement[] = [];
  for (const m of movement) {
    if (e.controlled.has(m.ndc11)) {
      leftOut.controlled++;
      continue;
    }
    const cls = e.generic.get(m.ndc11);
    if (cls === undefined) {
      leftOut.unknownClass++;
      continue;
    }
    if (cls !== "G") {
      leftOut.notGeneric++;
      continue;
    }
    rows.push(m);
  }
  return { rows, leftOut };
}

export function fillMinimums(input: FillInput): SupplierFill[] {
  const horizon = input.horizonDays ?? 60;
  const materiality = input.materialityCents ?? 500;
  const out: SupplierFill[] = [];
  const { rows: candidatesMovement, leftOut } = eligible(input.movement, input.eligibility);
  // On-order stock is cover: fold it into the shelf figure the cap is measured against.
  const withCover: Movement[] = candidatesMovement.map((m) => ({ ...m, onHandThousandths: m.onHandThousandths + (input.onOrderThousandths?.get(m.ndc11) ?? 0) }));

  for (const s of input.suppliers) {
    const basketCents = input.basketCentsBySupplier.get(s.supplier) ?? 0;
    const minimumCents = s.minimumCents ?? null;
    const shortfallCents = minimumCents === null ? 0 : Math.max(0, minimumCents - basketCents);
    const base: Omit<SupplierFill, "candidates" | "picks" | "addedCents" | "overshootCents" | "meets" | "refused" | "says"> = {
      supplier: s.supplier,
      supplierId: s.supplierId ?? null,
      minimumCents,
      basketCents,
      shortfallCents,
      leftOut,
    };
    if (minimumCents === null) {
      out.push({ ...base, candidates: [], picks: [], addedCents: 0, overshootCents: 0, meets: true, refused: [], says: `${s.supplier} has no order minimum on file.` });
      continue;
    }

    const { ranked, refused } = topUpCandidates({
      supplier: s.supplier,
      offers: input.offers,
      movement: withCover,
      names: input.names,
      alreadyOrdered: input.orderedBySupplier.get(s.supplier) ?? new Set(),
      maxDaysOfStock: horizon,
      materialityCents: materiality,
    });
    const rate = new Map(withCover.map((m) => [m.ndc11, m.perDayThousandths]));
    const held = new Map(withCover.map((m) => [m.ndc11, m.onHandThousandths]));
    // Soonest needed first: the shelf that runs out on Thursday is the one to top up today.
    const candidates = ranked
      .map((c) => candidateOf(c, rate.get(c.ndc11) ?? 0, held.get(c.ndc11) ?? 0))
      .sort((a, b) => a.daysOnHand - b.daysOnHand || b.savingPerPackCents / Math.max(1, b.packCostCents) - a.savingPerPackCents / Math.max(1, a.packCostCents));

    if (shortfallCents === 0) {
      out.push({ ...base, candidates, picks: [], addedCents: 0, overshootCents: basketCents - minimumCents, meets: true, refused, says: `Today's lines of ${dollars(basketCents)} already meet the ${dollars(minimumCents)} minimum.` });
      continue;
    }
    /*
     * Saving per dollar first, then velocity: two items that save the same per dollar are told
     * apart by which one the pharmacy will dispense sooner, because that is the one whose cash
     * comes back first.
     */
    const order = [...ranked].sort((a, b) => b.savingPerDollar - a.savingPerDollar || (rate.get(b.ndc11) ?? 0) - (rate.get(a.ndc11) ?? 0));

    const picks: FillPick[] = [];
    let added = 0;
    for (const c of order) {
      if (added >= shortfallCents) break;
      const pick = pickFrom(c, shortfallCents - added, rate.get(c.ndc11) ?? 0, withCover.find((m) => m.ndc11 === c.ndc11)?.onHandThousandths ?? 0, horizon);
      if (!pick) continue;
      picks.push(pick);
      added += pick.costCents;
    }
    const meets = basketCents + added >= minimumCents;
    const overshoot = basketCents + added - minimumCents;
    const says = meets
      ? `${picks.length} generic${picks.length === 1 ? "" : "s"} for ${dollars(added)} reach the ${dollars(minimumCents)} minimum from ${dollars(basketCents)}, each cheapest here and inside ${horizon} days of use${overshoot > 0 ? `; ${dollars(overshoot)} over, the last pack being whole` : ""}.`
      : picks.length === 0
        ? `Nothing qualifies: no generic this supplier is cheapest on moves steadily enough to buy ${horizon} days of. ${dollars(shortfallCents)} short of the minimum; buy the basket at the primary or wait.`
        : `${picks.length} generic${picks.length === 1 ? "" : "s"} for ${dollars(added)} still leave the order ${dollars(-overshoot)} short of the ${dollars(minimumCents)} minimum. Buy the basket at the primary or wait for more need.`;
    out.push({ ...base, candidates, picks, addedCents: added, overshootCents: overshoot, meets, refused: refused.slice(0, 40), says });
  }
  return out;
}

/** One candidate priced by the pack, with where the shelf stands on it today. */
function candidateOf(c: Candidate, perDay: number, onHand: number): FillCandidate {
  const packQty = c.offer.packQty as number;
  const packUnits = packQty * 1000;
  const packCost = packCostCents(c.offer, 1);
  const alt = c.alternative ? Math.round((packQty * c.alternative.effectiveUnitMicros) / 10_000) : null;
  return {
    ndc11: c.ndc11,
    name: c.name,
    itemNumber: c.offer.itemNumber ?? null,
    packQty,
    packCostCents: packCost,
    savingPerPackCents: alt !== null ? Math.max(0, alt - packCost) : 0,
    maxPacks: Math.max(1, Math.floor(c.capThousandths / packUnits)),
    perDayThousandths: perDay,
    daysOnHand: daysOfStock(onHand, perDay),
    daysAfterOnePack: daysOfStock(onHand + packUnits, perDay),
    unitMicros: c.offer.effectiveUnitMicros,
    alternative: c.alternative ? { supplier: c.alternative.supplier, unitMicros: c.alternative.effectiveUnitMicros } : null,
  };
}

/**
 * The packs of one candidate to take: as many as the remaining shortfall needs, never more than
 * the cap allows, and at least one — a whole pack may overshoot the minimum, which is said rather
 * than avoided, because an order $3 over a minimum is an order and one $3 under is not.
 */
function pickFrom(c: Candidate, remainingCents: number, perDay: number, onHand: number, horizon: number): FillPick | null {
  const packQty = c.offer.packQty;
  if (!packQty || packQty <= 0) return null;
  const packUnits = packQty * 1000;
  const capPacks = Math.floor(c.capThousandths / packUnits);
  if (capPacks < 1) return null;
  const packCost = packCostCents(c.offer, 1);
  if (packCost <= 0) return null;
  const packsWanted = Math.max(1, Math.ceil(remainingCents / packCost));
  const packs = Math.min(capPacks, packsWanted);
  const units = packs * packUnits;
  const cost = packCostCents(c.offer, packs);
  const alt = c.alternative ? Math.round((units / 1000) * c.alternative.effectiveUnitMicros / 10_000) : null;
  const saving = alt !== null ? alt - cost : 0;
  return {
    ndc11: c.ndc11,
    name: c.name,
    itemNumber: c.offer.itemNumber ?? null,
    packs,
    packQty,
    unitsThousandths: units,
    costCents: cost,
    savingCents: saving,
    perDayThousandths: perDay,
    daysOfStockAfter: Math.round(daysOfStock(onHand + units, perDay)),
    projectedThousandths: Math.round(perDay * horizon),
    why: `Cheapest here at ${(c.offer.effectiveUnitMicros / 10_000 / 100).toFixed(4)}/unit${c.alternative ? ` against ${(c.alternative.effectiveUnitMicros / 10_000 / 100).toFixed(4)} at ${c.alternative.supplier}` : ""}; ${perDay > 0 ? (perDay / 1000).toFixed(2) : "0"} units a day leaves ${Math.round(daysOfStock(onHand + units, perDay))} days on the shelf after this.`,
  };
}
