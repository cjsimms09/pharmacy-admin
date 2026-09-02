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

export default async function IncidentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireManager();
  const { id } = await params;
  const { error, saved } = await searchParams;
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
