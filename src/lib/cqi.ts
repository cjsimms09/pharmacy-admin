import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptText, encryptText, newId } from "./crypto";
import { cqiPeriodAfter, lastDayOfMonth, nextCqiPeriod, periodLabel, todayIso } from "./dates";
import { incidentStage, isThin } from "./cqi-rules";

export function rxNumbersOf(inc: { rxNumbersEnc: string | null }): string[] {
  if (!inc.rxNumbersEnc) return [];
  try {
    const v = JSON.parse(decryptText(inc.rxNumbersEnc));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return ["(unreadable — encryption key changed)"];
  }
}

export function encodeRxNumbers(raw: string): string | null {
  const list = raw.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return null;
  return encryptText(JSON.stringify(list));
}

export type EmployeeReview = { personId: string; reviewedOn: string | null; reviewedByPersonId: string | null };
export function employeeReviewsOf(inc: { employeeReviews: string }): EmployeeReview[] {
  try {
    const v = JSON.parse(inc.employeeReviews);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Incidents whose report was created inside the summary period. */
export async function incidentsInPeriod(periodStart: string, periodEnd: string) {
  return db.query.cqiIncidents.findMany({
    where: and(gte(schema.cqiIncidents.reportCreatedOn, periodStart), lte(schema.cqiIncidents.reportCreatedOn, periodEnd)),
    orderBy: (i, { asc }) => [asc(i.reportCreatedOn)],
  });
}

/**
 * CAPs to evaluate on this summary: K.A.R. 68-19-1 asks for "evaluation of the outcomes and
 * effectiveness of each corrective action plan from the summaries for the previous four months",
 * and the C-550 records a first and a second review. So: any incident with a CAP whose report was
 * created in the four months ending with this period, that has fewer than two reviews recorded.
 */
export async function capsToEvaluate(periodStart: string, periodEnd: string) {
  const [y, m] = periodStart.split("-").map(Number);
  const startMinus2 = m - 2 <= 0 ? `${y - 1}-${String(m - 2 + 12).padStart(2, "0")}-01` : `${y}-${String(m - 2).padStart(2, "0")}-01`;
  const candidates = await db.query.cqiIncidents.findMany({
    where: and(gte(schema.cqiIncidents.reportCreatedOn, startMinus2), lte(schema.cqiIncidents.reportCreatedOn, periodEnd)),
    orderBy: (i, { asc }) => [asc(i.reportCreatedOn)],
  });
  const reviews = await db.query.cqiCapReviews.findMany();
  return candidates
    .filter((i) => i.correctiveActionPlan && i.correctiveActionPlan.trim().length > 0)
    .map((i) => {
      const done = reviews.filter((r) => r.incidentId === i.id).sort((a, b) => a.reviewNumber - b.reviewNumber);
      return { incident: i, reviews: done, nextReviewNumber: done.length + 1 };
    });
}

export function periodFromDue(dueOn: string) {
  const [y, m] = dueOn.split("-").map(Number);
  const m1 = m - 2;
  const y1 = m1 <= 0 ? y - 1 : y;
  const mm1 = m1 <= 0 ? m1 + 12 : m1;
  return { periodStart: `${y1}-${String(mm1).padStart(2, "0")}-01`, periodEnd: lastDayOfMonth(y, m - 1) };
}

// The staging rules live in cqi-rules.ts so they can be tested without a database.
export { isThin, incidentStage, reviewCompleteDeadline, reviewStartDeadline } from "./cqi-rules";
export type { IncidentStage, IncidentStageKey } from "./cqi-rules";

/** Every incident with its stage, newest first. One query for the whole cycle. */
export async function incidentsWithStage() {
  const [incidents, reviews] = await Promise.all([
    db.query.cqiIncidents.findMany({ orderBy: (i, { desc }) => [desc(i.incidentNumber)] }),
    db.query.cqiCapReviews.findMany(),
  ]);
  const due = nextCqiPeriod().dueOn;
  return incidents.map((i) => ({ incident: i, stage: incidentStage(i, reviews.filter((r) => r.incidentId === i.id), due) }));
}

/**
 * The summary obligation actually outstanding.
 *
 * nextCqiPeriod answers "which period is due about now", which keeps pointing at a period for
 * six weeks after its due date. Once that summary is finalized it is no longer an obligation, so
 * this walks forward to the first period that has not been filed. Without it a finalized summary
 * goes on being reported as overdue, which is both wrong and the fastest way to teach someone to
 * ignore the dashboard.
 */
export async function currentCqiObligation() {
  let period = nextCqiPeriod();
  for (let guard = 0; guard < 12; guard++) {
    const summary = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.periodStart, period.periodStart) });
    if (!summary || summary.status !== "final") return { period, summary: summary ?? null };
    const next = cqiPeriodAfter(period.periodStart);
    if (!next) return { period, summary };
    period = next;
  }
  return { period, summary: null };
}

/**
 * Make sure a draft summary exists for the period now due, so the next one is always already open and
 * collecting. Idempotent: returns the existing summary when there is one.
 */
export async function ensureCurrentSummary() {
  const { period } = await currentCqiObligation();
  const existing = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.periodStart, period.periodStart) });
  if (existing) {
    // Keep the null-report flag honest as incidents are logged into an already-open period.
    if (existing.status !== "final") {
      const inPeriod = await incidentsInPeriod(existing.periodStart, existing.periodEnd);
      const shouldBeNull = inPeriod.length === 0;
      if (existing.isNullReport !== shouldBeNull) {
        await db.update(schema.cqiSummaries).set({ isNullReport: shouldBeNull, incidentIds: JSON.stringify(inPeriod.map((i) => i.id)) }).where(eq(schema.cqiSummaries.id, existing.id));
        return { summary: { ...existing, isNullReport: shouldBeNull }, created: false };
      }
    }
    return { summary: existing, created: false };
  }
  const incidents = await incidentsInPeriod(period.periodStart, period.periodEnd);
  const pic = await db.query.people.findFirst({ where: eq(schema.people.isPic, true) });
  const id = newId();
  await db.insert(schema.cqiSummaries).values({
    id,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    dueOn: period.dueOn,
    isNullReport: incidents.length === 0,
    incidentIds: JSON.stringify(incidents.map((i) => i.id)),
    preparedByPersonId: pic?.id ?? null,
    preparedOn: todayIso(),
  });
  const summary = (await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, id) }))!;
  return { summary, created: true };
}

/**
 * Business the earlier summaries did not finish, brought onto this one: reviews still open from a
 * previous period, and corrective actions that were judged not effective and need a new plan.
 */
export async function carriedForward(periodStart: string) {
  const [incidents, reviews, summaries] = await Promise.all([
    db.query.cqiIncidents.findMany({ orderBy: (i, { asc }) => [asc(i.incidentNumber)] }),
    db.query.cqiCapReviews.findMany(),
    db.query.cqiSummaries.findMany(),
  ]);
  const earlier = incidents.filter((i) => i.reportCreatedOn < periodStart);
  const reviewsOf = (id: string) => reviews.filter((r) => r.incidentId === id).sort((a, b) => a.reviewNumber - b.reviewNumber);
  const summaryLabel = (summaryId: string) => {
    const s = summaries.find((x) => x.id === summaryId);
    return s ? periodLabel(s.periodStart, s.periodEnd) : "an earlier summary";
  };
  const openReviews = earlier.filter((i) => !i.reviewCompletedOn);
  const thin = earlier.filter((i) => i.reviewCompletedOn && isThin(i.rootCauseAnalysis, i.correctiveActionPlan));
  const ineffective = earlier
    .map((i) => ({ incident: i, review: reviewsOf(i.id).filter((r) => r.effective === false).pop() }))
    .filter((x): x is { incident: (typeof earlier)[number]; review: (typeof reviews)[number] } => Boolean(x.review))
    .map((x) => ({ ...x, on: summaryLabel(x.review.summaryId) }));
  const capMissing = earlier.filter((i) => i.reviewCompletedOn && i.correctiveActionPlan && !i.capImplementedOn);
  return { openReviews, thin, ineffective, capMissing, any: openReviews.length + thin.length + ineffective.length + capMissing.length > 0 };
}
