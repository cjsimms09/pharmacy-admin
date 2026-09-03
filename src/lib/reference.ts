import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId, sha256 } from "./crypto";

/**
 * Reference data and contract files, loaded from folders the pharmacy drops files into.
 *
 * No AI anywhere here. This is the routing layer: BIN → PBM → the agreement that governs a
 * claim, plus which of the known documents have actually arrived. It has to be boring and
 * exact, because everything downstream — expected reimbursement, MAC appeals — is wrong if
 * a claim is matched to the wrong contract.
 */

const dataDir = () => path.dirname(path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
export const referenceDir = () => path.join(dataDir(), "reference");
export const contractsDir = () => path.join(dataDir(), "contracts");

/** Minimal CSV reader: handles quoted fields, embedded commas and newlines, and a BOM. */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

async function readIfPresent(dir: string, names: string[]): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  // Match on a distinctive fragment so "a2302110-bin_crosswalk.csv" still resolves.
  const hit = entries.find((e) => names.some((n) => e.toLowerCase().includes(n)));
  return hit ? fs.readFile(path.join(dir, hit), "utf8") : null;
}

const num = (v: string | undefined) => {
  const n = Number((v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export type ImportSummary = { bins: number; docs: number; aging: number; agingAsOf: string | null; skipped: string[] };

/** Reads every reference file present and replaces what it covers. Safe to re-run. */
export async function importReference(): Promise<ImportSummary> {
  const dir = referenceDir();
  const out: ImportSummary = { bins: 0, docs: 0, aging: 0, agingAsOf: null, skipped: [] };

  // ── BIN crosswalk ────────────────────────────────────────────────
  const binCsv = await readIfPresent(dir, ["bin_crosswalk"]);
  if (binCsv) {
    const rows = parseCsv(binCsv);
    const counts = new Map<string, Set<string>>();
    for (const r of rows) {
      const bin = (r.bin || "").trim();
      if (!bin) continue;
      if (!counts.has(bin)) counts.set(bin, new Set());
      counts.get(bin)!.add((r.pbm_name || "").trim());
    }
    await db.delete(schema.payerBins);
    for (const r of rows) {
      const bin = (r.bin || "").trim();
      if (!bin) continue;
      const help = r.help_desk || null;
      await db.insert(schema.payerBins).values({
        id: newId(),
        bin,
        pbmName: (r.pbm_name || "").trim() || "(unnamed)",
        subNetwork: r.sub_network || null,
        linesOfBusiness: r.lines_of_business || null,
        aliases: r.aliases || null,
        helpDesk: help,
        // The MAC appeal contact is buried in the help-desk free text; pull it forward.
        macContact: help ? (help.match(/MAC[^;]*/i)?.[0] ?? null) : null,
        notes: r.notes || null,
        collides: (counts.get(bin)?.size ?? 1) > 1,
      });
      out.bins++;
    }
  } else out.skipped.push("bin_crosswalk.csv");

  // ── Contract index ───────────────────────────────────────────────
  const idxCsv = await readIfPresent(dir, ["contract_index"]);
  if (idxCsv) {
    const rows = parseCsv(idxCsv);
    // Keep any file matches already made; only the catalogue is replaced.
    const existing = await db.query.contractDocs.findMany();
    const seen = new Map(existing.filter((d) => d.fileName).map((d) => [`${d.pbmName}|${d.documentName}`, d]));
    await db.delete(schema.contractDocs);
    for (const r of rows) {
      const pbm = (r.pbm || "").trim();
      const name = (r.document_name || "").trim();
      if (!name) continue;
      const prev = seen.get(`${pbm}|${name}`);
      await db.insert(schema.contractDocs).values({
        id: newId(),
        pbmName: pbm || "(unlabelled)",
        documentName: name,
        documentType: r.document_type || null,
        effectiveYear: Number(r.effective_year) || null,
        fileName: prev?.fileName ?? null,
        sizeBytes: prev?.sizeBytes ?? null,
        sha256: prev?.sha256 ?? null,
        matchedBy: prev?.matchedBy ?? null,
        priority: isPriority(pbm, name, Number(r.effective_year) || 0),
        extractionState: prev?.extractionState ?? "none",
        extractionJson: prev?.extractionJson ?? null,
      });
      out.docs++;
    }
  } else out.skipped.push("contract_index.csv");

  // ── Open claims aging ────────────────────────────────────────────
  const agingCsv = await readIfPresent(dir, ["openclaims", "claims_aging", "aging"]);
  if (agingCsv) {
    const rows = parseCsv(agingCsv);
    const asOf = new Date().toISOString().slice(0, 10);
    await db.delete(schema.claimsAging);
    for (const r of rows) {
      const payer = (r["Payer name"] || r.payer_name || "").trim();
      if (!payer || payer === "_Totals") continue;
      await db.insert(schema.claimsAging).values({
        id: newId(),
        asOf,
        payerName: payer,
        bin: (r["BIN number"] || r.bin || "").trim(),
        d0_30: num(r["0 - 30 days"]),
        d31_60: num(r["31 - 60 days"]),
        d61_90: num(r["61 - 90 days"]),
        d91_120: num(r["91 - 120 days"]),
        d121_150: num(r["121 - 150 days"]),
        d151_180: num(r["151 - 180 days"]),
        over180: num(r["Over 180 days"]),
        totalOut: num(r["Total out"]),
      });
      out.aging++;
    }
    out.agingAsOf = asOf;
  } else out.skipped.push("open claims aging");

  return out;
}

// Every PBM this pharmacy actually bills, from the open-claims report — not the ones with the
// largest outstanding balance. A payer that pays promptly shows a small balance and still needs
// its rates checked.
const PRIORITY_PBMS = [
  "apollo", "prime", "dst", "caremark", "optum", "aetna", "pdmi", "vytlone", "rxsense",
  "liviniti", "medimpact", "capital rx", "judi", "ventegra", "medone", "smithrx", "navitus",
  "citizens", "lucyrx", "script care", "tredium", "change healthcare", "iqvia", "pharmpix",
  "sav-rx", "savrx", "prodigy", "mc-rx", "procare", "rightway", "scriptsave", "hippo",
];
const RATE_WORDS = /rate|rates|exhibit|fee schedule|network|amendment|compensation|addendum|mfp|enrollment form/i;
const AGREEMENT = /base agreement|main agreement|psao agreement|participating|services agreement/i;
const NOT_RATES = /provider manual|pharmacy manual|providers manual|services manual|state addenda|arbitration|settlement|request for proposal|chain info|notice|attestation/i;

/** The documents worth extracting: current rate paper for the payers where money is at stake. */
export function isPriority(pbm: string, name: string, year: number): boolean {
  const p = pbm.toLowerCase();
  if (!PRIORITY_PBMS.some((x) => p.includes(x))) return false;
  if (NOT_RATES.test(name)) return false;
  if (AGREEMENT.test(name)) return true;
  return year >= 2025 && RATE_WORDS.test(name);
}

/** Normalises a name so a portal filename can be compared to a catalogue entry. */
function key(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.pdf$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(20\d\d)\b/g, "$1")
    .trim();
}

export type ScanResult = { found: number; matched: number; unmatched: string[]; viaManifest: number };

/**
 * Looks at data/contracts/ and works out which catalogue entries have arrived.
 *
 * A download_manifest.csv sitting alongside the files is trusted first, because portals hand
 * out filenames like "download(7).pdf" and the manifest is the only thing that maps those back.
 * Otherwise names are compared directly.
 */
export async function scanContracts(): Promise<ScanResult> {
  const dir = contractsDir();
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((e) => e.toLowerCase().endsWith(".pdf"));
  } catch {
    return { found: 0, matched: 0, unmatched: [], viaManifest: 0 };
  }

  const docs = await db.query.contractDocs.findMany();
  const byKey = new Map(docs.map((d) => [key(d.documentName), d]));
  const res: ScanResult = { found: entries.length, matched: 0, unmatched: [], viaManifest: 0 };

  // Manifest first, when there is one.
  const manifest = await readIfPresent(dir, ["download_manifest", "manifest"]);
  const fromManifest = new Map<string, string>(); // file name -> document name
  if (manifest) {
    for (const r of parseCsv(manifest)) {
      const f = (r.saved_filename || r.file_name || "").trim();
      const d = (r.document_name || "").trim();
      if (f && d) fromManifest.set(f, d);
    }
  }

  for (const file of entries) {
    const full = path.join(dir, file);
    const stat = await fs.stat(full);
    const claimed = fromManifest.get(file);
    const doc = (claimed ? byKey.get(key(claimed)) : undefined) ?? byKey.get(key(file));
    if (!doc) {
      res.unmatched.push(file);
      continue;
    }
    const buf = await fs.readFile(full);
    await db
      .update(schema.contractDocs)
      .set({ fileName: file, sizeBytes: stat.size, sha256: sha256(buf), matchedBy: claimed ? "manifest" : "filename" })
      .where(eq(schema.contractDocs.id, doc.id));
    res.matched++;
    if (claimed) res.viaManifest++;
  }
  return res;
}

/** What the checklist page needs: how much of the priority set has landed, and what is missing. */
export async function contractStatus() {
  const docs = await db.query.contractDocs.findMany({ orderBy: (d, { asc }) => [asc(d.pbmName), asc(d.documentName)] });
  const priority = docs.filter((d) => d.priority);
  const byPbm = new Map<string, { total: number; here: number }>();
  for (const d of priority) {
    const e = byPbm.get(d.pbmName) ?? { total: 0, here: 0 };
    e.total++;
    if (d.fileName) e.here++;
    byPbm.set(d.pbmName, e);
  }
  return {
    docs,
    priority,
    missing: priority.filter((d) => !d.fileName),
    here: priority.filter((d) => d.fileName),
    byPbm: [...byPbm.entries()].map(([pbm, v]) => ({ pbm, ...v })).sort((a, b) => b.total - a.total),
  };
}

/** Outstanding balance joined to the PBM each BIN belongs to. */
export async function agingByPbm() {
  const [aging, bins] = await Promise.all([db.query.claimsAging.findMany(), db.query.payerBins.findMany()]);
  const pbmOf = new Map<string, string[]>();
  for (const b of bins) {
    const l = pbmOf.get(b.bin) ?? [];
    if (!l.includes(b.pbmName)) l.push(b.pbmName);
    pbmOf.set(b.bin, l);
  }
  const roll = new Map<string, { total: number; over180: number; bins: Set<string>; mapped: boolean }>();
  for (const a of aging) {
    const names = pbmOf.get(a.bin);
    const targets = names && names.length ? names : [a.payerName];
    for (const t of targets) {
      const e = roll.get(t) ?? { total: 0, over180: 0, bins: new Set<string>(), mapped: Boolean(names?.length) };
      e.total += a.totalOut / targets.length;
      e.over180 += a.over180 / targets.length;
      e.bins.add(a.bin);
      roll.set(t, e);
    }
  }
  return [...roll.entries()]
    .map(([pbm, v]) => ({ pbm, total: v.total, over180: v.over180, bins: v.bins.size, mapped: v.mapped }))
    .sort((a, b) => b.total - a.total);
}

export async function referenceCounts() {
  const [b, d, a] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(schema.payerBins),
    db.select({ n: sql<number>`count(*)` }).from(schema.contractDocs),
    db.select({ n: sql<number>`count(*)` }).from(schema.claimsAging),
  ]);
  return { bins: b[0].n, docs: d[0].n, aging: a[0].n };
}
