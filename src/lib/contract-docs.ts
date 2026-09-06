import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId, sha256 } from "./crypto";
import { contractsDir } from "./reference";
import { parseTerms, estimateCost } from "./contract-extract";
import { proposeFromContract, type Proposals, type Existing, type PlanForMatch } from "./contract-apply";
import { savePayerLink, applyLinksToClaims } from "./payer-links";
import { getSettings } from "./settings";

/**
 * The contract library as a whole: what is in the folder, what the site knows about each file,
 * what a read would cost, and the step after the draft — proposals accepted into the tables.
 *
 * A PDF the catalogue never listed used to sit in the folder unmatched and unread. Here it becomes
 * a document of its own, named from the manifest where the portal wrote one and from its filename
 * where not, so nothing in the folder is invisible to the read.
 */

const MODEL_DEFAULT = "claude-opus-5";

export type LibraryDoc = {
  id: string;
  documentName: string;
  pbmName: string;
  fileName: string | null;
  matchedBy: string | null;
  state: "none" | "queued" | "done" | "failed";
  error: string | null;
  counterparty: string | null;
  role: string | null;
  rates: number;
  confidence: number | null;
  caveats: number;
};

export type Library = {
  filesInFolder: number;
  unattached: string[];
  docs: LibraryDoc[];
  pending: number;
  pendingPages: number;
  estimate: { low: number; high: number };
  model: string;
  keyPresent: boolean;
  folder: string;
};

async function pdfFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(contractsDir())).filter((e) => e.toLowerCase().endsWith(".pdf")).sort();
  } catch {
    return [];
  }
}

function pageCount(buf: Buffer): number {
  return Math.max(1, (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length);
}

export async function contractLibrary(): Promise<Library> {
  const [files, docs, s] = await Promise.all([pdfFiles(), db.query.contractDocs.findMany({ orderBy: (t, { asc }) => [asc(t.pbmName), asc(t.documentName)] }), getSettings()]);
  const attached = new Set(docs.map((d) => d.fileName).filter(Boolean) as string[]);
  const model = s.ai_model || MODEL_DEFAULT;
  let pendingPages = 0;
  const rows: LibraryDoc[] = [];
  for (const d of docs) {
    const terms = d.extractionState === "done" ? parseTerms(d.extractionJson) : null;
    if (d.fileName && d.extractionState !== "done" && d.extractionState !== "queued") {
      try { pendingPages += pageCount(await fs.readFile(path.join(contractsDir(), d.fileName))); } catch { /* counted as nothing */ }
    }
    rows.push({
      id: d.id, documentName: d.documentName, pbmName: d.pbmName, fileName: d.fileName, matchedBy: d.matchedBy,
      state: d.extractionState, error: d.extractionError,
      counterparty: terms?.counterparty ?? null, role: terms?.documentRole ?? null, rates: terms?.rates.length ?? 0,
      confidence: terms?.confidence ?? null, caveats: terms?.unclearOrMissing.length ?? 0,
    });
  }
  const pending = rows.filter((r) => r.fileName && r.state !== "done" && r.state !== "queued").length;
  return {
    filesInFolder: files.length,
    unattached: files.filter((f) => !attached.has(f)),
    docs: rows,
    pending,
    pendingPages,
    estimate: estimateCost(pendingPages, model),
    model,
    keyPresent: Boolean(s.anthropic_api_key_enc),
    folder: contractsDir(),
  };
}

/**
 * Every PDF in the folder that no document claims becomes a document, named from the manifest
 * where there is one and from the file where there is not. The counterparty is "Unnamed" until
 * the read says who it is or a person does; either way the file is now visible.
 */
export async function adoptUnattached(): Promise<{ added: number; named: number }> {
  const dir = contractsDir();
  const files = await pdfFiles();
  const docs = await db.query.contractDocs.findMany();
  const attached = new Set(docs.map((d) => d.fileName).filter(Boolean) as string[]);
  const manifest = new Map<string, { name: string; pbm: string | null }>();
  for (const m of ["download_manifest.csv", "manifest.csv"]) {
    try {
      const text = await fs.readFile(path.join(dir, m), "utf8");
      const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
      const cols = head.split(",").map((c) => c.trim().toLowerCase());
      const ix = (k: string[]) => cols.findIndex((c) => k.includes(c));
      const fi = ix(["saved_filename", "file_name", "filename"]);
      const ni = ix(["document_name", "name", "title"]);
      const pi = ix(["pbm_name", "pbm", "counterparty", "payer"]);
      for (const l of lines) {
        const cells = l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        if (fi >= 0 && cells[fi]) manifest.set(cells[fi], { name: (ni >= 0 && cells[ni]) || cells[fi], pbm: pi >= 0 ? cells[pi] || null : null });
      }
      break;
    } catch { /* no manifest by that name */ }
  }
  let added = 0;
  let named = 0;
  for (const f of files) {
    if (attached.has(f)) continue;
    const buf = await fs.readFile(path.join(dir, f));
    const m = manifest.get(f);
    await db.insert(schema.contractDocs).values({
      id: newId(),
      pbmName: m?.pbm ?? "Unnamed",
      documentName: m?.name ?? f.replace(/\.pdf$/i, ""),
      fileName: f,
      sizeBytes: buf.length,
      sha256: sha256(buf),
      matchedBy: "manual",
    });
    added++;
    if (m?.pbm) named++;
  }
  return { added, named };
}

/** Rename a document's counterparty by hand: the first axis, before the read where possible. */
export async function nameDocument(id: string, pbmName: string, documentName?: string): Promise<void> {
  const values: Partial<typeof schema.contractDocs.$inferInsert> = { pbmName: pbmName.trim() || "Unnamed" };
  if (documentName?.trim()) values.documentName = documentName.trim();
  await db.update(schema.contractDocs).set(values).where(eq(schema.contractDocs.id, id));
}

/** Put a failed or done document back to unread, so the next run reads it again. */
export async function resetDocument(id: string): Promise<void> {
  await db.update(schema.contractDocs).set({ extractionState: "none", extractionError: null }).where(eq(schema.contractDocs.id, id));
}

/** The pharmacy's plans as the claims know them, with the PCN, for matching a document's identifiers. */
export async function plansForMatching(): Promise<PlanForMatch[]> {
  const rows = await db.query.claims.findMany({ columns: { bin: true, pcn: true, groupNumber: true, payerLabel: true, status: true, cashPlan: true } });
  const by = new Map<string, PlanForMatch>();
  for (const c of rows) {
    if (c.cashPlan || !c.bin) continue;
    const k = `${c.bin}|${c.pcn ?? ""}|${c.groupNumber ?? ""}`;
    const p = by.get(k) ?? { id: k, bin: c.bin, pcn: c.pcn ?? null, groupNumber: c.groupNumber ?? null, payerLabel: c.payerLabel, claims: 0 };
    if (c.status !== "reversed") p.claims++;
    by.set(k, p);
  }
  return [...by.values()].sort((a, b) => b.claims - a.claims);
}

/** What the tables already hold for this counterparty, and every other document's BINs. */
export async function existingFor(pbmName: string, exceptDocId: string): Promise<Existing> {
  const [rates, appeal, contacts, routing, docs] = await Promise.all([
    db.query.networkRates.findMany(),
    db.query.macAppealTerms.findFirst({ where: eq(schema.macAppealTerms.pbmName, pbmName) }),
    db.query.pbmContacts.findMany({ where: eq(schema.pbmContacts.pbmName, pbmName) }),
    db.query.paymentRouting.findFirst({ where: eq(schema.paymentRouting.pbmName, pbmName) }),
    db.query.contractDocs.findMany({ where: and(eq(schema.contractDocs.extractionState, "done")) }),
  ]);
  return {
    rates: rates.map((r) => ({ pbmName: r.pbmName, lineOfBusiness: r.lineOfBusiness, network: r.network, daysSupply: r.daysSupply, brandRate: r.brandRate, genericRate: r.genericRate })),
    appeal: appeal ? { pbmName: appeal.pbmName, submissionChannel: appeal.submissionChannel, submissionTarget: appeal.submissionTarget, appealWindowDays: appeal.appealWindowDays, windowBasis: appeal.windowBasis } : null,
    contacts: contacts.map((c) => ({ pbmName: c.pbmName, contactType: c.contactType, phone: c.phone, email: c.email, portalUrl: c.portalUrl })),
    routing: routing ? { pbmName: routing.pbmName, paysVia: routing.paysVia, paymentMethod: routing.paymentMethod, remittanceSource: routing.remittanceSource, paymentCycle: routing.paymentCycle } : null,
    otherDocuments: docs.filter((d) => d.id !== exceptDocId).map((d) => ({ name: d.documentName, bins: parseTerms(d.extractionJson)?.bins ?? [] })),
  };
}

export async function proposalsFor(docId: string): Promise<{ doc: typeof schema.contractDocs.$inferSelect; proposals: Proposals } | null> {
  const doc = await db.query.contractDocs.findFirst({ where: eq(schema.contractDocs.id, docId) });
  if (!doc) return null;
  const terms = parseTerms(doc.extractionJson);
  if (!terms) return null;
  const [plans, existing] = await Promise.all([plansForMatching(), existingFor(terms.counterparty, doc.id)]);
  return { doc, proposals: proposeFromContract(terms, doc.documentName, plans, existing) };
}

export type Picks = { rates: number[]; appeal: boolean; contacts: number[]; routing: boolean; plans: number[] };

/**
 * Writes the accepted proposals. Each row carries the document as its source and the quote in its
 * notes, so a figure on a payer page can always be traced to the sentence it came from. A rate
 * row for the same PBM, network, line and days-supply is replaced, never duplicated; the appeal
 * terms and payment path are one row per PBM; contacts are one per purpose.
 */
export async function acceptProposals(docId: string, picks: Picks, user: { name: string }): Promise<{ rates: number; appeal: boolean; contacts: number; routing: boolean; links: number; claims: number }> {
  const got = await proposalsFor(docId);
  if (!got) throw new Error("That document has no draft to accept.");
  const { doc, proposals: p } = got;
  const source = doc.documentName;
  const out = { rates: 0, appeal: false, contacts: 0, routing: false, links: 0, claims: 0 };

  for (const i of picks.rates) {
    const r = p.rates[i];
    if (!r) continue;
    const prior = await db.query.networkRates.findFirst({
      where: and(eq(schema.networkRates.pbmName, r.row.pbmName), eq(schema.networkRates.network, r.row.network), eq(schema.networkRates.lineOfBusiness, r.row.lineOfBusiness), r.row.daysSupply === null ? isNull(schema.networkRates.daysSupply) : eq(schema.networkRates.daysSupply, r.row.daysSupply)),
    });
    const values = { ...r.row, sourceLabel: source, notes: [r.row.notes, r.quote && `“${r.quote}”`].filter(Boolean).join(" ") || null, sourceUrl: null };
    if (prior) await db.update(schema.networkRates).set(values).where(eq(schema.networkRates.id, prior.id));
    else await db.insert(schema.networkRates).values({ id: newId(), ...values });
    out.rates++;
  }

  if (picks.appeal && p.appeal) {
    const a = p.appeal.row;
    const values = { ...a, sourceLabel: source, notes: p.appeal.quote ? `“${p.appeal.quote}”` : null, sourceUrl: null };
    const prior = await db.query.macAppealTerms.findFirst({ where: eq(schema.macAppealTerms.pbmName, a.pbmName) });
    if (prior) await db.update(schema.macAppealTerms).set(values).where(eq(schema.macAppealTerms.id, prior.id));
    else await db.insert(schema.macAppealTerms).values({ id: newId(), ...values });
    out.appeal = true;
  }

  for (const i of picks.contacts) {
    const c = p.contacts[i];
    if (!c) continue;
    const values = { ...c.row, sourceLabel: source, sourceUrl: null };
    const prior = await db.query.pbmContacts.findFirst({ where: and(eq(schema.pbmContacts.pbmName, c.row.pbmName), eq(schema.pbmContacts.contactType, c.row.contactType)) });
    if (prior) await db.update(schema.pbmContacts).set(values).where(eq(schema.pbmContacts.id, prior.id));
    else await db.insert(schema.pbmContacts).values({ id: newId(), ...values });
    out.contacts++;
  }

  if (picks.routing && p.routing) {
    const r = p.routing.row;
    const values = { ...r, sourceLabel: source, onContractListing: null, sourceUrl: null };
    const prior = await db.query.paymentRouting.findFirst({ where: eq(schema.paymentRouting.pbmName, r.pbmName) });
    if (prior) await db.update(schema.paymentRouting).set(values).where(eq(schema.paymentRouting.id, prior.id));
    else await db.insert(schema.paymentRouting).values({ id: newId(), ...values });
    out.routing = true;
  }

  for (const i of picks.plans) {
    const m = p.plans[i];
    if (!m) continue;
    await savePayerLink(
      { bin: m.proposedLink.bin, pcn: m.proposedLink.pcn, groupNumber: m.proposedLink.groupNumber, contractId: null },
      { pbmName: m.proposedLink.pbmName, contractDocId: doc.id, contractFileName: doc.fileName, basis: m.proposedLink.basis },
      user,
    );
    out.links++;
  }
  if (out.links > 0) out.claims = (await applyLinksToClaims()).claims;
  return out;
}
