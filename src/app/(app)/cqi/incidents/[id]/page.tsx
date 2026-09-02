import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { daysUntil, fmt } from "@/lib/dates";
import { employeeReviewsOf, incidentStage, reviewCompleteDeadline, reviewStartDeadline, rxNumbersOf } from "@/lib/cqi";
import { nextCqiPeriod } from "@/lib/dates";
import { PageHeader, BackLink, Notice } from "@/components/ui";
import { DocumentList, UploadForm } from "@/components/documents";
import { IncidentForm } from "../../incident-form";
import { deleteIncident, updateIncident } from "../../actions";
import { restoreBeforeAi, startReview, suggestForIncident } from "../../ai-actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { ConfirmButton } from "@/components/confirm-button";
import { hasApiKey } from "@/lib/ai";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function IncidentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string; ai?: string; drafting?: string }> }) {
  await requireManager();
  const { id } = await params;
  const { error, saved, ai, drafting } = await searchParams;
  const aiReady = await hasApiKey();
  const incident = await db.query.cqiIncidents.findFirst({ where: eq(schema.cqiIncidents.id, id) });
  if (!incident) notFound();
  const [people, docs, reviews] = await Promise.all([
    db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.documents.findMany({ where: eq(schema.documents.cqiIncidentId, id) }),
    db.query.cqiCapReviews.findMany({ where: eq(schema.cqiCapReviews.incidentId, id) }),
  ]);
  const stage = incidentStage(incident, reviews, nextCqiPeriod().dueOn);
  const busy = incident.aiState === "queued";
  const here = `/cqi/incidents/${id}`;
  const startDue = reviewStartDeadline(incident.reportCreatedOn);
  const doneDue = reviewCompleteDeadline(incident.reportCreatedOn);

  return (
    <>
      <BackLink href="/cqi/incidents">Incidents</BackLink>
      <PageHeader
        title={`Incident #${incident.incidentNumber}`}
        subtitle={`Report created ${fmt(incident.reportCreatedOn)}`}
        actions={<Link href={`${here}/print`} className="btn btn-primary">Print C-650</Link>}
      />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>Saved.</Notice>}
      {drafting && <Notice kind="warn">The review is open and Claude is drafting. It appears below in a minute or two.</Notice>}
      {ai && <Notice kind="warn">Claude wrote the root cause analysis and corrective action plan below. Read every line, fix anything that isn't true for your pharmacy, and save. They are yours once you sign the form.</Notice>}
      {busy && (
        <>
          <AutoRefresh seconds={8} />
          <Notice kind="warn">Claude is writing the root cause analysis and corrective action plan. It takes a minute or two and appears here on its own — you can leave and come back.</Notice>
        </>
      )}
      {incident.aiState === "failed" && incident.aiError && (
        <Notice kind="crit">The draft did not finish: {incident.aiError} Nothing was written over — press “Draft the analysis with Claude” below to try again.</Notice>
      )}

      <section className="card mb-4 max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-2">Where this incident is</div>
            <div className="mt-1 font-semibold">{stage.label}</div>
            <p className="mt-1 max-w-xl text-sm text-ink-2">{stage.next}</p>
            {stage.dueOn && <p className="mt-1 text-xs text-ink-3">By {fmt(stage.dueOn)}{daysUntil(stage.dueOn)! < 0 ? ` — ${-daysUntil(stage.dueOn)!} days overdue` : ` — ${daysUntil(stage.dueOn)} days left`}</p>}
          </div>
          {!incident.reviewStartedOn && !busy && (
            <form action={startReview.bind(null, id)}>
              <button className="btn btn-primary" type="submit">Start the review</button>
              <p className="mt-1 max-w-[16rem] text-xs text-ink-3">Records today as the review start (K.A.R. 68-19-1 gives 7 days){aiReady ? " and has Claude draft the analysis and corrective action for you to check." : "."}</p>
            </form>
          )}
        </div>
      </section>

      {aiReady && incident.reviewStartedOn && !busy && (
        <section className="card mb-4 max-w-4xl">
          <form action={suggestForIncident.bind(null, id)} className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <div className="font-semibold">{incident.rootCauseAnalysis || incident.correctiveActionPlan ? "Strengthen the analysis with Claude" : "Draft the analysis with Claude"}</div>
              <p className="text-xs text-ink-3">Claude examines the process (where it happened, contributing factors, why safeguards failed, patient impact) and writes numbered, auditable corrective actions with owners, timing, staff education, and how effectiveness will be measured on the next two summaries. Prior incidents of the same type and how those plans fared go in too, so a repeat gets a stronger plan than the one that did not hold. Existing text is kept as fact and expanded; the previous version stays one click away. It is a draft until you complete the review.</p>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Anything Claude should know (optional)</label>
              <textarea name="extraContext" className="field" rows={2} placeholder="e.g. it was a Monday rush; the tech was new; we already moved the stock; prescriber was called" />
            </div>
            <div className="flex items-end"><button className="btn btn-primary" type="submit">{incident.rootCauseAnalysis || incident.correctiveActionPlan ? "Strengthen with Claude" : "Draft with Claude"}</button></div>
          </form>
          {(incident.rcaBeforeAi || incident.capBeforeAi) && (
            <form action={restoreBeforeAi.bind(null, id)} className="mt-2"><button className="text-xs text-ink-2 underline">Restore the text from before Claude's rewrite</button></form>
          )}
        </section>
      )}
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <span className={`badge ${incident.reviewStartedOn ? "badge-ok" : daysUntil(startDue)! < 0 ? "badge-crit" : "badge-warn"}`}>
          {incident.reviewStartedOn ? `Review started ${fmt(incident.reviewStartedOn)}` : `Start review by ${fmt(startDue)}`}
        </span>
        <span className={`badge ${incident.reviewCompletedOn ? "badge-ok" : daysUntil(doneDue)! < 0 ? "badge-crit" : "badge-warn"}`}>
          {incident.reviewCompletedOn ? `Review completed ${fmt(incident.reviewCompletedOn)}` : `Complete review by ${fmt(doneDue)}`}
        </span>
      </div>
      <div className="max-w-4xl">
        <IncidentForm action={updateIncident.bind(null, id)} people={people} incident={incident} rxNumbers={rxNumbersOf(incident)} employeeReviews={employeeReviewsOf(incident)} submitLabel="Save changes" />

        <section className="card mt-6">
          <h2 className="mb-3 font-semibold">Attached documents</h2>
          <p className="mb-3 text-xs text-ink-3">A scanned, signed C-650 or supporting pages.</p>
          <DocumentList docs={docs} redirectTo={here} canManage />
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-accent">Upload</summary>
            <div className="mt-3"><UploadForm redirectTo={here} hidden={{ cqiIncidentId: id }} categories={["cqi_incident", "other"]} defaultCategory="cqi_incident" compact /></div>
          </details>
        </section>

        <form action={deleteIncident.bind(null, id)} className="mt-6">
          <ConfirmButton className="btn btn-danger" message={`Delete incident #${incident.incidentNumber} and everything recorded on it? This cannot be undone.`}>
            Delete incident
          </ConfirmButton>
        </form>
      </div>
    </>
  );
}
