import "server-only";
import { daysBetween } from "./dates";
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
  known: { generics: number; brands: number; controlled: number; unclassified: number };  /** On hand (with on order) and the daily rate per moving NDC, thousandths. */
  shelf: Map<string, { onHandThousandths: number; perDayThousandths: number }>;
  /** How many days of claims the rates rest on, and the span they cover; `fullAt` is where the window stops growing. */
  evidence: { days: number; from: string | null; to: string | null; fullAt: number };
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
  const { held } = await import("./held");
  return held("minimums", loadMinimums);
}

async function loadMinimums(): Promise<MinimumsView> {
  const [view, move, rates] = await Promise.all([buyListNow(), shelfMovement(), contractRatesBySupplier()]);
  const missing = [...view.missing];

  /*
   * The levelled catalogue, not the raw table.
   *
   * This read the supplier_items table directly until 9 September, and the raw table carries the
   * unit cost as the wholesaler's export printed it. For a McKesson, ANDA or ParMed multi-pack —
   * "(5) 1 ML", "(3) 28 EA" — that printed figure is the carton's cost over the inner pack alone,
   * so it is n times too high: 1,593 of the 2,147 multi-packs with a NADAC land at the benchmark
   * only once divided by the bracket. catalogue-cache levels every row to the whole package
   * (wholePackage), applies the pharmacy's pack fixes and the majority rule, and withholds the rows
   * that fail the price check; the shelf, the buy list and the planner all read it. This page did
   * not, so every multi-pack add-on it ranked was priced up to thirty times too high, in the
   * direction that sends the order to whoever printed the pack without a bracket.
   */
  const items = await (await import("./catalogue-cache")).catalogueRows();
  const offers: Offer[] = [];
  const names = new Map<string, string | null>();
  for (const it of items) {
    if (it.unitCostMicros === null) continue;
    const packQty = packQtyOf(it.packSize);
    // The same reading the buy list gives the flag: "not rebated" is not rebated, and only "rebated" is.
    const rebated = it.contractFlag === "rebated" ? true : it.contractFlag === "not rebated" ? false : null;
    const rate = rates[it.supplier.trim().toLowerCase()] ?? null;
    offers.push({
      ndc11: it.ndc11,
      supplier: it.supplier,
      itemNumber: it.itemNumber ?? null,
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

  /*
   * CMS's own brand/generic flag, from the newest row per NDC. Nothing is inferred from a name.
   * The newest rows are held (nadac-latest.ts); every row ever held was a million and a half, and
   * loading them to keep the newest of each was nine seconds of this page.
   */
  const { nadacNow } = await import("./nadac-latest");
  const generic = new Map<string, "B" | "G">();
  for (const n of await nadacNow()) if (n.classification === "B" || n.classification === "G") generic.set(n.ndc11, n.classification);
  const controlled = await controlledNdcs(names);
  const eligibility: Eligibility = { generic, controlled };

  const onOrder = new Map<string, number>();
  for (const r of move.snapshot?.rxRows ?? []) if ((r.onOrderThousandths ?? 0) > 0) onOrder.set(r.ndc11, r.onOrderThousandths as number);

  /*
   * Only the lines the shelf is actually short of count as "already going" to a supplier. The
   * planner's own top-ups are the same kind of thing the filler ranks, so they are left to the
   * ranked list rather than counted as spoken for — the pharmacist chooses them there or not.
   */
  const basketCentsBySupplier = new Map(view.plan.baskets.map((b) => [b.supplier, b.lines.filter((l) => l.reason === "need").reduce((n, l) => n + l.costCents, 0)]));
  const orderedBySupplier = new Map(view.plan.baskets.map((b) => [b.supplier, new Set(b.lines.filter((l) => l.reason === "need").map((l) => l.ndc11))]));

  if (generic.size === 0) missing.push("No NADAC file is loaded, so nothing is known to be a generic and nothing can be added.");

  /*
   * How deep a suggested buy may go depends on how much evidence the rate rests on.
   *
   * Every rate is dispensing over the days of claims held, up to ninety. Six days of claims is a
   * rate, but not one to buy two months against — a drug filled twice in a busy week reads as a
   * daily habit. So the horizon is two days of stock for every day of claims, floored at a
   * fortnight and capped at sixty: a pharmacy a week into the site is offered fourteen days deep,
   * a month in gets the full sixty, and the page says which. The list gets deeper, and the rates
   * steadier, with every evening's report.
   */
  const evidenceDays = move.from && move.to ? Math.max(1, daysBetween(move.from, move.to) + 1) : 0;
  const horizonDays = evidenceDays === 0 ? 14 : Math.min(60, Math.max(14, 2 * evidenceDays));

  // Generics by their FDA equivalence key, so an add-on may be the cheapest AB-rated equivalent rather than the dispensed NDC alone.
  const { directoryKeys } = await import("./drug-directory-store");
  const keys = await directoryKeys();
  const groupOf = (n: string) => {
    const k = keys.get(n);
    return k && k.classification === "G" && k.key ? k.key : null;
  };
  const fills = fillMinimums({
    groupOf,
    suppliers: view.suppliers,
    basketCentsBySupplier,
    orderedBySupplier,
    offers,
    movement: move.movement,
    onOrderThousandths: onOrder,
    names,
    eligibility,
    horizonDays,
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
  // Where the shelf stands on every moving NDC, so a page can say "3 days on hand" beside a line.
  const shelf = new Map(move.movement.map((m) => [m.ndc11, { onHandThousandths: m.onHandThousandths + (onOrder.get(m.ndc11) ?? 0), perDayThousandths: m.perDayThousandths }]));
  return { fills, missing, horizonDays, evidence: { days: evidenceDays, from: move.from, to: move.to, fullAt: SHELF_POLICY.lookbackDays }, known: { generics, brands, controlled: [...moving].filter((n) => controlled.has(n)).length, unclassified }, shelf };
}

export type { SupplierFill } from "./minimum-filler";
export { schema };
