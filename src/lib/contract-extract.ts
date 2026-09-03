import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { contractsDir } from "./reference";
import { ContractTerms, EXTRACT_SYSTEM, requireCitations, type ContractTermsT } from "./contract-terms";

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

/** Roughly what a run will cost, so nothing starts without the number on screen. */
export function estimateCost(pages: number, model: string): { low: number; high: number } {
  // A contract page runs 1,500–3,000 tokens. Output is ~3k per document.
  const inPerM = model.includes("sonnet") ? 2 : 5;
  const outPerM = model.includes("sonnet") ? 10 : 25;
  const batch = 0.5;
  const lo = ((pages * 1500) / 1e6) * inPerM * batch;
  const hi = ((pages * 3000) / 1e6) * inPerM * batch;
  const out = ((pages / 12) * 3000 / 1e6) * outPerM * batch;
  return { low: lo + out, high: hi + out };
}

function docRequest(id: string, pdf: Buffer, name: string, model: string): Anthropic.Messages.Batches.BatchCreateParams.Request {
  return {
    custom_id: id,
    params: {
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: zodOutputFormat(ContractTerms) },
      // Cached: identical on every document in the run, so it is billed once.
      system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
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

export type QueueResult = { queued: number; batchId: string | null; skipped: string[]; estimate: { low: number; high: number } };

/**
 * Sends every contract that has a file and no extraction yet.
 *
 * The batch id is stored on each document so a run can be picked up later — the pharmacy computer
 * may well be switched off before the results come back, and that must not lose the work.
 */
export async function queueExtraction(userId: string, userName: string, onlyIds?: string[]): Promise<QueueResult> {
  const all = await db.query.contractDocs.findMany();
  const pending = all.filter(
    (d) => d.fileName && d.extractionState !== "done" && d.extractionState !== "queued" && (!onlyIds || onlyIds.includes(d.id)),
  );
  const skipped: string[] = [];
  if (pending.length === 0) return { queued: 0, batchId: null, skipped: ["nothing to do — every document with a file is already read"], estimate: { low: 0, high: 0 } };

  if (MOCK) {
    for (const d of pending) {
      await db.update(schema.contractDocs).set({ extractionState: "done", extractionJson: JSON.stringify(mockTerms(d.documentName, d.pbmName)) }).where(eq(schema.contractDocs.id, d.id));
    }
    return { queued: pending.length, batchId: "mock", skipped, estimate: { low: 0, high: 0 } };
  }

  const { client: c, model } = await client();
  const requests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = [];
  let pages = 0;
  for (const d of pending) {
    try {
      const buf = await fs.readFile(path.join(contractsDir(), d.fileName!));
      // A rough page count from the PDF itself, only used for the cost estimate.
      pages += Math.max(1, (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length);
      requests.push(docRequest(d.id, buf, d.documentName, model));
    } catch {
      skipped.push(d.documentName);
    }
  }
  if (requests.length === 0) return { queued: 0, batchId: null, skipped, estimate: { low: 0, high: 0 } };

  const batch = await c.messages.batches.create({ requests });
  await db
    .update(schema.contractDocs)
    .set({ extractionState: "queued", extractionError: batch.id })
    .where(inArray(schema.contractDocs.id, requests.map((r) => r.custom_id)));
  await audit({ action: "contracts.extract.queued", userId, userName, details: `${requests.length} document(s), batch ${batch.id}` });
  return { queued: requests.length, batchId: batch.id, skipped, estimate: estimateCost(pages, model) };
}

export type CollectResult = { done: number; failed: number; stillRunning: number; rejected: { doc: string; why: string }[] };

/** Picks up finished batches. Safe to call repeatedly; results arrive in any order. */
export async function collectExtraction(userId: string, userName: string): Promise<CollectResult> {
  const res: CollectResult = { done: 0, failed: 0, stillRunning: 0, rejected: [] };
  const queued = await db.query.contractDocs.findMany({ where: eq(schema.contractDocs.extractionState, "queued") });
  const batches = [...new Set(queued.map((d) => d.extractionError).filter((b): b is string => Boolean(b)))];
  if (batches.length === 0) return res;
  const { client: c } = await client();

  for (const batchId of batches) {
    const batch = await c.messages.batches.retrieve(batchId);
    if (batch.processing_status !== "ended") {
      res.stillRunning += queued.filter((d) => d.extractionError === batchId).length;
      continue;
    }
    for await (const entry of await c.messages.batches.results(batchId)) {
      const doc = queued.find((d) => d.id === entry.custom_id);
      if (!doc) continue;
      if (entry.result.type !== "succeeded") {
        await fail(doc.id, `Claude could not read this one (${entry.result.type}).`);
        res.failed++;
        continue;
      }
      const text = entry.result.message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      let terms: ContractTermsT;
      try {
        terms = ContractTerms.parse(JSON.parse(text));
      } catch {
        await fail(doc.id, "The answer did not match the expected shape. Try this one again.");
        res.failed++;
        continue;
      }
      // A figure without the contract's words behind it does not get stored.
      const missing = requireCitations(terms);
      if (missing.length > 0) {
        const why = `No supporting quote for ${missing.map((m) => m.field).join(", ")}`;
        await fail(doc.id, `${why}. Nothing was saved — a rate that cannot be traced to a sentence is not usable in an appeal.`);
        res.rejected.push({ doc: doc.documentName, why });
        res.failed++;
        continue;
      }
      await db
        .update(schema.contractDocs)
        .set({ extractionState: "done", extractionJson: JSON.stringify(terms), extractionError: null })
        .where(eq(schema.contractDocs.id, doc.id));
      res.done++;
    }
  }
  await audit({ action: "contracts.extract.collected", userId, userName, details: `${res.done} read, ${res.failed} failed, ${res.rejected.length} rejected for missing citations` });
  return res;
}

async function fail(id: string, why: string) {
  await db.update(schema.contractDocs).set({ extractionState: "failed", extractionError: why }).where(eq(schema.contractDocs.id, id));
}

export function parseTerms(json: string | null): ContractTermsT | null {
  if (!json) return null;
  try {
    return ContractTerms.parse(JSON.parse(json));
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
    linesOfBusiness: ["Commercial"],
    effectiveDate: "2025-01-01",
    endDate: null,
    autoRenews: true,
    terminationNoticeDays: 90,
    amendmentNoticeDays: 30,
    rates: [
      {
        pbmVendor: "CVS/Caremark",
        network: "Mock Commercial Broad",
        costSharingTier: "standard" as const,
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
