import Link from "next/link";
import { db } from "@/db";
import { requireManager } from "@/lib/auth";
import { fmt } from "@/lib/dates";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { PageHeader, BackLink, Empty, Notice } from "@/components/ui";
import { hasApiKey } from "@/lib/ai";
import { strengthenThinIncidents } from "../ai-actions";
import { isThin } from "@/lib/cqi";

export const metadata = { title: "CQI incidents" };
// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; detail?: string }> }) {
  await requireManager();
  const { saved, error, detail } = await searchParams;
  const [incidents, aiReady] = await Promise.all([
    db.query.cqiIncidents.findMany({ orderBy: (i, { desc }) => [desc(i.incidentNumber)] }),
    hasApiKey(),
  ]);
  const thin = incidents.filter((i) => isThin(i.rootCauseAnalysis, i.correctiveActionPlan));
  return (
    <>
      <BackLink href="/cqi">CQI program</BackLink>
      <PageHeader title="Incidents" subtitle="Each incident report and its review, root cause analysis, and corrective action plan." actions={<Link href="/cqi/incidents/new" className="btn btn-primary">Log incident</Link>} />
      {saved && <Notice>{detail || "Saved."}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}
      {thin.length > 0 && (
        <section className="card mb-5 border-warn bg-warn-soft">
          <h2 className="font-semibold">{thin.length} incident{thin.length === 1 ? " has" : "s have"} a write-up too thin for the Board</h2>
          <p className="mt-1 text-sm">
            The root cause analysis is missing, or the corrective action is a single line — common on packets imported from old paper forms.
            {aiReady
              ? " Claude can reconstruct a full analysis for each one from the corrective action and the incident type, and flags what you should confirm. You review and correct every one before signing."
              : " Add your Anthropic API key under Settings → Claude to have these written for you, or open each incident and write them yourself."}
          </p>
          {aiReady && (
            <form action={strengthenThinIncidents} className="mt-3">
              <button className="btn btn-primary" type="submit">Write the missing analyses with Claude</button>
              <span className="ml-2 text-xs text-ink-2">About a minute per incident.</span>
            </form>
          )}
        </section>
      )}
      {incidents.length === 0 ? <Empty>No incidents logged.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="table">
            <thead><tr><th>#</th><th>Report created</th><th>Type</th><th>Review started</th><th>Review completed</th><th>Write-up</th></tr></thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/cqi/incidents/${i.id}`} className="font-medium text-accent hover:underline">#{i.incidentNumber}</Link></td>
                  <td>{fmt(i.reportCreatedOn)}</td>
                  <td>{INCIDENT_TYPE_LABEL[i.type]}{i.type === "other" && i.typeOther ? `: ${i.typeOther}` : ""}</td>
                  <td>{i.reviewStartedOn ? fmt(i.reviewStartedOn) : <span className="badge badge-warn">not started</span>}</td>
                  <td>{i.reviewCompletedOn ? fmt(i.reviewCompletedOn) : <span className="badge badge-warn">open</span>}</td>
                  <td className="text-xs">
                    {isThin(i.rootCauseAnalysis, i.correctiveActionPlan) ? (
                      <span className="badge badge-warn">needs work</span>
                    ) : (
                      <span className="badge badge-ok">complete</span>
                    )}
                    {i.capImplementedOn && <div className="text-ink-3">CAP {fmt(i.capImplementedOn)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
