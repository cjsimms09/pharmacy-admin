import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { parseCents, parseUnitMicros, parseQuantityThousandths, formatCents } from "./money";
import { readSheetAsObjects } from "./xlsx";
import { parseCsv } from "./reference";
import { normalizeClaimNdc, parseClaimDate } from "./claims";
import { productKey } from "./product-key";
import { parsePioneerCatalog, supplierFromFileName, dateFromFileName, type CatalogSection } from "./pioneer-catalog";

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
/**
 * Loading PioneerRx's own supplier catalogue export — the one that arrives every Monday.
 *
 * Different from importSupplierCatalog in two ways that matter. The supplier is read from the
 * section header inside the file rather than from a sender rule, because the file names it; and
 * a file may carry several suppliers at once (the first one exported by hand carried twenty-four),
 * each of which is stored under its own name. The writing is identical: replace only the NDCs the
 * file covers, so a partial list never deletes what it does not mention.
 *
 * Where the filename claims one supplier and the file names another, the file is refused. A
 * McKesson price list stored under IPD is a purchasing recommendation to buy from the wrong place,
 * and the cost of refusing is a message somebody reads on Monday morning.
 */
export type PioneerImportReport = {
  importIds: string[];
  suppliers: { supplier: string; itemsAdded: number; itemsUpdated: number; shortDated: number }[];
  rowsRead: number;
  skipped: number;
  skipReasons: Record<string, number>;
  pricedOn: string | null;
  problems: string[];
};

export async function importPioneerCatalog(file: Buffer, fileName: string, userId: string): Promise<PioneerImportReport> {
  const text = file.toString("utf8");
  const parsed = parsePioneerCatalog(text);
  const problems = [...parsed.problems];
  const pricedOn = parsed.printedOn ?? dateFromFileName(fileName);

  if (parsed.sections.length === 0) {
    return { importIds: [], suppliers: [], rowsRead: 0, skipped: parsed.skipped, skipReasons: parsed.reasons, pricedOn, problems };
  }

  const claimed = supplierFromFileName(fileName);
  const named = parsed.sections.map((x) => x.supplier);
  if (claimed && !(named.length === 1 && named[0] === claimed)) {
    throw new Error(
      `The file is named for ${claimed} but names ${named.join(", ")} inside. Nothing was loaded — a price list stored ` +
        `under the wrong supplier would recommend buying from the wrong place.`,
    );
  }

  const importIds: string[] = [];
  const suppliers: PioneerImportReport["suppliers"] = [];
  let rowsRead = 0;

  for (const section of parsed.sections) {
    const r = await writeSection(section, fileName, pricedOn, userId);
    importIds.push(r.importId);
    suppliers.push({ supplier: section.supplier, itemsAdded: r.added, itemsUpdated: r.updated, shortDated: r.shortDated });
    rowsRead += section.rows.length;
  }

  return { importIds, suppliers, rowsRead, skipped: parsed.skipped, skipReasons: parsed.reasons, pricedOn, problems };
}

async function writeSection(
  section: CatalogSection,
  fileName: string,
  pricedOn: string | null,
  userId: string,
): Promise<{ importId: string; added: number; updated: number; shortDated: number }> {
  const { supplier, rows } = section;
  const importId = newId();
  await db.insert(schema.supplierImports).values({
    id: importId, supplier, fileName, rowsRead: rows.length, createdBy: userId,
  });

  const before = new Set(
    (await db.query.supplierItems.findMany({ where: eq(schema.supplierItems.supplier, supplier), columns: { ndc11: true } })).map((e) => e.ndc11),
  );

  /*
   * One NDC, several rows: keep the one a comparison should see.
   *
   * The same NDC appears under several item numbers within one supplier — a full-dated pack, a
   * short-dated lot at a fraction of the price, a repackager. A comparison that sees the cheapest
   * of these recommends the short-dated lot every time, so the rows are collapsed to one per NDC:
   * the cheapest *full-dated* price, with the short-dated alternative noted in availability so it
   * is visible but never wins by default.
   */
  const byNdc = new Map<string, typeof rows>();
  for (const r of rows) byNdc.set(r.ndc11, [...(byNdc.get(r.ndc11) ?? []), r]);

  const rows2: (typeof schema.supplierItems.$inferInsert)[] = [];
  let added = 0, updated = 0, shortDated = 0;
  const now = new Date().toISOString();

  for (const [ndc11, group] of byNdc) {
    const dated = group.filter((r) => !r.shortDated && r.unitCostMicros !== null);
    const sd = group.filter((r) => r.shortDated && r.unitCostMicros !== null);
    shortDated += sd.length;
    const pick = (dated.length ? dated : sd).sort((a, b) => (a.unitCostMicros ?? 0) - (b.unitCostMicros ?? 0))[0];
    if (!pick) continue;

    const availability = dated.length
      ? sd.length
        ? `Short-dated lot also offered at ${(Math.min(...sd.map((r) => r.unitCostMicros!)) / 1_000_000).toFixed(4)}/unit (exp ${sd.map((r) => r.shortDated).join(", ")})`
        : null
      : `Short-dated only (exp ${pick.shortDated})`;

    if (before.has(ndc11)) updated++; else added++;
    rows2.push({
      id: newId(),
      supplier,
      ndc11,
      description: pick.description,
      productKey: pick.productKey,
      manufacturer: null,
      packSize: pick.packQty !== null && pick.unit ? `${pick.orderMultiple && pick.orderMultiple > 1 ? `(${pick.orderMultiple}) ` : ""}${pick.packQty} ${pick.unit}` : null,
      unitCostMicros: pick.unitCostMicros,
      packCostCents: pick.unitCostMicros !== null && pick.packQty ? Math.round((pick.unitCostMicros * pick.packQty) / 10_000) : null,
      // Gross, before rebates. Said here because the comparison has to know, and because a
      // McKesson OneStop generic at gross is not the price the pharmacy pays.
      contractFlag: "gross, before rebates",
      availability,
      pricedOn,
      importId,
      updatedAt: now,
    });
  }

  const covered = [...new Set(rows2.map((r) => r.ndc11))];
  for (let i = 0; i < covered.length; i += 300) {
    await db
      .delete(schema.supplierItems)
      .where(and(eq(schema.supplierItems.supplier, supplier), inArray(schema.supplierItems.ndc11, covered.slice(i, i + 300))));
  }
  for (let i = 0; i < rows2.length; i += 300) await db.insert(schema.supplierItems).values(rows2.slice(i, i + 300));

  await db.update(schema.supplierImports).set({
    itemsAdded: added, itemsUpdated: updated, skipped: 0,
    skipReasons: JSON.stringify({}),
    unmappedColumns: JSON.stringify([]),
    pricedOn,
  }).where(eq(schema.supplierImports.id, importId));

  return { importId, added, updated, shortDated };
}

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

/** When a supplier price file last arrived, across every supplier. */
export async function latestSupplierImport(): Promise<string | null> {
  const rows = await db.query.supplierImports.findMany({
    columns: { createdAt: true },
    orderBy: (i, { desc }) => [desc(i.createdAt)],
    limit: 1,
  });
  return rows[0]?.createdAt ?? null;
}
