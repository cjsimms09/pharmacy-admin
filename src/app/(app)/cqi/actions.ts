"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { INCIDENT_TYPES } from "@/db/schema";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { encodeRxNumbers, incidentsInPeriod, periodFromDue } from "@/lib/cqi";
import { storeFile } from "@/lib/files";
import { todayIso } from "@/lib/dates";

const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).transform((v) => (v ? v : null));
const reqDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optText = (max = 5000) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));
const tri = z.string().optional().transform((v) => (v === "yes" ? true : v === "no" ? false : null));

function fail(path: string, msg: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(msg)}`);
}

const incidentSchema = z.object({
  occurredOn: reqDate,
  reportCreatedOn: reqDate,
  type: z.enum(INCIDENT_TYPES),
  typeOther: optText(200),
  description: z.string().trim().min(1).max(5000),
  rxNumbers: z.string().trim().max(2000).optional().default(""),
  reachedPatient: tri,
  reviewerPersonId: z.string().optional().transform((v) => (v ? v : null)),
  reviewStartedOn: optDate,
  reviewCompletedOn: optDate,
  employeeCommunication: optText(),
  rootCauseAnalysis: optText(),
  correctiveActionPlan: optText(),
  capImplementedOn: optDate,
  externalReportRef: optText(300),
});

function employeeReviewsFrom(fd: FormData) {
  const out: { personId: string; reviewedOn: string | null; reviewedByPersonId: string | null }[] = [];
  for (let i = 0; i < 8; i++) {
    const personId = String(fd.get(`emp_${i}_personId`) ?? "");
    if (!personId) continue;
    const reviewedOn = String(fd.get(`emp_${i}_reviewedOn`) ?? "") || null;
    const reviewedByPersonId = String(fd.get(`emp_${i}_reviewedBy`) ?? "") || null;
    out.push({ personId, reviewedOn, reviewedByPersonId });
  }
  return out;
}

export async function createIncident(fd: FormData) {
  const user = await requireManager();
  const parsed = incidentSchema.safeParse(Object.fromEntries(fd.entries()));
  if (!parsed.success) fail("/cqi/incidents/new", "Check the form: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const { rxNumbers, ...data } = parsed.data;
  if (/\b(dob|date of birth|phone|address)\b/i.test(data.description)) fail("/cqi/incidents/new", "The description looks like it may contain patient information. Describe the incident without identifying the patient.");
  let rxNumbersEnc: string | null;
  try {
    rxNumbersEnc = encodeRxNumbers(rxNumbers);
  } catch (e) {
    fail("/cqi/incidents/new", e instanceof Error ? e.message : "Encryption key missing.");
  }
  const next = (await db.select({ n: sql<number>`coalesce(max(${schema.cqiIncidents.incidentNumber}), 0) + 1` }).from(schema.cqiIncidents))[0].n;
  const id = newId();
  await db.insert(schema.cqiIncidents).values({
    id,
    incidentNumber: next,
    ...data,
    rxNumbersEnc,
    employeeReviews: JSON.stringify(employeeReviewsFrom(fd)),
    createdBy: user.id,
  });
  await audit({ action: "cqi.incident.create", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: id, details: `#${next} ${data.type}` });
  revalidatePath("/cqi");
  revalidatePath("/");
  redirect(`/cqi/incidents/${id}?saved=1`);
}

export async function updateIncident(id: string, fd: FormData) {
  const user = await requireManager();
  const parsed = incidentSchema.safeParse(Object.fromEntries(fd.entries()));
  const here = `/cqi/incidents/${id}`;
  if (!parsed.success) fail(here, "Check the form: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const { rxNumbers, ...data } = parsed.data;
  let rxNumbersEnc: string | null;
  try {
    rxNumbersEnc = encodeRxNumbers(rxNumbers);
  } catch (e) {
    fail(here, e instanceof Error ? e.message : "Encryption key missing.");
  }
  await db
    .update(schema.cqiIncidents)
    .set({ ...data, rxNumbersEnc, employeeReviews: JSON.stringify(employeeReviewsFrom(fd)), updatedAt: new Date().toISOString() })
    .where(eq(schema.cqiIncidents.id, id));
  await audit({ action: "cqi.incident.update", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: id });
  revalidatePath("/cqi");
  revalidatePath(here);
  revalidatePath("/");
  redirect(`${here}?saved=1`);
}

export async function deleteIncident(id: string) {
  const user = await requireManager();
  await db.delete(schema.cqiIncidents).where(eq(schema.cqiIncidents.id, id));
  await audit({ action: "cqi.incident.delete", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: id });
  revalidatePath("/cqi");
  redirect("/cqi/incidents");
}

/** Create a draft summary for a due date (e.g. 2026-10-15) and pull in the period's incidents. */
export async function createSummary(fd: FormData) {
  const user = await requireManager();
  const dueOn = String(fd.get("dueOn") ?? "");
  if (!/^\d{4}-(02|04|06|08|10|12)-15$/.test(dueOn)) fail("/cqi/summaries/new", "Pick a summary period.");
  const { periodStart, periodEnd } = periodFromDue(dueOn);
  const existing = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.periodStart, periodStart) });
  if (existing) redirect(`/cqi/summaries/${existing.id}`);
  const incidents = await incidentsInPeriod(periodStart, periodEnd);
  const pic = await db.query.people.findFirst({ where: eq(schema.people.isPic, true) });
  const id = newId();
  await db.insert(schema.cqiSummaries).values({
    id,
    periodStart,
    periodEnd,
    dueOn,
    isNullReport: incidents.length === 0,
    incidentIds: JSON.stringify(incidents.map((i) => i.id)),
    preparedByPersonId: pic?.id ?? null,
    preparedOn: todayIso(),
  });
  await audit({ action: "cqi.summary.create", userId: user.id, userName: user.name, entity: "cqi_summary", entityId: id, details: `${periodStart}..${periodEnd}` });
  revalidatePath("/cqi");
  revalidatePath("/");
  redirect(`/cqi/summaries/${id}`);
}

const summarySchema = z.object({
  isNullReport: z.string().optional().transform((v) => v === "on"),
  preparedByPersonId: z.string().optional().transform((v) => (v ? v : null)),
  preparedOn: optDate,
  communicatedOn: optDate,
  communicationMethod: optText(200),
  additionalNotes: optText(),
  finalize: z.string().optional(),
});

export async function updateSummary(id: string, fd: FormData) {
  const user = await requireManager();
  const here = `/cqi/summaries/${id}`;
  const parsed = summarySchema.safeParse(Object.fromEntries(fd.entries()));
  if (!parsed.success) fail(here, "Check the form.");
  const { finalize, ...data } = parsed.data;
  const summary = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, id) });
  if (!summary) fail("/cqi", "Summary not found.");

  // Refresh the incident list from the period (new incidents may have been logged since the draft was created).
  const incidents = await incidentsInPeriod(summary.periodStart, summary.periodEnd);
  const communicatedTo = fd.getAll("communicatedTo").map(String).filter(Boolean);

  // CAP reviews recorded on this summary.
  const capIds = fd.getAll("cap_incident_id").map(String);
  for (const incId of capIds) {
    const eff = String(fd.get(`cap_${incId}_effective`) ?? "");
    const comments = String(fd.get(`cap_${incId}_comments`) ?? "").trim() || null;
    const reviewNumber = Number(fd.get(`cap_${incId}_review_number`) ?? 1);
    const existing = await db.query.cqiCapReviews.findFirst({ where: (r, { and, eq }) => and(eq(r.incidentId, incId), eq(r.summaryId, id)) });
    const effective = eff === "yes" ? true : eff === "no" ? false : null;
    if (existing) await db.update(schema.cqiCapReviews).set({ effective, comments }).where(eq(schema.cqiCapReviews.id, existing.id));
    else if (effective !== null || comments) await db.insert(schema.cqiCapReviews).values({ id: newId(), incidentId: incId, summaryId: id, reviewNumber, effective, comments });
  }

  await db
    .update(schema.cqiSummaries)
    .set({
      ...data,
      isNullReport: incidents.length === 0 ? true : data.isNullReport,
      incidentIds: JSON.stringify(incidents.map((i) => i.id)),
      communicatedTo: JSON.stringify(communicatedTo),
      updatedAt: new Date().toISOString(),
      ...(finalize ? { status: "final" as const, finalizedAt: new Date().toISOString(), finalizedBy: user.id } : {}),
    })
    .where(eq(schema.cqiSummaries.id, id));
  await audit({ action: finalize ? "cqi.summary.finalize" : "cqi.summary.update", userId: user.id, userName: user.name, entity: "cqi_summary", entityId: id });
  revalidatePath("/cqi");
  revalidatePath(here);
  revalidatePath("/");
  redirect(finalize ? `${here}/print` : `${here}?saved=1`);
}

export async function reopenSummary(id: string) {
  const user = await requireManager();
  await db.update(schema.cqiSummaries).set({ status: "draft", finalizedAt: null, finalizedBy: null }).where(eq(schema.cqiSummaries.id, id));
  await audit({ action: "cqi.summary.reopen", userId: user.id, userName: user.name, entity: "cqi_summary", entityId: id });
  revalidatePath(`/cqi/summaries/${id}`);
  redirect(`/cqi/summaries/${id}`);
}

export async function deleteSummary(id: string) {
  const user = await requireManager();
  await db.delete(schema.cqiSummaries).where(eq(schema.cqiSummaries.id, id));
  await audit({ action: "cqi.summary.delete", userId: user.id, userName: user.name, entity: "cqi_summary", entityId: id });
  revalidatePath("/cqi");
  redirect("/cqi");
}

/** Upload a previously completed (signed) summary as a historical record for its period. */
export async function uploadHistoricalSummary(fd: FormData) {
  const user = await requireManager();
  const dueOn = String(fd.get("dueOn") ?? "");
  const file = fd.get("file");
  const isNull = String(fd.get("isNullReport") ?? "") === "on";
  if (!/^\d{4}-(02|04|06|08|10|12)-15$/.test(dueOn)) fail("/cqi", "Pick which summary this is (month and year).");
  if (!(file instanceof File) || file.size === 0) fail("/cqi", "Choose the scanned summary to upload.");
  const { periodStart, periodEnd } = periodFromDue(dueOn);
  let summary = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.periodStart, periodStart) });
  let stored;
  try {
    stored = await storeFile(file);
  } catch (e) {
    fail("/cqi", e instanceof Error ? e.message : "Upload failed.");
  }
  if (!summary) {
    const id = newId();
    await db.insert(schema.cqiSummaries).values({ id, periodStart, periodEnd, dueOn, isNullReport: isNull, isHistorical: true, status: "final", finalizedAt: new Date().toISOString(), finalizedBy: user.id });
    summary = (await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, id) }))!;
  }
  const docId = newId();
  await db.insert(schema.documents).values({
    id: docId,
    category: "cqi_summary",
    title: `CQI Bimonthly Summary — due ${dueOn}`,
    fileName: file.name.slice(0, 200),
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    cqiSummaryId: summary.id,
    effectiveOn: dueOn,
    uploadedBy: user.id,
  });
  await audit({ action: "cqi.summary.upload_historical", userId: user.id, userName: user.name, entity: "cqi_summary", entityId: summary.id, details: dueOn });
  revalidatePath("/cqi");
  revalidatePath("/");
  redirect("/cqi?saved=1");
}
