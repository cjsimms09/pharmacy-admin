import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { comparePack, fdaPackageUnits, cataloguePackUnits, containerShape } from "./data-health-packages";
import {
  proposeFdaCorrection,
  proposeContainerContents,
  isFromFda,
  isFromPerson,
  unitCostMicros,
  FDA_SOURCE,
  type NeedsPersonReason,
} from "./pack-fixes";

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
  /**
   * How much the pharmacy actually deals in this package, which is what orders the queue.
   *
   * A list of twelve thousand packages sorted by NDC is not a work queue, it is a phone book. The
   * owner settles what he sells before what he might: fills first, because a package he dispenses
   * is one he has held, and spend second.
   */
  fills: number;
  spentCents: number;
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
  /** NDCs the FDA file has no package row for, so nothing can be compared. A different job entirely. */
  noDescription: number;
  settledByPerson: number;
  examples: string[];
}> {
  const { byNdc, packageOf, fixes } = await load();
  let corrected = 0;
  let alreadyRight = 0;
  let needsPerson = 0;
  let settledByPerson = 0;
  let noDescription = 0;
  const examples: string[] = [];
  const now = new Date().toISOString();

  /*
   * What the pharmacy actually dispenses, which settles a disagreement neither file can.
   *
   * The FDA package file counts what is in the box; a wholesaler catalogue counts what it sells
   * you; and for a GSK Ellipta inhaler those are different numbers for an honest reason — the
   * device holds two blister strips, one per drug reservoir, so thirty doses are sixty blisters.
   * The catalogues count blisters, the FDA counts doses.
   *
   * Correcting 60 down to 30 halved the pack and so doubled every per-unit cost built on it, which
   * is where a Trelegy loss of $1,436.21 came from against a real one of about $79 — PioneerRx put
   * it at $12.97. Fifty-seven corrections had made a pack smaller than every catalogue said, one of
   * them by a factor of a hundred.
   *
   * The owner settled it in three words: "trelegy we bill 60". The claim is in the unit the
   * pharmacy buys and bills in, so where a correction would put the pack below a quantity actually
   * dispensed, the catalogue is describing the real world and the correction is not applied.
   */
  const dispensed = new Map<string, number>();
  for (const c of await db
    .select({ ndc11: schema.claims.ndc11, q: schema.claims.quantityThousandths, status: schema.claims.status })
    .from(schema.claims)) {
    if (!c.ndc11 || c.status !== "paid" || !c.q || c.q <= 0) continue;
    dispensed.set(c.ndc11, Math.max(dispensed.get(c.ndc11) ?? 0, c.q / 1000));
  }
  for (const [ndc11, rows] of byNdc) {
    const description = packageOf.get(ndc11);
    /*
     * No FDA package description, so there is nothing to compare against — and this said nothing about
     * it. The health row counted 12,328 NDCs as "need a person" while this button could reach about
     * 2,369 of them; the other 10,287 were skipped here, silently, and the run reported success
     * without mentioning them. Somebody pressing it would watch the number barely move and have no
     * way to know why.
     *
     * They are a real group with a real cause — the FDA file has no package row for that NDC — and a
     * different remedy from a package the reader could not parse. Counted and named as their own line.
     */
    if (!description) {
      noDescription++;
      continue;
    }
    const existing = fixes.get(ndc11);

    if (existing && isFromPerson(existing.correctedBy)) {
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

    /*
     * Never below what has actually gone out of the door.
     *
     * A pack the pharmacy has dispensed more than in a single fill is not the pack it buys. Left
     * for a person rather than dropped silently, because the disagreement is real and worth
     * somebody knowing about — it is just not one this can settle from two files.
     */
    const most = dispensed.get(ndc11) ?? 0;
    const proposed = Number((p.packSize.match(/[\d.]+/) ?? ["0"])[0]);
    if (most > 0 && proposed > 0 && proposed < most) {
      needsPerson++;
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
  return { corrected, alreadyRight, needsPerson, noDescription, settledByPerson, examples };
}

/**
 * NADAC's pricing unit for every NDC it prices, newest row per NDC.
 *
 * This is the document that settles whether a package is counted or measured, and it is the unit
 * the benchmark comparison and the Kansas floor both use. `claims.quantity_unit` cannot do the job:
 * the daily report never carries it and it is null on every row.
 */
async function nadacUnits(): Promise<Map<string, "EA" | "ML" | "GM">> {
  const rows = await db
    .select({ ndc11: schema.nadacPrices.ndc11, pricingUnit: schema.nadacPrices.pricingUnit, effectiveOn: schema.nadacPrices.effectiveOn })
    .from(schema.nadacPrices);
  const newest = new Map<string, { on: string; unit: string }>();
  for (const r of rows) {
    const seen = newest.get(r.ndc11);
    if (!seen || r.effectiveOn > seen.on) newest.set(r.ndc11, { on: r.effectiveOn, unit: r.pricingUnit });
  }
  const out = new Map<string, "EA" | "ML" | "GM">();
  for (const [ndc11, v] of newest) {
    const u = v.unit.trim().toUpperCase();
    // Only the three the rest of this site knows. An unrecognised unit is left absent rather than
    // mapped to a guess, so the NDC falls to a person instead of being settled on a misreading.
    if (u === "EA" || u === "ML" || u === "GM") out.set(ndc11, u);
  }
  return out;
}

/**
 * How many of the open questions the container-contents rule would settle, without settling any.
 *
 * Counted before it is ever applied, deliberately. The rule is new, it rewrites a pack size from a
 * count of vials to a volume, and that changes every per-unit cost on those NDCs — so the size of
 * what it would do is worth knowing before it does it, not after.
 */
export async function countContainerContents(): Promise<{
  wouldSettle: number;
  countedAsNadacCounts: number;
  noNadac: number;
  blockedByCount: number;
  notThisShape: number;
  /**
   * What the ones that are not this shape actually are, commonest first.
   *
   * Two thousand NDCs described as "not this shape" is a number nobody can act on. Named, it is a
   * finding — and naming it is the only way to stop the next rule being a guess at the same bulk.
   */
  shapes: { shape: string; count: number }[];
  examples: string[];
}> {
  const { byNdc, packageOf, fixes } = await load();
  const units = await nadacUnits();
  let wouldSettle = 0;
  let countedAsNadacCounts = 0;
  let noNadac = 0;
  let blockedByCount = 0;
  let notThisShape = 0;
  const shapes = new Map<string, number>();
  const examples: string[] = [];

  for (const [ndc11, rows] of byNdc) {
    const description = packageOf.get(ndc11);
    if (!description) continue;
    const existing = fixes.get(ndc11);
    if (existing && isFromPerson(existing.correctedBy)) continue;

    // Only NDCs that are open questions today: settled or agreeing ones are not this rule's work.
    const open = rows.some((r) => ["unit-differs", "differs", "cannot-compare"].includes(comparePack(r.packSize, description).verdict));
    if (!open) continue;

    const proposals = rows.map((r) => ({
      row: r,
      p: proposeContainerContents({
        catalogue: r.packSize,
        packageDescription: description,
        nadacUnit: units.get(ndc11) ?? null,
        existing: existing ? { packSize: existing.packSize, correctedBy: existing.correctedBy } : null,
      }),
    }));

    const settles = proposals.find((x) => x.p.apply);
    if (settles && settles.p.apply) {
      wouldSettle++;
      if (examples.length < 5) {
        examples.push(`${ndc11}: ${settles.row.supplier} counts ${settles.row.packSize} → ${settles.p.packSize}`);
      }
      continue;
    }
    const verdicts = proposals.filter((x) => !x.p.apply).map((x) => (x.p as { verdict: string }).verdict);
    // Ordered by what the answer means, not by which row came first: "NADAC counts it in EA" is a
    // closed question and outranks the shape complaints, which are only ever "not this rule".
    if (verdicts.includes("counted-as-nadac-counts")) countedAsNadacCounts++;
    else if (verdicts.includes("no-nadac")) noNadac++;
    else if (verdicts.includes("differs")) blockedByCount++;
    else {
      notThisShape++;
      const shape = containerShape(description);
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    }
  }

  return {
    wouldSettle,
    countedAsNadacCounts,
    noNadac,
    blockedByCount,
    notThisShape,
    shapes: [...shapes].map(([shape, count]) => ({ shape, count })).sort((a, b) => b.count - a.count),
    examples,
  };
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
  const [{ fillsBy, spentBy }, units] = await Promise.all([dealings(), nadacUnits()]);
  const wanted = (opts.text ?? "").trim().toLowerCase();
  const out: PackQuestion[] = [];

  for (const [ndc11, rows] of byNdc) {
    const description = packageOf.get(ndc11) ?? null;
    const existing = fixes.get(ndc11) ?? null;
    const settledByPerson = existing !== null && isFromPerson(existing.correctedBy);

    // Settled by a person is done, unless somebody asked to see the settled ones too.
    if (settledByPerson && !opts.includeSettled) continue;

    /*
     * A unit disagreement NADAC has already settled is not a question.
     *
     * "McKesson counts 1 EA where the FDA counts 20 ML" looks like a disagreement and is not one:
     * NADAC prices that NDC per EA, which says the package is counted, so the wholesaler's number is
     * the right divisor and nothing needs deciding. Left in, these were 874 of the queue — items
     * asking a pharmacist to adjudicate something a document had already answered, which is the
     * fastest way to make a work queue ignored.
     */
    const nadacUnit = units.get(ndc11) ?? null;

    let reason: NeedsPersonReason | null = null;
    let why = "";
    for (const r of rows) {
      const v = comparePack(r.packSize, description);
      if (v.verdict === "unit-differs") {
        // NADAC says this package is counted and the catalogue counts it, so the FDA's volume is
        // not a disagreement to adjudicate — it is a second true description of the same box.
        const cat = cataloguePackUnits(r.packSize);
        if (nadacUnit === "EA" && cat.ok && cat.uom === "EA") continue;
      }
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
      fills: fillsBy.get(ndc11) ?? 0,
      spentCents: spentBy.get(ndc11) ?? 0,
    });
  }

  /*
   * Ordered by what the pharmacy actually dispenses, then by what it spends, then by the kind of
   * question.
   *
   * Twelve thousand packages sorted by NDC is a phone book, not a work queue. A package the
   * pharmacy has dispensed is one somebody has held, so it can be settled from memory and its
   * per-unit cost is already being used in anger; a package nobody has bought is a question that
   * can wait forever without costing anything.
   */
  const order: Record<NeedsPersonReason, number> = { "unit-differs": 0, differs: 1, "cannot-compare": 2 };
  out.sort(
    (a, b) =>
      b.fills - a.fills ||
      b.spentCents - a.spentCents ||
      order[a.reason] - order[b.reason] ||
      a.ndc11.localeCompare(b.ndc11),
  );
  return { questions: out.slice(0, opts.limit ?? 200), total: out.length };
}

/**
 * How many fills and how much spend each NDC carries, for ordering the queue.
 *
 * Fills are counted by prescription, fill number and date rather than by claim row, because a
 * second payor on one dispensing is one fill and counting rows would rank a coordinated claim
 * above a busier drug.
 */
async function dealings(): Promise<{ fillsBy: Map<string, number>; spentBy: Map<string, number> }> {
  const claims = await db
    .select({
      ndc11: schema.claims.ndc11,
      rxNumber: schema.claims.rxNumber,
      fillNumber: schema.claims.fillNumber,
      dateFilled: schema.claims.dateFilled,
      status: schema.claims.status,
    })
    .from(schema.claims);
  const seen = new Set<string>();
  const fillsBy = new Map<string, number>();
  for (const c of claims) {
    if (c.status !== "paid" || !isNdc(c.ndc11)) continue;
    const key = [c.rxNumber, c.fillNumber ?? "", c.dateFilled, c.ndc11].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    fillsBy.set(c.ndc11, (fillsBy.get(c.ndc11) ?? 0) + 1);
  }

  const lines = await db
    .select({ ndc11: schema.invoiceLines.ndc11, extendedCents: schema.invoiceLines.extendedCents })
    .from(schema.invoiceLines);
  const spentBy = new Map<string, number>();
  for (const l of lines) {
    if (!isNdc(l.ndc11)) continue;
    spentBy.set(l.ndc11, (spentBy.get(l.ndc11) ?? 0) + l.extendedCents);
  }

  return { fillsBy, spentBy };
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
export async function packFixSummary(): Promise<{
  settledByPerson: number;
  settledByFda: number;
  needsPerson: number;
  /** Questions NADAC answered: counted, as NADAC counts them. Nothing was wrong with these. */
  closedByNadac: number;
}> {
  const { byNdc, packageOf, fixes } = await load();
  const units = await nadacUnits();
  let needsPerson = 0;
  let closedByNadac = 0;
  for (const [ndc11, rows] of byNdc) {
    const description = packageOf.get(ndc11) ?? null;
    const existing = fixes.get(ndc11);
    if (existing && isFromPerson(existing.correctedBy)) continue;
    const nadacUnit = units.get(ndc11) ?? null;

    // The same gate the queue applies, so the figure at the top of the page and the list under it
    // can never disagree about how much work there is.
    let open = false;
    let closed = false;
    for (const r of rows) {
      const v = comparePack(r.packSize, description).verdict;
      if (v === "unit-differs") {
        const cat = cataloguePackUnits(r.packSize);
        if (nadacUnit === "EA" && cat.ok && cat.uom === "EA") {
          closed = true;
          continue;
        }
      }
      if (v === "unit-differs" || v === "differs" || v === "cannot-compare") open = true;
    }
    if (open) needsPerson++;
    else if (closed) closedByNadac++;
  }
  const all = [...fixes.values()];
  return {
    settledByPerson: all.filter((f) => isFromPerson(f.correctedBy)).length,
    settledByFda: all.filter((f) => isFromFda(f.correctedBy)).length,
    needsPerson,
    closedByNadac,
  };
}
