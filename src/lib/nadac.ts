import "server-only";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { parseCsv, referenceDir } from "./reference";
import { splitRow } from "./pioneer-catalog";
import { isPricingUnit, parseUnitMicros } from "./money";
import type { NadacRecord } from "./reimbursement-rules";

/**
 * NADAC — the National Average Drug Acquisition Cost, published weekly by CMS.
 *
 * Free, public, and since Kansas SB 20 took effect on 1 July 2026 it is the reimbursement floor
 * for commercial plans outside ERISA. An underpayment measured against it is provable without
 * anything from a PBM.
 *
 * Two things shape how this is stored.
 *
 * Each weekly file carries only the prices in force that week, and every row states its own
 * effective date. So loading several weekly files builds the history by itself: a July file
 * contributes the July effective dates, a September file the later ones, and a claim is priced
 * against whichever was in force on its fill date. To price a July claim you need a file
 * published around July — the current file has forgotten that price.
 *
 * And a row is only stored if it parses completely. A NADAC row missing its price, unit or
 * effective date is skipped and counted, never defaulted. A claim priced against a guessed
 * benchmark is worse than a claim we decline to price.
 */

export const nadacDir = () => path.join(referenceDir(), "nadac");

/** CMS publishes MM/DD/YYYY. Accept ISO too, in case a file is re-saved by a spreadsheet. */
export function parseNadacDate(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}

/** NADAC publishes 11-digit NDCs. Strip anything that is not a digit and require exactly 11. */
export function normalizeNdc(raw: string | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length === 11 ? d : null;
}

/** Headers drift in case and spacing between CMS releases, so match loosely but explicitly. */
function pick(row: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const key = Object.keys(row).find((k) => k.toLowerCase().replace(/[\s_]+/g, " ").trim() === n);
    if (key !== undefined) return row[key];
  }
  return undefined;
}

export type ParsedNadacRow = {
  ndc11: string;
  description: string | null;
  unitMicros: number;
  pricingUnit: string;
  effectiveOn: string;
  classification: string | null;
  otc: boolean;
  explanationCode: string | null;
  fileAsOf: string;
};

export type ParseReport = {
  rows: ParsedNadacRow[];
  skipped: number;
  reasons: Record<string, number>;
  /** The earliest as-of date in the file. For a weekly file this is the file's own date. */
  fileAsOf: string | null;
  /**
   * The latest as-of date in the file, which is a different question once year archives exist.
   *
   * A weekly file has one as-of date, so reporting the first row's was fine. A year archive holds
   * fifty-odd of them, and reporting the first made a full year of 2022 announce itself as "the
   * file published 2022-01-05" — technically true, completely misleading, and it hid the fact
   * that the wrong dataset had been fetched at all.
   */
  fileAsOfLatest: string | null;
  /** Distinct as-of dates present. More than one means this is an archive, not a weekly file. */
  weeks: number;
};

type RowCtx = {
  rows: ParsedNadacRow[];
  skipped: number;
  reasons: Record<string, number>;
  fileAsOf: string | null;
  fileAsOfLatest: string | null;
  asOfSeen: Set<string>;
};

const newCtx = (): RowCtx => ({ rows: [], skipped: 0, reasons: {}, fileAsOf: null, fileAsOfLatest: null, asOfSeen: new Set() });

/** One CMS row, as an object keyed by header, into a price or a counted reason. */
function readNadacRow(r: Record<string, string>, ctx: RowCtx): ParsedNadacRow | null {
  const skip = (why: string) => {
    ctx.skipped++;
    ctx.reasons[why] = (ctx.reasons[why] ?? 0) + 1;
    return null;
  };
  const ndc11 = normalizeNdc(pick(r, "ndc"));
  const unitMicros = parseUnitMicros(pick(r, "nadac per unit"));
  const unit = (pick(r, "pricing unit") ?? "").trim().toUpperCase();
  const effectiveOn = parseNadacDate(pick(r, "effective date"));
  const asOf = parseNadacDate(pick(r, "as of date"));

  if (!ndc11) return skip("NDC missing or not 11 digits");
  if (unitMicros === null) return skip("no readable NADAC per unit");
  if (!isPricingUnit(unit)) return skip(`unrecognised pricing unit (${unit || "blank"})`);
  if (!effectiveOn) return skip("no readable effective date");

  if (asOf) {
    ctx.asOfSeen.add(asOf);
    if (!ctx.fileAsOf || asOf < ctx.fileAsOf) ctx.fileAsOf = asOf;
    if (!ctx.fileAsOfLatest || asOf > ctx.fileAsOfLatest) ctx.fileAsOfLatest = asOf;
  }
  return {
    ndc11,
    description: (pick(r, "ndc description") ?? "").trim() || null,
    unitMicros,
    pricingUnit: unit,
    effectiveOn,
    classification: (pick(r, "classification for rate setting") ?? "").trim() || null,
    otc: (pick(r, "otc") ?? "").trim().toUpperCase().startsWith("Y"),
    explanationCode: (pick(r, "explanation code") ?? "").trim() || null,
    fileAsOf: asOf ?? effectiveOn,
  };
}

/** Reads one CMS NADAC CSV held in memory. Never throws on a bad row — it counts it and moves on. */
export function parseNadacCsv(text: string): ParseReport {
  const ctx = newCtx();
  for (const r of parseCsv(text)) {
    const row = readNadacRow(r, ctx);
    if (row) ctx.rows.push(row);
  }
  return { rows: ctx.rows, skipped: ctx.skipped, reasons: ctx.reasons, fileAsOf: ctx.fileAsOf, fileAsOfLatest: ctx.fileAsOfLatest, weeks: ctx.asOfSeen.size };
}

/** Whether the first lines of a file are a CMS NADAC header. Cheap, so it can run on a download's first chunk. */
export function looksLikeNadacHeader(firstLines: string): boolean {
  const head = firstLines.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const cols = splitRow(head, ",").map((c) => c.trim().toLowerCase().replace(/[\s_]+/g, " "));
  return cols.includes("ndc") && cols.includes("nadac per unit") && cols.includes("effective date");
}

export type LoadReport = {
  file: string;
  added: number;
  alreadyHad: number;
  skipped: number;
  reasons: Record<string, number>;
  fileAsOf: string | null;
  fileAsOfLatest: string | null;
  weeks: number;
  rows: number;
};

/**
 * Which files in the folder have been loaded, and as what.
 *
 * Without this, every fetch re-read every file in the folder — including a year archive of a
 * million rows that had been loaded weeks before — and that, not the button, is what kept
 * stopping the site. A file is loaded once; it is read again only if its size or modified time
 * has changed, which is what happens when somebody drops a corrected copy over it.
 */
type Manifest = Record<string, { size: number; mtimeMs: number; sha256: string | null; loadedAt: string; added: number; rows: number }>;
const MANIFEST = ".loaded.json";

/** The files already loaded, by name, with the hash of each — so a re-download of the same bytes is recognised. */
export async function loadedFiles(): Promise<Manifest> {
  return readManifest(nadacDir());
}

async function readManifest(dir: string): Promise<Manifest> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, MANIFEST), "utf8")) as Manifest;
  } catch {
    return {};
  }
}

let loading: Promise<LoadReport[]> | null = null;

/**
 * Loads every NADAC CSV in data/reference/nadac/ that has not been loaded already.
 *
 * Streams. The first version read a whole file into a string, parsed it into an array of objects
 * and then inserted; a weekly file survived that, a year archive did not — a hundred megabytes of
 * text becomes gigabytes of objects, and the parse ran on the one thread that also serves every
 * page. This reads a line at a time, inserts four hundred rows at a time, and hands the thread back
 * between batches, so a page requested while a million rows load waits for one batch, not for the
 * file. Duplicates are the database's job: the unique index on NDC and effective date refuses a
 * price already held, and the count of refusals is the "already had" figure.
 *
 * One load at a time: the weekly check and the button can both ask, and the second waits for the
 * first rather than reading the same file alongside it.
 */
type LoadOpts = { onProgress?: (text: string) => void | Promise<void>; sha256?: Record<string, string> };

export async function loadNadacFiles(opts: LoadOpts = {}): Promise<LoadReport[]> {
  if (loading) return loading;
  loading = loadNadacFilesNow(opts).finally(() => { loading = null; });
  return loading;
}

async function loadNadacFilesNow(opts: LoadOpts): Promise<LoadReport[]> {
  const dir = nadacDir();
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter((f) => /\.(csv|txt)$/i.test(f)).sort();
  const manifest = await readManifest(dir);
  const reports: LoadReport[] = [];

  for (const file of files) {
    const full = path.join(dir, file);
    const stat = await fs.stat(full);
    const done = manifest[file];
    if (done && done.size === stat.size && Math.abs(done.mtimeMs - stat.mtimeMs) < 1) continue;

    const report = await loadOneFile(full, file, stat.size, opts.onProgress);
    reports.push(report);
    const sha256 = opts.sha256?.[file] ?? (await hashFile(full));
    manifest[file] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256, loadedAt: new Date().toISOString(), added: report.added, rows: report.rows };
    await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  }
  return reports;
}

const BATCH = 400;

async function hashFile(full: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(full)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function loadOneFile(full: string, file: string, size: number, onProgress?: (text: string) => void | Promise<void>): Promise<LoadReport> {
  const ctx = newCtx();
  let headers: string[] | null = null;
  let rows = 0;
  let added = 0;
  let batch: (typeof schema.nadacPrices.$inferInsert)[] = [];
  let lastReport = Date.now();

  const flush = async () => {
    if (batch.length === 0) return;
    const r = await db.insert(schema.nadacPrices).values(batch).onConflictDoNothing();
    added += Number(r.rowsAffected ?? 0);
    batch = [];
    // Hand the thread back so a page requested mid-load is served between batches.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (onProgress && Date.now() - lastReport > 2000) {
      lastReport = Date.now();
      await onProgress(`Loading ${file}: ${rows.toLocaleString()} rows read, ${added.toLocaleString()} new`);
    }
  };

  const rl = readline.createInterface({ input: createReadStream(full, { encoding: "utf8", highWaterMark: 1 << 16 }), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    const line = rawLine.replace(/^﻿/, "");
    if (!line.trim()) continue;
    const cells = splitRow(line, ",");
    if (!headers) {
      headers = cells.map((c) => c.trim());
      continue;
    }
    rows++;
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
    const row = readNadacRow(obj, ctx);
    if (!row) continue;
    batch.push({ id: newId(), ...row });
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  if (onProgress) await onProgress(`Loaded ${file}: ${rows.toLocaleString()} rows, ${added.toLocaleString()} new (${(size / 1_048_576).toFixed(1)} MB)`);

  return {
    file,
    added,
    alreadyHad: rows - ctx.skipped - added,
    skipped: ctx.skipped,
    reasons: ctx.reasons,
    fileAsOf: ctx.fileAsOf,
    fileAsOfLatest: ctx.fileAsOfLatest,
    weeks: ctx.asOfSeen.size,
    rows,
  };
}

/**
 * How many of our own claims could actually be priced against what is loaded.
 *
 * Coverage in the abstract is not the useful number — a file with 30,000 NDCs is meaningless if
 * it misses the twelve we dispensed. This counts the claims we hold that have a NADAC in force
 * on their own fill date, which is the only figure that says whether the floor can be applied.
 */
export async function nadacClaimCoverage() {
  const claims = await db.query.claims.findMany({
    columns: { id: true, ndc11: true, dateFilled: true, itemName: true, planType: true },
  });
  const withNdc = claims.filter((c) => c.ndc11);
  if (withNdc.length === 0) {
    return { claims: claims.length, withNdc: 0, noNdc: claims.length, priced: 0, missing: [] as { ndc11: string; itemName: string | null; claims: number }[] };
  }

  // Every effective date held for the NDCs we actually dispensed, fetched in one go.
  //
  // Asking the database per claim was fine at a few hundred claims and would not have been at a
  // year of them. The set of NDCs we dispense is small — a couple of hundred — so one query
  // against those and the rest is arithmetic.
  const wanted = [...new Set(withNdc.map((c) => c.ndc11!))];
  const dates = new Map<string, string[]>();
  for (let i = 0; i < wanted.length; i += 400) {
    const rows = await db
      .select({ ndc11: schema.nadacPrices.ndc11, effectiveOn: schema.nadacPrices.effectiveOn })
      .from(schema.nadacPrices)
      .where(inArray(schema.nadacPrices.ndc11, wanted.slice(i, i + 400)));
    for (const r of rows) {
      const a = dates.get(r.ndc11) ?? [];
      a.push(r.effectiveOn);
      dates.set(r.ndc11, a);
    }
  }

  let priced = 0;
  const missing = new Map<string, { ndc11: string; itemName: string | null; claims: number }>();
  for (const c of withNdc) {
    // In force means the latest effective date on or before the fill — the same rule the pricing
    // engine applies, so this figure cannot disagree with what pricing will actually do.
    const inForce = (dates.get(c.ndc11!) ?? []).some((d) => d <= c.dateFilled);
    if (inForce) {
      priced++;
    } else {
      const e = missing.get(c.ndc11!) ?? { ndc11: c.ndc11!, itemName: c.itemName, claims: 0 };
      e.claims++;
      missing.set(c.ndc11!, e);
    }
  }
  return {
    claims: claims.length,
    withNdc: withNdc.length,
    noNdc: claims.length - withNdc.length,
    priced,
    missing: [...missing.values()].sort((a, b) => b.claims - a.claims),
  };
}

/**
 * Which weeks the pharmacy is missing prices for, in the order of how much it costs to be missing them.
 *
 * "184 claims have no NADAC" is a fact nobody can act on. The actionable version names the weeks,
 * because that is what a CMS file is: one file per week, and to price a claim filled on 15 July
 * you need a file published around 15 July. Today's file has forgotten any price that has changed
 * since — that is the whole reason this gap exists and cannot be closed by fetching again.
 *
 * Grouped by the week the claim was filled rather than by NDC, because that is the unit the fix
 * comes in. Downloading one file closes a whole row of this table.
 */
export async function nadacWeekGaps(): Promise<
  { weekStart: string; claims: number; distinctNdcs: number; examples: string[] }[]
> {
  const claims = await db.query.claims.findMany({
    columns: { ndc11: true, dateFilled: true, itemName: true },
  });
  const withNdc = claims.filter((c) => c.ndc11);
  if (withNdc.length === 0) return [];

  const wanted = [...new Set(withNdc.map((c) => c.ndc11!))];
  const dates = new Map<string, string[]>();
  for (let i = 0; i < wanted.length; i += 400) {
    const rows = await db
      .select({ ndc11: schema.nadacPrices.ndc11, effectiveOn: schema.nadacPrices.effectiveOn })
      .from(schema.nadacPrices)
      .where(inArray(schema.nadacPrices.ndc11, wanted.slice(i, i + 400)));
    for (const r of rows) {
      const a = dates.get(r.ndc11) ?? [];
      a.push(r.effectiveOn);
      dates.set(r.ndc11, a);
    }
  }

  const byWeek = new Map<string, { claims: number; ndcs: Set<string>; examples: Set<string> }>();
  for (const c of withNdc) {
    const inForce = (dates.get(c.ndc11!) ?? []).some((d) => d <= c.dateFilled);
    if (inForce) continue;
    const w = weekStart(c.dateFilled);
    const e = byWeek.get(w) ?? { claims: 0, ndcs: new Set<string>(), examples: new Set<string>() };
    e.claims++;
    e.ndcs.add(c.ndc11!);
    if (e.examples.size < 3 && c.itemName) e.examples.add(c.itemName);
    byWeek.set(w, e);
  }

  return [...byWeek.entries()]
    .map(([weekStart, e]) => ({ weekStart, claims: e.claims, distinctNdcs: e.ndcs.size, examples: [...e.examples] }))
    .sort((a, b) => b.claims - a.claims || a.weekStart.localeCompare(b.weekStart));
}

/** The Monday of the week an ISO date falls in. */
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** What is loaded, and whether it actually covers the period we need to price. */
export async function nadacCoverage() {
  const [agg] = await db
    .select({
      prices: sql<number>`count(*)`,
      ndcs: sql<number>`count(distinct ${schema.nadacPrices.ndc11})`,
      earliest: sql<string | null>`min(${schema.nadacPrices.effectiveOn})`,
      latest: sql<string | null>`max(${schema.nadacPrices.effectiveOn})`,
    })
    .from(schema.nadacPrices);
  const weeks = await db
    .select({ effectiveOn: schema.nadacPrices.effectiveOn, n: sql<number>`count(*)` })
    .from(schema.nadacPrices)
    .groupBy(schema.nadacPrices.effectiveOn)
    .orderBy(schema.nadacPrices.effectiveOn);
  return { ...agg, weeks };
}

/** The price the statute pointed at on a given fill date, or null with nothing invented. */
export async function priceInForce(ndc11: string, dateFilled: string): Promise<NadacRecord | null> {
  const rows = await db.query.nadacPrices.findMany({
    where: and(eq(schema.nadacPrices.ndc11, ndc11), sql`${schema.nadacPrices.effectiveOn} <= ${dateFilled}`),
    orderBy: (p, { desc }) => [desc(p.effectiveOn)],
    limit: 1,
  });
  const r = rows[0];
  if (!r || !isPricingUnit(r.pricingUnit)) return null;
  return {
    ndc11: r.ndc11,
    unitMicros: r.unitMicros,
    pricingUnit: r.pricingUnit.toUpperCase() as NadacRecord["pricingUnit"],
    effectiveOn: r.effectiveOn,
    fileAsOf: r.fileAsOf,
  };
}
