"use server";

import { asked } from "@/lib/ai-gate";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { INCIDENT_TYPES } from "@/db/schema";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { storeFile } from "@/lib/files";
import { capsToEvaluate, carriedForward, encodeRxNumbers, incidentsInPeriod, isThin, periodFromDue } from "@/lib/cqi";
import { todayIso } from "@/lib/dates";
import { describeError, draftCapEvaluations, extractPacket, hasApiKey } from "@/lib/ai";
import { roleNames, writeIncidentAnalysis, writeIncidentAnalysisInBackground } from "@/lib/cqi-ai";

function fail(path: string, msg: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(msg)}`);
}

/** Upload a scanned packet, have Claude read it, and store the extraction for review. */
export async function importPacket(fd: FormData) {
  const user = await requireManager();
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) fail("/cqi/import", "Choose the scanned packet (PDF).");
  if (file.type !== "application/pdf") fail("/cqi/import", "Upload a PDF scan.");
  let stored;
  try {
    stored = await storeFile(file);
  } catch (e) {
    fail("/cqi/import", e instanceof Error ? e.message : "Upload failed.");
  }
  const docId = newId();
  await db.insert(schema.documents).values({
    id: docId,
    category: "cqi_summary",
    title: `CQI packet — ${file.name.slice(0, 120)}`,
    fileName: file.name.slice(0, 200),
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    uploadedBy: user.id,
  });
  const importId = newId();
  await db.insert(schema.cqiImports).values({ id: importId, documentId: docId, createdBy: user.id });
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await asked(user.name, "Reading a CQI packet", () => extractPacket(buf, { userId: user.id, userName: user.name }));
    await db.update(schema.cqiImports).set({ resultJson: JSON.stringify(result) }).where(eq(schema.cqiImports.id, importId));
  } catch (e) {
    await db.update(schema.cqiImports).set({ status: "failed", error: describeError(e) }).where(eq(schema.cqiImports.id, importId));
    fail("/cqi/import", describeError(e));
  }
  await audit({ action: "cqi.import.extracted", userId: user.id, userName: user.name, entity: "cqi_import", entityId: importId, details: file.name });
  revalidatePath("/cqi");
  redirect(`/cqi/import/${importId}`);
}

/** Apply a reviewed extraction: create historical summaries, incidents, CAP reviews. */
export async function applyImport(id: string, fd: FormData) {
  const user = await requireManager();
  const imp = await db.query.cqiImports.findFirst({ where: eq(schema.cqiImports.id, id) });
  if (!imp) fail("/cqi/import", "Import not found.");
  if (imp.status === "applied") redirect("/cqi");
  const people = await db.query.people.findMany();
  const findPerson = (name: string | null | undefined) => {
    if (!name) return null;
    const n = name.trim().toLowerCase();
    return (
      people.find((p) => `${p.firstName} ${p.lastName}`.toLowerCase() === n) ??
      people.find((p) => n.includes(p.lastName.toLowerCase()) && n.includes(p.firstName.toLowerCase())) ??
      people.find((p) => p.lastName.toLowerCase() === n || p.firstName.toLowerCase() === n) ??
      null
    );
  };

  // Summaries (historical, final) — from the form's summary rows
  const summaryIds = new Map<string, string>(); // dueOn -> id
  const nSum = Number(fd.get("summary_count") ?? 0);
  for (let i = 0; i < nSum; i++) {
    if (!fd.get(`sum_${i}_include`)) continue;
    const dueOn = String(fd.get(`sum_${i}_dueOn`) ?? "");
    if (!/^\d{4}-(02|04|06|08|10|12)-15$/.test(dueOn)) continue;
    const { periodStart, periodEnd } = periodFromDue(dueOn);
    let s = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.periodStart, periodStart) });
    if (!s) {
      const sid = newId();
      await db.insert(schema.cqiSummaries).values({
        id: sid,
        periodStart,
        periodEnd,
        dueOn,
        isNullReport: Boolean(fd.get(`sum_${i}_isNull`)),
        isHistorical: true,
        status: "final",
        communicatedOn: String(fd.get(`sum_${i}_communicatedOn`) ?? "") || null,
        communicationMethod: String(fd.get(`sum_${i}_method`) ?? "") || null,
        preparedByPersonId: findPerson(String(fd.get(`sum_${i}_pic`) ?? ""))?.id ?? null,
        finalizedAt: new Date().toISOString(),
        finalizedBy: user.id,
      });
      s = (await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, sid) }))!;
    }
    summaryIds.set(dueOn, s.id);
  }
  // Attach the scanned packet to the first summary it covers.
  const firstSummaryId = [...summaryIds.values()][0];
  if (firstSummaryId) await db.update(schema.documents).set({ cqiSummaryId: firstSummaryId, title: `CQI packet (scanned) — ${[...summaryIds.keys()].join(", ")}` }).where(eq(schema.documents.id, imp.documentId));

  // Incidents
  const nInc = Number(fd.get("incident_count") ?? 0);
  const toWrite: string[] = [];
  let created = 0;
  for (let i = 0; i < nInc; i++) {
    if (!fd.get(`inc_${i}_include`)) continue;
    const g = (k: string) => String(fd.get(`inc_${i}_${k}`) ?? "").trim();
    const reportCreatedOn = g("reportCreatedOn");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportCreatedOn)) fail(`/cqi/import/${id}`, `Incident ${i + 1} needs a "report created" date.`);
    const type = (INCIDENT_TYPES as readonly string[]).includes(g("type")) ? (g("type") as (typeof INCIDENT_TYPES)[number]) : "other";
    const next = (await db.select({ n: sql<number>`coalesce(max(${schema.cqiIncidents.incidentNumber}), 0) + 1` }).from(schema.cqiIncidents))[0].n;
    const incId = newId();
    const employees: { personId: string; reviewedOn: string | null; reviewedByPersonId: string | null }[] = [];
    const unmatched: string[] = [];
    for (let e = 0; e < 10; e++) {
      const pid = g(`emp_${e}_personId`);
      const name = g(`emp_${e}_name`);
      const reviewedBy = g(`emp_${e}_reviewedBy`);
      const p = pid ? people.find((x) => x.id === pid) ?? null : findPerson(name);
      if (p) employees.push({ personId: p.id, reviewedOn: g(`emp_${e}_reviewedOn`) || null, reviewedByPersonId: (people.find((x) => x.id === reviewedBy) ?? findPerson(reviewedBy))?.id ?? null });
      else if (name) unmatched.push(name);
    }
    let rxNumbersEnc: string | null = null;
    try {
      rxNumbersEnc = encodeRxNumbers(g("rxNumbers"));
    } catch (e) {
      fail(`/cqi/import/${id}`, e instanceof Error ? e.message : "Encryption key missing.");
    }
    await db.insert(schema.cqiIncidents).values({
      id: incId,
      incidentNumber: next,
      occurredOn: g("occurredOn") || reportCreatedOn,
      reportCreatedOn,
      type,
      typeOther: g("typeOther") || null,
      description: g("description") || "(imported from scanned packet)",
      rxNumbersEnc,
      reviewerPersonId: (people.find((x) => x.id === g("reviewerPersonId")) ?? findPerson(g("reviewerName")))?.id ?? null,
      reviewStartedOn: g("reviewStartedOn") || null,
      reviewCompletedOn: g("reviewCompletedOn") || null,
      employeeReviews: JSON.stringify(employees),
      employeeCommunication: unmatched.length ? `Personnel named on the scanned form not matched to a staff record: ${unmatched.join(", ")}` : null,
      rootCauseAnalysis: g("rootCauseAnalysis") || null,
      correctiveActionPlan: g("correctiveActionPlan") || null,
      capImplementedOn: g("capImplementedOn") || null,
      externalReportRef: "Imported from scanned CQI packet",
      createdBy: user.id,
    });
    // CAP reviews from the scan
    for (let r = 0; r < 2; r++) {
      const due = g(`cap_${r}_summaryDueOn`);
      const eff = g(`cap_${r}_effective`);
      const comments = g(`cap_${r}_comments`);
      if (!due && !eff && !comments) continue;
      let sid = summaryIds.get(due);
      if (!sid && /^\d{4}-(02|04|06|08|10|12)-15$/.test(due)) {
        const { periodStart, periodEnd } = periodFromDue(due);
        const existing = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.periodStart, periodStart) });
        if (existing) sid = existing.id;
        else {
          sid = newId();
          await db.insert(schema.cqiSummaries).values({ id: sid, periodStart, periodEnd, dueOn: due, isHistorical: true, status: "final", finalizedAt: new Date().toISOString(), finalizedBy: user.id });
        }
        summaryIds.set(due, sid);
      }
      if (!sid) continue;
      await db.insert(schema.cqiCapReviews).values({ id: newId(), incidentId: incId, summaryId: sid, reviewNumber: r + 1, effective: eff === "yes" ? true : eff === "no" ? false : null, comments: comments || null });
    }
    // Queue the write-up rather than doing it inside this request: a full analysis takes a minute or
    // two per incident, and a browser giving up mid-way used to spend the call and show nothing.
    if (fd.get(`inc_${i}_strengthen`)) {
      await db.update(schema.cqiIncidents).set({ aiState: "queued", aiError: null }).where(eq(schema.cqiIncidents.id, incId));
      toWrite.push(incId);
    }
    created++;
  }
  await db.update(schema.cqiImports).set({ status: "applied", appliedAt: new Date().toISOString() }).where(eq(schema.cqiImports.id, id));
  await audit({ action: "cqi.import.applied", userId: user.id, userName: user.name, entity: "cqi_import", entityId: id, details: `${created} incident(s), ${summaryIds.size} summary period(s)` });
  revalidatePath("/cqi");
  revalidatePath("/cqi/incidents");
  revalidatePath("/");
  if (toWrite.length > 0) {
    after(async () => {
      for (const incId of toWrite) await writeIncidentAnalysisInBackground(incId, { id: user.id, name: user.name });
    });
    redirect(`/cqi/incidents?drafting=${toWrite.length}`);
  }
  redirect(`/cqi/incidents?saved=1`);
}

export async function discardImport(id: string) {
  const user = await requireManager();
  await db.delete(schema.cqiImports).where(eq(schema.cqiImports.id, id));
  await audit({ action: "cqi.import.discard", userId: user.id, userName: user.name, entity: "cqi_import", entityId: id });
  redirect("/cqi/import");
}

/** Write (or strengthen) the RCA and CAP on an incident with Claude. Previous text is kept for restore. */
export async function suggestForIncident(id: string, fd: FormData) {
  const user = await requireManager();
  const here = `/cqi/incidents/${id}`;
  const extra = String(fd.get("extraContext") ?? "").trim() || null;
  try {
    await writeIncidentAnalysis(id, extra, user);
  } catch (e) {
    fail(here, describeError(e));
  }
  await audit({ action: "cqi.incident.ai_rca_cap", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: id });
  revalidatePath(here);
  redirect(`${here}?ai=1`);
}

/** Put back the RCA/CAP text that was there before Claude rewrote it. */
export async function restoreBeforeAi(id: string) {
  const user = await requireManager();
  const inc = await db.query.cqiIncidents.findFirst({ where: eq(schema.cqiIncidents.id, id) });
  if (!inc) fail("/cqi/incidents", "Incident not found.");
  await db
    .update(schema.cqiIncidents)
    .set({ rootCauseAnalysis: inc.rcaBeforeAi, correctiveActionPlan: inc.capBeforeAi, rcaBeforeAi: null, capBeforeAi: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.cqiIncidents.id, id));
  await audit({ action: "cqi.incident.ai_restore", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: id });
  revalidatePath(`/cqi/incidents/${id}`);
  redirect(`/cqi/incidents/${id}?saved=1`);
}

/** Rewrites every incident whose analysis is missing or too thin to sign. Used after importing old packets. */
export async function strengthenThinIncidents() {
  const user = await requireManager();
  const here = "/cqi/incidents";
  const all = await db.query.cqiIncidents.findMany({ orderBy: (i, { desc }) => [desc(i.reportCreatedOn)] });
  const thin = all.filter((i) => isThin(i.rootCauseAnalysis, i.correctiveActionPlan));
  if (thin.length === 0) fail(here, "Every incident already has a full root cause analysis and corrective action plan.");
  const batch = thin.slice(0, 20);
  for (const inc of batch) {
    await db.update(schema.cqiIncidents).set({ aiState: "queued", aiError: null }).where(eq(schema.cqiIncidents.id, inc.id));
  }
  await audit({ action: "cqi.incidents.ai_bulk_strengthen", userId: user.id, userName: user.name, details: `${batch.length} queued` });
  // One at a time in the background — each analysis takes a minute or two and the page must come back now.
  after(async () => {
    for (const inc of batch) await writeIncidentAnalysisInBackground(inc.id, { id: user.id, name: user.name });
  });
  revalidatePath(here);
  revalidatePath("/cqi");
  redirect(`${here}?drafting=${batch.length}`);
}

/** Draft CAP effectiveness comments for every CAP due on a summary that has no comment yet. */
export async function draftEvaluationsForSummary(id: string) {
  const user = await requireManager();
  const here = `/cqi/summaries/${id}`;
  try {
    await draftEvaluationsFor(id, user);
  } catch (e) {
    fail(here, describeError(e));
  }
  revalidatePath(here);
  redirect(`${here}?ai=1`);
}

async function draftEvaluationsFor(id: string, user: { id: string; name: string }) {
  const summary = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, id) });
  if (!summary) throw new Error("Summary not found.");
  if (summary.status === "final") throw new Error("Reopen the summary before drafting.");
  const caps = await capsToEvaluate(summary.periodStart, summary.periodEnd);
  const mine = await db.query.cqiCapReviews.findMany({ where: eq(schema.cqiCapReviews.summaryId, id) });
  const pending = caps.filter(({ incident, nextReviewNumber }) => {
    const existing = mine.find((r) => r.incidentId === incident.id);
    return !(existing && existing.comments) && nextReviewNumber <= 2;
  });
  if (pending.length === 0) throw new Error("Every corrective action plan on this summary already has an evaluation.");
  const all = await db.query.cqiIncidents.findMany();
  const inputs = pending.map(({ incident: i, reviews: done, nextReviewNumber }) => ({
    incidentNumber: i.incidentNumber,
    type: i.type,
    description: i.description,
    correctiveActionPlan: i.correctiveActionPlan ?? "",
    capImplementedOn: i.capImplementedOn,
    reviewNumber: mine.find((r) => r.incidentId === i.id)?.reviewNumber ?? nextReviewNumber,
    recurrencesSince: all.filter((o) => o.id !== i.id && o.type === i.type && i.capImplementedOn && o.reportCreatedOn > i.capImplementedOn && o.reportCreatedOn <= summary.periodEnd).length,
    priorReview: done.filter((r) => r.summaryId !== id)[0] ? { effective: done[0].effective, comments: done[0].comments } : null,
  }));
  const evals = await asked(user.name, "Drafting CAP evaluations", async () => draftCapEvaluations(inputs, await roleNames(), { userId: user.id, userName: user.name }));
  for (const ev of evals) {
    const p = pending.find((x) => x.incident.incidentNumber === ev.incidentNumber);
    if (!p) continue;
    const existing = mine.find((r) => r.incidentId === p.incident.id);
    if (existing) await db.update(schema.cqiCapReviews).set({ effective: existing.effective ?? ev.effective, comments: ev.comments }).where(eq(schema.cqiCapReviews.id, existing.id));
    else await db.insert(schema.cqiCapReviews).values({ id: newId(), incidentId: p.incident.id, summaryId: id, reviewNumber: p.nextReviewNumber, effective: ev.effective, comments: ev.comments });
  }
}

/**
 * Open the pharmacist's review of an incident and have Claude draft the analysis for it.
 *
 * K.A.R. 68-19-1 puts the root cause analysis and corrective action inside the pharmacist's review,
 * which begins within 7 days of the report. So nothing is drafted when an incident is logged — only
 * here, when the pharmacist starts the review, and always as a draft the pharmacist then adopts.
 */
export async function startReview(id: string) {
  const user = await requireManager();
  const here = `/cqi/incidents/${id}`;
  const inc = await db.query.cqiIncidents.findFirst({ where: eq(schema.cqiIncidents.id, id) });
  if (!inc) fail("/cqi/incidents", "Incident not found.");
  const reviewer = await reviewerFor(user);
  const ready = await hasApiKey();
  await db
    .update(schema.cqiIncidents)
    .set({
      reviewStartedOn: inc.reviewStartedOn ?? todayIso(),
      reviewerPersonId: inc.reviewerPersonId ?? reviewer,
      aiState: ready ? "queued" : "idle",
      aiError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.cqiIncidents.id, id));
  await audit({ action: "cqi.incident.review_started", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: id });
  if (ready) after(() => writeIncidentAnalysisInBackground(id, { id: user.id, name: user.name }));
  revalidatePath(here);
  revalidatePath("/cqi");
  revalidatePath("/cqi/incidents");
  redirect(ready ? `${here}?drafting=1` : `${here}?saved=1`);
}

/**
 * One button for the whole summary. Starts and drafts every review the period still needs, drafts
 * the effectiveness evaluations for the corrective action plans due, and leaves everything as a draft
 * for the PIC to read, correct and sign.
 */
export async function prepareSummary(id: string) {
  const user = await requireManager();
  const here = `/cqi/summaries/${id}`;
  const summary = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, id) });
  if (!summary) fail("/cqi", "Summary not found.");
  if (summary.status === "final") fail(here, "This summary is finalized. Reopen it first.");
  if (!(await hasApiKey())) fail(here, "Add your Anthropic API key under Settings → Claude to have the summary prepared for you.");
  const reviewer = await reviewerFor(user);

  // Every incident in the period, plus anything an earlier period left unfinished.
  const inPeriod = await incidentsInPeriod(summary.periodStart, summary.periodEnd);
  const carried = await carriedForward(summary.periodStart);
  const needing = [...inPeriod, ...carried.openReviews, ...carried.thin].filter(
    (i, idx, arr) => arr.findIndex((x) => x.id === i.id) === idx && (isThin(i.rootCauseAnalysis, i.correctiveActionPlan) || !i.reviewStartedOn),
  );

  for (const inc of needing) {
    await db
      .update(schema.cqiIncidents)
      .set({ reviewStartedOn: inc.reviewStartedOn ?? todayIso(), reviewerPersonId: inc.reviewerPersonId ?? reviewer, aiState: "queued", aiError: null })
      .where(eq(schema.cqiIncidents.id, inc.id));
  }
  await audit({ action: "cqi.summary.prepare", userId: user.id, userName: user.name, entity: "cqi_summary", entityId: id, details: `${needing.length} review(s) queued` });

  // Draft them one at a time after the page has already come back, then the CAP evaluations.
  after(async () => {
    for (const inc of needing) await writeIncidentAnalysisInBackground(inc.id, { id: user.id, name: user.name });
    try {
      await draftEvaluationsFor(id, user);
    } catch {
      /* the evaluation drafts are a convenience; the PIC can still press the button on the summary */
    }
  });

  revalidatePath(here);
  revalidatePath("/cqi");
  revalidatePath("/cqi/incidents");
  redirect(`${here}?preparing=${needing.length}`);
}

/** The person recorded as conducting the review: the signed-in user if they are staff, otherwise the PIC. */
async function reviewerFor(user: { personId: string | null }): Promise<string | null> {
  if (user.personId) return user.personId;
  const pic = await db.query.people.findFirst({ where: eq(schema.people.isPic, true) });
  return pic?.id ?? null;
}
