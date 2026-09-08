import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { comparePack, fdaPackageUnits, cataloguePackUnits } from "./data-health-packages";
import { proposeFdaCorrection, isFromFda, unitCostMicros, FDA_SOURCE, type NeedsPersonReason } from "./pack-fixes";

/**
 * Reading the catalogue against the FDA, correcting what the file settles, and queueing the rest.
 *
 * The pure decisions are in `pack-fixes.ts`. This is the half that touches the database.
 *
 * ── One NDC, several catalogues ──
 *
 * The pure module judges one wholesaler's pack size against the FDA. Real rows are not like that:
 * an NDC appears in up to five catalogues, and they do not always agree with each other. A
 * correction is written per NDC — because an NDC names one package and the answer must hold for a
 * supplier the pharmacy has never bought from — so the whole group has to be judged together.
 *
 * The rule is that the FDA settles the group only when nothing in it contradicts the FDA:
 *
 *   - every readable supplier row either already equals the FDA's figure, or is a whole factor of
 *     it — the "quoting an inner pack" case, which is exactly what the FDA is resolving;
 *   - and no row disagrees in a way arithmetic cannot bridge.
 *
 * One supplier counting the package in grams where the FDA counts actuations sends the whole NDC
 * to a person, even if three other suppliers agree with the FDA. That is deliberate: a unit
 * disagreement is evidence that the package is not what one of the parties thinks it is, and
 * settling it automatically on a majority would be exactly the confident wrong number this exists
 * to remove.
 */

export type SupplierReading = {
  supplier: string;
  packSize: string | null;
  packCostCents: number | null;
  /** What one dispensing unit costs if this row's own pack size is believed. */
  unitCostMicros: number | null;
};

/** One NDC that needs a person, with everything needed to decide it on one row. */
export type PackQuestion = {
  ndc11: string;
  description: string | null;
  /** The FDA's package text as printed, so the pharmacist can read what the file actually says. */
  packageDescription: string | null;
  /** The FDA's reading, where it has one. */
  fdaPackSize: string | null;
  /** Why the file cannot settle it. */
  reason: NeedsPersonReason;
  why: string;
  suppliers: SupplierReading[];
  /** What one unit would cost under the FDA's reading, for comparison against each supplier's. */
  fdaUnitCostMicros: number | null;
  /** The correction already on file, if any. */
  settled: { packSize: string; note: string | null; by: string; at: string } | null;
};

type Row = {
  ndc11: string;
  supplier: string;
  description: string | null;
  packSize: string | null;
  packCostCents: number | null;
};

const isNdc = (s: string | null | undefined): s is string => typeof s === "string" && /^\d{11}$/.test(s);

/** The catalogue and the FDA text for it, in one pass, keyed by NDC. */
async function load(): Promise<{
  byNdc: Map<string, Row[]>;
  packageOf: Map<string, string>;
  fixes: Map<string, { packSize: string; note: string | null; correctedBy: string; correctedAt: string }>;
}> {
  const raw = await db
    .select({
      ndc11: schema.supplierItems.ndc11,
      supplier: schema.supplierItems.supplier,
      description: schema.supplierItems.description,
      packSize: schema.supplierItems.packSize,
      packCostCents: schema.supplierItems.packCostCents,
    })
    .from(schema.supplierItems);

  const byNdc = new Map<string, Row[]>();
  for (const r of raw) {
    if (!isNdc(r.ndc11)) continue;
    const list = byNdc.get(r.ndc11);
    if (list) list.push(r as Row);
    else byNdc.set(r.ndc11, [r as Row]);
  }

  // Only the descriptions for NDCs the catalogue carries; the directory is 217,773 rows.
  const directory = await db
    .select({ ndc11: schema.drugDirectory.ndc11, packageDescription: schema.drugDirectory.packageDescription })
    .from(schema.drugDirectory);
  const packageOf = new Map<string, string>();
  for (const d of directory) if (byNdc.has(d.ndc11)) packageOf.set(d.ndc11, d.packageDescription);

  const existing = await db.select().from(schema.ndcPackFixes);
  const fixes = new Map(existing.map((f) => [f.ndc11, { packSize: f.packSize, note: f.note, correctedBy: f.correctedBy, correctedAt: f.correctedAt }]));

  return { byNdc, packageOf, fixes };
}

/**
 * Writes the corrections the FDA settles on its own.
 *
 * Returns what it changed and what it refused, because the refusals are the queue and their size is
 * the honest measure of how much of this the file could not do.
 */
export async function applyFdaCorrections(user: { name: string }): Promise<{
  corrected: number;
  alreadyRight: number;
  needsPerson: number;
  settledByPerson: number;
  examples: string[];
}> {
  const { byNdc, packageOf, fixes } = await load();
  let corrected = 0;
  let alreadyRight = 0;
  let needsPerson = 0;
  let settledByPerson = 0;
  const examples: string[] = [];
  const now = new Date().toISOString();

  for (const [ndc11, rows] of byNdc) {
    const description = packageOf.get(ndc11);
    if (!description) continue;
    const existing = fixes.get(ndc11);

    if (existing && !isFromFda(existing.correctedBy)) {
      settledByPerson++;
      continue;
    }

    /*
     * Judged across every catalogue that carries the NDC, not on the first row found.
     *
     * A group is settled only when nothing in it contradicts the FDA. One row counted in a
     * different unit stops the whole NDC even where others agree, because a unit disagreement says
     * the package is not what one party thinks it is, and no majority makes that safe.
     */
    let blocked = false;
    let anyMultiple = false;
    let anyAgree = false;
    let readable = 0;
    for (const r of rows) {
      const v = comparePack(r.packSize, description);
      if (v.verdict === "cannot-compare") continue;
      readable++;
      if (v.verdict === "agree") anyAgree = true;
      else if (v.verdict === "multiple") anyMultiple = true;
      else blocked = true;
    }

    if (readable === 0 || blocked) {
      needsPerson++;
      continue;
    }
    if (!anyMultiple && anyAgree) {
      alreadyRight++;
      continue;
    }

    // Every readable row agrees or is a whole factor of the FDA's. Propose against the row that
    // differs, so the note carries the arithmetic somebody would want to check.
    const differing = rows.find((r) => comparePack(r.packSize, description).verdict === "multiple")!;
    const p = proposeFdaCorrection({
      catalogue: differing.packSize,
      packageDescription: description,
      existing: existing ? { packSize: existing.packSize, correctedBy: existing.correctedBy } : null,
    });
    if (!p.apply) {
      needsPerson++;
      continue;
    }

    if (existing?.packSize === p.packSize) {
      alreadyRight++;
      continue;
    }

    await db
      .insert(schema.ndcPackFixes)
      .values({ id: newId(), ndc11, packSize: p.packSize, note: p.note, correctedBy: FDA_SOURCE, correctedAt: now })
      .onConflictDoUpdate({
        target: schema.ndcPackFixes.ndc11,
        set: { packSize: p.packSize, note: p.note, correctedBy: FDA_SOURCE, correctedAt: now },
      });
    corrected++;
    if (examples.length < 5) {
      examples.push(`${ndc11}: ${differing.supplier} read ${differing.packSize}, corrected to ${p.packSize} (${p.factor}× out)`);
    }
  }

  void user;
  return { corrected, alreadyRight, needsPerson, settledByPerson, examples };
}

/**
 * Every NDC the file cannot settle, with each supplier's reading and what a unit costs under each.
 *
 * `text` searches the NDC and the description, because a pharmacist looking one of these up has
 * either the bottle in his hand or the name in his head, and rarely both.
 */
export async function packQuestions(opts: { text?: string; limit?: number; includeSettled?: boolean } = {}): Promise<{
  questions: PackQuestion[];
  total: number;
}> {
  const { byNdc, packageOf, fixes } = await load();
  const wanted = (opts.text ?? "").trim().toLowerCase();
  const out: PackQuestion[] = [];

  for (const [ndc11, rows] of byNdc) {
    const description = packageOf.get(ndc11) ?? null;
    const existing = fixes.get(ndc11) ?? null;
    const settledByPerson = existing !== null && !isFromFda(existing.correctedBy);

    // Settled by a person is done, unless somebody asked to see the settled ones too.
    if (settledByPerson && !opts.includeSettled) continue;

    let reason: NeedsPersonReason | null = null;
    let why = "";
    for (const r of rows) {
      const v = comparePack(r.packSize, description);
      if (v.verdict === "unit-differs") {
        reason = "unit-differs";
        why = `${r.supplier} counts ${v.catalogue} where the FDA counts ${v.fda}.`;
        break;
      }
      if (v.verdict === "differs") {
        reason = "differs";
        why = `${r.supplier} says ${v.catalogue} ${v.uom} and the FDA says ${v.fda} ${v.uom}, which is not a whole multiple either way.`;
      }
      if (v.verdict === "cannot-compare" && reason === null) {
        reason = "cannot-compare";
        why = v.why;
      }
    }
    if (reason === null) continue;

    if (wanted) {
      const hay = `${ndc11} ${rows.map((r) => r.description ?? "").join(" ")}`.toLowerCase();
      if (!hay.includes(wanted)) continue;
    }

    const fda = fdaPackageUnits(description);
    const fdaPackSize = fda.ok ? `${fda.units} ${fda.uom}` : null;
    const cheapestPack = rows.map((r) => r.packCostCents).filter((c): c is number => c !== null && c > 0).sort((a, b) => a - b)[0] ?? null;

    out.push({
      ndc11,
      description: rows.find((r) => (r.description ?? "").trim() !== "")?.description ?? null,
      packageDescription: description,
      fdaPackSize,
      reason,
      why,
      suppliers: rows.map((r) => ({
        supplier: r.supplier,
        packSize: r.packSize,
        packCostCents: r.packCostCents,
        unitCostMicros: unitCostMicros(r.packCostCents, r.packSize),
      })),
      fdaUnitCostMicros: fdaPackSize ? unitCostMicros(cheapestPack, fdaPackSize) : null,
      settled: existing ? { packSize: existing.packSize, note: existing.note, by: existing.correctedBy, at: existing.correctedAt } : null,
    });
  }

  const order: Record<NeedsPersonReason, number> = { "unit-differs": 0, differs: 1, "cannot-compare": 2 };
  out.sort((a, b) => order[a.reason] - order[b.reason] || a.ndc11.localeCompare(b.ndc11));
  return { questions: out.slice(0, opts.limit ?? 200), total: out.length };
}

/**
 * The pharmacy's answer for one package, which outranks every file from here on.
 *
 * The note is required in spirit and requested in the form: it is the only record of what was
 * checked against what — the bottle, the invoice, the manufacturer's page — and a correction with
 * no reason is indistinguishable next year from a typing mistake.
 */
export async function settlePack(
  ndc11: string,
  input: { packSize: string; note: string },
  user: { name: string },
): Promise<void> {
  const size = input.packSize.trim();
  if (!isNdc(ndc11)) throw new Error("That is not an eleven-digit NDC.");
  const read = cataloguePackUnits(size);
  if (!read.ok) throw new Error(`"${size}" is not a pack size this can use: ${read.why}`);

  await db
    .insert(schema.ndcPackFixes)
    .values({
      id: newId(),
      ndc11,
      packSize: `${read.units} ${read.uom}`,
      note: input.note.trim() || null,
      correctedBy: user.name,
      correctedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.ndcPackFixes.ndc11,
      set: {
        packSize: `${read.units} ${read.uom}`,
        note: input.note.trim() || null,
        correctedBy: user.name,
        correctedAt: new Date().toISOString(),
      },
    });
}

/** Takes a correction back off, so a wrong answer is not permanent. */
export async function unsettlePack(ndc11: string): Promise<void> {
  await db.delete(schema.ndcPackFixes).where(eq(schema.ndcPackFixes.ndc11, ndc11));
}

/** How the work stands, for the top of the page. */
export async function packFixSummary(): Promise<{ settledByPerson: number; settledByFda: number; needsPerson: number }> {
  const { byNdc, packageOf, fixes } = await load();
  let needsPerson = 0;
  for (const [ndc11, rows] of byNdc) {
    const description = packageOf.get(ndc11) ?? null;
    const existing = fixes.get(ndc11);
    if (existing && !isFromFda(existing.correctedBy)) continue;
    if (rows.some((r) => ["unit-differs", "differs", "cannot-compare"].includes(comparePack(r.packSize, description).verdict))) needsPerson++;
  }
  const all = [...fixes.values()];
  return {
    settledByPerson: all.filter((f) => !isFromFda(f.correctedBy)).length,
    settledByFda: all.filter((f) => isFromFda(f.correctedBy)).length,
    needsPerson,
  };
}
