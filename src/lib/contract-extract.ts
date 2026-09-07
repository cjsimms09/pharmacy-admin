import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { contractsDir } from "./reference";
import { ContractTerms, ContractTermsWire, EXTRACT_SYSTEM, shapeForPrompt, requireCitations, fillNulls, fromWire, termsFromObject, termsFromAnswer, type ContractTermsT } from "./contract-terms";

/**
 * Reading the contract library.
 *
 * Every document is one request. They are sent through the Batch API because nothing here is
 * urgent and batch is half price — the whole library runs while the pharmacy is closed. The
 * system prompt and schema are identical across every document, so they are cached and paid for
 * once rather than several hundred times.
 *
 * Nothing an extraction produces is treated as fact. It lands as a draft the PIC reviews with the
 * supporting quote beside each figure, because these numbers end up in appeals.
 */

const MOCK = process.env.AI_MOCK === "1";

async function client(): Promise<{ client: Anthropic; model: string }> {
  const { getSettings } = await import("./settings");
  const { decryptText } = await import("./crypto");
  const s = await getSettings();
  if (!s.anthropic_api_key_enc) throw new Error("Add your Anthropic API key under Settings → Claude first.");
  return {
    client: new Anthropic({ apiKey: decryptText(s.anthropic_api_key_enc), maxRetries: 2, timeout: 15 * 60 * 1000 }),
    model: s.ai_model || "claude-opus-5",
  };
}

import { estimateCost, pdfPageCount, planBatches, batchIdsIn, pdfPageLimit, PDF_PAGE_LIMIT, PDF_BYTES_LIMIT, UPLOAD_BYTES_LIMIT, BATCH_REQUEST_LIMIT } from "./contract-run";
import { Triage, TRIAGE_SYSTEM, triageByText, shouldRead, estimateTriageCost, type TriageT } from "./contract-triage";
import { pdfText } from "./pdf-text";
import { checkProving, PROVING_TITLE, type ProvingCheck } from "./contract-proving";
import { quoteInText } from "./contract-apply";
export { estimateCost, pdfPageCount, planBatches, pdfPageLimit, PDF_PAGE_LIMIT, PDF_PAGE_LIMIT_LONG, PDF_PAGE_LIMIT_SHORT, PDF_BYTES_LIMIT, BATCH_BYTES_LIMIT, BATCH_REQUEST_LIMIT } from "./contract-run";

/*
 * The answer is held to a grammar built from the schema (structured outputs). That was refused
 * for a night — "too many parameters with union types (104 …, limit: 16)" — because every term a
 * contract might not state was `.nullable()`, a union each. The base branch's fix is the one in
 * force: those fields are `.optional()` on the wire (no union) and `fillNulls` makes them null on
 * this side, so the grammar is back and the shape is guaranteed. The answer is still parsed through
 * `termsFromAnswer`, which also accepts an object wrapped in a fence, so a read made without the
 * grammar (the proving read, an older batch) parses the same way.
 */
function docRequest(id: string, pdf: Buffer, name: string, model: string): Anthropic.Messages.Batches.BatchCreateParams.Request {
  return {
    custom_id: id,
    params: {
      model,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      /*
       * No output grammar: this schema is too large to compile into one, and it is too large
       * because a contract really does carry this many terms. The shape is in the system prompt
       * and the answer is validated against the same schema on the way in. See contract-terms.
       */
      output_config: { effort: "high" },
      // Cached: identical on every document in the run, so it is billed once.
      system: [
        {
          type: "text",
          text: `${EXTRACT_SYSTEM}\n\n## The shape of your answer\n\nReply with one JSON object and nothing else — no explanation before it, no code fence around it. Every field below is required; give "" where the document does not state something, and "not stated" where a field offers it. Numbers are written as text.\n\n${shapeForPrompt()}`,
          // Identical on every document in the run, so the shape is billed once rather than per read.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
            { type: "text", text: `File name: ${name}\n\nExtract this contract's terms.` },
          ],
        },
      ],
    },
  };
}


export type QueueResult = { queued: number; batchId: string | null; batches: string[]; skipped: string[]; estimate: { low: number; high: number } };

/**
 * Sends every contract that has a file and no extraction yet.
 *
 * The batch id is stored on each document so a run can be picked up later — the pharmacy computer
 * may well be switched off before the results come back, and that must not lose the work.
 */
export async function queueExtraction(userId: string, userName: string, onlyIds?: string[]): Promise<QueueResult> {
  const all = await db.query.contractDocs.findMany();
  // A document the sort ruled out is not read unless it is asked for by name.
  const pending = all.filter(
    (d) => d.fileName && d.extractionState !== "done" && d.extractionState !== "queued" && (onlyIds ? onlyIds.includes(d.id) : shouldRead(d.triage as never)),
  );
  const skipped: string[] = [];
  if (pending.length === 0) return { queued: 0, batchId: null, batches: [], skipped: ["nothing to do — every document with a file is already read"], estimate: { low: 0, high: 0 } };

  if (MOCK) {
    for (const d of pending) {
      const terms = mockTerms(d.documentName, d.pbmName);
      await db.update(schema.contractDocs).set({ extractionState: "done", extractionJson: JSON.stringify(terms) }).where(eq(schema.contractDocs.id, d.id));
      if (d.fileName) await (await import("./contract-search")).rememberReadText(d.fileName, terms);
    }
    return { queued: pending.length, batchId: "mock", batches: ["mock"], skipped, estimate: { low: 0, high: 0 } };
  }

  const { client: c, model } = await client();
  const { rates, monthlyCap, dollars } = await import("./ai-spend");
  const r = await rates();

  /*
   * Sized first, opened later.
   *
   * The run used to read every PDF into memory and base64 it before the first batch went out — a
   * folder of three hundred and fifty scans is most of a gigabyte held at once on a computer that
   * is also running the dispensing system. Now each document is sized from the file system, the
   * batches are planned on those sizes, and a batch's files are opened only when that batch is
   * built, then let go. Each batch is kept under forty megabytes so one upload from the pharmacy's
   * connection finishes in minutes, and the documents in it are marked queued the moment it is
   * accepted, so a run cut off halfway loses nothing that was sent.
   */
  const sized: { doc: (typeof pending)[number]; bytes: number; pages: number }[] = [];
  let pages = 0;
  for (const d of pending) {
    try {
      const file = path.join(contractsDir(), d.fileName!);
      const size = (await fs.stat(file)).size;
      let n = d.pages ?? null;
      if (n === null) {
        n = pdfPageCount(await fs.readFile(file));
        await db.update(schema.contractDocs).set({ pages: n }).where(eq(schema.contractDocs.id, d.id));
      }
      // The limit belongs to the model this is going to, not to the site; see pdfPageLimit.
      const limit = pdfPageLimit(model);
      if (n > limit) {
        skipped.push(`${d.documentName} (${n} pages; the limit is ${limit} a document on ${model} — split it into parts and put the parts in the folder)`);
        continue;
      }
      if (size > PDF_BYTES_LIMIT) {
        skipped.push(`${d.documentName} (${Math.round(size / 1024 / 1024)} MB; the limit is 32 MB — re-save it smaller)`);
        continue;
      }
      pages += n;
      sized.push({ doc: d, bytes: Math.ceil((size * 4) / 3), pages: n });
    } catch {
      skipped.push(`${d.documentName} (the file could not be read)`);
    }
  }
  if (sized.length === 0) return { queued: 0, batchId: null, batches: [], skipped, estimate: { low: 0, high: 0 } };

  /*
   * The ceiling, before anything is sent.
   *
   * Every other model call passes through `ai.ts`, where the ceiling lives; this one goes to the
   * Batch API directly, so it asks the same question itself. A run that would carry the month past
   * the ceiling is refused with the figures, not started and cut off halfway.
   */
  const estimate = estimateCost(pages, model, r);
  const cap = await monthlyCap();
  if (cap.cap !== null && cap.spent + estimate.high > cap.cap) {
    throw new Error(
      `This run could cost up to ${dollars(estimate.high)}, and the month has ${dollars(cap.left)} left under the ceiling of ${dollars(cap.cap)}. Raise the ceiling under Settings → Claude, or read fewer documents.`,
    );
  }

  const batches: string[] = [];
  let queued = 0;
  for (const group of planBatches(sized.map((x) => ({ item: x, bytes: x.bytes })), { bytes: UPLOAD_BYTES_LIMIT, count: BATCH_REQUEST_LIMIT })) {
    const requests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = [];
    for (const x of group) {
      try {
        requests.push(docRequest(x.doc.id, await fs.readFile(path.join(contractsDir(), x.doc.fileName!)), x.doc.documentName, model));
      } catch {
        skipped.push(`${x.doc.documentName} (the file could not be read)`);
      }
    }
    if (requests.length === 0) continue;
    const batch = await c.messages.batches.create({ requests });
    batches.push(batch.id);
    queued += requests.length;
    await db
      .update(schema.contractDocs)
      .set({ extractionState: "queued", extractionError: batch.id })
      .where(inArray(schema.contractDocs.id, requests.map((g) => g.custom_id)));
  }
  await audit({ action: "contracts.extract.queued", userId, userName, details: `${queued} document(s), ${pages} pages, ${batches.length} batch(es): ${batches.join(", ")}; estimate ${dollars(estimate.low)}–${dollars(estimate.high)}` });
  return { queued, batchId: batches[0] ?? null, batches, skipped, estimate };
}

export type CollectResult = { done: number; failed: number; stillRunning: number; rejected: { doc: string; why: string }[] };

/** Picks up finished batches. Safe to call repeatedly; results arrive in any order. */
export async function collectExtraction(userId: string, userName: string): Promise<CollectResult> {
  const res: CollectResult = { done: 0, failed: 0, stillRunning: 0, rejected: [] };
  const queued = await db.query.contractDocs.findMany({ where: eq(schema.contractDocs.extractionState, "queued") });
  const batches = [...new Set(queued.map((d) => d.extractionError).filter((b): b is string => Boolean(b)))];
  if (batches.length === 0) return res;
  const { client: c } = await client();
  let tokensIn = 0;
  let tokensOut = 0;

  for (const batchId of batches) {
    const batch = await c.messages.batches.retrieve(batchId);
    if (batch.processing_status !== "ended") {
      res.stillRunning += queued.filter((d) => d.extractionError === batchId).length;
      continue;
    }
    for await (const entry of await c.messages.batches.results(batchId)) {
      const doc = queued.find((d) => d.id === entry.custom_id);
      if (!doc) continue;
      const a = await absorb(doc, entry);
      tokensIn += a.tokensIn;
      tokensOut += a.tokensOut;
      if (a.outcome === "done") res.done++;
      else {
        res.failed++;
        if (a.outcome === "rejected") res.rejected.push({ doc: doc.documentName, why: a.why });
      }
    }
  }
  // Written the way every other model call writes it, so the spend page counts this run.
  await audit({ action: "contracts.extract.collected", userId, userName, details: `${res.done} read, ${res.failed} failed, ${res.rejected.length} rejected for missing citations · tokens in=${tokensIn} out=${tokensOut}` });
  return res;
}

type Absorbed = { outcome: "done" | "failed" | "rejected"; why: string; tokensIn: number; tokensOut: number };

/**
 * One batch result, landed on its document.
 *
 * Kept as a draft when the answer parses and every money figure carries its sentence; otherwise
 * refused with the reason written on the document, so the page can say it and a person can act.
 * The collect step and the recovery step both come through here, so a result is judged the same
 * way whether it was picked up on time or fetched back weeks later.
 */
async function absorb(
  doc: { id: string; documentName: string; fileName: string | null; pbmName: string | null; matchedBy: string | null },
  entry: Anthropic.Messages.Batches.MessageBatchIndividualResponse,
): Promise<Absorbed> {
  if (entry.result.type !== "succeeded") {
    const why = explainFailure(entry.result);
    await fail(doc.id, why);
    return { outcome: "failed", why, tokensIn: 0, tokensOut: 0 };
  }
  const msg = entry.result.message;
  const tokensIn = msg.usage?.input_tokens ?? 0;
  const tokensOut = msg.usage?.output_tokens ?? 0;
  // An answer cut off at the token limit is not a bad read; it is a document too long for one answer.
  if (msg.stop_reason === "max_tokens") {
    const why = "The answer ran past the length limit before it finished. Split the document into parts and read the parts.";
    await fail(doc.id, why);
    return { outcome: "failed", why, tokensIn, tokensOut };
  }
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  let terms: ContractTermsT;
  try {
    terms = fillNulls(ContractTerms, fromWire(ContractTerms, ContractTermsWire.parse(JSON.parse(jsonIn(text))))) as ContractTermsT;
  } catch {
    const why = "The answer did not match the expected shape. Try this one again.";
    await fail(doc.id, why);
    return { outcome: "failed", why, tokensIn, tokensOut };
  }
  // A figure without the contract's words behind it does not get stored.
  const missing = requireCitations(terms);
  if (missing.length > 0) {
    const why = `No supporting quote for ${missing.map((m) => m.field).join(", ")}`;
    await fail(doc.id, `${why}. Nothing was saved — a rate that cannot be traced to a sentence is not usable in an appeal.`);
    return { outcome: "rejected", why, tokensIn, tokensOut };
  }
  /*
   * The contract names its own counterparty, so the read is what ties the document to a payer.
   *
   * Until now it did not: the terms were stored with the counterparty inside them and the document
   * row kept whatever the file name had suggested, or nothing. A contract read and filed under no
   * payer cannot be found from the payer's page, which is the one place anybody looks for it.
   *
   * It is the most reliable of the four ways: a file name is a guess and a manifest is somebody
   * else's list, where this is the agreement stating who it is with. It does not overrule a person
   * — a document matched by hand keeps that.
   */
  const named = (terms.counterparty ?? "").trim();
  const linkToPayer =
    named && doc.matchedBy !== "manual" && (!doc.pbmName || doc.matchedBy === "filename" || doc.matchedBy === "unmatched")
      ? { pbmName: await knownPayerName(named), matchedBy: "read" as const }
      : {};
  await db
    .update(schema.contractDocs)
    .set({ extractionState: "done", extractionJson: JSON.stringify(terms), extractionError: null, ...linkToPayer })
    .where(eq(schema.contractDocs.id, doc.id));
  // A scan has no words of its own to search; the read's cited lines become them.
  if (doc.fileName) await (await import("./contract-search")).rememberReadText(doc.fileName, terms);
  return { outcome: "done", why: "", tokensIn, tokensOut };
}

export type Recovery = { batches: number; gone: number; stillRunning: number; recovered: number; explained: { doc: string; reason: string }[]; note: string };

/**
 * The reason for every read that was refused before the reason was kept.
 *
 * The first live runs came back "errored" and the code of the day threw the API's message away and
 * wrote that one word over the batch id. The audit line written when each run was queued still
 * names its batches, and the API holds a batch's results for 29 days. So this reads those ids back,
 * asks for the results, and lands each one on its document exactly as collect would have: a refusal
 * gets its reason in words that say what to do; a read that succeeded but was never collected is
 * kept as a draft. Nothing is sent to the model, so nothing is charged.
 */
export async function recoverFailures(userId: string, userName: string): Promise<Recovery> {
  const out: Recovery = { batches: 0, gone: 0, stillRunning: 0, recovered: 0, explained: [], note: "" };
  const events = await db.query.auditEvents.findMany({
    where: eq(schema.auditEvents.action, "contracts.extract.queued"),
    orderBy: (t, { desc }) => [desc(t.at)],
    limit: 60,
  });
  const ids = batchIdsIn(events.map((e) => e.details));
  if (ids.length === 0) {
    out.note = "No read has been queued from this site, so there is no batch to ask about.";
    return out;
  }
  if (MOCK) {
    out.note = `Mock: ${ids.length} batch id(s) found, nothing asked.`;
    return out;
  }
  const docs = await db.query.contractDocs.findMany({ columns: { id: true, documentName: true, fileName: true, extractionState: true, pbmName: true, matchedBy: true } });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const { client: c } = await client();
  for (const batchId of ids) {
    let batch: Anthropic.Messages.Batches.MessageBatch;
    try {
      batch = await c.messages.batches.retrieve(batchId);
    } catch (e) {
      if (e instanceof Anthropic.NotFoundError) {
        out.gone++;
        continue;
      }
      throw e;
    }
    out.batches++;
    if (batch.processing_status !== "ended") {
      out.stillRunning++;
      continue;
    }
    let results: Awaited<ReturnType<typeof c.messages.batches.results>>;
    try {
      results = await c.messages.batches.results(batchId);
    } catch {
      // Ended, but its results are past the 29 days the API keeps them.
      out.gone++;
      continue;
    }
    for await (const entry of results) {
      const doc = byId.get(entry.custom_id);
      // The newest batch is asked first, so the first verdict seen for a document is its latest.
      if (!doc || seen.has(doc.id) || doc.extractionState === "done" || doc.extractionState === "queued") continue;
      seen.add(doc.id);
      const a = await absorb(doc, entry);
      if (a.outcome === "done") out.recovered++;
      else out.explained.push({ doc: doc.documentName, reason: a.why });
    }
  }
  await audit({
    action: "contracts.extract.recovered",
    userId,
    userName,
    details: `${out.batches} batch(es) asked, ${out.gone} no longer held, ${out.stillRunning} still running, ${out.recovered} read(s) recovered, ${out.explained.length} refusal(s) explained`,
  });
  return out;
}

/**
 * Why the API refused a document, in words that say what to do next.
 *
 * "errored" on its own sent the owner back to the page with nothing to act on. The API's own
 * message names the cause almost every time — a document too long for the model's window, a file
 * that is not a PDF at all, a key that no longer works — and each of those has one fix.
 */
export function explainFailure(result: { type: string; error?: { error?: { type?: string; message?: string } } }): string {
  if (result.type === "expired") return "The batch expired before it was collected (results are kept for 24 hours). Press \"Read again\" on this one.";
  if (result.type === "canceled") return "The batch was cancelled. Press \"Read again\" on this one.";
  const err = result.error?.error;
  const msg = (err?.message ?? "").trim();
  const kind = err?.type ?? "unknown";
  const low = msg.toLowerCase();
  if (/too long|too many tokens|exceeds? .*context|maximum context|prompt is too long/.test(low)) {
    // No model is named at this point, so the cautious figure is quoted; see pdfPageLimit.
    return `Too long for one read: the model's window cannot hold every page as an image (${msg}). Split the PDF into parts of ${PDF_PAGE_LIMIT} pages or fewer and put the parts in the folder.`;
  }
  if (/could not process (the )?(pdf|document|image)|invalid.*(pdf|document)|not a valid|corrupt|unsupported/.test(low)) {
    return `The file could not be read as a PDF (${msg}). Open it and re-save it as a PDF, or replace it.`;
  }
  if (/too many parameters with union types/.test(low)) {
    return `The answer's schema was too complex for the API's grammar compiler (${msg}). This is the site's request, not the document; update the site and read again.`;
  }
  if (kind === "authentication_error" || kind === "permission_error") return `The Claude key was refused (${msg}). Check it under Settings → Connections.`;
  if (kind === "billing_error") return `Claude's billing refused the request (${msg}). Check the account's credit.`;
  if (kind === "rate_limit_error" || kind === "overloaded_error") return `Claude was busy (${msg}). Nothing was charged; press \"Read again\" later.`;
  return `Claude could not read this one (${kind}${msg ? `: ${msg}` : ""}). Nothing was charged for a refused request.`;
}

/**
 * The JSON out of an answer that may have dressed it up.
 *
 * Without a grammar the model writes the object itself, and it occasionally arrives inside a code
 * fence or after a line of preamble. Refusing a read over punctuation would waste a paid batch, so
 * the object is taken from the first brace to the last.
 */
export function jsonIn(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/**
 * The payer's name as this site already spells it, where it knows the payer at all.
 *
 * A contract signed with "CVS Caremark" and a BIN register that says "Caremark" are one payer, and
 * storing both forks every screen that groups by name. The register wins where it recognises the
 * name; where it does not, the contract's own wording stands rather than being forced into
 * something close.
 */
async function knownPayerName(counterparty: string): Promise<string> {
  const want = counterparty.trim().toLowerCase();
  const bins = await db.query.payerBins.findMany({ columns: { pbmName: true } });
  const names = [...new Set(bins.map((b) => b.pbmName).filter(Boolean))];
  const exact = names.find((n) => n.trim().toLowerCase() === want);
  if (exact) return exact;
  // One name containing the other — "Caremark" inside "CVS Caremark" — is the same payer.
  const contained = names.find((n) => {
    const a = n.trim().toLowerCase();
    return a.length >= 4 && (a.includes(want) || want.includes(a));
  });
  return contained ?? counterparty.trim();
}

async function fail(id: string, why: string) {
  // Stamped, so the message can never be read as the API refusing again; see the column's note.
  await db
    .update(schema.contractDocs)
    .set({ extractionState: "failed", extractionError: why, extractionFailedAt: new Date().toISOString() })
    .where(eq(schema.contractDocs.id, id));
}

/**
 * Drops every null, at any depth, so a draft read before the schema stopped using them still opens.
 *
 * An optional field and a null field say the same thing — the contract does not state it — but
 * `.optional()` rejects an explicit null, and every draft already stored is full of them. Throwing
 * those reads away to satisfy a schema change would be the site losing work the pharmacy paid for.
 * An empty array is not a null and is left alone: "no transaction fees" is an answer.
 */

export function parseTerms(json: string | null): ContractTermsT | null {
  if (!json) return null;
  try {
    return termsFromObject(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function mockTerms(name: string, pbm: string): ContractTermsT {
  const cite = { quote: "Generic drugs shall be reimbursed at the lesser of MAC plus the dispensing fee.", page: 4, section: "Exhibit B" };
  return {
    counterparty: pbm,
    documentTitle: name,
    contractType: "payer_network",
    documentRole: "exhibit",
    parentAgreement: null,
    amendmentNumber: null,
    supersedes: [],
    bins: ["610455"],
    pcns: ["MOCKPCN"],
    groupIds: [],
    chainCodes: ["605", "630"],
    networkNames: ["Mock Commercial Broad"],
    networkReimbursementIds: ["MOCKNET1"],
    pharmacyNcpdps: [],
    pharmacyNpis: [],
    linesOfBusiness: ["Commercial"],
    effectiveDate: "2025-01-01",
    endDate: null,
    autoRenews: true,
    agreementNumber: null,
    terminationRights: { value: null, citation: null },
    allProductsClause: { value: null, citation: null },
    noticesOwedByPharmacy: [],
    terminationNoticeDays: 90,
    amendmentNoticeDays: 30,
    rates: [
      {
        pbmVendor: "CVS/Caremark",
        network: "Mock Commercial Broad",
        costSharingTier: "standard" as const, bins: [], pcns: [], groupIds: [], lineOfBusiness: null,
        daysSupplyMin: 1,
        daysSupplyMax: 34,
        brandFormula: "AWP - 15.0%",
        brandDispensingFee: 1.25,
        genericBasis: "MAC",
        genericDispensingFee: 1.25,
        specialtyTerms: null,
        compoundTerms: null,
        vaccineTerms: null,
        effectiveFrom: "2025-01-01",
        effectiveTo: null,
        citation: cite,
      },
    ],
    effectiveRateGuarantees: [],
    postPointOfSaleDiscounts: [],
    disputeWindows: [],
    reportsOwed: [],
    incorporatesByReference: [],
    definitionsDelegatedTo: null,
    usualAndCustomaryDefinition: null,
    dirFeeBasis: { value: null, citation: null },
    dirMeasurementPeriod: null,
    macAppealWindowDays: { value: 14, citation: { quote: "Appeals must be submitted within fourteen (14) days of adjudication.", page: 9, section: "7.3" } },
    macAppealWindowBasis: "date_of_adjudication",
    macAppealMethod: { value: "Provider portal", citation: cite },
    macAppealResponseDays: 7,
    claimSubmissionWindowDays: 90,
    reversalWindowDays: 14,
    transactionFees: [{ name: "Claim processing fee", amount: "$0.10 per claim", appliesTo: "all claims", citation: cite }],
    pricingCompendium: { value: "Medi-Span AWP as of the date of service", citation: cite },
    macListAccess: { value: "Published on the provider portal, updated weekly", citation: cite },
    performanceMeasures: [{ measure: "Generic dispensing rate", threshold: "85%", effect: "DIR tier 1 below, tier 2 above", period: "quarterly", citation: cite }],
    dawRules: { value: null, citation: null },
    promptPayDays: 30,
    latePaymentInterest: null,
    recoupmentTerms: { value: "Offsets against future remittances after 30 days' notice", citation: cite },
    keyDefinitions: [{ term: "Generic", definition: "A drug product with a multi-source indicator of Y in the pricing compendium.", citation: cite }],
    sections: [{ title: "Exhibit B — Reimbursement", pageFrom: 4, pageTo: 6, gist: "The rate schedule by network and days supply." }],
    macAppealRequiredFields: ["claim number", "NDC", "date of service", "invoice"],
    macAppealInvoiceRequired: true,
    macAppealSubmissionTarget: "https://portal.example.invalid/mac-appeals",
    contacts: [{ purpose: "mac_appeals", name: "MAC Appeals Desk", organisation: pbm, phone: null, fax: null, email: "macappeals@example.invalid", portalUrl: "https://portal.example.invalid/mac-appeals", postalAddress: null, citation: cite }],
    remittance: { payerNamesOnRemittance: [], payerIdentifiers: [], paidBy: pbm, paymentMethod: "EFT", paymentCycle: "twice monthly", eraOffered: true, enrollmentMethod: "Provider portal, EFT/ERA enrollment form", remittanceContact: "providerpayments@example.invalid", citation: cite },
    macAppealRetroactive: true,
    auditLookbackYears: 2,
    auditExtrapolationAllowed: false,
    gcrTiers: [],
    gcrDefinition: { value: null, citation: null },
    primarySupplierRequirementPercent: null,
    rebatePaymentTerms: null,
    unclearOrMissing: ["Mock mode — no document was read."],
    confidence: 0.9,
  };
}


// ── The sort before the read ─────────────────────────────────────────────────

/** The small model the sort runs on. Reads a PDF the same way; answers in a sentence. */
export const TRIAGE_MODEL = "claude-haiku-4-5-20251001";

export type TriageQueue = { sortedByText: number; sentToModel: number; batches: string[]; skipped: string[]; estimate: number; alreadySorted: number; /** Scans not sent this press; press again for them. */ scansLeft: number };
/** How many scans one press of Sort sends to the model. Enough to be worth a batch; few enough that the press answers in a minute or two. */
export const SCANS_A_PRESS = 40;

/**
 * Sorts every unsorted document: by its own text where it has one, by the small model where not.
 *
 * Nothing is paid for a document with a text layer. A scan is sent to the small model in a batch
 * with the one-line question, and the whole folder of scans costs about what three full reads
 * would. The ceiling is checked first, like every other model call.
 */
export async function queueTriage(userId: string, userName: string): Promise<TriageQueue> {
  const all = await db.query.contractDocs.findMany();
  const out: TriageQueue = { sortedByText: 0, sentToModel: 0, batches: [], skipped: [], estimate: 0, alreadySorted: 0, scansLeft: 0 };
  /*
   * Text first, for nothing; then the scans, a few dozen a press.
   *
   * Every PDF with a text layer is sorted by its words here, however many there are. The scans go
   * to the model, and each press sends at most SCANS_A_PRESS of them: a press that base64-encodes
   * a hundred scans and uploads them all before it answers looks, from the chair, like a button
   * that hangs. The page says how many are left, and the next press sends the next few dozen.
   */
  const toModel: { id: string; name: string; file: string; bytes: number; pages: number }[] = [];
  let pages = 0;
  let scansLeft = 0;
  for (const d of all) {
    if (!d.fileName || d.extractionState === "done") continue;
    if (d.triage || d.triageBatch) {
      out.alreadySorted++;
      continue;
    }
    const file = path.join(contractsDir(), d.fileName);
    let buf: Buffer;
    try {
      buf = await fs.readFile(file);
    } catch {
      out.skipped.push(`${d.documentName} (the file could not be read)`);
      continue;
    }
    let text = "";
    try {
      text = pdfText(buf);
    } catch {
      text = "";
    }
    const byText = triageByText(text, d.fileName);
    if (byText) {
      await db.update(schema.contractDocs).set({ triage: byText.kind, triageWhy: byText.why, triageBy: "rule" }).where(eq(schema.contractDocs.id, d.id));
      out.sortedByText++;
      continue;
    }
    if (MOCK) {
      const mock: TriageT = { kind: /w-?9|newsletter|statement/i.test(d.fileName) ? "not_relevant" : "contract", counterparty: d.pbmName, why: "Mock sort.", confidence: 0.9 };
      await db.update(schema.contractDocs).set({ triage: mock.kind, triageWhy: mock.why, triageBy: "model" }).where(eq(schema.contractDocs.id, d.id));
      out.sentToModel++;
      continue;
    }
    let n = d.pages ?? null;
    if (n === null) {
      n = pdfPageCount(buf);
      await db.update(schema.contractDocs).set({ pages: n }).where(eq(schema.contractDocs.id, d.id));
    }
    /*
     * The sort runs on Haiku 4.5, whose window is two hundred thousand tokens — not the million the
     * reader has. Its limit is therefore the smaller one, and it must not follow the reader's: a
     * 150-page agreement sent here would be refused by the API at 100 pages and by the model again
     * at 450,000 tokens, inside a batch already created and paid for.
     */
    const triageLimit = pdfPageLimit(TRIAGE_MODEL);
    if (n > triageLimit || buf.length > PDF_BYTES_LIMIT) {
      // Too long to sort; marked unsure so it is not forgotten, and the read judges it on its own limit.
      await db.update(schema.contractDocs).set({ triage: "unsure", triageWhy: `Too long to sort by model (${n} pages, and the sort takes ${triageLimit}); it can still be read.`, triageBy: "rule" }).where(eq(schema.contractDocs.id, d.id));
      out.skipped.push(`${d.documentName} (${n} pages; too long to sort, but it can still be read)`);
      continue;
    }
    if (toModel.length >= SCANS_A_PRESS) {
      scansLeft++;
      continue;
    }
    pages += n;
    toModel.push({ id: d.id, name: d.fileName, file, bytes: Math.ceil((buf.length * 4) / 3), pages: n });
  }
  out.scansLeft = scansLeft;
  if (toModel.length === 0) return out;

  out.estimate = estimateTriageCost(pages);
  const { monthlyCap, dollars } = await import("./ai-spend");
  const cap = await monthlyCap();
  if (cap.cap !== null && cap.spent + out.estimate > cap.cap) {
    throw new Error(`Sorting the scans could cost up to ${dollars(out.estimate)}, and the month has ${dollars(cap.left)} left under the ceiling of ${dollars(cap.cap)}.`);
  }
  const { client: c } = await client();
  for (const group of planBatches(toModel.map((x) => ({ item: x, bytes: x.bytes })), { bytes: UPLOAD_BYTES_LIMIT, count: BATCH_REQUEST_LIMIT })) {
    const requests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = [];
    for (const g of group) {
      let buf: Buffer;
      try {
        buf = await fs.readFile(g.file);
      } catch {
        out.skipped.push(`${g.name} (the file could not be read)`);
        continue;
      }
      requests.push({
        custom_id: g.id,
        params: {
          model: TRIAGE_MODEL,
          max_tokens: 400,
          output_config: { format: zodOutputFormat(Triage) },
          system: [{ type: "text", text: TRIAGE_SYSTEM, cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
                { type: "text", text: `File name: ${g.name}\n\nWhat kind of document is this?` },
              ],
            },
          ],
        },
      });
    }
    if (requests.length === 0) continue;
    const batch = await c.messages.batches.create({ requests });
    out.batches.push(batch.id);
    await db.update(schema.contractDocs).set({ triageBatch: batch.id }).where(inArray(schema.contractDocs.id, requests.map((g) => g.custom_id)));
    out.sentToModel += requests.length;
  }
  await audit({ action: "contracts.triage.queued", userId, userName, details: `${out.sortedByText} sorted by text, ${out.sentToModel} scan(s) sent to ${TRIAGE_MODEL} in ${out.batches.length} batch(es), ${pages} pages; estimate ${dollars(out.estimate)}` });
  return out;
}

export type TriageCollect = { sorted: number; failed: number; stillRunning: number; notRelevant: number };

/** Picks up the model's sorts. Safe to call repeatedly. */
export async function collectTriage(userId: string, userName: string): Promise<TriageCollect> {
  const res: TriageCollect = { sorted: 0, failed: 0, stillRunning: 0, notRelevant: 0 };
  const waiting = await db.query.contractDocs.findMany();
  const pending = waiting.filter((d) => d.triageBatch);
  const batches = [...new Set(pending.map((d) => d.triageBatch!))];
  if (batches.length === 0) return res;
  const { client: c } = await client();
  let tokensIn = 0;
  let tokensOut = 0;
  for (const batchId of batches) {
    const batch = await c.messages.batches.retrieve(batchId);
    if (batch.processing_status !== "ended") {
      res.stillRunning += pending.filter((d) => d.triageBatch === batchId).length;
      continue;
    }
    for await (const entry of await c.messages.batches.results(batchId)) {
      const doc = pending.find((d) => d.id === entry.custom_id);
      if (!doc) continue;
      if (entry.result.type !== "succeeded") {
        // A refused sort is not a refused read: the document goes to the full read as unsure.
        await db.update(schema.contractDocs).set({ triage: "unsure", triageWhy: explainFailure(entry.result), triageBy: "model", triageBatch: null }).where(eq(schema.contractDocs.id, doc.id));
        res.failed++;
        continue;
      }
      const msg = entry.result.message;
      tokensIn += msg.usage?.input_tokens ?? 0;
      tokensOut += msg.usage?.output_tokens ?? 0;
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      let t: TriageT;
      try {
        t = Triage.parse(JSON.parse(text));
      } catch {
        await db.update(schema.contractDocs).set({ triage: "unsure", triageWhy: "The sort's answer did not match the expected shape.", triageBy: "model", triageBatch: null }).where(eq(schema.contractDocs.id, doc.id));
        res.failed++;
        continue;
      }
      // A confident "not relevant" is the only verdict that changes what is read; a hesitant one is read anyway.
      const kind = t.kind === "not_relevant" && t.confidence < 0.7 ? "unsure" : t.kind;
      await db
        .update(schema.contractDocs)
        .set({ triage: kind, triageWhy: t.why + (t.counterparty ? ` (${t.counterparty})` : ""), triageBy: "model", triageBatch: null, ...(doc.pbmName === "Unnamed" && t.counterparty ? { pbmName: t.counterparty } : {}) })
        .where(eq(schema.contractDocs.id, doc.id));
      res.sorted++;
      if (kind === "not_relevant") res.notRelevant++;
    }
  }
  await audit({ action: "contracts.triage.collected", userId, userName, details: `${res.sorted} sorted, ${res.failed} unsure after a refused sort, ${res.notRelevant} ruled out · tokens in=${tokensIn} out=${tokensOut}` });
  return res;
}

/** A person's word on a document beats the sort's. */
export async function setTriage(id: string, kind: TriageT["kind"], by: string): Promise<void> {
  await db.update(schema.contractDocs).set({ triage: kind, triageWhy: `Decided by ${by}.`, triageBy: by, triageBatch: null }).where(eq(schema.contractDocs.id, id));
}


// ── Read one now, and say exactly why not ─────────────────────────────────────

export type ReaderTest =
  | { ok: true; documentName: string; seconds: number; tokensIn: number; tokensOut: number; counterparty: string; rates: number; stored: boolean; note: string }
  | { ok: false; documentName: string; reason: string; detail: string };

/**
 * Reads one document straight away, outside the batch, and returns either its terms or the API's
 * exact refusal.
 *
 * The batch takes minutes to hours and, when it refuses, the reason comes back late. This is the
 * same request sent synchronously so a person watching the page gets the answer in a minute. A
 * successful read is kept like any other; a refused one costs nothing and names its cause.
 */
export async function testReader(docId: string, userId: string, userName: string): Promise<ReaderTest> {
  const doc = await db.query.contractDocs.findFirst({ where: eq(schema.contractDocs.id, docId) });
  if (!doc || !doc.fileName) return { ok: false, documentName: doc?.documentName ?? docId, reason: "No file", detail: "This document has no PDF in the folder." };
  if (MOCK) {
    const terms = mockTerms(doc.documentName, doc.pbmName);
    await db.update(schema.contractDocs).set({ extractionState: "done", extractionJson: JSON.stringify(terms), extractionError: null }).where(eq(schema.contractDocs.id, doc.id));
    return { ok: true, documentName: doc.documentName, seconds: 0, tokensIn: 0, tokensOut: 0, counterparty: terms.counterparty, rates: terms.rates.length, stored: true, note: "Mock read." };
  }
  const buf = await fs.readFile(path.join(contractsDir(), doc.fileName));
  const n = pdfPageCount(buf);
  const { client: c, model } = await client();
  const limit = pdfPageLimit(model);
  if (n > limit) return { ok: false, documentName: doc.documentName, reason: "Too long for one read", detail: `${n} pages; the limit is ${limit} on ${model}. Split it.` };
  const req = docRequest(doc.id, buf, doc.documentName, model);
  const t0 = Date.now();
  try {
    const msg = await c.messages.create(req.params);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const tokensIn = msg.usage?.input_tokens ?? 0;
    const tokensOut = msg.usage?.output_tokens ?? 0;
    await audit({ action: "contracts.extract.test", userId, userName, entity: "contract_doc", entityId: doc.id, details: `${doc.documentName} read synchronously on ${model} · tokens in=${tokensIn} out=${tokensOut}` });
    if (msg.stop_reason === "max_tokens") return { ok: false, documentName: doc.documentName, reason: "The answer ran past the length limit", detail: "Split the document into parts and read the parts." };
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    let terms: ContractTermsT;
    try {
      terms = fillNulls(ContractTerms, fromWire(ContractTerms, ContractTermsWire.parse(JSON.parse(jsonIn(text))))) as ContractTermsT;
    } catch (e) {
      return { ok: false, documentName: doc.documentName, reason: "The answer did not match the expected shape", detail: `${e instanceof Error ? e.message.slice(0, 300) : String(e)} · first words: ${text.slice(0, 200)}` };
    }
    const missing = requireCitations(terms);
    if (missing.length > 0) {
      await fail(doc.id, `No supporting quote for ${missing.map((m) => m.field).join(", ")}. Nothing was saved.`);
      return { ok: true, documentName: doc.documentName, seconds, tokensIn, tokensOut, counterparty: terms.counterparty, rates: terms.rates.length, stored: false, note: `The read worked but ${missing.length} figure(s) came without the contract's words behind them, so nothing was saved. The request shape is fine; try "Read again".` };
    }
    await db.update(schema.contractDocs).set({ extractionState: "done", extractionJson: JSON.stringify(terms), extractionError: null }).where(eq(schema.contractDocs.id, doc.id));
    await (await import("./contract-search")).rememberReadText(doc.fileName, terms);
    return { ok: true, documentName: doc.documentName, seconds, tokensIn, tokensOut, counterparty: terms.counterparty, rates: terms.rates.length, stored: true, note: "Kept, like any batch read." };
  } catch (e) {
    const err = e as { status?: number; type?: string | null; message?: string; error?: { error?: { type?: string; message?: string } } };
    const inner = err.error?.error;
    const kind = inner?.type ?? err.type ?? "unknown";
    const message = inner?.message ?? err.message ?? String(e);
    const explained = explainFailure({ type: "errored", error: { error: { type: kind, message } } });
    await audit({ action: "contracts.extract.test", userId, userName, entity: "contract_doc", entityId: doc.id, details: `${doc.documentName} refused on ${model}: ${kind}${err.status ? ` (${err.status})` : ""}: ${message.slice(0, 300)}` });
    return { ok: false, documentName: doc.documentName, reason: explained, detail: `${model} · ${kind}${err.status ? ` · HTTP ${err.status}` : ""} · ${message}` };
  }
}

export type ProvingResult = { ok: boolean; passed: number; of: number; checks: ProvingCheck[]; seconds: number; tokensIn: number; tokensOut: number; refusal: string | null };

/**
 * The reader, proved on the site's own document.
 *
 * The proving agreement (`fixtures/contracts/proving-agreement.pdf`, written by the site from
 * `contract-proving.ts`) is sent through the exact request the batch uses, and the answer is
 * marked against what the document is known to say: the identifiers, both rate lines with their
 * fees, the guarantee kept out of the rates, the fee taken back, the appeal window, the payment
 * path, the dispute clock, and that every quote is in the text. A pass is the reader working
 * today, on this key, with this prompt and this model; a fail names which part of the read to
 * look at before a real document is paid for.
 */
export async function proveReader(userId: string, userName: string): Promise<ProvingResult> {
  const file = path.join(process.cwd(), "fixtures", "contracts", "proving-agreement.pdf");
  const buf = await fs.readFile(file);
  if (MOCK) {
    const checks = checkProving(mockTerms(PROVING_TITLE, "Proving Benefit Managers"), quoteInText);
    return { ok: false, passed: checks.filter((c) => c.ok).length, of: checks.length, checks, seconds: 0, tokensIn: 0, tokensOut: 0, refusal: "Mock: the mock terms are not the proving document's, so most checks fail by design." };
  }
  const { client: c, model } = await client();
  const req = docRequest("proving", buf, "proving-agreement.pdf", model);
  const t0 = Date.now();
  let msg: Anthropic.Message;
  try {
    msg = await c.messages.create(req.params);
  } catch (e) {
    const err = e as { error?: { error?: { type?: string; message?: string } }; message?: string };
    return { ok: false, passed: 0, of: 0, checks: [], seconds: Math.round((Date.now() - t0) / 1000), tokensIn: 0, tokensOut: 0, refusal: explainFailure({ type: "errored", error: { error: err.error?.error ?? { type: "unknown", message: err.message } } }) };
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const tokensIn = msg.usage?.input_tokens ?? 0;
  const tokensOut = msg.usage?.output_tokens ?? 0;
  await audit({ action: "contracts.extract.proved", userId, userName, details: `proving document read on ${model} · tokens in=${tokensIn} out=${tokensOut}` });
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  let terms: ContractTermsT;
  try {
    terms = termsFromAnswer(text);
  } catch (e) {
    return { ok: false, passed: 0, of: 0, checks: [], seconds, tokensIn, tokensOut, refusal: `The answer did not match the expected shape: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
  }
  const checks = checkProving(terms, quoteInText);
  const passed = checks.filter((c) => c.ok).length;
  return { ok: passed === checks.length, passed, of: checks.length, checks, seconds, tokensIn, tokensOut, refusal: null };
}
