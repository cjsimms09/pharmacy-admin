import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { hasApiKey } from "./ai";
import { todayIso, daysBetween } from "./dates";
import { isThin, reviewStartDeadline } from "./cqi-rules";
import { incidentsInPeriod, capsToEvaluate, carriedForward, currentCqiObligation, ensureCurrentSummary } from "./cqi";
import { writeIncidentAnalysisInBackground } from "./cqi-ai";

/**
 * The CQI cycle, running itself.
 *
 * The pharmacist's part is one thing: writing down what happened, in their own words, at the
 * counter, while they remember it. Everything after that — starting the review inside the seven
 * days the regulation allows, turning the note into an analysis that can be signed, gathering
 * the period's incidents and the corrective actions now due their first or second look, and
 * having a summary ready before the fifteenth — is work a computer can do and a busy pharmacist
 * will not reliably remember to.
 *
 * Two timings matter, and they are the ones the rule sets.
 *
 * K.A.R. 68-19-1 requires a review to begin within seven days of the report. Drafting is
 * therefore held back until day five rather than fired the moment an incident is logged: a note
 * written at the counter is often added to an hour later, and analysing the first version wastes
 * the analysis. Five days leaves two days of margin on a seven-day duty.
 *
 * And once a period closes, everything belonging to it is assembled at once, because that is the
 * moment the summary has to be capable of being read, signed and filed.
 */

/** How long after the report an unstarted review is picked up. Two days inside the seven. */
const DRAFT_AFTER_DAYS = 5;

/** The account the automation acts as, so the audit trail never claims a person did this. */
const ROBOT = { id: "cqi-automation", name: "CQI automation" };

export type CqiAutomationReport = {
  reviewsStarted: number;
  drafted: number;
  summaryPrepared: string | null;
  attached: number;
  skipped: string | null;
};

/**
 * Starts reviews that are approaching their deadline and has the analysis drafted.
 *
 * Only touches incidents with nothing written yet. An analysis the pharmacist has already
 * written, however short, is theirs — the automation never overwrites a person's words.
 */
async function startDueReviews(): Promise<{ started: number; queued: string[] }> {
  const today = todayIso();
  const incidents = await db.query.cqiIncidents.findMany();
  const queued: string[] = [];
  let started = 0;

  const pic = await db.query.people.findFirst({ where: eq(schema.people.isPic, true) });

  for (const inc of incidents) {
    if (inc.reviewCompletedOn) continue;
    const age = daysBetween(inc.reportCreatedOn, today);
    if (age < DRAFT_AFTER_DAYS) continue;

    const needsReview = !inc.reviewStartedOn;
    const needsWriting = isThin(inc.rootCauseAnalysis, inc.correctiveActionPlan) && inc.aiState !== "queued";

    if (needsReview) {
      await db
        .update(schema.cqiIncidents)
        .set({
          reviewStartedOn: today,
          reviewerPersonId: inc.reviewerPersonId ?? pic?.id ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.cqiIncidents.id, inc.id));
      started++;
      await audit({
        action: "cqi.incident.review_started_automatically",
        userId: null,
        userName: ROBOT.name,
        entity: "cqi_incident",
        entityId: inc.id,
        details: `Review opened on day ${age} of the seven allowed by K.A.R. 68-19-1(b). Deadline was ${reviewStartDeadline(inc.reportCreatedOn)}.`,
      });
    }

    if (needsWriting) {
      await db.update(schema.cqiIncidents).set({ aiState: "queued", aiError: null }).where(eq(schema.cqiIncidents.id, inc.id));
      queued.push(inc.id);
    }
  }
  return { started, queued };
}

/**
 * Assembles the summary for a period that has ended.
 *
 * Attaches the period's own incidents and the corrective actions now due their first or second
 * evaluation, so the C-550 carries everything the regulation expects without anyone having to
 * remember which incident is due which look.
 */
async function assembleSummary(): Promise<{ summaryId: string | null; attached: number }> {
  const { period } = await currentCqiObligation();
  // Only once the period has actually closed. A summary assembled mid-period would be missing
  // whatever happens in the rest of it, and would look complete.
  if (todayIso() <= period.periodEnd) return { summaryId: null, attached: 0 };

  const { summary } = await ensureCurrentSummary();
  if (summary.status === "final") return { summaryId: null, attached: 0 };

  const [inPeriod, caps, carried] = await Promise.all([
    incidentsInPeriod(summary.periodStart, summary.periodEnd),
    capsToEvaluate(summary.periodStart, summary.periodEnd),
    carriedForward(summary.periodStart),
  ]);

  const ids = [
    ...inPeriod.map((i) => i.id),
    ...caps.map((c) => c.incident.id),
    ...carried.openReviews.map((i) => i.id),
    ...carried.thin.map((i) => i.id),
  ];
  const unique = [...new Set(ids)];

  const before: string[] = JSON.parse(summary.incidentIds || "[]");
  const added = unique.filter((id) => !before.includes(id));
  if (added.length === 0 && summary.isNullReport === (unique.length === 0)) {
    return { summaryId: summary.id, attached: 0 };
  }

  await db
    .update(schema.cqiSummaries)
    .set({
      incidentIds: JSON.stringify(unique),
      // A period with nothing in it is a null report, and that has to stay true as things attach.
      isNullReport: unique.length === 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.cqiSummaries.id, summary.id));

  if (added.length > 0) {
    await audit({
      action: "cqi.summary.assembled_automatically",
      userId: null,
      userName: ROBOT.name,
      entity: "cqi_summary",
      entityId: summary.id,
      details: `${added.length} item(s) attached for ${summary.periodStart} to ${summary.periodEnd}: ${inPeriod.length} in period, ${caps.length} corrective action review(s) due, ${carried.openReviews.length + carried.thin.length} carried forward.`,
    });
  }
  return { summaryId: summary.id, attached: added.length };
}

/**
 * One pass of the whole cycle. Safe to call repeatedly; does nothing when there is nothing to do.
 */
export async function runCqiAutomation(): Promise<CqiAutomationReport> {
  const assembled = await assembleSummary();
  const reviews = await startDueReviews();

  // Drafting needs a key. Everything else — opening reviews on time, gathering the period — is
  // regulation and happens regardless, so a pharmacy without a key still stays compliant; it
  // just writes its own analyses.
  if (!(await hasApiKey())) {
    for (const id of reviews.queued) {
      await db.update(schema.cqiIncidents).set({ aiState: "idle" }).where(eq(schema.cqiIncidents.id, id));
    }
    return {
      reviewsStarted: reviews.started,
      drafted: 0,
      summaryPrepared: assembled.summaryId,
      attached: assembled.attached,
      skipped: reviews.queued.length > 0 ? "No Anthropic key, so the analyses were not drafted." : null,
    };
  }

  // One at a time. Each takes a minute or two and this runs on the shared connection.
  let drafted = 0;
  for (const id of reviews.queued) {
    await writeIncidentAnalysisInBackground(id, ROBOT);
    drafted++;
  }

  return {
    reviewsStarted: reviews.started,
    drafted,
    summaryPrepared: assembled.summaryId,
    attached: assembled.attached,
    skipped: null,
  };
}
