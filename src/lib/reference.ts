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

/**
 * The reference tables shipped with the app.
 *
 * data/ is deliberately outside version control — it holds the database and uploaded documents —
 * so reference CSVs left only there would never reach a second machine. A copy travels in the
 * repository instead, and a file dropped into data/reference/ overrides it. That way a refreshed
 * scrape is a file copy rather than a code change, and a fresh install still starts with data.
 */
export const shippedReferenceDir = () => path.join(process.cwd(), "reference-data");
export const contractsDir = () => path.join(dataDir(), "contracts");

/**
 * Minimal CSV reader, at the row level.
 *
 * Exposed separately because a file has to be recognisable by its header even when it carries no
 * data rows — a scheduled report covering a quiet day is still that report.
 */
export function parseCsvRows(text: string): string[][] {
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
  return rows;
}

/** The same reader, keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const [head, ...body] = parseCsvRows(text).filter((r) => r.some((v) => v.trim() !== ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/**
 * Finds a reference file by name, preferring a local drop over the shipped copy.
 *
 * Searches data/reference/ first, then the copy in the repository. Returns the first hit, so a
 * refreshed file dropped locally silently supersedes the one that shipped.
 */
async function readReference(names: string[]): Promise<string | null> {
  for (const d of [referenceDir(), shippedReferenceDir()]) {
    const hit = await readIfPresent(d, names);
    if (hit !== null) return hit;
  }
  return null;
}

async function readIfPresent(dir: string, names: string[]): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  // An exact basename wins first. Only then fall back to a contains match, so a portal filename
  // like "a2302110-bin_crosswalk.csv" still resolves — but "contract_bin_crosswalk.csv" can never
  // be picked up in place of "bin_crosswalk.csv" just because readdir happened to return it first.
  const lower = entries.map((e) => [e, e.toLowerCase()] as const);
  for (const n of names) {
    const exact = lower.find(([, l]) => l === `${n}.csv` || l === `${n}.tsv`);
    if (exact) return fs.readFile(path.join(dir, exact[0]), "utf8");
  }
  const hit = lower.find(([, l]) => names.some((n) => l.includes(n)));
  return hit ? fs.readFile(path.join(dir, hit[0]), "utf8") : null;
}

const num = (v: string | undefined) => {
  const n = Number((v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export type ImportSummary = {
  bins: number;
  docs: number;
  rates: number;
  appeals: number;
  routing: number;
  contacts: number;
  communications: number;
  /** Source labels that did not resolve to a canonical PBM name. These need a crosswalk row. */
  unresolvedPbms: string[];
  skipped: string[];
  /** From the pharmacy's own payer list, where one is in the folder: BINs added, and BINs the two records disagree on. */
  listingBins: number;
  listingConflicts: string[];
  /** Claims already held that gained a payer from the list. */
  listingClaims: number;
};

/** "null" and "N/A" are literal strings in these exports; they mean absent, not a value. */
const clean = (v: string | undefined): string | null => {
  const s = (v ?? "").trim();
  if (!s || /^(null|n\/a|none|unknown|-)$/i.test(s)) return null;
  return s;
};

const int = (v: string | undefined): number | null => {
  const s = clean(v);
  if (s === null) return null;
  const n = Number.parseInt(s.replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * Resolving a PBM label to one canonical payer.
 *
 * The HMA sources disagree with themselves. The BIN listing says "OptumRx"; the network table
 * says "Optum Rx (PerformRx, RxAdvance) ***841 stores are excluded"; the payment table says
 * "OptumRx (CastiaRx, Catamaran, ScriptNet & StoneRiver)". Left alone that is three payers, and
 * a BIN lookup on OptumRx finds fifty-nine BINs and no rates — which reads as missing data when
 * it is really a naming mismatch. That is the single most dangerous failure mode in this import,
 * because it is invisible.
 *
 * Four passes, most trustworthy first:
 *
 *   1. pbm_name_crosswalk.csv, where a person has already stated the mapping.
 *   2. The BIN listing's own names and its aliases column, mechanically normalised.
 *   3. A squashed key, so "ScriptGuideRx" and "ScriptGuide Rx" meet.
 *   4. A short hand-written table for the rest, each entry justified in a comment.
 *
 * Anything still unresolved keeps its own label and is reported. It is not quietly folded into
 * a near neighbour: several of these are genuinely not PBMs on the listing (Express Scripts,
 * the MTF, Health Mart Atlas itself), and merging them would be worse than leaving them apart.
 */

const NOISE = /\b(health|healthcare|systems|solutions|inc|llc|the|pharmacy|therapeutics|group)\b/g;

/** Lowercases and strips the decoration: footnotes, parentheticals, "Rx", punctuation. */
export function normalizePbm(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/\*{2,}.*$/, "");                       // "***841 stores are excluded"
  s = s.replace(/\*+/g, "");
  s = s.replace(/\((?:previously|formerly)[^)]*\)/g, ""); // "(previously MaxorPlus)"
  s = s.replace(/\([^)]*\)/g, " ");                      // any remaining parenthetical
  s = s.replace(/\brx\b/g, " ");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(NOISE, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** A tighter key that ignores spacing entirely, so "ScryptSense" matches "Scrypt Sense". */
export function squashPbm(raw: string): string {
  return normalizePbm(raw).replace(/[^a-z0-9]/g, "").replace(/^rx|rx$/g, "");
}

/**
 * Letters and digits only, with nothing removed.
 *
 * The communications feed writes names closed up — "PrimeTherapeutics", "AbarcaHealth" — where
 * the other tables space them. Stripping "Therapeutics" as a noise word turns "Prime
 * Therapeutics" into "prime" but leaves "primetherapeutics" intact, so those two never meet on
 * the normalised key. This one compares them before anything is dropped.
 */
export function tightPbm(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Mappings the sources do not state and normalisation cannot infer. Keyed on the normalised
 * label. Each one is a claim about who actually adjudicates, so each carries its reason.
 */
const MANUAL_ALIASES: Record<string, string> = {
  // The HMA listing carries "Ascella Health" as an OptumRx alias (BIN 028181); the network
  // table writes it closed up and notes it processes under PerformRx, also OptumRx.
  ascellahealth: "OptumRx",
  // "ServeYou" is an OptumRx alias on the BIN listing; the payment table spaces it.
  "serve you": "OptumRx",
  // Elixir and MedTrak are both named as MedImpact sub-brands on the network table row
  // "MedImpact (Elixir, MedTrak, SavRx)".
  "elixir options": "MedImpact",
  medtrakrx: "MedImpact",
  medtrak: "MedImpact",
  // "PDMI- Pharmacy Data Management, Inc. (Universal Rx)" is the listing's PDMI.
  "pdmi data management": "PDMI",
  // The Workers Compensation row has no PBM name on the source table; the listing labels it SRPS.
  "unnamed row workers compensation bin 005567": "SRPS (unnamed row on source table)",
  // The communications feed concatenates a parent and its brand with no separator, so these
  // three cannot be split mechanically. SS&C Health is DST's parent; Elixir is a MedImpact
  // brand; Opus Health is IQVIA's pharmacy arm.
  sschealthdst: "DST Pharmacy Solutions",
  medimpactelixir: "MedImpact",
  iqviaopus: "IQVIA",
};

/**
 * Labels that resolve to nothing on the BIN listing on purpose. Naming them here keeps them out
 * of the "unresolved, go and fix it" report — they are not errors, they are known gaps or
 * entities that are not PBMs at all.
 */
export const KNOWN_NON_LISTING: { match: RegExp; name: string; why: string }[] = [
  {
    match: /express\s*scripts|(^|\W)esi(\W|$)/i,
    name: "Express Scripts",
    why: "HMA publishes no BINs for Express Scripts. Claims adjudicate to it but the listing does not carry it, which is why ESI payments do not match. Tracked separately.",
  },
  {
    match: /health\s*mart\s*atlas/i,
    name: "Health Mart Atlas (PSAO)",
    why: "The PSAO itself, not a PBM. Carries the MAC Success Manager route that applies across payers.",
  },
  {
    match: /medicare transaction facilitator|(^|\W)mtf(\W|$)/i,
    name: "Medicare Transaction Facilitator (MTF)",
    why: "The CMS Maximum Fair Price refund channel, not a PBM.",
  },
  { match: /covermymeds/i, name: "CoverMyMeds", why: "eVoucher processor, not a PBM." },
  { match: /apha foundation/i, name: "APhA Foundation", why: "Grant/program payer, not a PBM." },
  { match: /healthesystems/i, name: "Healthesystems", why: "Workers' compensation processor, not on the PBM listing." },
  { match: /employee health insurance management|ehim/i, name: "EHIM", why: "Third-party administrator, not on the PBM listing." },
  { match: /ga medicaid|georgia medicaid/i, name: "Georgia Medicaid", why: "State payer, not a PBM." },
  { match: /pharmacy quality services|\bpqs\b/i, name: "Pharmacy Quality Services (PQS)", why: "Quality program payer, not a PBM." },
];

export type PbmResolution = { name: string; via: "crosswalk" | "listing" | "squash" | "manual" | "known-gap" | "unresolved"; why?: string };

export type PbmResolver = {
  resolve: (label: string) => PbmResolution;
  unresolved: () => string[];
};

/**
 * Builds the resolver from the canonical names and aliases already loaded into payer_bins,
 * plus the crosswalk file if one is present.
 */
export function buildPbmResolver(
  listing: { pbmName: string; aliases: string | null }[],
  crosswalkCsv: string | null,
): PbmResolver {
  const byNorm = new Map<string, string>();
  const bySquash = new Map<string, string>();
  const byTight = new Map<string, string>();
  const add = (label: string, canonical: string) => {
    const n = normalizePbm(label);
    const q = squashPbm(label);
    const t = tightPbm(label);
    if (n && !byNorm.has(n)) byNorm.set(n, canonical);
    if (q && !bySquash.has(q)) bySquash.set(q, canonical);
    if (t && !byTight.has(t)) byTight.set(t, canonical);
  };
  // Whole names and stated aliases first, so an exact match always beats a partial one.
  for (const row of listing) {
    add(row.pbmName, row.pbmName);
    for (const a of (row.aliases ?? "").split(";")) if (a.trim()) add(a.trim(), row.pbmName);
  }
  // Then each brand inside a combined canonical name. "MC-Rx & ProCare" and
  // "Gateway/CitizensRx/LucyRx" are single listing entries covering several brands, and the other
  // tables refer to them one brand at a time. Second pass, so this can never displace a whole name.
  for (const row of listing) {
    const parts = row.pbmName.split(/\s*[&/]\s*|,\s+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) for (const part of parts) add(part, row.pbmName);
  }

  const fromCrosswalk = new Map<string, string>();
  if (crosswalkCsv) {
    for (const r of parseCsv(crosswalkCsv)) {
      const label = (r.phase2_label || "").trim();
      const phase1 = (r.phase1_pbm_name || "").trim();
      // Only adopt the phase-1 name when the crosswalk asserts they are the same payer. The
      // non-matching rows carry prose explanations in that column, not names.
      if (label && phase1 && (r.matches_phase1 || "").trim().toLowerCase() === "y") {
        fromCrosswalk.set(normalizePbm(label), phase1);
      }
    }
  }

  const missed = new Set<string>();

  const resolve = (raw: string): PbmResolution => {
    const label = raw.trim();
    // "null" arrives as a literal string in these exports and means the source had no value.
    if (!label || /^(null|n\/a|none)$/i.test(label)) return { name: "(unlabelled)", via: "unresolved" };

    const gap = KNOWN_NON_LISTING.find((g) => g.match.test(label));
    if (gap) return { name: gap.name, via: "known-gap", why: gap.why };

    const n = normalizePbm(label);
    const q = squashPbm(label);
    const t = tightPbm(label);

    const cross = fromCrosswalk.get(n);
    if (cross) return { name: cross, via: "crosswalk" };
    if (MANUAL_ALIASES[n]) return { name: MANUAL_ALIASES[n], via: "manual" };
    if (MANUAL_ALIASES[t]) return { name: MANUAL_ALIASES[t], via: "manual" };
    if (byNorm.has(n)) return { name: byNorm.get(n)!, via: "listing" };
    if (byTight.has(t)) return { name: byTight.get(t)!, via: "squash" };
    if (bySquash.has(q)) return { name: bySquash.get(q)!, via: "squash" };

    // "MC-Rx, ProCare & MaxCare" and the like: a single row covering several brands. Resolve on
    // the first named brand, which is the one the listing indexes.
    const first = label.split(/[&/,]/)[0];
    if (first && first !== label) {
      const fn = normalizePbm(first);
      const fq = squashPbm(first);
      if (MANUAL_ALIASES[fn]) return { name: MANUAL_ALIASES[fn], via: "manual" };
      if (byNorm.has(fn)) return { name: byNorm.get(fn)!, via: "listing" };
      if (byTight.has(tightPbm(first))) return { name: byTight.get(tightPbm(first))!, via: "squash" };
      if (bySquash.has(fq)) return { name: bySquash.get(fq)!, via: "squash" };
    }

    missed.add(label);
    return { name: label, via: "unresolved" };
  };

  return { resolve, unresolved: () => [...missed].sort() };
}

/** Reads every reference file present and replaces what it covers. Safe to re-run. */
/** The resolver as it stands, from what is loaded: for naming a counterparty the way the payer pages name it. */
export async function pbmResolver(): Promise<PbmResolver> {
  return buildPbmResolver(await db.query.payerBins.findMany({ columns: { pbmName: true, aliases: true } }), await readReference(["pbm_name_crosswalk"]));
}

export async function importReference(): Promise<ImportSummary> {
  const dir = referenceDir();
  const out: ImportSummary = { bins: 0, docs: 0, rates: 0, appeals: 0, routing: 0, contacts: 0, communications: 0, unresolvedPbms: [], skipped: [], listingBins: 0, listingConflicts: [], listingClaims: 0 };

  // ── BIN crosswalk ────────────────────────────────────────────────
  const binCsv = await readReference(["bin_crosswalk"]);
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
    const binRows: (typeof schema.payerBins.$inferInsert)[] = [];
    for (const r of rows) {
      const bin = (r.bin || "").trim();
      if (!bin) continue;
      const help = r.help_desk || null;
      binRows.push({
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
    for (let i = 0; i < binRows.length; i += 300) await db.insert(schema.payerBins).values(binRows.slice(i, i + 300));
  } else out.skipped.push("bin_crosswalk.csv");

  // ── PBM name resolver ────────────────────────────────────────────
  // Built here, between the BIN listing and everything else, because every table below is keyed
  // on the canonical name it produces — the contract catalogue included.
  // Reads the BIN listing back out of the database, so the resolver is built from what was
  // actually loaded a moment ago rather than from a second parse of the same file.
  const resolver = buildPbmResolver(
    await db.query.payerBins.findMany({ columns: { pbmName: true, aliases: true } }),
    await readReference(["pbm_name_crosswalk"]),
  );
  const canonical = (label: string): string => resolver.resolve(label).name;

  // ── The pharmacy's own payer list ────────────────────────────────
  // The reconciliation service's export: this pharmacy's payers, one row per BIN, with the PSAO
  // marked on the name. Fills the BINs the published crosswalk does not carry and never overwrites
  // one it does; a disagreement is named for a person.
  const listingCsv = await readReference(["payer_listing", "openclaims"]);
  if (listingCsv) {
    const { parsePayerListing, reconcileListing } = await import("./payer-listing");
    const held = await db.query.payerBins.findMany({ columns: { id: true, bin: true, pbmName: true, aliases: true } });
    const r = reconcileListing(parsePayerListing(listingCsv), held, (l) => { const x = resolver.resolve(l); return x.via === "unresolved" ? l : x.name; });
    for (const a of r.add) {
      await db.insert(schema.payerBins).values({
        id: newId(), bin: a.bin, pbmName: a.canonical, aliases: a.rawName, subNetwork: a.viaPsao,
        notes: `From the pharmacy's own payer list${a.viaPsao ? `; contracted through ${a.viaPsao}` : "; pays direct"}.`, collides: false,
      });
      out.bins++;
      out.listingBins++;
    }
    for (const x of r.same) {
      const row = held.find((h) => h.bin === x.bin);
      if (!row) continue;
      const aliases = new Set((row.aliases ?? "").split(";").map((v) => v.trim()).filter(Boolean));
      if (!aliases.has(x.rawName)) {
        aliases.add(x.rawName);
        await db.update(schema.payerBins).set({ aliases: [...aliases].join(";"), subNetwork: x.viaPsao ?? undefined }).where(eq(schema.payerBins.id, row.id));
      }
    }
    out.listingConflicts = r.conflict.map((c) => `${c.bin}: the list says ${c.rawName}, the crosswalk says ${c.listedAs}`);
    /*
     * What was learned is applied to the claims already held, the way naming a BIN by hand does:
     * every claim on a newly named BIN that has no payer yet gets one. A BIN the crosswalk already
     * named was attributed when its claims were imported.
     */
    if (r.add.length > 0) {
      const named = new Map(r.add.map((a) => [a.bin, a.canonical]));
      const held = await db.query.claims.findMany({ columns: { id: true, bin: true, pbmName: true } });
      for (const c of held) {
        const name = c.bin ? named.get(c.bin.trim()) : undefined;
        if (!name || c.pbmName) continue;
        await db.update(schema.claims).set({ pbmName: name, matchMethod: "payer_list", payerAmbiguous: false }).where(eq(schema.claims.id, c.id));
        out.listingClaims++;
      }
    }
  } else out.skipped.push("payer_listing.csv");

  // ── Contract index ───────────────────────────────────────────────
  const idxCsv = await readReference(["contract_index"]);
  if (idxCsv) {
    const rows = parseCsv(idxCsv);
    // Keep any file matches already made; only the catalogue is replaced.
    const existing = await db.query.contractDocs.findMany();
    const seen = new Map(existing.filter((d) => d.fileName).map((d) => [`${d.pbmName}|${d.documentName}`, d]));
    await db.delete(schema.contractDocs);
    const docRows: (typeof schema.contractDocs.$inferInsert)[] = [];
    for (const r of rows) {
      const pbm = canonical((r.pbm || "").trim());
      const name = (r.document_name || "").trim();
      if (!name) continue;
      const prev = seen.get(`${pbm}|${name}`);
      docRows.push({
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
    for (let i = 0; i < docRows.length; i += 300) await db.insert(schema.contractDocs).values(docRows.slice(i, i + 300));
  } else out.skipped.push("contract_index.csv");

  // ── Network rates ────────────────────────────────────────────────
  const ratesCsv = await readReference(["network_participation", "network_rates"]);
  if (ratesCsv) {
    await db.delete(schema.networkRates);
    const rateRows: (typeof schema.networkRates.$inferInsert)[] = [];
    for (const r of parseCsv(ratesCsv)) {
      const label = (r.pbm || "").trim();
      if (!label) continue;
      rateRows.push({
        id: newId(),
        pbmName: canonical(label),
        sourceLabel: label,
        lineOfBusiness: clean(r.line_of_business) ?? "(unstated)",
        network: clean(r.network) ?? "(unstated)",
        effectiveDate: clean(r.effective_date),
        status: clean(r.status),
        daysSupply: clean(r.days_supply),
        brandRate: clean(r.brand_rate),
        genericRate: clean(r.generic_rate),
        berGuardrail: clean(r.ber_guardrail),
        gerGuardrail: clean(r.ger_guardrail),
        notes: clean(r.notes),
        sourceUrl: clean(r.source_url),
      });
      out.rates++;
    }
    for (let i = 0; i < rateRows.length; i += 300) await db.insert(schema.networkRates).values(rateRows.slice(i, i + 300));
  } else out.skipped.push("network_participation.csv");

  // ── MAC appeal terms ─────────────────────────────────────────────
  const macCsv = await readReference(["mac_appeals"]);
  if (macCsv) {
    await db.delete(schema.macAppealTerms);
    const macRows: (typeof schema.macAppealTerms.$inferInsert)[] = [];
    for (const r of parseCsv(macCsv)) {
      const label = (r.pbm || "").trim();
      if (!label) continue;
      macRows.push({
        id: newId(),
        pbmName: canonical(label),
        sourceLabel: label,
        submissionChannel: clean(r.submission_channel),
        submissionTarget: clean(r.submission_target),
        appealWindowDays: int(r.appeal_window_days),
        windowBasis: clean(r.window_basis),
        requiredFields: clean(r.required_fields),
        invoiceRequired: clean(r.invoice_required),
        responseSlaDays: int(r.response_sla_days),
        adjustmentRetroactive: clean(r.adjustment_retroactive),
        escalationContact: clean(r.escalation_contact),
        notes: clean(r.notes),
        sourceUrl: clean(r.source_url),
      });
      out.appeals++;
    }
    for (let i = 0; i < macRows.length; i += 300) await db.insert(schema.macAppealTerms).values(macRows.slice(i, i + 300));
  } else out.skipped.push("mac_appeals.csv");

  // ── Payment routing ──────────────────────────────────────────────
  const payCsv = await readReference(["payment_routing"]);
  if (payCsv) {
    await db.delete(schema.paymentRouting);
    const payRows: (typeof schema.paymentRouting.$inferInsert)[] = [];
    for (const r of parseCsv(payCsv)) {
      const label = (r.pbm || "").trim();
      if (!label) continue;
      payRows.push({
        id: newId(),
        pbmName: canonical(label),
        sourceLabel: label,
        paysVia: clean(r.pays_via),
        paymentMethod: clean(r.payment_method),
        remittanceSource: clean(r.remittance_source),
        paymentCycle: clean(r.payment_cycle),
        onContractListing: clean(r.pbm_on_contract_listing),
        notes: clean(r.notes),
        sourceUrl: clean(r.source_url),
      });
      out.routing++;
    }
    for (let i = 0; i < payRows.length; i += 300) await db.insert(schema.paymentRouting).values(payRows.slice(i, i + 300));
  } else out.skipped.push("payment_routing.csv");

  // ── Contacts ─────────────────────────────────────────────────────
  const contactCsv = await readReference(["pbm_contacts"]);
  if (contactCsv) {
    await db.delete(schema.pbmContacts);
    const contactRows: (typeof schema.pbmContacts.$inferInsert)[] = [];
    for (const r of parseCsv(contactCsv)) {
      const label = (r.pbm || "").trim();
      if (!label) continue;
      contactRows.push({
        id: newId(),
        pbmName: canonical(label),
        sourceLabel: label,
        contactType: clean(r.contact_type) ?? "other",
        phone: clean(r.phone),
        email: clean(r.email),
        portalUrl: clean(r.portal_url),
        notes: clean(r.notes),
        sourceUrl: clean(r.source_url),
      });
      out.contacts++;
    }
    for (let i = 0; i < contactRows.length; i += 300) await db.insert(schema.pbmContacts).values(contactRows.slice(i, i + 300));
  } else out.skipped.push("pbm_contacts.csv");

  // ── Communications feed ──────────────────────────────────────────
  const commsCsv = await readReference(["communications_index"]);
  if (commsCsv) {
    await db.delete(schema.pbmCommunications);
    const commRows: (typeof schema.pbmCommunications.$inferInsert)[] = [];
    for (const r of parseCsv(commsCsv)) {
      const date = clean(r.published_date);
      const subject = clean(r.subject);
      if (!date || !subject) continue;
      const label = (r.pbm || "").trim();
      commRows.push({
        id: newId(),
        pbmName: label ? canonical(label) : null,
        sourceLabel: label || null,
        publishedDate: date,
        subject,
        type: clean(r.type),
        url: clean(r.url),
        sourceUrl: clean(r.source_url),
      });
      out.communications++;
    }
    for (let i = 0; i < commRows.length; i += 300) await db.insert(schema.pbmCommunications).values(commRows.slice(i, i + 300));
  } else out.skipped.push("communications_index.csv");

  out.unresolvedPbms = resolver.unresolved();
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

export async function referenceCounts() {
  const n = sql<number>`count(*)`;
  const [bins, docs, rates, appeals, routing, contacts, communications, nadac] = await Promise.all([
    db.select({ n }).from(schema.payerBins),
    db.select({ n }).from(schema.contractDocs),
    db.select({ n }).from(schema.networkRates),
    db.select({ n }).from(schema.macAppealTerms),
    db.select({ n }).from(schema.paymentRouting),
    db.select({ n }).from(schema.pbmContacts),
    db.select({ n }).from(schema.pbmCommunications),
    db.select({ n }).from(schema.nadacPrices),
  ].map((q) => q.then((r) => r[0].n)));
  return { bins, docs, rates, appeals, routing, contacts, communications, nadac };
}

/**
 * Every PBM we hold anything about, with what we hold on each.
 *
 * Driven off the union of all six tables rather than the BIN listing alone, because a payer can
 * appear in the network tables without a BIN row (Express Scripts is exactly that case) and
 * dropping it from the list would hide the gap instead of showing it.
 */
export async function pbmDirectory() {
  const [bins, rates, appeals, routing, contacts, docs] = await Promise.all([
    db.query.payerBins.findMany(),
    db.query.networkRates.findMany(),
    db.query.macAppealTerms.findMany(),
    db.query.paymentRouting.findMany(),
    db.query.pbmContacts.findMany(),
    db.query.contractDocs.findMany(),
  ]);
  type Row = {
    pbmName: string;
    bins: string[];
    rates: number;
    appeals: number;
    hasRouting: boolean;
    contacts: number;
    docsKnown: number;
    docsHere: number;
  };
  const map = new Map<string, Row>();
  const at = (name: string): Row => {
    let r = map.get(name);
    if (!r) {
      r = { pbmName: name, bins: [], rates: 0, appeals: 0, hasRouting: false, contacts: 0, docsKnown: 0, docsHere: 0 };
      map.set(name, r);
    }
    return r;
  };
  for (const b of bins) if (!at(b.pbmName).bins.includes(b.bin)) at(b.pbmName).bins.push(b.bin);
  for (const r of rates) at(r.pbmName).rates++;
  for (const a of appeals) at(a.pbmName).appeals++;
  for (const p of routing) at(p.pbmName).hasRouting = true;
  for (const c of contacts) at(c.pbmName).contacts++;
  for (const d of docs) {
    const row = at(d.pbmName);
    row.docsKnown++;
    if (d.fileName) row.docsHere++;
  }
  for (const r of map.values()) r.bins.sort();
  return [...map.values()].sort((a, b) => b.bins.length - a.bins.length || a.pbmName.localeCompare(b.pbmName));
}

/** Everything known about one PBM, for the payer detail page. */
export async function pbmProfile(pbmName: string) {
  const eqName = <T extends { pbmName: unknown }>(t: T) => eq(t.pbmName as never, pbmName);
  const [bins, rates, appeals, routing, contacts, docs, communications] = await Promise.all([
    db.query.payerBins.findMany({ where: (t) => eqName(t), orderBy: (t, { asc }) => [asc(t.bin)] }),
    db.query.networkRates.findMany({ where: (t) => eqName(t), orderBy: (t, { asc }) => [asc(t.lineOfBusiness), asc(t.network)] }),
    db.query.macAppealTerms.findMany({ where: (t) => eqName(t) }),
    db.query.paymentRouting.findMany({ where: (t) => eqName(t) }),
    db.query.pbmContacts.findMany({ where: (t) => eqName(t), orderBy: (t, { asc }) => [asc(t.contactType)] }),
    db.query.contractDocs.findMany({ where: (t) => eqName(t), orderBy: (t, { asc }) => [asc(t.documentName)] }),
    db.query.pbmCommunications.findMany({ where: (t) => eqName(t), orderBy: (t, { desc }) => [desc(t.publishedDate)], limit: 25 }),
  ]);
  return { pbmName, bins, rates, appeals, routing, contacts, docs, communications };
}

/**
 * Resolves a BIN — and optionally a PCN — the way a claim has to be resolved.
 *
 * A BIN alone is not always enough: sixty of them appear under more than one PBM. When that
 * happens this returns every candidate rather than picking one, because guessing here attaches
 * a claim to the wrong contract and every figure downstream inherits the error.
 */
export async function lookupBin(bin: string) {
  const b = bin.replace(/\D/g, "");
  if (!b) return { bin: b, candidates: [], ambiguous: false };
  const rows = await db.query.payerBins.findMany({ where: (t) => eq(t.bin, b), orderBy: (t, { asc }) => [asc(t.pbmName)] });
  const names = [...new Set(rows.map((r) => r.pbmName))];
  return { bin: b, candidates: rows, ambiguous: names.length > 1, pbmNames: names };
}
