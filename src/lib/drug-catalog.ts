import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { audit } from "./audit";
import { problemsWith, packUnits } from "./catalogue-check";
import { buildDrugRow, reimbursementFrom, marginOf, packReadings, type DrugRow, type DrugSearch, type SupplierOffer } from "./drug-file";

/**
 * The drug file: every NDC the site holds, from every file, in one place.
 *
 * Assembling it means touching four sources — 147,000 supplier rows across two dozen wholesalers,
 * the daily count, NADAC, and the claims — so it is built once and held, exactly as the supplier
 * catalogue and the NADAC benchmark already are. The key moves when any of those change.
 */

let held: { key: string; at: number; rows: DrugRow[] } | null = null;
const MAX_AGE_MS = 10 * 60_000;

async function currentKey(): Promise<string> {
  const [supplierImport, count, claim, fixes, packFixes] = await Promise.all([
    db.query.supplierImports.findFirst({ orderBy: (i, { desc }) => [desc(i.createdAt)], columns: { id: true } }),
    db.query.onHandImports.findFirst({ orderBy: (i, { desc }) => [desc(i.countedOn)], columns: { id: true } }),
    db.query.claims.findFirst({ orderBy: (c, { desc }) => [desc(c.createdAt)], columns: { id: true } }),
    db.query.supplierItemFixes.findMany({ columns: { id: true } }),
    db.query.ndcPackFixes.findMany({ columns: { id: true, correctedAt: true } }),
  ]);
  const newestFix = packFixes.map((f) => f.correctedAt).sort().pop() ?? "none";
  return `${supplierImport?.id ?? "-"}|${count?.id ?? "-"}|${claim?.id ?? "-"}|${fixes.length}|${packFixes.length}:${newestFix}`;
}

/** Every drug the site holds anything about, assembled from every file. */
export async function drugFile(): Promise<DrugRow[]> {
  const key = await currentKey();
  if (held && held.key === key && Date.now() - held.at < MAX_AGE_MS) return held.rows;

  const { catalogueRows } = await import("./catalogue-cache");
  const { nadacNow } = await import("./nadac-latest");
  const { drugNames } = await import("./drug-names");
  const { latestShelf, movement } = await import("./shelf");

  const [items, nadac, names, shelf, move, itemFixes, packFixes] = await Promise.all([
    catalogueRows(),
    nadacNow(),
    drugNames(),
    latestShelf(),
    movement(),
    db.query.supplierItemFixes.findMany(),
    db.query.ndcPackFixes.findMany(),
  ]);

  const benchmark = new Map(nadac.map((n) => [n.ndc11, n]));
  const correctedItems = new Set(itemFixes.map((f) => `${f.supplier.trim().toLowerCase()}|${f.ndc11}`));
  const packFixBy = new Map(packFixes.map((f) => [f.ndc11, f]));

  const shelfBy = new Map<string, { packQty: number | null; onHandThousandths: number; valueCents: number | null }>();
  for (const r of shelf?.rxRows ?? [])
    shelfBy.set(r.ndc11, { packQty: r.packQty, onHandThousandths: r.quantityThousandths, valueCents: r.valueCents });

  /*
   * What each drug reimburses, from fills rather than claims.
   *
   * A fill billed to a primary plan and then a secondary is two claim rows for one bottle, each
   * carrying the same quantity — 73 of them in the pharmacy's archive. Counted as claims, the
   * quantity doubles and the reimbursement per unit halves, which is the one figure on this page
   * nobody can look up anywhere else.
   */
  const fillsBy = new Map<string, { quantityThousandths: number | null; remitCents: number; revenueCents: number; dateFilled: string; cashPlan: boolean }[]>();
  for (const f of move?.fills ?? []) {
    if (!f.ndc11) continue;
    const list = fillsBy.get(f.ndc11) ?? [];
    list.push({ quantityThousandths: f.quantityThousandths, remitCents: f.remitCents, revenueCents: f.revenueCents, dateFilled: f.dateFilled, cashPlan: f.cashPlan });
    fillsBy.set(f.ndc11, list);
  }

  const byNdc = new Map<string, typeof items>();
  for (const it of items) byNdc.set(it.ndc11, [...(byNdc.get(it.ndc11) ?? []), it]);

  const rows: DrugRow[] = [];
  for (const ndc11 of new Set([...byNdc.keys(), ...shelfBy.keys(), ...fillsBy.keys()])) {
    const offers: SupplierOffer[] = (byNdc.get(ndc11) ?? [])
      .map((it) => ({
        supplier: it.supplier,
        packSize: it.packSize,
        packUnits: packUnits(it.packSize),
        unitCostMicros: it.unitCostMicros,
        packCostCents: it.packCostCents,
        awpCents: it.awpCents,
        contractFlag: it.contractFlag,
        pricedOn: it.pricedOn,
        availability: it.availability,
        corrected: correctedItems.has(`${it.supplier.trim().toLowerCase()}|${it.ndc11}`),
        problems: problemsWith(
          {
            ndc11: it.ndc11, supplier: it.supplier, description: it.description, packSize: it.packSize,
            unitCostMicros: it.unitCostMicros, packCostCents: it.packCostCents, awpCents: it.awpCents, contractFlag: it.contractFlag,
          },
          benchmark.get(it.ndc11)?.unitMicros ?? null,
        ),
      }))
      .sort((a, b) => (a.packCostCents ?? Infinity) - (b.packCostCents ?? Infinity));

    const fix = packFixBy.get(ndc11);
    rows.push(
      buildDrugRow({
        ndc11,
        name: names.get(ndc11) ?? (byNdc.get(ndc11) ?? [])[0]?.description ?? null,
        offers,
        shelf: shelfBy.get(ndc11) ?? null,
        nadacUnitMicros: benchmark.get(ndc11)?.unitMicros ?? null,
        nadacPricingUnit: benchmark.get(ndc11)?.pricingUnit ?? null,
        reimbursement: reimbursementFrom(fillsBy.get(ndc11) ?? []),
        packFix: fix ? { packSize: fix.packSize, note: fix.note, correctedBy: fix.correctedBy, correctedAt: fix.correctedAt } : null,
      }),
    );
  }

  held = { key, at: Date.now(), rows };
  return rows;
}

export function forgetDrugFile(): void {
  held = null;
}

export type DrugSearchResult = { rows: DrugRow[]; matched: number; total: number };

/** The drug file, searched and ranked for a person working down it. */
export async function searchDrugs(q: DrugSearch = {}): Promise<DrugSearchResult> {
  const all = await drugFile();
  const needle = (q.text ?? "").trim().toLowerCase();
  const digits = needle.replace(/[^\d]/g, "");
  const supplier = (q.supplier ?? "").trim().toLowerCase();

  const out: DrugRow[] = [];
  let matched = 0;
  for (const r of all) {
    if (supplier && !r.offers.some((o) => o.supplier.trim().toLowerCase() === supplier)) continue;
    if (needle) {
      const hitsName = (r.name ?? "").toLowerCase().includes(needle);
      const hitsNdc = digits.length >= 4 && r.ndc11.includes(digits);
      if (!hitsName && !hitsNdc) continue;
    }
    if (q.mismatchOnly && !(r.packDisagreement && !r.packFix)) continue;
    if (q.problemsOnly && r.problems.length === 0) continue;
    if (q.dispensedOnly && !r.reimbursement) continue;
    if (q.fixedOnly && !r.packFix) continue;
    matched++;
    if (out.length < (q.limit ?? 200)) out.push(r);
  }

  /*
   * Worst first, then by what being wrong costs, then by what the drug actually earns.
   *
   * A drug nobody dispenses that two wholesalers describe differently matters less than one filled
   * every week, so where nothing is wrong the list is ordered by the money the claims put through it.
   */
  const rank = (r: DrugRow) => (r.problems.some((p) => p.level === "wrong") ? 0 : r.problems.length ? 1 : 2);
  const worth = (r: DrugRow) => Math.max(0, ...r.problems.map((p) => p.costCents));
  out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      worth(b) - worth(a) ||
      (b.reimbursement?.remitCents ?? 0) - (a.reimbursement?.remitCents ?? 0) ||
      (b.bestPackCostCents ?? 0) - (a.bestPackCostCents ?? 0),
  );
  return { rows: out, matched, total: all.length };
}

/** The line at the top of the page: how much of the drug file is sound. */
export async function drugFileHealth(): Promise<{
  total: number;
  suppliers: { supplier: string; items: number }[];
  mismatches: number;
  settled: number;
  dispensed: number;
  problems: number;
  reimbursedCents: number;
}> {
  const { held } = await import("./held");
  return held("drug-file-health", loadDrugFileHealth);
}

async function loadDrugFileHealth(): Promise<{
  total: number;
  suppliers: { supplier: string; items: number }[];
  mismatches: number;
  settled: number;
  dispensed: number;
  problems: number;
  reimbursedCents: number;
}> {
  const all = await drugFile();
  const bySupplier = new Map<string, number>();
  let mismatches = 0, settled = 0, dispensed = 0, problems = 0, reimbursedCents = 0;
  for (const r of all) {
    for (const o of r.offers) bySupplier.set(o.supplier, (bySupplier.get(o.supplier) ?? 0) + 1);
    if (r.packDisagreement && !r.packFix) mismatches++;
    if (r.packFix) settled++;
    if (r.reimbursement) {
      dispensed++;
      reimbursedCents += r.reimbursement.remitCents;
    }
    if (r.problems.length > 0) problems++;
  }
  return {
    total: all.length,
    suppliers: [...bySupplier.entries()].map(([supplier, items]) => ({ supplier, items })).sort((a, b) => b.items - a.items),
    mismatches,
    settled,
    dispensed,
    problems,
    reimbursedCents,
  };
}

/**
 * Settles what a package of this NDC holds, for every supplier and every file from now on.
 *
 * Kept on the NDC rather than the supplier because an NDC names one package: two wholesalers
 * disagreeing about it are one error, and answering it once is the whole point.
 */
export async function settlePackSize(
  a: { ndc11: string; packSize: string; note?: string | null },
  user: { id?: string | null; name: string },
): Promise<string> {
  const ndc11 = a.ndc11.trim();
  const packSize = a.packSize.trim();
  if (!ndc11) return "No drug was named.";
  if (!packSize) return "No pack size was given, so nothing was settled.";
  if (packReadings(packSize).whole === null) {
    return `“${packSize}” gives no number of units, which is the problem it was meant to answer. Write it as the bottle does — 180 EA, 473 ML, 30 GM.`;
  }

  const existing = await db.query.ndcPackFixes.findFirst({ where: eq(schema.ndcPackFixes.ndc11, ndc11) });
  const values = { ndc11, packSize, note: (a.note ?? "").trim() || null, correctedBy: user.name, correctedAt: new Date().toISOString() };
  if (existing) await db.update(schema.ndcPackFixes).set(values).where(eq(schema.ndcPackFixes.id, existing.id));
  else await db.insert(schema.ndcPackFixes).values({ id: newId(), ...values });

  await audit({
    action: "drug.pack_settled", userId: user.id ?? null, userName: user.name,
    entity: "ndc", entityId: ndc11, details: `${packSize}${values.note ? ` — ${values.note}` : ""}`,
  });
  forgetDrugFile();
  (await import("./catalogue-cache")).forgetCatalogue();
  return `Settled. A package of ${ndc11} is ${packSize}, for every supplier, and next week's files will not undo it.`;
}

/** Removes a settled pack size, putting the suppliers' own figures back. */
export async function clearPackSize(ndc11: string, user: { id?: string | null; name: string }): Promise<string> {
  const existing = await db.query.ndcPackFixes.findFirst({ where: eq(schema.ndcPackFixes.ndc11, ndc11.trim()) });
  if (!existing) return "That drug's package has not been settled.";
  await db.delete(schema.ndcPackFixes).where(eq(schema.ndcPackFixes.id, existing.id));
  await audit({ action: "drug.pack_unsettled", userId: user.id ?? null, userName: user.name, entity: "ndc", entityId: ndc11, details: existing.packSize });
  forgetDrugFile();
  (await import("./catalogue-cache")).forgetCatalogue();
  return `The settled package for ${ndc11} is removed. Each supplier's own figure applies again.`;
}

export { marginOf };
