import "server-only";
import { db, schema } from "@/db";
import { desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readOnHand, onHandTotals } from "./on-hand";
import type { Fill } from "./fills";
import { velocity, toOrderThousandths, whyNotSteady, type Velocity } from "./usage";
import { leanShelf, shelfTotals, type ShelfRow } from "./lean-shelf";
import {
  planOrder,
  type Offer,
  type Need,
  type Movement,
  type SupplierTerms,
  type Plan,
} from "./order-plan";

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

export type ShelfLine = {
  code: string;
  /** Null for a front-shop barcode, which is why every join below is on this and not on `code`. */
  ndc11: string | null;
  description: string | null;
  inventoryGroup: string | null;
  quantityThousandths: number;
  onOrderThousandths: number | null;
  packQty: number | null;
  valueCents: number | null;
};

export type ShelfSnapshot = {
  countedOn: string;
  fileName: string;
  /** Everything counted, front shop included, because the balance sheet takes the lot. */
  rows: ShelfLine[];
  /**
   * The dispensing shelf alone. The buy list, the return list and days-of-stock all work from this:
   * a bottle of shampoo has no claims behind it, and a tool that ranks by "nothing dispensed this"
   * would put the whole front shop at the top of the return list.
   */
  rxRows: RxShelfLine[];
  valueCents: number | null;
  /** The dispensing shelf's share of that value, which is the figure the Rx account turns on. */
  rxValueCents: number | null;
  unitsThousandths: number;
  items: number;
  unmappedColumns: string[];
  skipReasons: Record<string, number>;
};

/** A dispensing line: in the Rx group, and carrying a real NDC to join claims on. */
export type RxShelfLine = ShelfLine & { ndc11: string };

/** The front shop is anything the report filed outside the Rx group, or that has no NDC at all. */
function isRx(r: ShelfLine): r is RxShelfLine {
  if (r.ndc11 === null) return false;
  return r.inventoryGroup === null || /^rx$/i.test(r.inventoryGroup);
}

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
): Promise<
  | {
      ok: true;
      countedOn: string;
      items: number;
      replaced: boolean;
      /** How many older counts the retention rule removed, and how many remain. */
      pruned: { removed: number; kept: number };
      unmappedColumns: string[];
      skipped: Record<string, number>;
    }
  | { ok: false; why: string }
> {
  const parsed = readOnHand(buf.toString("utf8"));
  if (parsed.problems.length > 0 && parsed.rows.length === 0)
    return { ok: false, why: parsed.problems[0] };
  const countedOn = opts.countedOn ?? parsed.countedOn;
  if (!countedOn) {
    return {
      ok: false,
      why: "The file carries no count date. Say which day it is for and upload it again.",
    };
  }
  if (parsed.rows.length === 0)
    return {
      ok: false,
      why: "No usable rows: every line was missing an NDC or a quantity.",
    };

  const totals = onHandTotals(parsed.rows);
  // The dispensing shelf's share, so the accounts can check drug cost against a drug shelf.
  const rxTotals = onHandTotals(
    parsed.rows.filter((r) =>
      isRx({
        inventoryGroup: r.inventoryGroup ?? null,
        ndc11: r.ndc11,
      } as ShelfLine),
    ),
  );
  const existing = await db.query.onHandImports.findFirst({
    where: eq(schema.onHandImports.countedOn, countedOn),
  });
  if (existing)
    await db
      .delete(schema.onHandImports)
      .where(eq(schema.onHandImports.id, existing.id));

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
    rxValueCents: rxTotals.valueCents,
    documentId: opts.documentId ?? null,
    createdBy: by.userId,
  });
  /*
   * Inserted in batches, because SQLite binds a limited number of parameters per statement and a
   * real count is over two thousand items across sixteen columns. One statement for the lot parses
   * fine and fails at run time — which is exactly how this was found.
   */
  const values = parsed.rows.map((r) => ({
    id: randomUUID(),
    importId,
    countedOn,
    code: r.code,
    codeKind: r.codeKind,
    ndc11: r.ndc11,
    description: r.description,
    itemNumber: r.itemNumber,
    inventoryGroup: r.inventoryGroup ?? null,
    quantityThousandths: r.quantityThousandths,
    onOrderThousandths: r.onOrderThousandths ?? null,
    packQty: r.packQty ?? null,
    countedInPackages: r.countedInPackages ?? false,
    unit: r.unit,
    unitCostMicros: r.unitCostMicros,
    valueCents: r.valueCents,
  }));
  for (let i = 0; i < values.length; i += 300)
    await db.insert(schema.onHand).values(values.slice(i, i + 300));

  // Today's count carries the best drug names the site has; see drug-names.
  (await import("./drug-names")).forgetDrugNames();

  const pruned = await pruneCounts(countedOn);

  return {
    ok: true,
    countedOn,
    items: parsed.rows.length,
    replaced: Boolean(existing),
    unmappedColumns: parsed.unmappedColumns,
    skipped: parsed.skipped,
    pruned,
  };
}

/**
 * Removes the daily counts that have done their job, and says how many.
 *
 * Run on every import rather than on a schedule, because the pharmacy has no scheduler and a
 * cleanup nobody remembers to run is a table that grows forever. The rule is in count-retention:
 * the last week, and the last count of every month. Deleting the import takes its rows with it —
 * `on_hand.import_id` cascades, and the foreign-key pragma is on.
 */
export async function pruneCounts(today: string): Promise<{ removed: number; kept: number }> {
  const { countsToKeep } = await import("./count-retention");
  const all = await db.query.onHandImports.findMany({ columns: { id: true, countedOn: true } });
  const { keep, drop } = countsToKeep(all.map((i) => i.countedOn), today);
  if (drop.length === 0) return { removed: 0, kept: keep.length };

  const going = new Set(drop);
  const ids = all.filter((i) => going.has(i.countedOn)).map((i) => i.id);
  for (let i = 0; i < ids.length; i += 100)
    await db.delete(schema.onHandImports).where(inArray(schema.onHandImports.id, ids.slice(i, i + 100)));
  return { removed: drop.length, kept: keep.length };
}

/** The most recent count held, or null where none has been uploaded. */
export async function latestShelf(): Promise<ShelfSnapshot | null> {
  const imp = await db.query.onHandImports.findFirst({
    orderBy: [desc(schema.onHandImports.countedOn)],
  });
  if (!imp) return null;
  const rows = await db.query.onHand.findMany({
    where: eq(schema.onHand.countedOn, imp.countedOn),
  });
  const lines: ShelfLine[] = rows.map((r) => ({
    code: r.code,
    ndc11: r.ndc11,
    description: r.description,
    inventoryGroup: r.inventoryGroup,
    quantityThousandths: r.quantityThousandths,
    onOrderThousandths: r.onOrderThousandths,
    packQty: r.packQty,
    valueCents: r.valueCents,
  }));
  const rxRows = lines.filter(isRx);
  const rxValue = rxRows.reduce<number | null>(
    (a, r) => (r.valueCents === null ? a : (a ?? 0) + r.valueCents),
    null,
  );
  return {
    countedOn: imp.countedOn,
    fileName: imp.fileName,
    rows: lines,
    rxRows,
    // Preferring what the import stored, and falling back to the rows for a count filed before
    // the front shop was told apart from the shelf.
    rxValueCents: imp.rxValueCents ?? rxValue,
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
export async function movement(
  lookbackDays = SHELF_POLICY.lookbackDays,
): Promise<{ rows: Velocity[]; from: string; to: string; fills: Fill[] } | null> {
  const { held } = await import("./held");
  return held(`movement:${lookbackDays}`, () => loadMovement(lookbackDays));
}

async function loadMovement(lookbackDays: number): Promise<{ rows: Velocity[]; from: string; to: string; fills: Fill[] } | null> {
  /*
   * Only the claims the window can use. Movement is a rate over the last ninety days; the claims
   * before it were loaded, grouped and thrown away, on every open, for every year the pharmacy
   * had been dispensing.
   */
  const { addDays, todayIso } = await import("./dates");
  const { gte } = await import("drizzle-orm");
  const claims = await db.query.claims.findMany({ where: gte(schema.claims.dateFilled, addDays(todayIso(), -(lookbackDays + 7))) });
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
  const { drugNames } = await import("./drug-names");
  const [later, names] = await Promise.all([laterPayments(), drugNames()]);
  const fills = groupIntoFills(
    claims.map((c) => ({
      id: c.id,
      rxNumber: c.rxNumber,
      fillNumber: c.fillNumber,
      dateFilled: c.dateFilled,
      ndc11: c.ndc11,
      /*
       * Named from what the site holds now, not from what it held the day the claim was imported.
       *
       * Every claim in the archive was filed with no name — the transaction report carries none and
       * the catalogue had not been imported yet — so the buy list, which is a page meant to be acted
       * on, listed bare eleven-digit numbers. The name is a lookup, not a fact about the claim, so
       * it is resolved here where everything downstream reads it.
       */
      itemName: (c.ndc11 ? names.get(c.ndc11) : null) ?? c.itemName,
      bin: c.bin,
      pcn: c.pcn,
      groupNumber: c.groupNumber,
      pbmName: c.pbmName,
      payerLabel: c.payerLabel,
      quantityThousandths: c.quantityThousandths,
      remitCents: c.remitCents,
      copayCents: c.copayCents,
      patientTotalCents: c.patientTotalCents,
      acquisitionCents: c.acquisitionCents,
      status: c.status,
      onAccount: c.onAccount,
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
    if (held === undefined || c.daysSupply > held)
      daysSupplyBy.set(key, c.daysSupply);
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

  const days = events
    .map((e) => e.dateFilled)
    .filter(Boolean)
    .sort();
  if (days.length === 0) return null;
  const to = days[days.length - 1];
  const earliest = days[0];
  const cutoff = new Date(
    Date.parse(`${to}T00:00:00Z`) - lookbackDays * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const from = cutoff > earliest ? cutoff : earliest;
  return {
    rows: velocity(
      events.filter((e) => e.dateFilled >= from),
      { from, to },
    ),
    /*
     * The fills themselves, for the drug file's reimbursement figures.
     *
     * Returned rather than regrouped there, because grouping claims into fills is the expensive
     * part and, more to the point, doing it twice invites two definitions of a fill. Every fill is
     * carried, not only those inside the velocity window: what a drug reimburses is a rate to
     * negotiate on and wants the whole archive, where velocity is about what moves now.
     */
    fills,
    from,
    to,
  };
}

/** Movement joined to the shelf, which is what both the buy list and the return list run on. */
export async function shelfMovement(): Promise<{
  movement: Movement[];
  velocity: Velocity[];
  snapshot: ShelfSnapshot | null;
  from: string | null;
  to: string | null;
}> {
  const [m, snapshot] = await Promise.all([movement(), latestShelf()]);
  const onHandBy = new Map(
    (snapshot?.rxRows ?? []).map((r) => [r.ndc11, r.quantityThousandths]),
  );
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
      // Which of the three tests failed, so the refusal on the add-ons list can say so.
      whyNotSteady: whyNotSteady(v),
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
  const { held } = await import("./held");
  return held("lean-shelf", loadLeanShelf);
}

async function loadLeanShelf(): Promise<LeanShelfView> {
  const { movement: move, velocity: vel, snapshot } = await shelfMovement();
  const missing: string[] = [];
  if (!snapshot)
    missing.push(
      "No inventory count has been uploaded, so nothing can be sized against what is here.",
    );
  if (vel.length === 0)
    missing.push(
      "No claims are held, so nothing has a rate to be measured against.",
    );
  if (!snapshot || vel.length === 0)
    return { rows: [], totals: shelfTotals([], null), snapshot, missing };

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
  const returns = new Map<
    string,
    {
      supplier: string;
      creditPercentNow: number;
      dropsInDays: number | null;
      dropsToPercent: number | null;
      closesInDays: number | null;
    }
  >();
  for (const r of due.rows) {
    const held = returns.get(r.ndc11);
    const soonest = (x: {
      dropsInDays: number | null;
      closesInDays: number | null;
    }) =>
      Math.min(
        x.dropsInDays ?? Number.MAX_SAFE_INTEGER,
        x.closesInDays ?? Number.MAX_SAFE_INTEGER,
      );
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
    missing.push(
      `No return policy on file for ${due.suppliersWithoutPolicy.join(", ")}, so nothing bought from them is given a window.`,
    );
  }

  const rows = leanShelf({
    onHand: snapshot.rxRows,
    movement: vel.map((v) => ({
      ndc11: v.ndc11,
      name: v.name,
      perDayThousandths: v.perDayThousandths,
      steady: v.steady,
      lastOn: v.lastOn,
    })),
    returns,
    targetDays: SHELF_POLICY.targetDays,
    materialityCents: SHELF_POLICY.materialityCents,
  });
  void velBy;
  void moveBy;
  // Measured against the dispensing shelf, not the whole building: the front shop is not what
  // these rows were drawn from, and dividing by it would flatter every share.
  return {
    rows,
    totals: shelfTotals(rows, snapshot.rxValueCents),
    snapshot,
    missing,
  };
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
  const { held } = await import("./held");
  return held("buy-list", loadBuyList);
}

/** Today's order built from the tables. Held between requests (held.ts); read it, never write into it. */
async function loadBuyList(): Promise<BuyListView> {
  const { movement: move, velocity: vel, snapshot } = await shelfMovement();
  const missing: string[] = [];
  if (!snapshot)
    missing.push(
      "No inventory count has been uploaded. Without one, a shortfall cannot be told from a full shelf.",
    );
  if (vel.length === 0)
    missing.push("No claims are held, so nothing has a rate to buy against.");

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
  const leadBy = new Map(
    suppliers.map((s) => [s.supplier, s.leadTimeDays ?? 1]),
  );
  // The shortest lead time on file, and never under a day: Math.min(..., 1) made every lead a
  // day at most, so a shelf with a three-day supplier was told to order two days late.
  const shortestLead = Math.max(1, leadBy.size > 0 ? Math.min(...leadBy.values()) : 1);

  // Held between requests rather than read again per page. See catalogue-cache.
  const items = await (await import("./catalogue-cache")).catalogueRows();
  if (items.length === 0)
    missing.push(
      "No supplier catalogue has been imported, so there is nothing to price an order against.",
    );

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
    // The same reading the purchasing ledger gives the flag: a line the catalogue marks "not
    // rebated" earned the discount here because any flag at all read as rebated.
    const rebated = it.contractFlag === "rebated" ? true : it.contractFlag === "not rebated" ? false : null;
    const rate = rates[it.supplier.trim().toLowerCase()] ?? null;
    const effective =
      rebated === true && rate !== null
        ? Math.round(it.unitCostMicros * (1 - rate))
        : it.unitCostMicros;
    offers.push({
      ndc11: it.ndc11,
      supplier: it.supplier,
      itemNumber: it.itemNumber ?? null,
      description: it.description,
      unitCostMicros: it.unitCostMicros,
      effectiveUnitMicros: effective,
      rebated,
      packQty: packQty !== null && packQty > 0 ? packQty : null,
      shortDated: /short|dated/i.test(it.availability ?? "")
        ? (it.availability ?? "").trim()
        : null,
    });
  }

  const onHandBy = new Map(
    (snapshot?.rxRows ?? []).map((r) => [r.ndc11, r.quantityThousandths]),
  );
  /*
   * What is already on a truck.
   *
   * The pharmacy's own report carries On Order, and without it the site cannot tell a shelf that is
   * genuinely short from one whose replacement was ordered yesterday — it would order the same
   * bottle again every day until the first one landed. It is counted as cover because that is what
   * it is: stock that will be here before the target days run out.
   */
  const onOrderBy = new Map(
    (snapshot?.rxRows ?? [])
      .filter((r) => (r.onOrderThousandths ?? 0) > 0)
      .map((r) => [r.ndc11, r.onOrderThousandths as number]),
  );
  const needs: Need[] = [];
  for (const v of vel) {
    if (!v.steady) continue; // A lumpy item is ordered when it is prescribed, not on a rate.
    const need = toOrderThousandths({
      onHandThousandths: onHandBy.get(v.ndc11) ?? 0,
      onOrderThousandths: onOrderBy.get(v.ndc11) ?? 0,
      perDayThousandths: v.perDayThousandths,
      targetDays: SHELF_POLICY.targetDays,
      leadTimeDays: shortestLead,
    });
    if (need > 0)
      needs.push({ ndc11: v.ndc11, name: v.name, needThousandths: need });
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
  plan.totalSavingCents = plan.baskets.reduce(
    (n, b) => n + b.savingCents + (b.bandDeltaCents ?? 0),
    0,
  );
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

export async function bandCostOfMoving(
  basketCents: number,
  contractShareCents?: number,
): Promise<BandCost | null> {
  if (basketCents <= 0) return null;
  const { allSuppliers } = await import("./suppliers-registry");
  const registry = await allSuppliers(true);
  const primary = registry.find((s) => s.primarySupplier === true);
  if (!primary) return null;

  const { ratesFor, earningSoFar } = await import("./rebate-rates");
  const [rates, earning] = await Promise.all([
    ratesFor(primary.id),
    earningSoFar(primary.id),
  ]);
  if (!rates || !earning) return null;

  /*
   * The ladder that is measured by the compliance ratio. A programme measured by something else —
   * the purchase ratio, OS/Gx — is not moved by where a generic is bought, so it is not in this.
   */
  const ladder = rates.view.programmes.find(
    (p) =>
      p.terms.kind === "tiered_ratio" &&
      /compliance|gcr/i.test(p.measuredBy ?? p.name),
  );
  if (
    !ladder ||
    ladder.achievedPercent === null ||
    ladder.terms.tiers.length === 0
  )
    return null;

  /*
   * The position: the ratio as settled, and the denominator it implies from the period's purchases.
   *
   * The ratio is generic Rx purchases over total Rx purchases less exclusions. The denominator is
   * taken from what has actually been bought at this supplier this period, so the projection is
   * against real money rather than a nominal base.
   */
  const denominatorCents = earning.rxPurchasedCents;
  if (denominatorCents <= 0) return null;

  const { tierEffect } = await import("./ratio-effect");
  const position = {
    ratioPercent: ladder.achievedPercent,
    denominatorCents,
    definition: "generics_over_rx" as const,
    scrub: "statement" as const,
  };
  const bands = ladder.terms.tiers.map((t) => ({
    thresholdPercent: t.thresholdPercent,
    rebatePercent: t.rebatePercent,
  }));

  /*
   * The contract share: how much of the basket would have been a contract generic at the primary.
   *
   * Where the caller does not know, the whole basket is treated as generic — which is the
   * pharmacy's actual case (a secondary is cheaper on generics, not on brands) and is the
   * conservative direction: it states the largest ratio effect the basket could have, so the site
   * is never surprised by a band it did not warn about.
   */
  const contract = contractShareCents ?? basketCents;

  const here = tierEffect(
    position,
    bands,
    [{ cents: contract, atPrimary: true, kind: "onestop_generic" }],
    earning.contractPurchasedCents + contract,
  );
  const away = tierEffect(
    position,
    bands,
    [{ cents: contract, atPrimary: false, kind: "onestop_generic" }],
    earning.contractPurchasedCents,
  );
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

/**
 * What the next rebate band is worth, and what it would take to get there before the month closes.
 *
 * The owner asked for this directly: "we also should be showing how much more the next rebate tier
 * is worth, especially at end of the month — if I am close to a higher tier and it's worth $500, I
 * might want to order generics from McKesson even if more expensive."
 *
 * Every part of the answer already existed and none of it was on a screen. `tierEffect` gives the
 * band above where the month currently sits, the contract-generic spend that would reach it, and
 * what that band pays on the period's base. The only thing to add is the comparison the decision
 * actually turns on — the premium at which moving that buying stops paying — which is the band's
 * worth divided by the spend it needs.
 *
 * It is a projection on the month so far, not a promise: the ratio is where the last statement or
 * the last drill down left it, and a fortnight of buying can still move it. That is why the days
 * left are part of the answer rather than a detail: the same $4,000 is a plan on the 8th and a
 * scramble on the 29th.
 */
export type NextTier = {
  supplier: string;
  month: string;
  /** Days left in the month, counting today. Nought on the last day. */
  daysLeft: number;
  ratioPercent: number;
  currentRatePercent: number | null;
  nextThresholdPercent: number;
  nextRatePercent: number;
  /** Contract-generic spend at the primary that would carry the ratio over the threshold. */
  neededCents: number;
  /** What the higher band pays, over the current one, on the period's contract generics. */
  worthCents: number;
  /** The most a dearer primary may cost on that spend before this stops paying. Null where moot. */
  breakEvenPremiumPercent: number | null;
  says: string;
};

export async function nextTierNow(month?: string): Promise<NextTier | null> {
  const { allSuppliers } = await import("./suppliers-registry");
  const primary = (await allSuppliers(true)).find((s) => s.primarySupplier === true);
  if (!primary) return null;

  const { ratesFor, earningSoFar } = await import("./rebate-rates");
  const [rates, earning] = await Promise.all([ratesFor(primary.id), earningSoFar(primary.id, month)]);
  if (!rates || !earning) return null;

  // The same ladder bandCostOfMoving uses, so the two screens can never quote different bands.
  const ladder = rates.view.programmes.find(
    (p) => p.terms.kind === "tiered_ratio" && /compliance|gcr/i.test(p.measuredBy ?? p.name),
  );
  if (!ladder || ladder.achievedPercent === null || ladder.terms.tiers.length === 0) return null;
  if (earning.rxPurchasedCents <= 0) return null;

  const { tierEffect, nextTierAdvice } = await import("./ratio-effect");
  const effect = tierEffect(
    { ratioPercent: ladder.achievedPercent, denominatorCents: earning.rxPurchasedCents, definition: "generics_over_rx", scrub: "statement" },
    ladder.terms.tiers.map((t) => ({ thresholdPercent: t.thresholdPercent, rebatePercent: t.rebatePercent })),
    [],
    earning.contractPurchasedCents,
  );
  if (!effect.next) return null;

  const { lastDayOfMonth, daysBetween, todayIso } = await import("./dates");
  const m = earning.month;
  const [y, mm] = m.split("-").map(Number);
  const today = todayIso();
  // Nought once the month has closed, so a report run in arrears never asks for spend that is
  // no longer possible.
  const daysLeft = today.slice(0, 7) === m ? Math.max(0, daysBetween(today, lastDayOfMonth(y, mm))) : 0;

  const advice = nextTierAdvice({ effect, supplier: primary.name, daysLeft });
  if (!advice) return null;

  return { supplier: primary.name, month: m, daysLeft, ...advice };
}
