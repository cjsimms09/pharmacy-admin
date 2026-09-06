import "server-only";
import { db, schema } from "@/db";
import { buyListNow, shelfMovement, SHELF_POLICY } from "./shelf";
import { fillMinimums, type SupplierFill, type Eligibility } from "./minimum-filler";
import { packQtyOf } from "./product-ledger";
import { contractRatesBySupplier } from "./rebate-rates";
import { scheduleFromNames } from "./controlled-names";
import type { Offer } from "./order-plan";

/**
 * The minimum filler, assembled from what the site holds.
 *
 * Starts from today's order (`buyListNow`), so what is already going to each supplier counts
 * towards its minimum, and adds only what `minimum-filler.ts` allows. Recomputed on every open of
 * the page from the latest count, claims and catalogues, which is the daily recompute the owner
 * asked for without a job to schedule or a table to go stale.
 */

export type MinimumsView = {
  fills: SupplierFill[];
  missing: string[];
  horizonDays: number;
  /** How the eligibility was known, so the page can say what it could not tell. */
  known: { generics: number; brands: number; controlled: number; unclassified: number };
};

/**
 * Which NDCs are controlled, from the supplier's own class letter on any invoice line (X is
 * Schedule II; B, D and E are III to V) and, where no invoice has carried the NDC, from the name
 * lists the invoice reader falls back to. Either source suffices to exclude; nothing is required
 * to include, because the cost of a wrong exclusion is a generic not bought at the cheapest place
 * and the cost of a wrong inclusion is a controlled substance ordered by a page that must not.
 */
async function controlledNdcs(names: Map<string, string | null>): Promise<Set<string>> {
  const lines = await db.query.invoiceLines.findMany({ columns: { ndc11: true, itemClass: true } });
  const out = new Set<string>();
  for (const l of lines) if (l.ndc11 && l.itemClass && /^(X|B|D|E)$/i.test(l.itemClass.trim())) out.add(l.ndc11);
  for (const [ndc, name] of names) {
    if (!name) continue;
    if (scheduleFromNames([name]).schedule !== "none") out.add(ndc);
  }
  return out;
}

export async function minimumsNow(): Promise<MinimumsView> {
  const [view, move, rates] = await Promise.all([buyListNow(), shelfMovement(), contractRatesBySupplier()]);
  const missing = [...view.missing];

  const items = await db.query.supplierItems.findMany({ columns: { supplier: true, ndc11: true, description: true, unitCostMicros: true, packSize: true, contractFlag: true, availability: true } });
  const offers: Offer[] = [];
  const names = new Map<string, string | null>();
  for (const it of items) {
    if (it.unitCostMicros === null) continue;
    const packQty = packQtyOf(it.packSize);
    const rebated = it.contractFlag ? true : null;
    const rate = rates[it.supplier.trim().toLowerCase()] ?? null;
    offers.push({
      ndc11: it.ndc11,
      supplier: it.supplier,
      description: it.description,
      unitCostMicros: it.unitCostMicros,
      effectiveUnitMicros: rebated === true && rate !== null ? Math.round(it.unitCostMicros * (1 - rate)) : it.unitCostMicros,
      rebated,
      packQty: packQty !== null && packQty > 0 ? packQty : null,
      shortDated: /short|dated/i.test(it.availability ?? "") ? (it.availability ?? "").trim() : null,
    });
    if (!names.has(it.ndc11)) names.set(it.ndc11, it.description ?? null);
  }
  for (const v of move.velocity) if (v.name && !names.get(v.ndc11)) names.set(v.ndc11, v.name);

  /* CMS's own brand/generic flag, latest row per NDC. Nothing is inferred from a name. */
  const nadac = await db.query.nadacPrices.findMany({ columns: { ndc11: true, classification: true, effectiveOn: true } });
  const generic = new Map<string, "B" | "G">();
  const seenOn = new Map<string, string>();
  for (const n of nadac) {
    if (n.classification !== "B" && n.classification !== "G") continue;
    const prev = seenOn.get(n.ndc11);
    if (!prev || n.effectiveOn > prev) {
      seenOn.set(n.ndc11, n.effectiveOn);
      generic.set(n.ndc11, n.classification);
    }
  }
  const controlled = await controlledNdcs(names);
  const eligibility: Eligibility = { generic, controlled };

  const onOrder = new Map<string, number>();
  for (const r of move.snapshot?.rxRows ?? []) if ((r.onOrderThousandths ?? 0) > 0) onOrder.set(r.ndc11, r.onOrderThousandths as number);

  const basketCentsBySupplier = new Map(view.plan.baskets.map((b) => [b.supplier, b.subtotalCents]));
  const orderedBySupplier = new Map(view.plan.baskets.map((b) => [b.supplier, new Set(b.lines.map((l) => l.ndc11))]));

  if (generic.size === 0) missing.push("No NADAC file is loaded, so nothing is known to be a generic and nothing can be added.");

  const fills = fillMinimums({
    suppliers: view.suppliers,
    basketCentsBySupplier,
    orderedBySupplier,
    offers,
    movement: move.movement,
    onOrderThousandths: onOrder,
    names,
    eligibility,
    horizonDays: 60,
    materialityCents: SHELF_POLICY.materialityCents,
  });

  const moving = new Set(move.movement.map((m) => m.ndc11));
  let generics = 0;
  let brands = 0;
  let unclassified = 0;
  for (const ndc of moving) {
    const g = generic.get(ndc);
    if (g === "G") generics++;
    else if (g === "B") brands++;
    else unclassified++;
  }
  return { fills, missing, horizonDays: 60, known: { generics, brands, controlled: [...moving].filter((n) => controlled.has(n)).length, unclassified } };
}

export type { SupplierFill } from "./minimum-filler";
export { schema };
