import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { parseCents, parseUnitMicros, parseQuantityThousandths, formatCents } from "./money";
import { readSheetAsObjects } from "./xlsx";
import { parseCsv } from "./reference";
import { normalizeClaimNdc, parseClaimDate } from "./claims";
import { productKey } from "./product-key";

/**
 * Supplier price files, and what they say we should be buying.
 *
 * Every wholesaler exports a different shape, so columns are matched loosely — but a column that
 * is not recognised is reported rather than dropped, because a silently ignored price column
 * produces a catalogue that looks loaded and recommends nothing.
 *
 * The comparison this feeds is narrow on purpose. It only ever compares NDCs that key to the
 * same product, and it never suggests substituting across strengths, salts, release profiles or
 * dosage forms. See product-key.ts for why that boundary is drawn where it is.
 */

const COLUMNS = {
  ndc: ["ndc", "ndc11", "ndc number", "item ndc", "ndc upc", "upc"],
  description: ["description", "item description", "product description", "item name", "product name", "drug name", "item"],
  manufacturer: ["manufacturer", "mfr", "labeler", "supplier name", "mfg"],
  packSize: ["pack size", "package size", "size", "pkg size", "unit size", "qty per pack"],
  unitCost: ["unit cost", "cost per unit", "unit price", "each cost", "price per unit"],
  packCost: ["pack cost", "case cost", "price", "cost", "net cost", "your cost", "contract price", "extended cost"],
  units: ["units per pack", "units", "count", "quantity", "pack quantity"],
  contractFlag: ["contract", "contract flag", "on contract", "generic contract", "source"],
  availability: ["availability", "in stock", "stock status", "status"],
  pricedOn: ["price date", "effective date", "as of date", "date"],
} as const;

type FieldName = keyof typeof COLUMNS;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function mapSupplierColumns(headers: string[]): { map: Partial<Record<FieldName, string>>; unmapped: string[] } {
  const byNorm = new Map<string, string>();
  for (const h of headers) if (h.trim()) byNorm.set(norm(h), h);
  const map: Partial<Record<FieldName, string>> = {};
  const used = new Set<string>();
  for (const [field, names] of Object.entries(COLUMNS) as [FieldName, readonly string[]][]) {
    for (const n of names) {
      const hit = byNorm.get(norm(n));
      if (hit && !used.has(hit)) { map[field] = hit; used.add(hit); break; }
    }
  }
  return { map, unmapped: headers.filter((h) => h.trim() && !used.has(h)) };
}

/**
 * Works out the cost of one dispensing unit.
 *
 * A stated unit cost is used as given. Otherwise it is derived from the pack cost and the count
 * in the pack — and only when both are present and the count is positive, because a pack cost
 * divided by a missing count is not an estimate, it is a fabrication.
 */
export function unitCostFrom(
  unitCostRaw: string | undefined,
  packCostRaw: string | undefined,
  unitsRaw: string | undefined,
): { unitCostMicros: number | null; packCostCents: number | null; how: "stated" | "derived" | "none" } {
  const stated = parseUnitMicros(unitCostRaw);
  const packCostCents = parseCents(packCostRaw);
  if (stated !== null) return { unitCostMicros: stated, packCostCents, how: "stated" };

  const unitsThousandths = parseQuantityThousandths(unitsRaw);
  if (packCostCents !== null && unitsThousandths !== null && unitsThousandths > 0) {
    // cents per pack -> micros per unit: (cents * 10^4) / (units)
    const micros = Math.round((packCostCents * 10_000 * 1000) / unitsThousandths);
    return { unitCostMicros: micros, packCostCents, how: "derived" };
  }
  return { unitCostMicros: null, packCostCents, how: "none" };
}

export type SupplierImportReport = {
  importId: string;
  supplier: string;
  rowsRead: number;
  itemsAdded: number;
  itemsUpdated: number;
  skipped: number;
  skipReasons: Record<string, number>;
  unmappedColumns: string[];
  unkeyable: number;
};

/**
 * Loads one supplier's price file, replacing that supplier's previous prices for the NDCs it
 * covers. Other suppliers are untouched, so files can be loaded one at a time as they arrive.
 */
export async function importSupplierCatalog(
  file: Buffer,
  fileName: string,
  supplier: string,
  userId: string,
): Promise<SupplierImportReport> {
  const rows = /\.csv$/i.test(fileName) ? parseCsv(file.toString("utf8")) : readSheetAsObjects(file);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const { map, unmapped } = mapSupplierColumns(headers);

  const importId = newId();
  const skipReasons: Record<string, number> = {};
  const skip = (why: string) => { skipReasons[why] = (skipReasons[why] ?? 0) + 1; };

  await db.insert(schema.supplierImports).values({
    id: importId, supplier, fileName, rowsRead: rows.length, createdBy: userId,
  });

  // Rows are gathered first and written in bulk. Doing it one price at a time meant a large
  // catalogue held the serialized connection for minutes, which is minutes of stopped site.
  const rows2: (typeof schema.supplierItems.$inferInsert)[] = [];
  let added = 0, updated = 0, unkeyable = 0, pricedOn: string | null = null;

  const before = new Set(
    (await db.query.supplierItems.findMany({ where: eq(schema.supplierItems.supplier, supplier), columns: { ndc11: true } })).map((e) => e.ndc11),
  );

  for (const r of rows) {
    const g = (f: FieldName) => (map[f] ? r[map[f]!] : undefined);
    const ndc11 = normalizeClaimNdc(g("ndc"));
    if (!ndc11) { skip("no readable 11-digit NDC"); continue; }

    const { unitCostMicros, packCostCents } = unitCostFrom(g("unitCost"), g("packCost"), g("units"));
    if (unitCostMicros === null && packCostCents === null) { skip("no readable price"); continue; }

    const description = (g("description") ?? "").trim() || null;
    const key = productKey(description).key;
    if (!key) unkeyable++;

    const date = parseClaimDate(g("pricedOn"));
    if (date && !pricedOn) pricedOn = date;

    if (before.has(ndc11)) updated++; else added++;
    rows2.push({
      id: newId(),
      supplier,
      ndc11,
      description,
      productKey: key,
      manufacturer: (g("manufacturer") ?? "").trim() || null,
      packSize: (g("packSize") ?? "").trim() || null,
      unitCostMicros,
      packCostCents,
      contractFlag: (g("contractFlag") ?? "").trim() || null,
      availability: (g("availability") ?? "").trim() || null,
      pricedOn: date,
      importId,
      updatedAt: new Date().toISOString(),
    });
  }

  // Replace only the NDCs this file covers. A partial price list must not delete everything else
  // we hold for that supplier, and a repriced line must not end up stored twice.
  const covered = [...new Set(rows2.map((r) => r.ndc11))];
  for (let i = 0; i < covered.length; i += 300) {
    await db
      .delete(schema.supplierItems)
      .where(and(eq(schema.supplierItems.supplier, supplier), inArray(schema.supplierItems.ndc11, covered.slice(i, i + 300))));
  }
  for (let i = 0; i < rows2.length; i += 300) await db.insert(schema.supplierItems).values(rows2.slice(i, i + 300));

  const skipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
  await db.update(schema.supplierImports).set({
    itemsAdded: added, itemsUpdated: updated, skipped,
    skipReasons: JSON.stringify(skipReasons),
    unmappedColumns: JSON.stringify(unmapped),
    pricedOn,
  }).where(eq(schema.supplierImports.id, importId));

  return { importId, supplier, rowsRead: rows.length, itemsAdded: added, itemsUpdated: updated, skipped, skipReasons, unmappedColumns: unmapped, unkeyable };
}

export type Opportunity = {
  productKey: string;
  description: string;
  claims: number;
  /** What we paid per unit on the claims, averaged. Null when acquisition cost was not exported. */
  paidUnitMicros: number | null;
  currentNdc: string | null;
  best: { supplier: string; ndc11: string; description: string | null; manufacturer: string | null; unitCostMicros: number; contractFlag: string | null } | null;
  /** Saving per unit, then scaled by the quantity we actually dispensed. */
  savingPerUnitMicros: number | null;
  savingCents: number | null;
  quantityThousandths: number | null;
};

/**
 * Where a cheaper source exists for something we already dispense.
 *
 * Only compares within a product key, so nothing here suggests a different drug. The saving is
 * scaled by the quantity actually dispensed in the loaded claims, which makes it a figure about
 * this pharmacy rather than a list price difference.
 *
 * Returns nothing at all where acquisition cost is missing from the claims — a saving computed
 * against an unknown current cost is not a saving, it is a guess with a dollar sign on it.
 */
export async function purchasingOpportunities(): Promise<{ ready: boolean; reason?: string; rows: Opportunity[] }> {
  const claims = await db.query.claims.findMany({
    columns: { ndc11: true, itemName: true, acquisitionCents: true, quantityThousandths: true },
  });
  if (claims.length === 0) return { ready: false, reason: "No claims loaded yet.", rows: [] };

  const withCost = claims.filter((c) => c.acquisitionCents !== null && c.quantityThousandths !== null && c.quantityThousandths > 0);
  if (withCost.length === 0) {
    return {
      ready: false,
      reason:
        "None of the loaded claims carry both an acquisition cost and a dispensed quantity, so there is nothing to " +
        "compare a supplier price against. Both come from the PioneerRx export and are currently blank.",
      rows: [],
    };
  }

  const items = await db.query.supplierItems.findMany();
  if (items.length === 0) return { ready: false, reason: "No supplier price files loaded yet.", rows: [] };

  const byKey = new Map<string, typeof items>();
  for (const i of items) {
    if (!i.productKey || i.unitCostMicros === null) continue;
    const a = byKey.get(i.productKey) ?? [];
    a.push(i);
    byKey.set(i.productKey, a);
  }

  type Agg = { key: string; description: string; claims: number; costMicros: number; qty: number; ndcs: Set<string> };
  const agg = new Map<string, Agg>();
  for (const c of withCost) {
    const key = productKey(c.itemName).key;
    if (!key) continue;
    let e = agg.get(key);
    if (!e) { e = { key, description: c.itemName ?? "", claims: 0, costMicros: 0, qty: 0, ndcs: new Set() }; agg.set(key, e); }
    e.claims++;
    e.qty += c.quantityThousandths!;
    // cents for the whole fill -> micros per unit
    e.costMicros += Math.round((c.acquisitionCents! * 10_000 * 1000) / c.quantityThousandths!);
    if (c.ndc11) e.ndcs.add(c.ndc11);
  }

  const rows: Opportunity[] = [];
  for (const e of agg.values()) {
    const candidates = byKey.get(e.key) ?? [];
    const best = candidates.reduce<(typeof candidates)[number] | null>(
      (b, i) => (b === null || i.unitCostMicros! < b.unitCostMicros! ? i : b),
      null,
    );
    const paidUnitMicros = Math.round(e.costMicros / e.claims);
    const savingPerUnitMicros = best ? paidUnitMicros - best.unitCostMicros! : null;
    rows.push({
      productKey: e.key,
      description: e.description,
      claims: e.claims,
      paidUnitMicros,
      currentNdc: [...e.ndcs][0] ?? null,
      quantityThousandths: e.qty,
      best: best
        ? {
            supplier: best.supplier,
            ndc11: best.ndc11,
            description: best.description,
            manufacturer: best.manufacturer,
            unitCostMicros: best.unitCostMicros!,
            contractFlag: best.contractFlag,
          }
        : null,
      savingPerUnitMicros,
      savingCents:
        savingPerUnitMicros !== null && savingPerUnitMicros > 0
          ? Math.round((savingPerUnitMicros * e.qty) / (1_000_000 * 1000 / 100))
          : null,
    });
  }

  rows.sort((a, b) => (b.savingCents ?? -1) - (a.savingCents ?? -1));
  return { ready: true, rows };
}

export async function supplierSummary() {
  const [imports, counts] = await Promise.all([
    db.query.supplierImports.findMany({ orderBy: (i, { desc }) => [desc(i.createdAt)], limit: 20 }),
    db
      .select({
        supplier: schema.supplierItems.supplier,
        items: sql<number>`count(*)`,
        keyed: sql<number>`sum(case when ${schema.supplierItems.productKey} is not null then 1 else 0 end)`,
      })
      .from(schema.supplierItems)
      .groupBy(schema.supplierItems.supplier),
  ]);
  return { imports, counts };
}

export { formatCents };
