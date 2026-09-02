import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { INCIDENT_TYPES } from "@/db/schema";
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

async function client(): Promise<{ client: Anthropic; model: string }> {
  const s = await getSettings();
  if (!s.anthropic_api_key_enc) throw new AiNotConfiguredError();
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

// ── Drafting RCA / CAP for an incident ───────────────────────────────
const Suggestion = z.object({
  rootCauseAnalysis: z.string(),
  correctiveActionPlan: z.string(),
});

export async function suggestRcaCap(
  input: { type: string; typeOther: string | null; description: string; reachedPatient: boolean | null; priorSimilar: { description: string; correctiveActionPlan: string | null; effective: boolean | null }[] },
  redactNames: { name: string; role: string }[],
  ctx: { userId: string; userName: string },
): Promise<z.infer<typeof Suggestion>> {
  if (MOCK) return { rootCauseAnalysis: "Mock RCA: look-alike packaging and no independent verification step.", correctiveActionPlan: "Mock CAP: add shelf separators and a bar-code verification at fill." };
  const { client: c, model } = await client();
  const prior = input.priorSimilar
    .slice(0, 5)
    .map((p, i) => `Prior incident ${i + 1}: ${redactText(p.description, redactNames)}\n  CAP: ${p.correctiveActionPlan ? redactText(p.correctiveActionPlan, redactNames) : "(none)"}\n  Effective: ${p.effective === true ? "yes" : p.effective === false ? "no" : "not yet evaluated"}`)
    .join("\n");
  const res = await c.messages.parse({
    model,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(Suggestion) },
    system:
      "You help a Kansas pharmacist-in-charge complete Form C-650 for the pharmacy's continuous quality improvement program (K.A.R. 68-19-1). Write a root cause analysis that examines the issues and processes that led to the incident (not blame), and a corrective action plan listing concrete measures to prevent recurrence, in the plain, specific voice a PIC would sign. 3–6 sentences each. If prior similar incidents show a CAP that was not effective, propose something different.",
    messages: [
      {
        role: "user",
        content: `Incident type: ${input.type}${input.typeOther ? ` (${input.typeOther})` : ""}\nReached the patient: ${input.reachedPatient === true ? "yes" : input.reachedPatient === false ? "no" : "unknown"}\nWhat happened: ${redactText(input.description, redactNames)}\n${prior ? `\nSimilar prior incidents at this pharmacy:\n${prior}` : ""}`,
      },
    ],
  });
  await logUsage("ai.suggest_rca_cap", ctx.userId, ctx.userName, res.usage, `model=${res.model}`);
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (!res.parsed_output) throw new Error("Claude returned an unreadable answer. Try again.");
  return res.parsed_output;
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
