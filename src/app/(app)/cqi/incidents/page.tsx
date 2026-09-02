import Link from "next/link";
import { db } from "@/db";
import { requireManager } from "@/lib/auth";
import { fmt } from "@/lib/dates";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { PageHeader, BackLink, Empty } from "@/components/ui";

export const metadata = { title: "CQI incidents" };

export default async function IncidentsPage() {
  await requireManager();
  const incidents = await db.query.cqiIncidents.findMany({ orderBy: (i, { desc }) => [desc(i.incidentNumber)] });
  return (
    <>
      <BackLink href="/cqi">CQI program</BackLink>
      <PageHeader title="Incidents" subtitle="Each incident report and its review, root cause analysis, and corrective action plan." actions={<Link href="/cqi/incidents/new" className="btn btn-primary">Log incident</Link>} />
      {incidents.length === 0 ? <Empty>No incidents logged.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="table">
            <thead><tr><th>#</th><th>Report created</th><th>Type</th><th>Review started</th><th>Review completed</th><th>CAP</th></tr></thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/cqi/incidents/${i.id}`} className="font-medium text-accent hover:underline">#{i.incidentNumber}</Link></td>
                  <td>{fmt(i.reportCreatedOn)}</td>
                  <td>{INCIDENT_TYPE_LABEL[i.type]}{i.type === "other" && i.typeOther ? `: ${i.typeOther}` : ""}</td>
                  <td>{i.reviewStartedOn ? fmt(i.reviewStartedOn) : <span className="badge badge-warn">not started</span>}</td>
                  <td>{i.reviewCompletedOn ? fmt(i.reviewCompletedOn) : <span className="badge badge-warn">open</span>}</td>
                  <td className="text-xs text-ink-2">{i.correctiveActionPlan ? (i.capImplementedOn ? `implemented ${fmt(i.capImplementedOn)}` : "written") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
