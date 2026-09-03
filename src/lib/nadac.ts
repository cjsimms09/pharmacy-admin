import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { parseCsv, referenceDir } from "./reference";
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

export type ParseReport = { rows: ParsedNadacRow[]; skipped: number; reasons: Record<string, number>; fileAsOf: string | null };

/** Reads one CMS NADAC CSV. Never throws on a bad row — it counts it and moves on. */
export function parseNadacCsv(text: string): ParseReport {
  const raw = parseCsv(text);
  const rows: ParsedNadacRow[] = [];
  const reasons: Record<string, number> = {};
  let skipped = 0;
  let fileAsOf: string | null = null;
  const skip = (why: string) => {
    skipped++;
    reasons[why] = (reasons[why] ?? 0) + 1;
  };

  for (const r of raw) {
    const ndc11 = normalizeNdc(pick(r, "ndc"));
    const unitMicros = parseUnitMicros(pick(r, "nadac per unit"));
    const unit = (pick(r, "pricing unit") ?? "").trim().toUpperCase();
    const effectiveOn = parseNadacDate(pick(r, "effective date"));
    const asOf = parseNadacDate(pick(r, "as of date"));

    if (!ndc11) { skip("NDC missing or not 11 digits"); continue; }
    if (unitMicros === null) { skip("no readable NADAC per unit"); continue; }
    if (!isPricingUnit(unit)) { skip(`unrecognised pricing unit (${unit || "blank"})`); continue; }
    if (!effectiveOn) { skip("no readable effective date"); continue; }

    if (asOf && !fileAsOf) fileAsOf = asOf;
    rows.push({
      ndc11,
      description: (pick(r, "ndc description") ?? "").trim() || null,
      unitMicros,
      pricingUnit: unit,
      effectiveOn,
      classification: (pick(r, "classification for rate setting") ?? "").trim() || null,
      otc: (pick(r, "otc") ?? "").trim().toUpperCase().startsWith("Y"),
      explanationCode: (pick(r, "explanation code") ?? "").trim() || null,
      fileAsOf: asOf ?? effectiveOn,
    });
  }
  return { rows, skipped, reasons, fileAsOf };
}

export type LoadReport = { file: string; added: number; alreadyHad: number; skipped: number; reasons: Record<string, number>; fileAsOf: string | null };

/**
 * Loads every NADAC CSV sitting in data/reference/nadac/.
 *
 * Re-running is safe: a price is keyed on NDC plus effective date, so the same file loaded twice
 * adds nothing, and overlapping weekly files simply fill in each other's gaps.
 */
export async function loadNadacFiles(): Promise<LoadReport[]> {
  const dir = nadacDir();
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter((f) => /\.(csv|txt)$/i.test(f)).sort();
  const reports: LoadReport[] = [];

  // Every price already held, read once.
  //
  // The first version of this asked the database whether each row existed and then inserted it
  // one at a time — sixty thousand round trips for a single weekly file, which made the page
  // look frozen for several minutes. A CMS file is about thirty thousand rows and the whole set
  // of keys is a few megabytes, so holding them in memory is the obvious trade.
  const seen = new Set<string>(
    (await db.select({ ndc11: schema.nadacPrices.ndc11, effectiveOn: schema.nadacPrices.effectiveOn }).from(schema.nadacPrices))
      .map((r) => `${r.ndc11}|${r.effectiveOn}`),
  );

  for (const file of files) {
    const text = await fs.readFile(path.join(dir, file), "utf8");
    const parsed = parseNadacCsv(text);
    let added = 0;
    let alreadyHad = 0;

    // Dedupe within the file as well as against the database. CMS files can repeat an NDC, and
    // two rows for the same NDC and date are the same price whichever arrives first.
    const fresh: ParsedNadacRow[] = [];
    for (const row of parsed.rows) {
      const key = `${row.ndc11}|${row.effectiveOn}`;
      if (seen.has(key)) { alreadyHad++; continue; }
      seen.add(key);
      fresh.push(row);
    }

    // Multi-row inserts, sized so the statement stays well inside SQLite's variable limit:
    // eleven columns a row, so 400 rows is about 4,400 bound values against a ceiling of 32,766.
    for (let i = 0; i < fresh.length; i += 400) {
      const chunk = fresh.slice(i, i + 400).map((row) => ({ id: newId(), ...row }));
      await db.insert(schema.nadacPrices).values(chunk);
      added += chunk.length;
    }

    reports.push({ file, added, alreadyHad, skipped: parsed.skipped, reasons: parsed.reasons, fileAsOf: parsed.fileAsOf });
  }
  return reports;
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
