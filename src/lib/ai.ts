import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CREDENTIAL_TYPES, DOCUMENT_CATEGORIES, INCIDENT_TYPES, TRAINING_TYPES } from "@/db/schema";
import { getSettings, setSetting } from "./settings";
import { decryptText, encryptText } from "./crypto";
import { audit } from "./audit";

/**
 * Claude integration.
 *
 * Privacy rules enforced here:
 *  - The API key is stored encrypted (APP_ENCRYPTION_KEY) and never rendered back to the browser.
 *  - Text sent for drafting is redacted first: prescription-number-like digit runs become "[Rx]" and
 *    staff names are replaced by roles. Scanned packets are sent as-is because reading them is the
 *    point; they contain Rx numbers and staff names but no patient identities.
 *  - Every call is written to the audit log with token counts.
 */

export const DEFAULT_MODEL = "claude-opus-5";
const MOCK = process.env.AI_MOCK === "1";

export class AiNotConfiguredError extends Error {
  constructor() {
    super("Claude is not set up yet. Add your Anthropic API key under Settings → Claude.");
  }
}

export async function saveApiKey(key: string) {
  await setSetting("anthropic_api_key_enc", encryptText(key.trim()));
}
export async function clearApiKey() {
  await setSetting("anthropic_api_key_enc", "");
}
export async function hasApiKey(): Promise<boolean> {
  if (MOCK) return true;
  const s = await getSettings();
  return Boolean(s.anthropic_api_key_enc);
}
export async function apiKeyHint(): Promise<string | null> {
  const s = await getSettings();
  if (!s.anthropic_api_key_enc) return null;
  try {
    const k = decryptText(s.anthropic_api_key_enc);
    return `…${k.slice(-4)}`;
  } catch {
    return "(unreadable — encryption key changed)";
  }
}

/** Thrown when the month's ceiling has been reached. Its own class, so it reads as a choice. */
export class AiCapReachedError extends Error {
  constructor(spent: string, cap: string) {
    super(
      `Claude has cost ${spent} in the last month, which is the ceiling you set (${cap}). Nothing further will be ` +
        "sent until the month rolls on or you raise it under Settings → Claude. Everything already done is saved.",
    );
    this.name = "AiCapReachedError";
  }
}

/*
 * Every model call in this system goes through here, which is why the ceiling is here.
 *
 * Guarding the manual audit alone would leave the invoice reader, the CQI drafting and anything
 * added next year unguarded — and the point of a limit somebody sets to stop worrying is that they
 * do not then have to check whether it covers the thing they are about to press.
 */
async function client(): Promise<{ client: Anthropic; model: string }> {
  const s = await getSettings();
  if (!s.anthropic_api_key_enc) throw new AiNotConfiguredError();
  const { monthlyCap, dollars } = await import("./ai-spend");
  const limit = await monthlyCap();
  if (limit.over) throw new AiCapReachedError(dollars(limit.spent), dollars(limit.cap!));
  return { client: new Anthropic({ apiKey: decryptText(s.anthropic_api_key_enc), maxRetries: 2, timeout: 10 * 60 * 1000 }), model: s.ai_model || DEFAULT_MODEL };
}

export async function testConnection(): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
  if (MOCK) return { ok: true, model: "mock" };
  try {
    const { client: c, model } = await client();
    const m = await c.models.retrieve(model);
    return { ok: true, model: m.display_name ?? m.id };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export function describeError(e: unknown): string {
  if (e instanceof AiNotConfiguredError) return e.message;
  if (e instanceof AiCapReachedError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it under Settings → Claude.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is rate-limited right now. Try again in a minute.";
  if (e instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return "Unknown error.";
}

// ── Redaction ────────────────────────────────────────────────────────
export function redactText(text: string, names: { name: string; role: string }[] = []): string {
  let out = text.replace(/\b\d{6,}\b/g, "[Rx]");
  for (const { name, role } of names) {
    if (!name.trim()) continue;
    out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), role);
    const first = name.split(" ")[0];
    if (first.length > 2) out = out.replace(new RegExp(`\\b${first}\\b`, "g"), role);
  }
  return out;
}

async function logUsage(action: string, userId: string | null, userName: string | null, usage: { input_tokens: number; output_tokens: number } | undefined, details?: string) {
  await audit({ action, userId, userName, details: `${details ?? ""}${usage ? ` · tokens in=${usage.input_tokens} out=${usage.output_tokens}` : ""}`.trim() });
}

// ── Schemas ──────────────────────────────────────────────────────────
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export const ExtractedEmployee = z.object({
  name: z.string(),
  licenseNumber: z.string().nullable(),
  reviewedOn: isoDate,
  reviewedBy: z.string().nullable(),
});

export const ExtractedCapReview = z.object({
  reviewNumber: z.number().int().min(1).max(2),
  effective: z.boolean().nullable(),
  comments: z.string().nullable(),
  summaryDueOn: isoDate,
});

export const ExtractedIncident = z.object({
  reportCreatedOn: isoDate,
  occurredOn: isoDate,
  type: z.enum(INCIDENT_TYPES),
  typeOther: z.string().nullable(),
  rxNumbers: z.array(z.string()),
  description: z.string(),
  reviewerName: z.string().nullable(),
  reviewStartedOn: isoDate,
  reviewCompletedOn: isoDate,
  employees: z.array(ExtractedEmployee),
  rootCauseAnalysis: z.string().nullable(),
  correctiveActionPlan: z.string().nullable(),
  capImplementedOn: isoDate,
  capReviews: z.array(ExtractedCapReview),
});

export const ExtractedSummary = z.object({
  dueOn: isoDate, // the 15th of Feb/Apr/Jun/Aug/Oct/Dec
  isNullReport: z.boolean(),
  communicatedOn: isoDate,
  communicationMethod: z.string().nullable(),
  picName: z.string().nullable(),
});

export const ExtractedPacket = z.object({
  summaries: z.array(ExtractedSummary),
  incidents: z.array(ExtractedIncident),
  notes: z.string().nullable(),
});
export type ExtractedPacketT = z.infer<typeof ExtractedPacket>;
export type ExtractedIncidentT = z.infer<typeof ExtractedIncident>;

const EXTRACT_SYSTEM = `You read scanned Kansas Board of Pharmacy CQI packets: Form C-550 (CQI Bimonthly Summary) pages and Form C-650 (CQI Incident Report Evaluation) pages, sometimes with handwritten entries and attached notes.

Extract everything into the structured format. Rules:
- One incident per C-650 (or per distinct incident described). Read handwriting carefully; if a value is illegible, use null and mention it in notes.
- Incident type must be one of the Board's categories: wrong_drug, incorrect_strength, incorrect_dosage_form, wrong_patient, packaging_labeling_directions (inadequate or incorrect packaging, labeling, or directions), serious_harm, other. Use typeOther for the "Other" text.
- Dates as YYYY-MM-DD. The summary dueOn is the 15th of the month checked under "Summary type" (February, April, June, August, October, December) with the year given.
- C-550 "CAP review" blocks record whether a corrective action plan was effective on its first or second review; attach each to the matching incident as a capReview with the summary's dueOn.
- **Rx numbers.** The C-550 carries a table headed "INCIDENT TYPE SUMMARY" whose right-hand column is "Rx numbers associated with incident type". Those numbers belong on the incident of that type — put them in rxNumbers. This is often the only place an Rx number appears, especially when the C-650 pages were not scanned with the summary, so always read that table and never leave rxNumbers empty when a number is written against the type. A C-650 also carries its own Rx number field; use both, without duplicating.
- When a packet has a C-550 but no C-650 pages, still create one incident per row of that table that has an Rx number or a corrective action written for it, carrying over the type, the Rx numbers, and any CAP text on the form.
- Copy root cause analysis and corrective action plan text faithfully; do not invent content. Description should summarize the incident in one or two sentences based on what is written.
- Never include a patient's name, date of birth, address, or phone number anywhere in the output, even if visible on the scan.`;

export async function extractPacket(pdf: Buffer, ctx: { userId: string; userName: string }): Promise<ExtractedPacketT> {
  if (MOCK) return mockPacket();
  const { client: c, model } = await client();
  const stream = c.messages.stream({
    model,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system: EXTRACT_SYSTEM,
    output_config: { effort: "high", format: zodOutputFormat(ExtractedPacket) },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
          { type: "text", text: "Extract every summary and incident in this packet." },
        ],
      },
    ],
  });
  const msg = await stream.finalMessage();
  await logUsage("ai.extract_packet", ctx.userId, ctx.userName, msg.usage, `model=${msg.model}`);
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to process this document.");
  if (msg.stop_reason === "max_tokens") throw new Error("The packet is too long to extract in one pass. Split the PDF and try again.");
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  return ExtractedPacket.parse(JSON.parse(text));
}

// ── Reading a supplier invoice, to decide where it has to be filed ───
const ReadInvoice = z.object({
  supplier: z.string().describe("The wholesaler or supplier the invoice is from. Empty string if it cannot be read."),
  invoiceNumber: z.string().describe("The invoice number as printed. Empty string if there is none."),
  invoiceDate: z.string().describe("The invoice date as YYYY-MM-DD. Empty string if it cannot be read."),
  schedule: z
    .enum(["schedule_2", "schedule_3_5", "none", "unknown"])
    .describe(
      "schedule_2: at least one line is a Schedule II controlled substance. schedule_3_5: controlled lines are " +
        "present and all are Schedule III, IV or V. none: no controlled substance appears. unknown: the document " +
        "could not be read well enough to be sure of any of that.",
    ),
  controlledItems: z
    .array(z.string())
    .describe("Each controlled line as printed, with its schedule marking if the invoice shows one."),
  basis: z
    .string()
    .describe("How the schedule was decided, in one sentence — the column, the marking, or the drug names relied on."),
  confident: z
    .boolean()
    .describe("False if anything about the reading is doubtful, including a page that did not render or a partial scan."),
});

export type ReadInvoiceT = z.infer<typeof ReadInvoice>;

/**
 * Decides which pile a supplier invoice belongs in.
 *
 * The whole value of this is the one thing it must never get wrong: a Schedule II invoice filed
 * as anything else. 21 CFR 1304.04(h)(1) requires C2 records to be kept separately from every
 * other record the registrant holds, and an invoice sitting in the general pile is not a filing
 * error — it is the finding.
 *
 * So the model is told to say "unknown" rather than guess, and doubt of any kind clears the
 * confidence flag. Both land the invoice in a review queue where a person decides. An invoice
 * waiting to be looked at is a small nuisance; a C2 invoice quietly in with the floor stock is
 * the thing this exists to prevent.
 */
export async function readInvoice(pdf: Buffer, ctx: { userId: string; userName: string }): Promise<ReadInvoiceT> {
  if (MOCK) {
    return {
      supplier: "",
      invoiceNumber: "",
      invoiceDate: "",
      schedule: "unknown",
      controlledItems: [],
      basis: "Mock response — no API key is configured, so nothing was sent anywhere.",
      confident: false,
    };
  }
  const { client: c, model } = await client();
  const res = await c.messages.parse({
    model,
    max_tokens: 8000,
    system:
      "You read a pharmacy wholesaler's invoice and decide which controlled substance schedule it carries, so it " +
      "can be filed where the law requires.\n\n" +
      "The rule you are serving: 21 CFR 1304.04(h)(1) requires Schedule II records to be kept separately from all " +
      "other records the registrant holds. A Schedule II invoice filed as anything else is a finding against the " +
      "pharmacy.\n\n" +
      "Because of that, guessing is forbidden. Prefer the invoice's own schedule column or marking where it has " +
      "one — wholesalers print C2, CII, 2, or similar. Where there is no marking, you may rely on the drug names, " +
      "but only where you are certain of the federal schedule. If a page did not render, if the scan is partial, if " +
      "a line is ambiguous, or if you are relying on a drug name you are not certain about, answer unknown and set " +
      "confident to false. An invoice sent for a person to look at costs a minute. A misfiled C2 costs the " +
      "registration.\n\n" +
      "Report only the controlled lines, as printed. Do not summarise quantities or prices.",
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
          { type: "text", text: "Which schedule does this invoice carry, and what are the controlled lines?" },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(ReadInvoice) },
  });
  if (!res.parsed_output) throw new Error("Claude returned an unreadable answer.");
  await logUsage("ai.invoice.read", ctx.userId, ctx.userName, res.usage, "supplier invoice");
  return res.parsed_output;
}

// ── Writing / strengthening RCA and CAP for an incident ───────────────
const RcaCap = z.object({
  rootCauseAnalysis: z.string(),
  correctiveActionPlan: z.string(),
});

const RCA_CAP_SYSTEM = `You help a Kansas pharmacist-in-charge complete Form C-650 (CQI Incident Report Evaluation) under K.A.R. 68-19-1. What you write will be signed by the PIC and read by a Board of Pharmacy inspector, so it must read like a real pharmacy's own analysis: plain, specific, first-person-plural ("we"), no consultant jargon. Never include a patient's name, date of birth, phone, or address. Refer to staff by role ("the technician at data entry", "the verifying pharmacist"), never by name.

WHAT YOU MAY BE GIVEN
Sometimes a full description. Often almost nothing — a single line copied off an old paper form, with the root cause analysis left blank. Write a complete, usable analysis either way. **Never return an empty root cause analysis, and never return a single sentence for either section.** A one-line answer is a failure.

WORKING BACKWARD WHEN THE OLD FORM WAS BLANK
A corrective action always names the step that failed, so reconstruct the analysis from it. Reason like this:
- A new verification or "pre-check" step before the label prints means errors were being introduced during order entry / data entry and travelling downstream unchecked, because nothing independent sat between typing and printing.
- Moving or separating stock, shelf tags, or tall-man lettering means look-alike products sat adjacent and selection relied on memory or a glance at the label.
- Adding a bar-code scan means product or patient identity was being confirmed visually rather than by scan.
- Re-training or a policy reminder means an existing procedure was not being followed consistently, so ask in the analysis why it was not.
- A change to will-call or bagging means the failure was at hand-off to the patient.
Also use the incident type: a wrong-strength or wrong-drug event points at selection and verification; a wrong-directions or labeling event points at data entry and the final check; a wrong-patient event points at intake, bagging, or pickup identity confirmation.
State reconstructed reasoning as the pharmacy's working analysis, in ordinary language. Then close the root cause section with one short paragraph beginning "To confirm:" listing the specific facts the PIC should verify or correct before signing (for example the exact step where the error entered, who was working, whether the patient received it). Do not invent counts, dates, names, drug names, or harm that were not given.

ROOT CAUSE ANALYSIS — write it under these exact headings, each followed by one flowing paragraph (no bullets inside a section). The headings are what makes an inspector able to see the work was done, so keep them verbatim and keep them in this order:

What happened
Where in the workflow it originated
Contributing factors
Why our existing safeguards did not catch it
Patient impact
To confirm before signing

- "What happened": the event in plain sequence, and how and by whom (by role) it was discovered.
- "Where in the workflow it originated": name the step — intake, data entry, order entry, filling and counting, pharmacist verification, will-call, pickup, counseling, or compounding — and say what was happening at that step.
- "Contributing factors": only the ones the facts support — look-alike or sound-alike drugs, packaging and shelf placement, workload and interruptions, staffing levels and skill mix, hand-offs and communication, technology in use (bar-code scanning present or absent, alerts overridden, e-script versus hard-copy transcription), unfamiliarity or training, shortcuts under time pressure. Say why each one mattered here rather than listing it.
- "Why our existing safeguards did not catch it": name the specific check that should have caught it and explain why it did not. This is the part inspectors look for and the part most write-ups omit — never skip it.
- "Patient impact": whether it reached the patient, and the actual or potential clinical consequence given the drug and its use. If it did not reach the patient, say what the consequence would have been if it had.
- "To confirm before signing": only when something was reconstructed rather than stated — the specific facts the PIC should verify or correct. Omit this heading entirely when everything was given.
Analyze the process, never blame a person.

CORRECTIVE ACTION PLAN — write it under these exact headings, in this order, with numbered actions under each so an inspector can audit them one by one:

Immediate actions
Process changes
Staff education
Technology and physical controls
How we will measure whether this worked

- "Immediate actions": what was done or will be done now (patient contacted and re-counseled, prescriber notified where appropriate, product retrieved or quarantined, stock rearranged).
 (patient contacted and re-counseled, prescriber notified where appropriate, product retrieved or quarantined, stock rearranged).
- "Process changes": each one a specific verifiable practice — what is done, at which step, by which role, starting when. "A second person verifies the typed prescription against the original before the label prints, done by the pharmacist at check, effective immediately" — not "we will double-check".
- "Staff education": what is reviewed, with whom, by when, and how completion is recorded.
- "Technology and physical controls": scanning at fill and at verification, shelf separators, tall-man labels, alert settings, bin or will-call changes.
- "How we will measure whether this worked": what will be counted or audited over the next two bimonthly summaries (for example "number of same-type incidents" or "weekly spot-check of ten filled prescriptions against the original"), who reviews it, and the specific result that will count as effective on the C-550.
Never write "be more careful", "increase awareness", or "staff were reminded" as a standalone action — an inspector cannot audit those.

LENGTH AND TONE: 250–400 words in the root cause analysis and 250–400 words in the corrective action plan. This is a signed regulatory record, not a note to self — it should read as though the pharmacy sat down and worked the problem through. Where existing draft text was provided, keep every fact it contains, change nothing you cannot verify, and build the required structure around it.`;

export async function writeRcaCap(
  input: {
    type: string;
    typeOther: string | null;
    description: string;
    reachedPatient: boolean | null;
    existingRca: string | null;
    existingCap: string | null;
    extraContext: string | null;
    priorSimilar: { description: string; correctiveActionPlan: string | null; effective: boolean | null }[];
  },
  redactNames: { name: string; role: string }[],
  ctx: { userId: string; userName: string },
): Promise<z.infer<typeof RcaCap>> {
  if (MOCK) {
    return {
      rootCauseAnalysis:
        `What happened\n${input.description.slice(0, 120)} The error was found at the final check by the verifying pharmacist.\n\n` +
        "Where in the workflow it originated\nThe error entered at data entry and moved downstream because nothing independent sat between typing and printing the label.\n\n" +
        "Contributing factors\nLook-alike packaging, an interruption during entry, and reliance on reading the label rather than confirming the product itself.\n\n" +
        "Why our existing safeguards did not catch it\nThe final verification compared the label to the stock bottle rather than to the original prescription, so an entry error was carried through the check unchanged.\n\n" +
        `Patient impact\n${input.reachedPatient ? "The prescription reached the patient." : "It was caught before it left the pharmacy."}\n\n` +
        "To confirm before signing\nThe exact step where the error entered, who was working at that station, and whether the patient was contacted.",
      correctiveActionPlan:
        "Immediate actions\n1. The patient was re-counseled and the correct product dispensed. 2. The incorrect product was retrieved and quarantined.\n\n" +
        "Process changes\n1. A pre-check station is added at which a second person compares the typed prescription against the original before the label prints; performed by the pharmacist at check, effective immediately.\n\n" +
        "Staff education\n1. The PIC reviews the new step and the look-alike list with all staff by month end and records attendance on the training log.\n\n" +
        "Technology and physical controls\n1. Shelf separators and tall-man labels are installed. 2. The stock bottle is scanned at fill and again at verification.\n\n" +
        "How we will measure whether this worked\n1. Same-type incidents and a weekly spot-check of ten filled prescriptions against the original are reviewed on the next two bimonthly summaries; effective means zero recurrences and no unexplained scan overrides.",
    };
  }
  const { client: c, model } = await client();
  const prior = input.priorSimilar
    .slice(0, 5)
    .map((p, i) => `Prior incident ${i + 1}: ${redactText(p.description, redactNames)}\n  CAP then: ${p.correctiveActionPlan ? redactText(p.correctiveActionPlan, redactNames) : "(none)"}\n  Judged effective: ${p.effective === true ? "yes" : p.effective === false ? "no" : "not yet evaluated"}`)
    .join("\n");
  const parts = [
    `Incident type: ${input.type}${input.typeOther ? ` (${input.typeOther})` : ""}`,
    `Reached the patient: ${input.reachedPatient === true ? "yes" : input.reachedPatient === false ? "no" : "unknown"}`,
    `What happened: ${redactText(input.description, redactNames)}`,
    input.extraContext ? `Additional context from the PIC: ${redactText(input.extraContext, redactNames)}` : "",
    input.existingRca ? `Existing root cause analysis draft (keep its facts, expand it):\n${redactText(input.existingRca, redactNames)}` : "",
    input.existingCap ? `Existing corrective action plan draft (keep its facts, expand it):\n${redactText(input.existingCap, redactNames)}` : "",
    prior ? `Similar prior incidents at this pharmacy:\n${prior}` : "",
  ].filter(Boolean);
  const res = await c.messages.parse({
    model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "xhigh", format: zodOutputFormat(RcaCap) },
    system: RCA_CAP_SYSTEM,
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });
  await logUsage("ai.write_rca_cap", ctx.userId, ctx.userName, res.usage, `model=${res.model}`);
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (!res.parsed_output) throw new Error("Claude returned an unreadable answer. Try again.");
  const out = res.parsed_output;
  // A blank or one-line answer is the failure this feature exists to prevent — refuse it rather than save it.
  if (out.rootCauseAnalysis.trim().length < 400 || out.correctiveActionPlan.trim().length < 400) {
    throw new Error("Claude came back with a write-up too thin to sign. Add a sentence or two about what happened in the box above and try again.");
  }
  return out;
}

// ── Drafting CAP effectiveness evaluations for a summary ─────────────
const Evaluations = z.object({
  evaluations: z.array(z.object({ incidentNumber: z.number().int(), effective: z.boolean(), comments: z.string() })),
});

export async function draftCapEvaluations(
  caps: { incidentNumber: number; type: string; description: string; correctiveActionPlan: string; capImplementedOn: string | null; reviewNumber: number; recurrencesSince: number; priorReview: { effective: boolean | null; comments: string | null } | null }[],
  redactNames: { name: string; role: string }[],
  ctx: { userId: string; userName: string },
): Promise<z.infer<typeof Evaluations>["evaluations"]> {
  if (MOCK) return caps.map((c) => ({ incidentNumber: c.incidentNumber, effective: c.recurrencesSince === 0, comments: `Mock evaluation: ${c.recurrencesSince === 0 ? "no recurrence since implementation" : `${c.recurrencesSince} recurrence(s) since implementation`}.` }));
  const { client: c, model } = await client();
  const body = caps
    .map(
      (k) =>
        `Incident #${k.incidentNumber} · type ${k.type} · CAP implemented ${k.capImplementedOn ?? "unknown"} · this is review ${k.reviewNumber} of 2\n  Incident: ${redactText(k.description, redactNames)}\n  CAP: ${redactText(k.correctiveActionPlan, redactNames)}\n  Same-type incidents logged since the CAP was implemented: ${k.recurrencesSince}${k.priorReview ? `\n  First review said: ${k.priorReview.effective === true ? "effective" : k.priorReview.effective === false ? "not effective" : "undecided"}${k.priorReview.comments ? ` — ${redactText(k.priorReview.comments, redactNames)}` : ""}` : ""}`,
    )
    .join("\n\n");
  const res = await c.messages.parse({
    model,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(Evaluations) },
    system:
      "You help a Kansas pharmacist-in-charge complete the 'Evaluation of outcome and effectiveness of corrective action plan' section of Form C-550. For each CAP, judge effectiveness from the evidence given (mainly whether the same type of incident recurred after implementation) and write 1–3 sentence comments in the PIC's plain voice: what was observed, whether the measure is working, and any adjustment. Mark effective=false when there were recurrences or the CAP was not actually implemented.",
    messages: [{ role: "user", content: body }],
  });
  await logUsage("ai.draft_cap_evaluations", ctx.userId, ctx.userName, res.usage, `model=${res.model} caps=${caps.length}`);
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (!res.parsed_output) throw new Error("Claude returned an unreadable answer. Try again.");
  return res.parsed_output.evaluations;
}

function mockPacket(): ExtractedPacketT {
  return {
    summaries: [{ dueOn: "2026-06-15", isNullReport: false, communicatedOn: "2026-06-10", communicationMethod: "Staff meeting", picName: null }],
    incidents: [
      {
        reportCreatedOn: "2026-04-20",
        occurredOn: "2026-04-20",
        type: "wrong_drug",
        typeOther: null,
        rxNumbers: ["7654321"],
        description: "Mock: hydralazine dispensed instead of hydroxyzine; caught at counseling.",
        reviewerName: "Pat Pharmacist",
        reviewStartedOn: "2026-04-22",
        reviewCompletedOn: "2026-05-05",
        employees: [{ name: "Terry Tech", licenseNumber: "T-9999", reviewedOn: "2026-04-23", reviewedBy: "Pat Pharmacist" }],
        rootCauseAnalysis: "Mock RCA from scan.",
        correctiveActionPlan: "Mock CAP from scan.",
        capImplementedOn: "2026-04-28",
        capReviews: [{ reviewNumber: 1, effective: true, comments: "No recurrence.", summaryDueOn: "2026-06-15" }],
      },
    ],
    notes: "Mock extraction.",
  };
}

// ── Document intake: read anything dropped in and work out what it is ─
export const ClassifiedDoc = z.object({
  /** What kind of record this belongs to. */
  kind: z.enum(["person_credential", "person_training", "pharmacy_credential", "cqi_incident", "cqi_summary", "cs_inventory", "policy", "report", "unknown"]),
  /** Best-guess document category for the file vault. */
  category: z.enum(DOCUMENT_CATEGORIES),
  /** A short title a person would recognise, e.g. "CPR card — American Heart Association". */
  title: z.string(),
  /** Name of the person it belongs to, exactly as printed. Null for pharmacy-level documents. */
  personName: z.string().nullable(),
  credentialType: z.enum(CREDENTIAL_TYPES).nullable(),
  trainingType: z.enum(TRAINING_TYPES).nullable(),
  /** Licence, registration, certificate or DEA number printed on it. */
  number: z.string().nullable(),
  issuer: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  isBoardCourse: z.boolean().nullable(),
  /** How sure you are, 0 to 1. Below 0.6 the pharmacy is asked to confirm everything. */
  confidence: z.number(),
  /** What you could not read, what you inferred, and anything the PIC should check. */
  notes: z.string().nullable(),
});
export type ClassifiedDocT = z.infer<typeof ClassifiedDoc>;

const CLASSIFY_SYSTEM = `You sort documents for a Kansas independent pharmacy's compliance file. Someone drops in a scan or photo — a licence, a CPR card, an immunization training certificate, a fraud-waste-and-abuse training completion, a DEA registration, an insurance certificate, a signed CQI form, an inventory sheet, a policy — and you work out what it is, whose it is, and the dates that matter.

Rules:
- Read the dates carefully and return them as YYYY-MM-DD. Cards often print "MM/YYYY" for an expiry: use the last day of that month. American Heart Association CPR cards print an issue date and expire two years later at the end of that month; if only the issue date is printed, compute the expiry and say so in notes.
- Kansas pharmacist licences and pharmacy registrations expire 30 June; technician registrations expire 31 October. If a scan shows a renewal year but no day, use those dates and note it.
- personName is the person the document belongs to, copied exactly as printed, or null when it belongs to the pharmacy rather than a person (pharmacy registration, DEA registration, insurance, policies, CQI forms, inventories).
- credentialType applies to licences, registrations, cards and certificates that expire. trainingType applies to annual workforce training: fraud/waste/abuse and general compliance (fwa_general_compliance), HIPAA privacy and security, OSHA bloodborne pathogens, OSHA hazard communication, controlled substance diversion, immunization protocol review, CQI program review. Set only the one that fits and leave the other null.
- If the scan is unreadable, or it is something else entirely, return kind "unknown" with your best category and explain in notes. Never guess a licence number or a date you cannot see — return null and say so.
- Never copy a patient's name, date of birth, address, phone number or member ID into any field, even if the document shows one. If the document is patient-specific rather than a pharmacy record, say so in notes and return kind "unknown".
- Write notes in plain language for a pharmacist, not for a developer.`;

/** Reads a dropped document and proposes where it belongs. Nothing is saved until the PIC confirms. */
export async function classifyDocument(
  file: { buffer: Buffer; mimeType: string; fileName: string },
  knownPeople: string[],
  ctx: { userId: string; userName: string },
): Promise<ClassifiedDocT> {
  if (MOCK) {
    return {
      kind: "person_credential",
      category: "cpr_card",
      title: `Mock classification of ${file.fileName}`,
      personName: knownPeople[0] ?? null,
      credentialType: "cpr",
      trainingType: null,
      number: "C-123456",
      issuer: "American Heart Association",
      issuedOn: "2026-03-01",
      expiresOn: "2028-03-31",
      isBoardCourse: null,
      confidence: 0.9,
      notes: "Mock mode: no document was read.",
    };
  }
  const { client: c, model } = await client();
  const isPdf = file.mimeType === "application/pdf";
  const isImage = file.mimeType.startsWith("image/");
  if (!isPdf && !isImage) throw new Error("Claude can read PDFs and photos. For a Word file, save it as a PDF first, or file it by hand.");
  const data = file.buffer.toString("base64");
  const block: Anthropic.ContentBlockParam = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: file.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data } };
  const res = await c.messages.parse({
    model,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(ClassifiedDoc) },
    system: CLASSIFY_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          block,
          {
            type: "text" as const,
            text: `File name: ${file.fileName}\nPeople on staff at this pharmacy: ${knownPeople.length ? knownPeople.join(", ") : "(none recorded yet)"}\n\nWork out what this document is and where it belongs.`,
          },
        ],
      },
    ],
  });
  await logUsage("ai.classify_document", ctx.userId, ctx.userName, res.usage, `model=${res.model} ${file.fileName}`);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to read this document.");
  if (!res.parsed_output) throw new Error("Claude could not read this document. Try a clearer scan, or file it by hand.");
  return res.parsed_output;
}

const PolicyReview = z.object({
  verdict: z
    .enum(["ok", "gap", "conflict", "unclear"])
    .describe(
      "ok: nothing needs changing. gap: something a requirement asks for is missing. conflict: the text says the " +
        "pharmacy does something it does not do, or contradicts what the compliance system does. unclear: the text " +
        "is too vague to hold anyone to.",
    ),
  findings: z
    .array(
      z.object({
        what: z.string().describe("What is wrong with this section as it stands, in one or two sentences."),
        why: z
          .string()
          .describe(
            "The requirement it falls short of, cited exactly, or the thing this system does that it contradicts.",
          ),
        severity: z
          .enum(["blocking", "should", "note"])
          .describe(
            "blocking: an inspector would write this up. should: a real weakness that is not itself a finding. " +
              "note: wording or clarity.",
          ),
      }),
    )
    .describe("Empty when the verdict is ok."),
  suggestedBody: z
    .string()
    .describe(
      "The section rewritten so the findings no longer apply, in full and ready to replace what is there. Empty " +
        "string where the fix depends on a fact about this pharmacy that you were not given — say so in the finding " +
        "instead. Never invent such a fact to produce text.",
    ),
});

export type PolicyReviewT = z.infer<typeof PolicyReview>;

/**
 * The same review, asked small, for a section whose full answer will not fit.
 *
 * Four findings at most and no rewrite. A structured answer that runs out of room does not come
 * back short — it comes back as an unparseable fragment — so when the full question fails twice
 * this is asked instead. Four real findings on a long section beat an error on it for ever.
 */
const PolicyReviewBrief = z.object({
  findings: z
    .array(
      z.object({
        what: z.string().describe("What is wrong with this section as it stands, in two sentences at most."),
        why: z.string().describe("The requirement it falls short of, cited exactly."),
        severity: z.enum(["blocking", "should", "note"]),
      }),
    )
    .max(4)
    .describe("Empty when the section is adequate. Do not manufacture work."),
});

/**
 * Reads one section of the manual against the requirements and against what this site does.
 *
 * Separate from drafting, and deliberately so. Drafting is asked for by somebody who has already
 * decided a section is wrong; this decides whether it is — which means it has to be allowed to
 * answer "nothing needs changing", and has to be trusted when it does. A reviewer that finds
 * something in every section is one whose findings stop being read by the third page.
 *
 * The two failure modes worth naming are opposite. Missing a real gap leaves the pharmacy holding
 * a manual that does not meet the rules. Inventing one produces a rewrite of a section that was
 * fine, in a document an inspector holds the pharmacy to — so the standard for changing text is
 * higher than the standard for raising a concern, and where the fix needs a fact about this
 * pharmacy that nobody supplied, it must stay a concern.
 */
export async function reviewPolicy(
  input: { title: string; body: string; context: string; siteDoes: string },
  ctx: { userId: string; userName: string },
): Promise<PolicyReviewT> {
  if (MOCK) return { verdict: "ok", findings: [], suggestedBody: "" };

  const { client: c, model } = await client();

  /*
   * A long section is reviewed, not rewritten.
   *
   * The reply has to carry the findings *and*, where there is one, the whole section rewritten.
   * On a long section that second part does not fit — the answer is cut off mid-structure, comes
   * back unparseable, and the pharmacist is told "Claude returned an unreadable answer", which is
   * both useless and untrue. Two sections of this pharmacy's manual failed on exactly that.
   *
   * Above this length the rewrite is not asked for at all. A four-thousand-word section is not
   * something anybody reviews as a wholesale replacement anyway; the findings are what is wanted,
   * and they always fit.
   */
  const TOO_LONG_TO_REWRITE = 4_000;
  const longSection = input.body.length > TOO_LONG_TO_REWRITE;

  /*
   * One retry, because a structured answer that fails to parse usually parses the second time.
   *
   * Two sections of this pharmacy's manual failed every pass, and neither was long enough to have
   * been cut off — so truncation was not the cause, and a single retry would have quietly fixed
   * whatever was. Retrying once is cheap; a section that can never be read costs the whole queue.
   */
  const ask = async () =>
    c.messages.parse({
      model,
      // Headroom, because the answer that does not fit does not come back short — it comes back
      // as an unparseable fragment, which is a far worse failure than a long reply.
      max_tokens: 32_000,
    system:
      "You audit sections of an independent Kansas community pharmacy's policy and procedure manual against Kansas " +
      "Board of Pharmacy regulations (K.S.A. 65-16xx, K.A.R. 68-x), DEA requirements (21 CFR 1300-1317), HIPAA " +
      "(45 CFR 160/164), OSHA (29 CFR 1910), and CMS Part D requirements where they reach the pharmacy counter.\n\n" +
      "Four rules override everything else.\n\n" +
      "First: a section that is adequate gets the verdict ok and no findings. Do not manufacture work. A reviewer " +
      "who finds something everywhere is one nobody reads by the third page.\n\n" +
      "Second: never invent a fact about this pharmacy. If fixing something needs a detail you were not given — a " +
      "frequency, a person, a threshold, a piece of equipment — leave suggestedBody empty and say in the finding what " +
      "the pharmacy has to decide.\n\n" +
      "Third: a manual is a standard an inspector holds the pharmacy to. Text claiming a practice the pharmacy does " +
      "not follow is worse than a gap, because it is a finding the pharmacy wrote for itself. Where the text claims " +
      "something the compliance system contradicts, that is a conflict and it matters.\n\n" +
      "Fourth: where the compliance system already performs a procedure, the manual should refer to it rather than " +
      "describe it a second time. Two descriptions of one procedure drift apart, and the one in the manual is the " +
      "one that goes stale.\n\n" +
      "Cite a regulation only where it genuinely governs the sentence, and cite it exactly. Plain prose in " +
      "suggestedBody: short sentences, no headings, no bullet characters, no markdown.",
    messages: [
      {
        role: "user",
        content:
          `The pharmacy: ${input.context}\n\n` +
          `What the compliance system already does:\n${input.siteDoes || "(nothing recorded)"}\n\n` +
          `Section title: ${input.title}\n\n` +
          (longSection
            ? "This section is long. Leave suggestedBody empty whatever you find — it is too long to replace " +
              "wholesale, and the findings are what is wanted. Describe the change in the finding instead.\n\n"
            : "") +
          `Current text:\n${input.body || "(empty)"}`,
      },
    ],
      output_config: { format: zodOutputFormat(PolicyReview) },
    });

  /*
   * The SDK throws, rather than returning nothing, when the answer is not valid JSON — "Unterminated
   * string in JSON at position 2885" was the message on three sections of this manual, none of them
   * long enough to have been cut off. A thrown parse error skipped the retry below entirely and
   * surfaced as the raw SDK text. So a parse failure is caught, retried once, and if it fails
   * again reported in words the pharmacist can act on.
   */
  const attempt = async () => {
    try {
      return { res: await ask(), parseError: null as string | null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/parse|JSON/i.test(msg)) return { res: null, parseError: msg };
      throw e;
    }
  };
  let { res, parseError } = await attempt();
  // A truncated answer will truncate again; anything else is worth one more go.
  if (!res?.parsed_output && res?.stop_reason !== "max_tokens" && res?.stop_reason !== "refusal") {
    ({ res, parseError } = await attempt());
  }
  /*
   * The last resort: ask for less.
   *
   * Three sections of this pharmacy's manual failed every pass with an unterminated string — the
   * answer running out part-way through, which is what a structured reply does when it does not
   * fit. Retrying the same question produced the same answer. So the question gets smaller: the
   * findings alone, at most four, each a couple of sentences, and no replacement text at all.
   * Findings without a rewrite are most of the value and a fraction of the length, and a section
   * that yields four real findings is far better than one that yields an error for ever.
   */
  if (!res?.parsed_output) {
    try {
      const small = await c.messages.parse({
        model,
        max_tokens: 8_000,
        system:
          "You audit one section of a Kansas community pharmacy's policy manual against Kansas Board of Pharmacy " +
          "regulations, DEA requirements (21 CFR 1300-1317), HIPAA and OSHA. Report at most the four most important " +
          "problems, each in two sentences at most. Do not rewrite the section. A section that is adequate gets no " +
          "findings at all — do not manufacture work. Never invent a fact about this pharmacy.",
        messages: [
          {
            role: "user",
            content: `The pharmacy: ${input.context}\n\nSection title: ${input.title}\n\nCurrent text:\n${input.body.slice(0, 30_000)}`,
          },
        ],
        output_config: { format: zodOutputFormat(PolicyReviewBrief) },
      });
      if (small.parsed_output) {
        await logUsage("ai.policy.review.brief", ctx.userId, ctx.userName, small.usage, input.title.slice(0, 120));
        return {
          verdict: small.parsed_output.findings.length === 0 ? "ok" : "gap",
          // No replacement text, which is exactly what an empty suggestedBody means everywhere
          // else: the reviewer had a finding and could not write the fix.
          findings: small.parsed_output.findings.map((f) => ({ ...f, severity: f.severity, suggestedBody: "" })),
          suggestedBody: "",
        } as PolicyReviewT;
      }
    } catch {
      // Fall through to the error below, which now names both attempts.
    }
  }

  if (!res) {
    throw new Error(
      `The review of “${input.title}” came back twice in a form this site could not read (${(parseError ?? "").split("\n")[0].slice(0, 160)}), ` +
        "and a shorter question failed too. The rest of the manual is unaffected. This section is long enough that " +
        "splitting it into smaller ones is worth doing anyway — nobody reads a four-thousand-word policy either.",
    );
  }

  /*
   * Say what actually went wrong, and name the reason the API gave.
   *
   * "Claude returned an unreadable answer" was the message for every failure here, which told the
   * pharmacist nothing and told whoever had to fix it less. Two sections failed every pass and
   * neither was long enough to have been cut off, so the cause was something this message was
   * hiding. It carries the stop reason now, so the next one diagnoses itself.
   */
  if (!res.parsed_output) {
    if (res.stop_reason === "max_tokens") {
      throw new Error(
        `The review of “${input.title}” did not fit in one answer. The section is about ${Math.round(input.body.length / 5)} words; ` +
          "split it into smaller sections and each part will read on its own.",
      );
    }
    if (res.stop_reason === "refusal") throw new Error(`Claude declined to review “${input.title}”.`);
    throw new Error(
      `The review of “${input.title}” came back in a form this site could not read, twice ` +
        `(the API stopped with: ${res.stop_reason ?? "no reason given"}). The rest of the manual is unaffected.`,
    );
  }
  await logUsage("ai.policy.review", ctx.userId, ctx.userName, res.usage, input.title.slice(0, 120));
  return res.parsed_output;
}

const PolicyDraft = z.object({
  body: z.string().describe("The revised policy text, in full, ready to replace what was there."),
  changed: z
    .string()
    .describe("What was changed and why, in two or three sentences addressed to the pharmacist-in-charge."),
  concerns: z
    .array(z.string())
    .describe(
      "Anything the pharmacy must decide or verify that the text assumes. Empty when there is nothing. Never invent a fact about this pharmacy to fill a gap.",
    ),
});

export type PolicyDraftT = z.infer<typeof PolicyDraft>;

/**
 * Helps write or revise one section of the policy manual.
 *
 * The instruction that matters most is the one about invention. A policy manual is a standard the
 * pharmacy is held to, so a plausible-sounding sentence describing a practice the pharmacy does
 * not follow is worse than a gap — it is a finding somebody wrote for themselves. Anything the
 * model would have to make up comes back as a concern to decide rather than as prose to sign.
 */
export async function draftPolicy(
  input: {
    title: string;
    body: string;
    instruction: string;
    /** What this pharmacy is, so the text is about them rather than about pharmacies. */
    context: string;
    /** What the site actually does, where it bears on this section. */
    siteDoes: string;
  },
  ctx: { userId: string; userName: string },
): Promise<PolicyDraftT> {
  if (MOCK) {
    return {
      body: `${input.body}\n\n[Draft: ${input.instruction}]`,
      changed: "Mock response — no API key is configured, so nothing was sent anywhere.",
      concerns: [],
    };
  }

  const { client: c, model } = await client();
  const res = await c.messages.parse({
    model,
    // A draft returns the whole section. The old limit of 4,000 truncated long ones, and a
    // truncated structured answer comes back unparseable rather than short.
    max_tokens: 12_000,
    system:
      "You revise sections of a community pharmacy's policy and procedure manual. Three rules override everything else.\n\n" +
      "First: never invent a fact about this pharmacy. If the text needs a detail you have not been given — a frequency, " +
      "a person, a piece of equipment, a threshold — do not choose one. Write the sentence around it and raise it as a " +
      "concern for the pharmacist-in-charge to decide.\n\n" +
      "Second: a manual is a standard an inspector holds the pharmacy to. Never write that the pharmacy does something " +
      "unless you have been told it does. Aspirational text is worse than a gap, because it becomes a finding the " +
      "pharmacy wrote for itself.\n\n" +
      "Third: where the compliance system already performs a procedure, the manual should refer to it rather than " +
      "describe it a second time. Two descriptions of one procedure drift.\n\n" +
      "Write in plain, direct prose. Short sentences. No headings inside the body, no bullet characters, no markdown. " +
      "Cite a regulation only where it genuinely governs the sentence, and cite it exactly.",
    messages: [
      {
        role: "user",
        content:
          `The pharmacy: ${input.context}\n\n` +
          `What the compliance system already does that bears on this section:\n${input.siteDoes || "(nothing recorded)"}\n\n` +
          `Section title: ${input.title}\n\n` +
          `Current text:\n${input.body || "(empty — this section has a heading and no content)"}\n\n` +
          `What is wanted: ${input.instruction}`,
      },
    ],
    output_config: { format: zodOutputFormat(PolicyDraft) },
  });
  if (!res.parsed_output) {
    if (res.stop_reason === "max_tokens") {
      throw new Error(
        `The draft of “${input.title}” did not fit in one answer. Split the section into smaller ones and each part ` +
          "will write on its own.",
      );
    }
    if (res.stop_reason === "refusal") throw new Error(`Claude declined to draft “${input.title}”.`);
    throw new Error(`Claude returned an answer that could not be read for “${input.title}”. Try again.`);
  }
  await logUsage("ai.policy.draft", ctx.userId, ctx.userName, res.usage, input.title.slice(0, 120));
  return res.parsed_output;
}

/**
 * Reading a supplier's returned-goods policy, which is prose rather than a table.
 *
 * The rebate breakdown is read by rule because it is a grid of figures that checks itself. A
 * returns policy is neither: it is paragraphs of conditions, and two of them — McKesson's and
 * IPC's — do not even yield readable text to the extractor, coming back as twenty-seven characters
 * of fragments. So the document goes to the model as a document, which is what the model is for.
 *
 * What comes back is a proposal, not a fact. Every field is quoted back to the sentence it came
 * from so the pharmacist can check it against the page in front of him, and nothing is stored until
 * he says so. A returns policy decides whether a bottle is worth sending back or throwing away;
 * a figure nobody checked is not worth having.
 */
const ReadReturnPolicy = z.object({
  windowMonthsBeforeExpiry: z.number().nullable().describe("Earliest a product can go back, in months before its expiry date. Null where the policy does not say."),
  windowMonthsAfterExpiry: z.number().nullable().describe("Latest, in months after expiry. 0 where nothing goes back after expiry. Null where not stated."),
  creditSteps: z
    .array(z.object({ monthsToExpiryMin: z.number(), creditPercent: z.number() }))
    .describe("Credit as a percentage of what was paid, by how many months remain to expiry. Empty where the policy states one flat rate or none."),
  restockingFeePercent: z.number().nullable(),
  nonReturnable: z.array(z.string()).describe("Categories the supplier will not take back, in the policy's own words."),
  reverseDistributor: z.string().nullable(),
  notes: z.string().nullable().describe("Anything else that changes what a return is worth: deadlines for a return authorisation, who pays freight, minimum values."),
  quotes: z
    .array(z.object({ field: z.string(), sentence: z.string() }))
    .describe("For every field you filled in, the sentence from the policy it came from, quoted exactly. This is how the pharmacist checks you."),
  unclear: z.array(z.string()).describe("Anything the policy does not settle. Leave the field null and say so here rather than guessing."),
});
export type ReadReturnPolicyT = z.infer<typeof ReadReturnPolicy>;

export async function readReturnPolicy(
  pdf: Buffer,
  supplier: string,
  ctx: { userId: string; userName: string },
): Promise<ReadReturnPolicyT> {
  if (MOCK) return { windowMonthsBeforeExpiry: null, windowMonthsAfterExpiry: null, creditSteps: [], restockingFeePercent: null, nonReturnable: [], reverseDistributor: null, notes: null, quotes: [], unclear: [] };
  const { client: c, model } = await client();
  const res = await c.messages.parse({
    model,
    max_tokens: 8_000,
    thinking: { type: "adaptive" },
    system:
      "You read a pharmaceutical wholesaler's returned-goods policy and set out its terms. Quote the sentence behind " +
      "every figure you give, exactly as written. Where the policy does not settle something, leave the field null " +
      "and say so in 'unclear' — never infer a number that is not there. Dating windows are often written as " +
      "'current month plus six months', which means a product is returnable while at least six months of shelf life " +
      "remain; convert such phrasing to months and quote the sentence.",
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
          { type: "text", text: `This is ${supplier}'s returned goods policy. Set out its terms.` },
        ],
      },
    ],
    output_config: { effort: "high", format: zodOutputFormat(ReadReturnPolicy) },
  });
  await logUsage("ai.read_return_policy", ctx.userId, ctx.userName, res.usage, supplier);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to read that document.");
  if (!res.parsed_output) throw new Error("That policy could not be read into terms. It may be a scan of poor quality.");
  return res.parsed_output;
}

