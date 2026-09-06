import "server-only";
import { db, schema } from "@/db";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { parseOnHand, onHandTotals } from "./on-hand";
import { velocity, toOrderThousandths, type Velocity } from "./usage";
import { leanShelf, shelfTotals, type ShelfRow } from "./lean-shelf";
import { planOrder, type Offer, type Need, type Movement, type SupplierTerms, type Plan } from "./order-plan";

/**
 * The shelf, joined to everything that has an opinion about it.
 *
 * The four modules underneath are pure and each answers one question: what moves (usage), what is
 * here (on-hand), what to buy and from whom (order-plan), what to send back (lean-shelf). This is
 * the only place that loads the database and puts them together, so the arithmetic stays testable
 * and there is exactly one definition of each figure in the site.
 *
 * ── The window, and why it is stated rather than assumed ──
 *
 * Velocity is units divided by days, and the days are the claim days actually held — not the days
 * a particular drug happens to appear in. Every rate in the site therefore shares a denominator,
 * which is what makes two drugs comparable. It is computed once, here, and handed down.
 */

/** How lean the pharmacy intends to run, and what it will not do to get there. */
export const SHELF_POLICY = {
  /** Days of stock to hold. The pharmacy's stated intent is one to two. */
  targetDays: 2,
  /** The most days of stock a bulk buy may create when filling a supplier's minimum. */
  maxTopUpDays: 14,
  /** Below this, a saving or a surplus is not worth an order line or an authorisation. */
  materialityCents: 500,
  /** How far back to measure movement. Long enough to be a rate, short enough to be current. */
  lookbackDays: 90,
};

export type ShelfSnapshot = {
  countedOn: string;
  fileName: string;
  rows: { ndc11: string; description: string | null; quantityThousandths: number; valueCents: number | null }[];
  valueCents: number | null;
  unitsThousandths: number;
  items: number;
  unmappedColumns: string[];
  skipReasons: Record<string, number>;
};

/**
 * Files a day's count, replacing that day wholesale.
 *
 * The same day uploaded twice is the same shelf, not twice the shelf. `countedOn` comes off the
 * file where it prints one; where it does not, the caller has to say, because dating a count wrong
 * by a day misplaces a day of dispensing and the site would then recommend returning stock that
 * has already gone.
 */
export async function fileOnHand(
  buf: Buffer,
  fileName: string,
  by: { userId: string },
  opts: { countedOn?: string; documentId?: string | null } = {},
): Promise<{ ok: true; countedOn: string; items: number; replaced: boolean; unmappedColumns: string[]; skipped: Record<string, number> } | { ok: false; why: string }> {
  const parsed = parseOnHand(buf.toString("utf8"));
  if (parsed.problems.length > 0 && parsed.rows.length === 0) return { ok: false, why: parsed.problems[0] };
  const countedOn = opts.countedOn ?? parsed.countedOn;
  if (!countedOn) {
    return { ok: false, why: "The file carries no count date. Say which day it is for and upload it again." };
  }
  if (parsed.rows.length === 0) return { ok: false, why: "No usable rows: every line was missing an NDC or a quantity." };

  const totals = onHandTotals(parsed.rows);
  const existing = await db.query.onHandImports.findFirst({ where: eq(schema.onHandImports.countedOn, countedOn) });
  if (existing) await db.delete(schema.onHandImports).where(eq(schema.onHandImports.id, existing.id));

  const importId = randomUUID();
  await db.insert(schema.onHandImports).values({
    id: importId,
    countedOn,
    fileName,
    rowsRead: parsed.rowsRead,
    itemsKept: parsed.rows.length,
    skipReasons: JSON.stringify(parsed.skipped),
    unmappedColumns: JSON.stringify(parsed.unmappedColumns),
    unitsThousandths: totals.unitsThousandths,
    valueCents: totals.valueCents,
    documentId: opts.documentId ?? null,
    createdBy: by.userId,
  });
  await db.insert(schema.onHand).values(
    parsed.rows.map((r) => ({
      id: randomUUID(),
      importId,
      countedOn,
      ndc11: r.ndc11,
      description: r.description,
      itemNumber: r.itemNumber,
      quantityThousandths: r.quantityThousandths,
      unit: r.unit,
      unitCostMicros: r.unitCostMicros,
      valueCents: r.valueCents,
    })),
  );

  return {
    ok: true, countedOn, items: parsed.rows.length, replaced: Boolean(existing),
    unmappedColumns: parsed.unmappedColumns, skipped: parsed.skipped,
  };
}

/** The most recent count held, or null where none has been uploaded. */
export async function latestShelf(): Promise<ShelfSnapshot | null> {
  const imp = await db.query.onHandImports.findFirst({ orderBy: [desc(schema.onHandImports.countedOn)] });
  if (!imp) return null;
  const rows = await db.query.onHand.findMany({ where: eq(schema.onHand.countedOn, imp.countedOn) });
  return {
    countedOn: imp.countedOn,
    fileName: imp.fileName,
    rows: rows.map((r) => ({ ndc11: r.ndc11, description: r.description, quantityThousandths: r.quantityThousandths, valueCents: r.valueCents })),
    valueCents: imp.valueCents,
    unitsThousandths: imp.unitsThousandths,
    items: imp.itemsKept,
    unmappedColumns: safeJson<string[]>(imp.unmappedColumns, []),
    skipReasons: safeJson<Record<string, number>>(imp.skipReasons, {}),
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * How fast everything moves, over the claim days actually held.
 *
 * The window is trimmed to `lookbackDays` so a rate is current, but never below the span of claims
 * held: a pharmacy a fortnight into using this site has a fortnight of window, and dividing that
 * fortnight's dispensing by ninety days would report every drug as barely moving and recommend
 * returning the lot.
 */
export async function movement(lookbackDays = SHELF_POLICY.lookbackDays): Promise<{ rows: Velocity[]; from: string; to: string } | null> {
  const claims = await db.query.claims.findMany();
  if (claims.length === 0) return null;

  /*
   * One row per dispensing, not per transmission.
   *
   * A fill billed to a primary plan and then a secondary is two claim rows for one bottle, each
   * carrying the same quantity. Counted as claims, that bottle is dispensed twice — so every
   * coordinated drug would show double the velocity, and the two places that hurt most are the
   * two this feeds: it would order twice what is needed and refuse to return stock that is
   * genuinely surplus. The purchasing ledger already learned this the same way.
   */
  const { groupIntoFills } = await import("./fills");
  const { laterPayments } = await import("./claim-payments");
  const later = await laterPayments();
  const fills = groupIntoFills(
    claims.map((c) => ({
      id: c.id, rxNumber: c.rxNumber, fillNumber: c.fillNumber, dateFilled: c.dateFilled,
      ndc11: c.ndc11, itemName: c.itemName, bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber,
      pbmName: c.pbmName, payerLabel: c.payerLabel, quantityThousandths: c.quantityThousandths,
      remitCents: c.remitCents, copayCents: c.copayCents, patientTotalCents: c.patientTotalCents,
      acquisitionCents: c.acquisitionCents, status: c.status, onAccount: c.onAccount,
      unmatchedReversal: (c.remitCents ?? 0) < 0 && !c.reversalKey,
    })),
    later,
  );
  /*
   * Days supply back onto the fill it belongs to.
   *
   * A fill carries no days supply of its own — it is a property of the prescription, and each of
   * the rows that made up a coordinated fill repeats it. Keyed on the prescription and the day, so
   * a re-run at a different quantity on a different day keeps its own.
   */
  const daysSupplyBy = new Map<string, number>();
  for (const c of claims) {
    if (c.daysSupply === null) continue;
    const key = `${c.rxNumber}|${c.dateFilled}`;
    const held = daysSupplyBy.get(key);
    if (held === undefined || c.daysSupply > held) daysSupplyBy.set(key, c.daysSupply);
  }

  const events = fills.map((f) => ({
    ndc11: f.ndc11,
    itemName: f.itemName,
    dateFilled: f.dateFilled,
    quantityThousandths: f.quantityThousandths,
    daysSupply: daysSupplyBy.get(`${f.rxNumber}|${f.dateFilled}`) ?? null,
    rxNumber: f.rxNumber,
    // groupIntoFills has already dropped what a reversal cancelled; nothing here is reversed.
    status: "paid" as const,
  }));

  const days = events.map((e) => e.dateFilled).filter(Boolean).sort();
  if (days.length === 0) return null;
  const to = days[days.length - 1];
  const earliest = days[0];
  const cutoff = new Date(Date.parse(`${to}T00:00:00Z`) - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const from = cutoff > earliest ? cutoff : earliest;
  return { rows: velocity(events.filter((e) => e.dateFilled >= from), { from, to }), from, to };
}

/** Movement joined to the shelf, which is what both the buy list and the return list run on. */
export async function shelfMovement(): Promise<{ movement: Movement[]; velocity: Velocity[]; snapshot: ShelfSnapshot | null; from: string | null; to: string | null }> {
  const [m, snapshot] = await Promise.all([movement(), latestShelf()]);
  const onHandBy = new Map((snapshot?.rows ?? []).map((r) => [r.ndc11, r.quantityThousandths]));
  const rows = m?.rows ?? [];
  return {
    velocity: rows,
    snapshot,
    from: m?.from ?? null,
    to: m?.to ?? null,
    movement: rows.map((v) => ({
      ndc11: v.ndc11,
      perDayThousandths: v.perDayThousandths,
      steady: v.steady,
      onHandThousandths: onHandBy.get(v.ndc11) ?? 0,
    })),
  };
}

export type LeanShelfView = {
  rows: ShelfRow[];
  totals: ReturnType<typeof shelfTotals>;
  snapshot: ShelfSnapshot | null;
  /** Named so the page can say what it could not do rather than showing a short list as if complete. */
  missing: string[];
};

/** What to send back, and by when. */
export async function leanShelfNow(): Promise<LeanShelfView> {
  const { movement: move, velocity: vel, snapshot } = await shelfMovement();
  const missing: string[] = [];
  if (!snapshot) missing.push("No inventory count has been uploaded, so nothing can be sized against what is here.");
  if (vel.length === 0) missing.push("No claims are held, so nothing has a rate to be measured against.");
  if (!snapshot || vel.length === 0) return { rows: [], totals: shelfTotals([], null), snapshot, missing };

  const velBy = new Map(vel.map((v) => [v.ndc11, v]));
  const moveBy = new Map(move.map((m) => [m.ndc11, m]));

  /*
   * The open return windows, from the invoice clock, keyed by NDC.
   *
   * Where one NDC sits on several invoices the soonest step is the one that matters — it is the
   * next deadline, and a later invoice's longer window does not extend the earlier bottle's.
   */
  const { returnsDueNow } = await import("./returns-due");
  const due = await returnsDueNow();
  const returns = new Map<string, { supplier: string; creditPercentNow: number; dropsInDays: number | null; dropsToPercent: number | null; closesInDays: number | null }>();
  for (const r of due.rows) {
    const held = returns.get(r.ndc11);
    const soonest = (x: { dropsInDays: number | null; closesInDays: number | null }) =>
      Math.min(x.dropsInDays ?? Number.MAX_SAFE_INTEGER, x.closesInDays ?? Number.MAX_SAFE_INTEGER);
    if (held && soonest(held) <= soonest(r)) continue;
    returns.set(r.ndc11, {
      supplier: r.supplier,
      creditPercentNow: r.creditPercentNow,
      dropsInDays: r.dropsInDays,
      dropsToPercent: r.dropsToPercent,
      closesInDays: r.closesInDays,
    });
  }
  if (due.suppliersWithoutPolicy.length > 0) {
    missing.push(`No return policy on file for ${due.suppliersWithoutPolicy.join(", ")}, so nothing bought from them is given a window.`);
  }

  const rows = leanShelf({
    onHand: snapshot.rows,
    movement: vel.map((v) => ({ ndc11: v.ndc11, name: v.name, perDayThousandths: v.perDayThousandths, steady: v.steady, lastOn: v.lastOn })),
    returns,
    targetDays: SHELF_POLICY.targetDays,
    materialityCents: SHELF_POLICY.materialityCents,
  });
  void velBy;
  void moveBy;
  return { rows, totals: shelfTotals(rows, snapshot.valueCents), snapshot, missing };
}

export type BuyListView = {
  plan: Plan;
  needs: Need[];
  suppliers: SupplierTerms[];
  snapshot: ShelfSnapshot | null;
  missing: string[];
};

/**
 * What to order this morning, from whom, and what to add to reach a minimum.
 *
 * Needs come from the shelf against the target: what is on hand, what leaves per day, what the
 * supplier's lead time is. Offers come from the catalogues at their effective price — the printed
 * price less the rebate rate where the line earns it — which is the only comparison that does not
 * recommend leaving a contract for a discount the pharmacy already has.
 */
export async function buyListNow(): Promise<BuyListView> {
  const { movement: move, velocity: vel, snapshot } = await shelfMovement();
  const missing: string[] = [];
  if (!snapshot) missing.push("No inventory count has been uploaded. Without one, a shortfall cannot be told from a full shelf.");
  if (vel.length === 0) missing.push("No claims are held, so nothing has a rate to buy against.");

  const { allSuppliers } = await import("./suppliers-registry");
  const registry = await allSuppliers(true);
  const suppliers: SupplierTerms[] = registry.map((s) => ({
    supplier: s.name,
    supplierId: s.id,
    minimumCents: s.minimumOrderCents ?? null,
    freeFreightCents: s.freeFreightCents ?? null,
    freightCents: s.freightCents ?? null,
    leadTimeDays: s.leadTimeDays ?? null,
    primary: s.primarySupplier === true,
  }));
  const leadBy = new Map(suppliers.map((s) => [s.supplier, s.leadTimeDays ?? 1]));
  const shortestLead = Math.min(...[...leadBy.values()], 1);

  const items = await db.query.supplierItems.findMany({
    columns: { supplier: true, ndc11: true, description: true, unitCostMicros: true, packSize: true, contractFlag: true, availability: true },
  });
  if (items.length === 0) missing.push("No supplier catalogue has been imported, so there is nothing to price an order against.");

  /*
   * The rebate rate per supplier, so a contract line is compared at what it actually costs.
   *
   * The same source the purchasing ledger uses: each supplier's own ladder at the ratio they are
   * currently in. A supplier with no ladder on file discounts nothing here, because an invented
   * rate is a recommendation to move spend off a contract for a discount that does not exist.
   */
  const { contractRatesBySupplier } = await import("./rebate-rates");
  const { packQtyOf } = await import("./product-ledger");
  const rates = await contractRatesBySupplier();

  const offers: Offer[] = [];
  for (const it of items) {
    if (it.unitCostMicros === null) continue;
    const packQty = packQtyOf(it.packSize);
    const rebated = it.contractFlag ? true : null;
    const rate = rates[it.supplier.trim().toLowerCase()] ?? null;
    const effective = rebated === true && rate !== null ? Math.round(it.unitCostMicros * (1 - rate)) : it.unitCostMicros;
    offers.push({
      ndc11: it.ndc11,
      supplier: it.supplier,
      description: it.description,
      unitCostMicros: it.unitCostMicros,
      effectiveUnitMicros: effective,
      rebated,
      packQty: packQty !== null && packQty > 0 ? packQty : null,
      shortDated: /short|dated/i.test(it.availability ?? "") ? (it.availability ?? "").trim() : null,
    });
  }

  const onHandBy = new Map((snapshot?.rows ?? []).map((r) => [r.ndc11, r.quantityThousandths]));
  const needs: Need[] = [];
  for (const v of vel) {
    if (!v.steady) continue; // A lumpy item is ordered when it is prescribed, not on a rate.
    const need = toOrderThousandths({
      onHandThousandths: onHandBy.get(v.ndc11) ?? 0,
      perDayThousandths: v.perDayThousandths,
      targetDays: SHELF_POLICY.targetDays,
      leadTimeDays: shortestLead,
    });
    if (need > 0) needs.push({ ndc11: v.ndc11, name: v.name, needThousandths: need });
  }

  const plan = planOrder({
    needs,
    offers,
    terms: suppliers,
    movement: move,
    maxDaysOfStock: SHELF_POLICY.maxTopUpDays,
    materialityCents: SHELF_POLICY.materialityCents,
    // Priced after the plan is built: the cost depends on the basket, which does not exist yet.
    bandDelta: () => null,
  });

  /*
   * Now that the baskets exist, price what moving each one off the primary does to the band, and
   * let that overrule the invoice saving where it is larger. The planner's verdict is recomputed
   * rather than patched, so the sentence and the number can never disagree.
   */
  const { verdictFor } = await import("./order-plan");
  for (const b of plan.baskets) {
    if (b.supplier === suppliers.find((x) => x.primary)?.supplier) continue;
    const cost = await bandCostOfMoving(b.subtotalCents);
    if (!cost) continue;
    b.bandDeltaCents = cost.deltaCents;
    Object.assign(
      b,
      verdictFor({
        meets: b.meetsMinimum,
        shortfall: b.shortfallCents,
        shortfallAfter: b.shortfallAfterTopUpsCents,
        topUpCents: b.topUpCents,
        saving: b.savingCents,
        bandDeltaCents: cost.deltaCents,
        materialityCents: SHELF_POLICY.materialityCents,
        primary: false,
      }),
    );
  }
  plan.totalSavingCents = plan.baskets.reduce((n, b) => n + b.savingCents + (b.bandDeltaCents ?? 0), 0);
  return { plan, needs, suppliers, snapshot, missing };
}

/**
 * What moving a basket off the primary does to the rebate band, in cents.
 *
 * The guard that stops the whole strategy backfiring. A generic bought at a secondary saves what
 * the invoice says and costs what nobody sees: it is a generic that did not go through the primary,
 * so the compliance ratio there is measured on a smaller numerator, and the ratio picks the band
 * the rebate is paid at on *every* contract generic in the period. A $14 saving that drops a band
 * can cost several hundred, months later, on a report nobody connects to the decision.
 *
 * So the answer is the difference between two worlds, not the effect of the order on one: the
 * rebate the primary pays if this basket is bought there, against the rebate it pays if it is not.
 * Negative is what moving the spend costs.
 *
 * Null — never zero — wherever the position, the ladder or the period's purchases are not on file.
 * Zero reads as "this costs nothing", which is precisely the wrong answer to give when the thing
 * that would have priced it is missing.
 */
export type BandCost = {
  supplier: string;
  /** Negative is the cost of buying elsewhere. */
  deltaCents: number;
  ratioBeforePercent: number;
  ratioAfterPercent: number;
  bandBeforePercent: number | null;
  bandAfterPercent: number | null;
  says: string;
};

export async function bandCostOfMoving(basketCents: number, contractShareCents?: number): Promise<BandCost | null> {
  if (basketCents <= 0) return null;
  const { allSuppliers } = await import("./suppliers-registry");
  const registry = await allSuppliers(true);
  const primary = registry.find((s) => s.primarySupplier === true);
  if (!primary) return null;

  const { ratesFor, earningSoFar } = await import("./rebate-rates");
  const [rates, earning] = await Promise.all([ratesFor(primary.id), earningSoFar(primary.id)]);
  if (!rates || !earning) return null;

  /*
   * The ladder that is measured by the compliance ratio. A programme measured by something else —
   * the purchase ratio, OS/Gx — is not moved by where a generic is bought, so it is not in this.
   */
  const ladder = rates.view.programmes.find((p) => p.terms.kind === "tiered_ratio" && /compliance|gcr/i.test(p.measuredBy ?? p.name));
  if (!ladder || ladder.achievedPercent === null || ladder.terms.tiers.length === 0) return null;

  /*
   * The position: the ratio as settled, and the denominator it implies from the period's purchases.
   *
   * The ratio is generic Rx purchases over total Rx purchases less exclusions. The denominator is
   * taken from what has actually been bought at this supplier this period, so the projection is
   * against real money rather than a nominal base.
   */
  const denominatorCents = earning.totalPurchasedCents;
  if (denominatorCents <= 0) return null;

  const { tierEffect } = await import("./ratio-effect");
  const position = {
    ratioPercent: ladder.achievedPercent,
    denominatorCents,
    definition: "generics_over_rx" as const,
    scrub: "statement" as const,
  };
  const bands = ladder.terms.tiers.map((t) => ({ thresholdPercent: t.thresholdPercent, rebatePercent: t.rebatePercent }));

  /*
   * The contract share: how much of the basket would have been a contract generic at the primary.
   *
   * Where the caller does not know, the whole basket is treated as generic — which is the
   * pharmacy's actual case (a secondary is cheaper on generics, not on brands) and is the
   * conservative direction: it states the largest ratio effect the basket could have, so the site
   * is never surprised by a band it did not warn about.
   */
  const contract = contractShareCents ?? basketCents;

  const here = tierEffect(position, bands, [{ cents: contract, atPrimary: true, kind: "onestop_generic" }], earning.contractPurchasedCents + contract);
  const away = tierEffect(position, bands, [{ cents: contract, atPrimary: false, kind: "onestop_generic" }], earning.contractPurchasedCents);
  const deltaCents = away.rebateAfterCents - here.rebateAfterCents;

  const pct = (n: number) => `${n.toFixed(2)}%`;
  const says =
    deltaCents < 0
      ? `Buying it elsewhere leaves ${primary.name}'s compliance ratio at ${pct(away.projection.afterPercent)} rather than ${pct(here.projection.afterPercent)}, worth $${(Math.abs(deltaCents) / 100).toFixed(2)} on the period's contract generics.`
      : deltaCents > 0
        ? `Buying it elsewhere raises what ${primary.name} pays by $${(deltaCents / 100).toFixed(2)}, because the spend it displaces was dragging the ratio.`
        : `No band moves: ${primary.name}'s ratio stays in the same band either way.`;

  return {
    supplier: primary.name,
    deltaCents,
    ratioBeforePercent: here.projection.beforePercent,
    ratioAfterPercent: away.projection.afterPercent,
    bandBeforePercent: here.after?.rebatePercent ?? null,
    bandAfterPercent: away.after?.rebatePercent ?? null,
    says,
  };
}
