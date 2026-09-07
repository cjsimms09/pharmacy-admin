import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId, sha256 } from "./crypto";
import { contractsDir, pbmResolver } from "./reference";
import { parseTerms, estimateCost, pdfPageCount, pdfPageLimit } from "./contract-extract";
import { shouldRead } from "./contract-triage";
import { rates as aiRates } from "./ai-spend";
import { proposeFromContract, type Proposals, type Existing, type PlanForMatch } from "./contract-apply";
import { savePayerLink, applyLinksToClaims } from "./payer-links";
import { counterpartyFile, clocksDue, type Clock } from "./contract-file";
import { todayIso } from "./dates";
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
  /** When that error was recorded, so a stored failure never reads as a live one. */
  failedAt: string | null;
  pages: number | null;
  /** Over the one-request page limit: must be split before it can be read. */
  tooLong: boolean;
  /** What the sort made of it, or null while unsorted; `sorting` while the model's answer is awaited. */
  triage: string | null;
  triageWhy: string | null;
  triageBy: string | null;
  sorting: boolean;
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
  /** Every document with a file, read or not, and what reading all of them again would cost. */
  withFile: number;
  allPages: number;
  estimateAll: { low: number; high: number };
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


export async function contractLibrary(): Promise<Library> {
  const [files, docs, s, r] = await Promise.all([pdfFiles(), db.query.contractDocs.findMany({ orderBy: (t, { asc }) => [asc(t.pbmName), asc(t.documentName)] }), getSettings(), aiRates()]);
  const attached = new Set(docs.map((d) => d.fileName).filter(Boolean) as string[]);
  const model = s.ai_model || MODEL_DEFAULT;
  let pendingPages = 0;
  let allPages = 0;
  let withFile = 0;
  const rows: LibraryDoc[] = [];
  for (const d of docs) {
    const terms = d.extractionState === "done" ? parseTerms(d.extractionJson) : null;
    let pages: number | null = d.pages ?? null;
    if (d.fileName) {
      withFile++;
      // Counted once and kept on the row; the folder is not opened to draw a list.
      if (pages === null) {
        try {
          pages = pdfPageCount(await fs.readFile(path.join(contractsDir(), d.fileName)));
          await db.update(schema.contractDocs).set({ pages }).where(eq(schema.contractDocs.id, d.id));
        } catch { /* counted as nothing */ }
      }
      allPages += pages ?? 0;
      // What a read would cost counts only what a read would send: the sort's rejects are out.
      if (d.extractionState !== "done" && d.extractionState !== "queued" && shouldRead(d.triage as never)) pendingPages += pages ?? 0;
    }
    rows.push({
      id: d.id, documentName: d.documentName, pbmName: d.pbmName, fileName: d.fileName, matchedBy: d.matchedBy,
      state: d.extractionState, error: d.extractionError, failedAt: d.extractionFailedAt,
      // Judged against the model that would read it, not against the sort's smaller limit.
      pages, tooLong: (pages ?? 0) > pdfPageLimit(model),
      triage: d.triage, triageWhy: d.triageWhy, triageBy: d.triageBy, sorting: Boolean(d.triageBatch),
      counterparty: terms?.counterparty ?? null, role: terms?.documentRole ?? null, rates: terms?.rates.length ?? 0,
      confidence: terms?.confidence ?? null, caveats: terms?.unclearOrMissing.length ?? 0,
    });
  }
  const pending = rows.filter((r) => r.fileName && r.state !== "done" && r.state !== "queued" && shouldRead(r.triage as never)).length;
  return {
    filesInFolder: files.length,
    unattached: files.filter((f) => !attached.has(f)),
    docs: rows,
    pending,
    pendingPages,
    estimate: estimateCost(pendingPages, model, r),
    withFile,
    allPages,
    estimateAll: estimateCost(allPages, model, r),
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
    let pages: number | null = null;
    try { pages = pdfPageCount(buf); } catch { /* not a PDF the counter can read; the read will say so */ }
    await db.insert(schema.contractDocs).values({
      id: newId(),
      pbmName: m?.pbm ?? "Unnamed",
      documentName: m?.name ?? f.replace(/\.pdf$/i, ""),
      fileName: f,
      sizeBytes: buf.length,
      sha256: sha256(buf),
      matchedBy: "manual",
      pages,
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

/**
 * Every document with a file back to unread: the one big run, on the whole library, after the
 * schema has been widened. The earlier drafts are not kept — the new read carries everything the
 * old one did and more — but the accepted rows on the payer pages stand until replaced.
 */
export async function resetAll(): Promise<number> {
  const docs = await db.query.contractDocs.findMany({ columns: { id: true, fileName: true, extractionState: true } });
  let n = 0;
  for (const d of docs) {
    if (!d.fileName || d.extractionState === "queued") continue;
    await db.update(schema.contractDocs).set({ extractionState: "none", extractionError: null }).where(eq(schema.contractDocs.id, d.id));
    n++;
  }
  return n;
}

/** Put a failed or done document back to unread, so the next run reads it again. */
export async function resetDocument(id: string): Promise<void> {
  await db.update(schema.contractDocs).set({ extractionState: "none", extractionError: null }).where(eq(schema.contractDocs.id, id));
}

/** The pharmacy's plans as the claims know them, with the PCN, for matching a document's identifiers. */
export async function plansForMatching(): Promise<PlanForMatch[]> {
  const rows = await db.query.claims.findMany({ columns: { bin: true, pcn: true, groupNumber: true, networkId: true, payerLabel: true, status: true, cashPlan: true } });
  const by = new Map<string, PlanForMatch & { networkIds: string[] }>();
  for (const c of rows) {
    if (c.cashPlan || !c.bin) continue;
    const k = `${c.bin}|${c.pcn ?? ""}|${c.groupNumber ?? ""}`;
    const p = by.get(k) ?? { id: k, bin: c.bin, pcn: c.pcn ?? null, groupNumber: c.groupNumber ?? null, payerLabel: c.payerLabel, claims: 0, networkIds: [] };
    if (c.status !== "reversed") p.claims++;
    if (c.networkId && !p.networkIds.includes(c.networkId)) p.networkIds.push(c.networkId);
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

/** The counterparty as the payer pages name it: the crosswalk's canonical name where one resolves, else as written. */
export async function canonicalCounterparty(name: string): Promise<string> {
  const r = (await pbmResolver()).resolve(name);
  return r.via === "unresolved" ? name.trim() : r.name;
}

export async function proposalsFor(docId: string): Promise<{ doc: typeof schema.contractDocs.$inferSelect; proposals: Proposals } | null> {
  const doc = await db.query.contractDocs.findFirst({ where: eq(schema.contractDocs.id, docId) });
  if (!doc) return null;
  const terms = parseTerms(doc.extractionJson);
  if (!terms) return null;
  const pbmName = await canonicalCounterparty(doc.pbmName !== "Unnamed" ? doc.pbmName : terms.counterparty);
  const [plans, existing, s, text] = await Promise.all([
    plansForMatching(),
    existingFor(pbmName, doc.id),
    getSettings(),
    // Only the PDF's own words can check a quote; the text a read left behind is the quotes themselves.
    doc.fileName ? db.query.contractText.findFirst({ where: eq(schema.contractText.fileName, doc.fileName), columns: { body: true, source: true } }) : Promise.resolve(null),
  ]);
  const pharmacy = { chainCode: s.pharmacy_chain_code || null, ncpdp: s.pharmacy_ncpdp || null, npi: s.pharmacy_npi || null };
  return { doc, proposals: proposeFromContract(terms, doc.documentName, plans, existing, { pbmName, pharmacy, text: text && text.source !== "read" ? text.body : null }) };
}

export type ApplyAllResult = {
  documents: number;
  named: number;
  rates: number;
  appeals: number;
  contacts: number;
  routing: number;
  links: number;
  claims: number;
  /** Documents with plan links a person still has to decide, because another document prints the same BIN. */
  decisions: { docId: string; documentName: string; contested: number; why?: string }[];
  /** Documents read correctly that do not govern this pharmacy (another chain code, another NCPDP); nothing from them is applied. */
  notOurs: { docId: string; documentName: string; why: string }[];
  /** Rates held back because their quote was not found in the document's own text. */
  unverified: number;
};

/**
 * Everything certain from every read document, applied in one pass.
 *
 * Certain means: a rate with the contract's sentence behind it; the appeal terms, contacts and
 * payment path as read; a plan link the document alone can claim (a BIN and PCN, a network id, or
 * a BIN no other document prints). A BIN printed in two documents is the one decision left to a
 * person, and it is listed rather than guessed. An unnamed document is named from what it read,
 * in the payer pages' own spelling.
 */
export async function applyAllReads(user: { name: string }): Promise<ApplyAllResult> {
  const out: ApplyAllResult = { documents: 0, named: 0, rates: 0, appeals: 0, contacts: 0, routing: 0, links: 0, claims: 0, decisions: [], notOurs: [], unverified: 0 };
  const docs = await db.query.contractDocs.findMany({ where: eq(schema.contractDocs.extractionState, "done") });
  for (const doc of docs) {
    const terms = parseTerms(doc.extractionJson);
    if (!terms) continue;
    const readName = terms.counterparty.trim();
    if (doc.pbmName === "Unnamed" && readName && !/^unnamed$/i.test(readName)) {
      await nameDocument(doc.id, await canonicalCounterparty(readName));
      out.named++;
    }
    const got = await proposalsFor(doc.id);
    if (!got) continue;
    const p = got.proposals;
    /*
     * A document that names another chain code or another NCPDP is somebody else's contract: read
     * correctly, applied never. One whose governing is unknown (the pharmacy's own code not in
     * Settings) is a decision, not a fact, and is listed for a person like a contested BIN.
     */
    if (p.governs.ok === false) {
      out.notOurs.push({ docId: doc.id, documentName: doc.documentName, why: p.governs.why ?? "" });
      continue;
    }
    if (p.governs.ok === null) {
      out.decisions.push({ docId: doc.id, documentName: doc.documentName, contested: 0, why: p.governs.why ?? "" });
      continue;
    }
    const certainRates = p.rates.map((r, i) => (r.quoteFound === false ? -1 : i)).filter((i) => i >= 0);
    out.unverified += p.rates.length - certainRates.length;
    const certainPlans = p.plans.map((m, i) => (m.contested.length === 0 ? i : -1)).filter((i) => i >= 0);
    const r = await acceptProposals(doc.id, {
      rates: certainRates,
      appeal: Boolean(p.appeal),
      contacts: p.contacts.map((_, i) => i),
      routing: Boolean(p.routing),
      plans: certainPlans,
    }, user);
    out.documents++;
    out.rates += r.rates; out.appeals += r.appeal ? 1 : 0; out.contacts += r.contacts; out.routing += r.routing ? 1 : 0; out.links += r.links; out.claims += r.claims;
    const contested = p.plans.length - certainPlans.length;
    const held = p.rates.length - certainRates.length;
    if (contested > 0 || held > 0) {
      out.decisions.push({
        docId: doc.id,
        documentName: doc.documentName,
        contested,
        why: [contested ? `${contested} plan link${contested === 1 ? "" : "s"} contested by another document` : null, held ? `${held} rate${held === 1 ? "" : "s"} whose quote was not found in the document's text` : null].filter(Boolean).join("; "),
      });
    }
  }
  return out;
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
    const values = { ...r.row, sourceLabel: source, status: "active", notes: [r.row.notes, r.quote && `“${r.quote}”`].filter(Boolean).join(" ") || null, sourceUrl: null };
    if (prior) await db.update(schema.networkRates).set(values).where(eq(schema.networkRates.id, prior.id));
    else await db.insert(schema.networkRates).values({ id: newId(), ...values });
    out.rates++;
  }
  /*
   * What this document replaces stops pricing claims. The names are the document's own for what
   * it supersedes; a rate row whose source carries that name is marked, never deleted, so the
   * old figure is still there to read and never used for a claim filled after the new one began.
   */
  if (picks.rates.length > 0) {
    const terms = parseTerms(doc.extractionJson);
    for (const name of terms?.supersedes ?? []) {
      const key = name.trim().toLowerCase();
      if (key.length < 6) continue;
      const rows = await db.query.networkRates.findMany({ where: eq(schema.networkRates.pbmName, p.pbmName) });
      for (const row of rows) {
        if (row.sourceLabel && row.sourceLabel !== source && (row.sourceLabel.toLowerCase().includes(key) || key.includes(row.sourceLabel.toLowerCase()))) {
          await db.update(schema.networkRates).set({ status: "superseded" }).where(eq(schema.networkRates.id, row.id));
        }
      }
    }
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

export type DueClock = Clock & { pbmName: string; href: string };

/**
 * Every dated contract clock that falls within a window of days from today, across every
 * counterparty: the notice to terminate or not renew, computed from the end date and the notice
 * period the document states. Today raises these with the licences and the duties, because a
 * renewal window missed is a rate accepted for another year, and nobody reads a contract's
 * signature page on the right morning without being told which morning it is.
 */
export async function contractClocksDue(withinDays = 90): Promise<DueClock[]> {
  const docs = await db.query.contractDocs.findMany({ where: eq(schema.contractDocs.extractionState, "done") });
  const byPbm = new Map<string, typeof docs>();
  for (const d of docs) byPbm.set(d.pbmName, [...(byPbm.get(d.pbmName) ?? []), d]);
  const today = todayIso();
  const out: DueClock[] = [];
  for (const [pbmName, rows] of byPbm) {
    const file = counterpartyFile(pbmName, rows.map((d) => ({ id: d.id, name: d.documentName, terms: parseTerms(d.extractionJson), state: d.extractionState, fileName: d.fileName, pages: d.pages ?? null })));
    for (const c of clocksDue(file, today, withinDays)) out.push({ ...c, pbmName, href: `/payers/${encodeURIComponent(pbmName)}#clocks` });
  }
  return out.sort((a, b) => (a.on ?? "").localeCompare(b.on ?? ""));
}
