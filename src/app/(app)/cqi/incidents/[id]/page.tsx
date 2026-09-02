import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { daysUntil, fmt } from "@/lib/dates";
import { employeeReviewsOf, reviewCompleteDeadline, reviewStartDeadline, rxNumbersOf } from "@/lib/cqi";
import { PageHeader, BackLink, Notice } from "@/components/ui";
import { DocumentList, UploadForm } from "@/components/documents";
import { IncidentForm } from "../../incident-form";
import { deleteIncident, updateIncident } from "../../actions";
import { restoreBeforeAi, suggestForIncident } from "../../ai-actions";
import { hasApiKey } from "@/lib/ai";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function IncidentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string; ai?: string }> }) {
  await requireManager();
  const { id } = await params;
  const { error, saved, ai } = await searchParams;
  const aiReady = await hasApiKey();
  const incident = await db.query.cqiIncidents.findFirst({ where: eq(schema.cqiIncidents.id, id) });
  if (!incident) notFound();
  const [people, docs] = await Promise.all([
    db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.documents.findMany({ where: eq(schema.documents.cqiIncidentId, id) }),
  ]);
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
      {ai && <Notice kind="warn">Claude wrote the root cause analysis and corrective action plan below. Read every line, fix anything that isn't true for your pharmacy, and save. They are yours once you sign the form.</Notice>}
      {aiReady && (
        <section className="card mb-4 max-w-4xl">
          <form action={suggestForIncident.bind(null, id)} className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <div className="font-semibold">{incident.rootCauseAnalysis || incident.correctiveActionPlan ? "Strengthen the RCA and CAP with Claude" : "Write the RCA and CAP with Claude"}</div>
              <p className="text-xs text-ink-3">Claude examines the process (where it happened, contributing factors, why safeguards failed, patient impact) and writes numbered, auditable corrective actions with owners, timing, staff education, and how effectiveness will be measured on the next two summaries. Existing text is kept as facts and expanded; the previous version stays one click away.</p>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Anything Claude should know (optional)</label>
              <textarea name="extraContext" className="field" rows={2} placeholder="e.g. it was a Monday rush; the tech was new; we already moved the stock; prescriber was called" />
            </div>
            <div className="flex items-end"><button className="btn btn-primary" type="submit">{incident.rootCauseAnalysis || incident.correctiveActionPlan ? "Strengthen with Claude" : "Write with Claude"}</button></div>
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
          <button className="btn btn-danger" type="submit">Delete incident</button>
        </form>
      </div>
    </>
  );
}
