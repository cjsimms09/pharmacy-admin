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

import { estimateCost, pdfPageCount, planBatches, PDF_PAGE_LIMIT, PDF_BYTES_LIMIT } from "./contract-run";
export { estimateCost, pdfPageCount, planBatches, PDF_PAGE_LIMIT, PDF_BYTES_LIMIT, BATCH_BYTES_LIMIT, BATCH_REQUEST_LIMIT } from "./contract-run";

function docRequest(id: string, pdf: Buffer, name: string, model: string): Anthropic.Messages.Batches.BatchCreateParams.Request {
  return {
    custom_id: id,
    params: {
      model,
      max_tokens: 32000,
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

export type QueueResult = { queued: number; batchId: string | null; batches: string[]; skipped: string[]; estimate: { low: number; high: number } };

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
  const requests: { req: Anthropic.Messages.Batches.BatchCreateParams.Request; bytes: number }[] = [];
  let pages = 0;
  for (const d of pending) {
    try {
      const buf = await fs.readFile(path.join(contractsDir(), d.fileName!));
      const n = pdfPageCount(buf);
      if (n > PDF_PAGE_LIMIT) {
        skipped.push(`${d.documentName} (${n} pages; the limit is ${PDF_PAGE_LIMIT} a document — split it into parts and put the parts in the folder)`);
        continue;
      }
      if (buf.length > PDF_BYTES_LIMIT) {
        skipped.push(`${d.documentName} (${Math.round(buf.length / 1024 / 1024)} MB; the limit is 32 MB — re-save it smaller)`);
        continue;
      }
      pages += n;
      const req = docRequest(d.id, buf, d.documentName, model);
      requests.push({ req, bytes: Math.ceil((buf.length * 4) / 3) });
    } catch {
      skipped.push(`${d.documentName} (the file could not be read)`);
    }
  }
  if (requests.length === 0) return { queued: 0, batchId: null, batches: [], skipped, estimate: { low: 0, high: 0 } };

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
  for (const group of planBatches(requests.map((x) => ({ item: x.req, bytes: x.bytes })))) {
    const batch = await c.messages.batches.create({ requests: group });
    batches.push(batch.id);
    await db
      .update(schema.contractDocs)
      .set({ extractionState: "queued", extractionError: batch.id })
      .where(inArray(schema.contractDocs.id, group.map((g) => g.custom_id)));
  }
  await audit({ action: "contracts.extract.queued", userId, userName, details: `${requests.length} document(s), ${pages} pages, ${batches.length} batch(es): ${batches.join(", ")}; estimate ${dollars(estimate.low)}–${dollars(estimate.high)}` });
  return { queued: requests.length, batchId: batches[0] ?? null, batches, skipped, estimate };
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
      if (entry.result.type !== "succeeded") {
        await fail(doc.id, `Claude could not read this one (${entry.result.type}).`);
        res.failed++;
        continue;
      }
      const msg = entry.result.message;
      tokensIn += msg.usage?.input_tokens ?? 0;
      tokensOut += msg.usage?.output_tokens ?? 0;
      // An answer cut off at the token limit is not a bad read; it is a document too long for one answer.
      if (msg.stop_reason === "max_tokens") {
        await fail(doc.id, "The answer ran past the length limit before it finished. Split the document into parts and read the parts.");
        res.failed++;
        continue;
      }
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
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
      // A scan has no words of its own to search; the read's cited lines become them.
      if (doc.fileName) await (await import("./contract-search")).rememberReadText(doc.fileName, terms);
      res.done++;
    }
  }
  // Written the way every other model call writes it, so the spend page counts this run.
  await audit({ action: "contracts.extract.collected", userId, userName, details: `${res.done} read, ${res.failed} failed, ${res.rejected.length} rejected for missing citations · tokens in=${tokensIn} out=${tokensOut}` });
  return res;
}

async function fail(id: string, why: string) {
  await db.update(schema.contractDocs).set({ extractionState: "failed", extractionError: why }).where(eq(schema.contractDocs.id, id));
}

export function parseTerms(json: string | null): ContractTermsT | null {
  if (!json) return null;
  try {
    // Fields added to the schema after a document was read are absent from its draft; an old
    // draft is still a draft, not a failure, so the additions default to "not stated".
    const raw = JSON.parse(json) as Record<string, unknown>;
    return ContractTerms.parse({
      macAppealRequiredFields: [], macAppealInvoiceRequired: null, macAppealSubmissionTarget: null, contacts: [], remittance: null,
      networkReimbursementIds: [], pharmacyNcpdps: [], pharmacyNpis: [], claimSubmissionWindowDays: null, reversalWindowDays: null,
      transactionFees: [], keyDefinitions: [], sections: [],
      pricingCompendium: { value: null, citation: null }, macListAccess: { value: null, citation: null }, performanceMeasures: [],
      dawRules: { value: null, citation: null }, promptPayDays: null, latePaymentInterest: null,
      recoupmentTerms: { value: null, citation: null },
      ...raw,
    });
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
    remittance: { paidBy: pbm, paymentMethod: "EFT", paymentCycle: "twice monthly", eraOffered: true, enrollmentMethod: "Provider portal, EFT/ERA enrollment form", remittanceContact: "providerpayments@example.invalid", citation: cite },
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
