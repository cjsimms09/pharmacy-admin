import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { audit } from "./audit";
import { problemsWith, worstLevel, packUnits, type Problem, type CatalogueItem } from "./catalogue-check";

/**
 * Looking at the supplier catalogue, and correcting a row that is wrong.
 *
 * Forty-five thousand items arrive every week and until now there was no way to see a single one
 * of them. Everything downstream — what to buy, what it costs, whether a plan pays enough — rests
 * on rows nobody could open, and the pharmacy had already spotted pack sizes and prices that were
 * plainly wrong with no way to say so.
 *
 * Two things, then. Search, so a drug can be found by NDC or by name and what the site believes
 * about it can be read. And a correction, kept in its own table so that next Monday's file does
 * not quietly undo it — see `supplier_item_fixes`.
 */

export type CatalogueRow = CatalogueItem & {
  pricedOn: string | null;
  availability: string | null;
  /** The units the pack size gives, or null where it gives none. */
  packUnits: number | null;
  /** NADAC's current price for the same NDC, where one is held. */
  nadacUnitMicros: number | null;
  /** What is wrong with it, if anything. */
  problems: Problem[];
  /** A correction the pharmacy has made, and what it changed. */
  fix: { packSize: string | null; unitCostMicros: number | null; note: string | null; correctedBy: string; correctedAt: string } | null;
  /** What the supplier's own file said, before any correction. */
  asImported: { packSize: string | null; unitCostMicros: number | null } | null;
};

export type CatalogueSearch = {
  /** NDC, item description, or part of either. */
  text?: string;
  supplier?: string;
  /** Only rows something is wrong with. */
  problemsOnly?: boolean;
  /** Only rows the pharmacy has corrected. */
  fixedOnly?: boolean;
  limit?: number;
};

/** Every correction on file, keyed for a lookup. */
async function fixesByKey(): Promise<Map<string, typeof schema.supplierItemFixes.$inferSelect>> {
  const rows = await db.query.supplierItemFixes.findMany();
  return new Map(rows.map((r) => [`${r.supplier.trim().toLowerCase()}|${r.ndc11}`, r]));
}

/**
 * The catalogue, searched, with the pharmacy's corrections applied and the problems named.
 *
 * The search runs over the held rows rather than in SQL, because they are already held in memory
 * for every other screen and a second copy queried a different way is a second answer waiting to
 * disagree with the first.
 */
export async function searchCatalogue(q: CatalogueSearch = {}): Promise<{ rows: CatalogueRow[]; total: number; matched: number }> {
  const { catalogueRows } = await import("./catalogue-cache");
  const { nadacNow } = await import("./nadac-latest");
  const [items, nadac, fixes] = await Promise.all([catalogueRows(), nadacNow(), fixesByKey()]);
  const benchmark = new Map(nadac.map((n) => [n.ndc11, n.unitMicros]));

  const needle = (q.text ?? "").trim().toLowerCase();
  const digits = needle.replace(/[^\d]/g, "");
  const supplier = (q.supplier ?? "").trim().toLowerCase();

  const out: CatalogueRow[] = [];
  let matched = 0;
  for (const it of items) {
    if (supplier && it.supplier.trim().toLowerCase() !== supplier) continue;
    if (needle) {
      const hitsText = (it.description ?? "").toLowerCase().includes(needle);
      const hitsNdc = digits.length >= 4 && it.ndc11.includes(digits);
      if (!hitsText && !hitsNdc) continue;
    }

    const fix = fixes.get(`${it.supplier.trim().toLowerCase()}|${it.ndc11}`) ?? null;
    /*
     * The row arrives already corrected — catalogue-cache applies the fixes, so that every screen
     * and every buying decision works from the same figures. What is added here is the fix itself
     * and what the supplier's file originally said, because the first question about a corrected
     * row is always what it said before.
     */
    const row: CatalogueRow = {
      ndc11: it.ndc11,
      supplier: it.supplier,
      description: it.description,
      packSize: it.packSize,
      unitCostMicros: it.unitCostMicros,
      packCostCents: it.packCostCents,
      awpCents: it.awpCents,
      contractFlag: it.contractFlag,
      pricedOn: it.pricedOn,
      availability: it.availability,
      packUnits: packUnits(it.packSize),
      nadacUnitMicros: benchmark.get(it.ndc11) ?? null,
      problems: [],
      fix: fix
        ? { packSize: fix.packSize, unitCostMicros: fix.unitCostMicros, note: fix.note, correctedBy: fix.correctedBy, correctedAt: fix.correctedAt }
        : null,
      asImported: it.asImported ? { packSize: it.asImported.packSize, unitCostMicros: it.asImported.unitCostMicros } : null,
    };
    row.problems = problemsWith(row, row.nadacUnitMicros);

    if (q.problemsOnly && row.problems.length === 0) continue;
    if (q.fixedOnly && !row.fix) continue;
    matched++;
    if (out.length < (q.limit ?? 200)) out.push(row);
  }

  /*
   * Worst first, then by what the fault is worth — not by what the pack is worth.
   *
   * Sorting by pack cost put a three-thousand-dollar vial whose AWP is a penny light above an
   * eighty-dollar pack that is forty dollars out, which is the wrong way round for anyone working
   * down the list. Each problem carries what being wrong about it costs, and the row is ranked on
   * the largest of them.
   */
  const rank = (r: CatalogueRow) => (worstLevel(r.problems) === "wrong" ? 0 : r.problems.length ? 1 : 2);
  const worth = (r: CatalogueRow) => Math.max(0, ...r.problems.map((p) => p.costCents));
  out.sort((a, b) => rank(a) - rank(b) || worth(b) - worth(a) || (b.packCostCents ?? 0) - (a.packCostCents ?? 0));

  return { rows: out, total: items.length, matched };
}

/** How much of the catalogue is sound, for the line at the top of the page. */
export async function catalogueHealth(): Promise<{
  total: number;
  wrong: number;
  worthChecking: number;
  fixed: number;
  suppliers: string[];
  bySupplier: { supplier: string; items: number; wrong: number }[];
}> {
  const { catalogueRows } = await import("./catalogue-cache");
  const { nadacNow } = await import("./nadac-latest");
  const [items, nadac, fixes] = await Promise.all([catalogueRows(), nadacNow(), fixesByKey()]);
  const benchmark = new Map(nadac.map((n) => [n.ndc11, n.unitMicros]));

  let wrong = 0;
  let worthChecking = 0;
  const by = new Map<string, { items: number; wrong: number }>();
  for (const it of items) {
    // Already corrected by catalogue-cache; this only has to judge what it is handed.
    const problems = problemsWith(
      {
        ndc11: it.ndc11,
        supplier: it.supplier,
        description: it.description,
        packSize: it.packSize,
        unitCostMicros: it.unitCostMicros,
        packCostCents: it.packCostCents,
        awpCents: it.awpCents,
        contractFlag: it.contractFlag,
      },
      benchmark.get(it.ndc11) ?? null,
    );
    const level = worstLevel(problems);
    if (level === "wrong") wrong++;
    else if (level === "check") worthChecking++;
    const s = by.get(it.supplier) ?? { items: 0, wrong: 0 };
    s.items++;
    if (level === "wrong") s.wrong++;
    by.set(it.supplier, s);
  }

  return {
    total: items.length,
    wrong,
    worthChecking,
    fixed: fixes.size,
    suppliers: [...by.keys()].sort(),
    bySupplier: [...by.entries()].map(([supplier, v]) => ({ supplier, ...v })).sort((a, b) => b.wrong - a.wrong || b.items - a.items),
  };
}

/**
 * Records a correction, replacing any earlier one for the same item.
 *
 * A blank pack size or price means "leave the supplier's", not "set it to nothing" — so a
 * correction to one of the two does not silently wipe the other.
 */
export async function correctItem(
  a: { supplier: string; ndc11: string; packSize?: string | null; unitCostMicros?: number | null; note?: string | null },
  user: { id?: string | null; name: string },
): Promise<string> {
  const supplier = a.supplier.trim();
  const ndc11 = a.ndc11.trim();
  if (!supplier || !ndc11) return "Nothing was named to correct.";

  const packSize = (a.packSize ?? "").trim() || null;
  const unitCostMicros = a.unitCostMicros ?? null;
  if (packSize === null && unitCostMicros === null) {
    return "Neither a pack size nor a price was given, so nothing was changed.";
  }
  if (packSize !== null && packUnits(packSize) === null) {
    return `“${packSize}” gives no number of units, which is the problem it was meant to fix. Write it as the bottle does — 180 EA, 473 ML, 30 GM.`;
  }

  const existing = await db.query.supplierItemFixes.findFirst({
    where: and(eq(schema.supplierItemFixes.supplier, supplier), eq(schema.supplierItemFixes.ndc11, ndc11)),
  });
  const values = {
    supplier,
    ndc11,
    packSize,
    unitCostMicros,
    note: (a.note ?? "").trim() || null,
    correctedBy: user.name,
    correctedAt: new Date().toISOString(),
  };
  if (existing) await db.update(schema.supplierItemFixes).set(values).where(eq(schema.supplierItemFixes.id, existing.id));
  else await db.insert(schema.supplierItemFixes).values({ id: newId(), ...values });

  await audit({
    action: "catalogue.corrected",
    userId: user.id ?? null,
    userName: user.name,
    entity: "supplier_item",
    entityId: `${supplier}|${ndc11}`,
    details: [packSize ? `pack size ${packSize}` : null, unitCostMicros !== null ? `unit cost ${(unitCostMicros / 1_000_000).toFixed(4)}` : null]
      .filter(Boolean)
      .join(", "),
  });

  return `Corrected. ${supplier}'s ${ndc11} now reads ${[packSize, unitCostMicros !== null ? `$${(unitCostMicros / 1_000_000).toFixed(4)} a unit` : null].filter(Boolean).join(" at ")}, and next week's file will not undo it.`;
}

/** Removes a correction, putting the supplier's own figures back. */
export async function clearCorrection(supplier: string, ndc11: string, user: { id?: string | null; name: string }): Promise<string> {
  const existing = await db.query.supplierItemFixes.findFirst({
    where: and(eq(schema.supplierItemFixes.supplier, supplier.trim()), eq(schema.supplierItemFixes.ndc11, ndc11.trim())),
  });
  if (!existing) return "There is no correction on that item.";
  await db.delete(schema.supplierItemFixes).where(eq(schema.supplierItemFixes.id, existing.id));
  await audit({
    action: "catalogue.correction_cleared",
    userId: user.id ?? null,
    userName: user.name,
    entity: "supplier_item",
    entityId: `${supplier}|${ndc11}`,
    details: existing.note ?? "",
  });
  return `The correction is removed. ${supplier}'s own figures for ${ndc11} apply again.`;
}
