import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptText, encryptText, newId } from "./crypto";
import { addDays, lastDayOfMonth, nextCqiPeriod, periodLabel, todayIso } from "./dates";

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

/** A write-up too short to satisfy the Board — an empty root cause analysis, or a one-line corrective action. */
export function isThin(rca: string | null, cap: string | null): boolean {
  return (rca ?? "").trim().length < 400 || (cap ?? "").trim().length < 400;
}

export const reviewStartDeadline = (reportCreatedOn: string) => addDays(reportCreatedOn, 7);
export const reviewCompleteDeadline = (reportCreatedOn: string) => addDays(reportCreatedOn, 30);

// ── The CQI cycle, tracked automatically ─────────────────────────────
// Every incident moves through the same course: logged → analysed → reviewed → corrective action
// implemented → effectiveness reviewed on the next two summaries → closed. The site works out where
// each one is and what happens next, so nothing has to be remembered between summaries.

export type IncidentStageKey =
  | "logged"
  | "drafting"
  | "draft_failed"
  | "analysis_missing"
  | "review_open"
  | "cap_not_started"
  | "eval_1"
  | "eval_2"
  | "revise"
  | "closed";

export type IncidentStage = {
  key: IncidentStageKey;
  /** Where the incident is in the cycle. */
  label: string;
  /** What happens next — and who does it. */
  next: string;
  dueOn: string | null;
  level: "ok" | "warn" | "crit";
  /** True when the site handles the next step on its own and the PIC has nothing to do. */
  automatic: boolean;
};

type StageIncident = {
  aiState: string;
  rootCauseAnalysis: string | null;
  correctiveActionPlan: string | null;
  reportCreatedOn: string;
  reviewStartedOn: string | null;
  reviewCompletedOn: string | null;
  capImplementedOn: string | null;
};

/**
 * Where this incident sits in the cycle, and what happens next.
 *
 * The order follows K.A.R. 68-19-1: the event is recorded when it happens; the pharmacist's review
 * begins within 7 days and is completed within 30; the analysis and corrective action belong to that
 * review, not to the moment of logging. Nothing is drafted until the pharmacist opens the review.
 */
export function incidentStage(
  inc: StageIncident,
  reviews: { reviewNumber: number; effective: boolean | null }[],
  nextSummaryDueOn: string | null,
): IncidentStage {
  const done = [...reviews].sort((a, b) => a.reviewNumber - b.reviewNumber);
  const latest = done[done.length - 1];
  const startBy = reviewStartDeadline(inc.reportCreatedOn);
  const completeBy = reviewCompleteDeadline(inc.reportCreatedOn);
  // A regulatory deadline that has passed is not a warning — the 7-day and 30-day windows in
  // K.A.R. 68-19-1 run from the report date whichever summary the incident eventually lands on.
  const at = (level: "ok" | "warn" | "crit", dueOn: string | null): "ok" | "warn" | "crit" =>
    dueOn && dueOn < todayIso() ? "crit" : level;

  if (inc.aiState === "queued")
    return { key: "drafting", label: "Claude is drafting the review", next: "Nothing to do — the root cause analysis and corrective action plan appear here in about a minute, for you to check.", dueOn: completeBy, level: "ok", automatic: true };
  if (inc.aiState === "failed")
    return { key: "draft_failed", label: "Draft did not finish", next: "Open the incident and press “Draft the analysis with Claude” again.", dueOn: completeBy, level: "crit", automatic: false };
  if (!inc.reviewStartedOn)
    return { key: "logged", label: "Logged — review not started", next: "Start the pharmacist's review. Claude drafts the analysis and corrective action for you to check.", dueOn: startBy, level: at("warn", startBy), automatic: false };
  if (isThin(inc.rootCauseAnalysis, inc.correctiveActionPlan))
    return { key: "analysis_missing", label: "Review started — analysis not written", next: "Have Claude draft the analysis, then read it and correct anything that is not right.", dueOn: completeBy, level: at("warn", completeBy), automatic: false };
  if (!inc.reviewCompletedOn)
    return { key: "review_open", label: "Review in progress", next: "Read the analysis and corrective action, correct anything that is not right, then set the review-completed date. That is your adoption of it.", dueOn: completeBy, level: at("warn", completeBy), automatic: false };
  if (!inc.capImplementedOn)
    return { key: "cap_not_started", label: "Corrective action not yet in place", next: "Put the corrective action into practice and record the date it started — the effectiveness reviews count from there.", dueOn: null, level: "warn", automatic: false };
  if (latest && latest.effective === false)
    return { key: "revise", label: "Corrective action judged not effective", next: "Revise the corrective action plan — the same problem recurred after it was put in place. Claude drafts a stronger one from what has already been tried.", dueOn: nextSummaryDueOn, level: "crit", automatic: false };
  if (done.length === 0)
    return { key: "eval_1", label: "Awaiting first effectiveness review", next: "Carried onto the next summary on its own; Claude drafts the evaluation there.", dueOn: nextSummaryDueOn, level: "ok", automatic: true };
  if (done.length === 1)
    return { key: "eval_2", label: "Awaiting second effectiveness review", next: "Carried onto the next summary on its own; Claude drafts the evaluation there.", dueOn: nextSummaryDueOn, level: "ok", automatic: true };
  return { key: "closed", label: "Closed", next: "Both effectiveness reviews are on record. Keep the file five years.", dueOn: null, level: "ok", automatic: true };
}

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
 * Make sure a draft summary exists for the period now due, so the next one is always already open and
 * collecting. Idempotent: returns the existing summary when there is one.
 */
export async function ensureCurrentSummary() {
  const period = nextCqiPeriod();
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
