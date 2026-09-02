"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { INCIDENT_TYPES } from "@/db/schema";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { storeFile } from "@/lib/files";
import { capsToEvaluate, encodeRxNumbers, isThin, periodFromDue } from "@/lib/cqi";
import { describeError, draftCapEvaluations, extractPacket, writeRcaCap } from "@/lib/ai";

function fail(path: string, msg: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(msg)}`);
}

async function roleNames() {
  const people = await db.query.people.findMany();
  return people.map((p) => ({ name: `${p.firstName} ${p.lastName}`, role: p.isPic ? "the PIC" : p.role === "pharmacist" ? "a pharmacist" : p.role === "technician" ? "a technician" : "a staff member" }));
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
    const result = await extractPacket(buf, { userId: user.id, userName: user.name });
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
  const strengthenFailures: string[] = [];
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
    if (fd.get(`inc_${i}_strengthen`)) {
      try {
        await strengthenIncident(incId, null, user);
      } catch (e) {
        const msg = describeError(e);
        strengthenFailures.push(`incident #${next}: ${msg}`);
        await audit({ action: "cqi.incident.ai_rca_cap_failed", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: incId, details: msg });
      }
    }
    created++;
  }
  await db.update(schema.cqiImports).set({ status: "applied", appliedAt: new Date().toISOString() }).where(eq(schema.cqiImports.id, id));
  await audit({ action: "cqi.import.applied", userId: user.id, userName: user.name, entity: "cqi_import", entityId: id, details: `${created} incident(s), ${summaryIds.size} summary period(s)` });
  revalidatePath("/cqi");
  revalidatePath("/cqi/incidents");
  revalidatePath("/");
  if (strengthenFailures.length > 0) {
    redirect(`/cqi/incidents?error=${encodeURIComponent(`Records were created, but Claude could not write the analysis for ${strengthenFailures.length} of them: ${strengthenFailures[0]} — open each incident and use “Write with Claude”.`)}`);
  }
  redirect(`/cqi/incidents?saved=1`);
}

export async function discardImport(id: string) {
  const user = await requireManager();
  await db.delete(schema.cqiImports).where(eq(schema.cqiImports.id, id));
  await audit({ action: "cqi.import.discard", userId: user.id, userName: user.name, entity: "cqi_import", entityId: id });
  redirect("/cqi/import");
}

async function strengthenIncident(incId: string, extraContext: string | null, user: { id: string; name: string }) {
  const inc = await db.query.cqiIncidents.findFirst({ where: eq(schema.cqiIncidents.id, incId) });
  if (!inc) throw new Error("Incident not found.");
  const similar = await db.query.cqiIncidents.findMany({ where: and(eq(schema.cqiIncidents.type, inc.type), ne(schema.cqiIncidents.id, incId)), orderBy: (i, { desc }) => [desc(i.reportCreatedOn)], limit: 5 });
  const reviews = await db.query.cqiCapReviews.findMany();
  const names = await roleNames();
  const out = await writeRcaCap(
    {
      type: inc.type,
      typeOther: inc.typeOther,
      description: inc.description,
      reachedPatient: inc.reachedPatient,
      existingRca: inc.rootCauseAnalysis,
      existingCap: inc.correctiveActionPlan,
      extraContext,
      priorSimilar: similar.map((p) => ({ description: p.description, correctiveActionPlan: p.correctiveActionPlan, effective: reviews.filter((r) => r.incidentId === p.id).sort((a, b) => b.reviewNumber - a.reviewNumber)[0]?.effective ?? null })),
    },
    names,
    { userId: user.id, userName: user.name },
  );
  await db
    .update(schema.cqiIncidents)
    .set({
      rcaBeforeAi: inc.rootCauseAnalysis,
      capBeforeAi: inc.correctiveActionPlan,
      rootCauseAnalysis: out.rootCauseAnalysis,
      correctiveActionPlan: out.correctiveActionPlan,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.cqiIncidents.id, incId));
}

/** Write (or strengthen) the RCA and CAP on an incident with Claude. Previous text is kept for restore. */
export async function suggestForIncident(id: string, fd: FormData) {
  const user = await requireManager();
  const here = `/cqi/incidents/${id}`;
  const extra = String(fd.get("extraContext") ?? "").trim() || null;
  try {
    await strengthenIncident(id, extra, user);
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
  let done = 0;
  const failures: string[] = [];
  for (const inc of thin.slice(0, 20)) {
    try {
      await strengthenIncident(inc.id, null, user);
      done++;
    } catch (e) {
      failures.push(`#${inc.incidentNumber}: ${describeError(e)}`);
    }
  }
  await audit({ action: "cqi.incidents.ai_bulk_strengthen", userId: user.id, userName: user.name, details: `${done} rewritten, ${failures.length} failed` });
  revalidatePath(here);
  revalidatePath("/cqi");
  if (failures.length > 0) fail(here, `Rewrote ${done}. ${failures.length} could not be done: ${failures[0]}`);
  redirect(`${here}?saved=1&detail=${encodeURIComponent(`Rewrote ${done} incident write-up${done === 1 ? "" : "s"}. Read each one and correct anything that isn't right before signing.`)}`);
}

/** Draft CAP effectiveness comments for every CAP due on a summary that has no comment yet. */
export async function draftEvaluationsForSummary(id: string) {
  const user = await requireManager();
  const here = `/cqi/summaries/${id}`;
  const summary = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, id) });
  if (!summary) fail("/cqi", "Summary not found.");
  if (summary.status === "final") fail(here, "Reopen the summary before drafting.");
  const caps = await capsToEvaluate(summary.periodStart, summary.periodEnd);
  const mine = await db.query.cqiCapReviews.findMany({ where: eq(schema.cqiCapReviews.summaryId, id) });
  const pending = caps.filter(({ incident, nextReviewNumber }) => {
    const existing = mine.find((r) => r.incidentId === incident.id);
    return !(existing && existing.comments) && nextReviewNumber <= 2;
  });
  if (pending.length === 0) fail(here, "Every corrective action plan on this summary already has an evaluation.");
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
  let evals;
  try {
    evals = await draftCapEvaluations(inputs, await roleNames(), { userId: user.id, userName: user.name });
  } catch (e) {
    fail(here, describeError(e));
  }
  for (const ev of evals) {
    const p = pending.find((x) => x.incident.incidentNumber === ev.incidentNumber);
    if (!p) continue;
    const existing = mine.find((r) => r.incidentId === p.incident.id);
    if (existing) await db.update(schema.cqiCapReviews).set({ effective: existing.effective ?? ev.effective, comments: ev.comments }).where(eq(schema.cqiCapReviews.id, existing.id));
    else await db.insert(schema.cqiCapReviews).values({ id: newId(), incidentId: p.incident.id, summaryId: id, reviewNumber: p.nextReviewNumber, effective: ev.effective, comments: ev.comments });
  }
  revalidatePath(here);
  redirect(`${here}?ai=1`);
}
