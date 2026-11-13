/**
 * CQI rules — pure functions, no database, no server-only import.
 *
 * These decide Board deadlines and where an incident sits in the cycle under K.A.R. 68-19-1.
 * They live apart from the data layer so they can be tested directly: a wrong deadline here is
 * a late filing, and that is not something to find out from an inspector.
 */
import { addDays, todayIso } from "./dates";

/** The pharmacist's review must begin within 7 days of the report (K.A.R. 68-19-1). */
export function reviewStartDeadline(reportCreatedOn: string): string {
  return addDays(reportCreatedOn, 7);
}

/** …and be completed within 30 days. */
export function reviewCompleteDeadline(reportCreatedOn: string): string {
  return addDays(reportCreatedOn, 30);
}

/**
 * A write-up too thin to put in front of the Board. The threshold is deliberately generous:
 * a real analysis under the required headings runs well past it, so anything shorter is a
 * placeholder rather than a borderline case.
 */
export function isThin(rca: string | null, cap: string | null): boolean {
  return (rca ?? "").trim().length < 400 || (cap ?? "").trim().length < 400;
}

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

