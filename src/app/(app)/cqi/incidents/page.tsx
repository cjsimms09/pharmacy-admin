import Link from "next/link";
import { requireManager } from "@/lib/auth";
import { fmt } from "@/lib/dates";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { PageHeader, BackLink, Empty, Notice } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { hasApiKey } from "@/lib/ai";
import { strengthenThinIncidents } from "../ai-actions";
import { deleteIncident } from "../actions";
import { ConfirmButton } from "@/components/confirm-button";
import { incidentsWithStage } from "@/lib/cqi";

export const metadata = { title: "CQI incidents" };
// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; detail?: string; drafting?: string }> }) {
  await requireManager();
  const { saved, error, detail, drafting } = await searchParams;
  const [rows, aiReady] = await Promise.all([incidentsWithStage(), hasApiKey()]);
  const busy = rows.filter((r) => r.stage.key === "drafting");
  const failed = rows.filter((r) => r.stage.key === "draft_failed");
  const thin = rows.filter((r) => r.stage.key === "analysis_missing");
  // Two reports of the same type on the same day are nearly always the same event entered twice.
  const dupKey = (i: { type: string; reportCreatedOn: string }) => `${i.type}|${i.reportCreatedOn}`;
  const counts = new Map<string, number>();
  for (const { incident: i } of rows) counts.set(dupKey(i), (counts.get(dupKey(i)) ?? 0) + 1);
  const duplicates = rows.filter(({ incident: i }) => (counts.get(dupKey(i)) ?? 0) > 1);

  return (
    <>
      <BackLink href="/cqi">CQI program</BackLink>
      <PageHeader
        title="Incidents"
        subtitle="Every quality-related event, and where each one sits in the cycle. Logged when it happens; analysed when the pharmacist opens the review."
        actions={<Link href="/cqi/incidents/new" className="btn btn-primary">Log incident</Link>}
      />
      {saved && <Notice>{detail || "Saved."}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}
      {drafting && <Notice kind="warn">Claude is drafting {drafting} write-up{drafting === "1" ? "" : "s"}. Each takes a minute or two — they appear below as they finish. You can leave this page and come back.</Notice>}

      {busy.length > 0 && (
        <>
          <AutoRefresh seconds={10} />
          <Notice kind="warn">
            Claude is writing {busy.length} analys{busy.length === 1 ? "is" : "es"} right now ({busy.map((b) => `#${b.incident.incidentNumber}`).join(", ")}). This page updates on its own.
          </Notice>
        </>
      )}

      {failed.length > 0 && (
        <section className="card mb-5 border-crit">
          <h2 className="font-semibold text-crit">{failed.length} draft{failed.length === 1 ? "" : "s"} did not finish</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {failed.map(({ incident: i }) => (
              <li key={i.id}>
                <Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link>
                {i.aiError && <span className="text-ink-2"> — {i.aiError}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-3">Nothing was saved over. Open the incident and press “Draft the analysis with Claude” to try again.</p>
        </section>
      )}

      {duplicates.length > 0 && (
        <Notice kind="warn">
          {duplicates.length} incidents look like duplicates — same type, same report date ({[...new Set(duplicates.map((d) => `#${d.incident.incidentNumber}`))].join(", ")}). Delete the extra with the <b>Delete</b> link on its row. Numbers are not reused, so a gap in the numbering is normal and fine.
        </Notice>
      )}

      {thin.length > 0 && (
        <section className="card mb-5 border-warn bg-warn-soft">
          <h2 className="font-semibold">{thin.length} incident{thin.length === 1 ? " has" : "s have"} a write-up too thin for the Board</h2>
          <p className="mt-1 text-sm">
            The root cause analysis is missing, or the corrective action is a single line — common on packets imported from old paper forms.
            {aiReady
              ? " Claude reconstructs a full analysis for each one from the corrective action and the incident type, and flags what you should confirm. You review and correct every one before signing."
              : " Add your Anthropic API key under Settings → Claude to have these written for you, or open each incident and write them yourself."}
          </p>
          {aiReady && (
            <form action={strengthenThinIncidents} className="mt-3">
              <button className="btn btn-primary" type="submit">Write the missing analyses with Claude</button>
              <span className="ml-2 text-xs text-ink-2">About a minute each; they appear here as they finish.</span>
            </form>
          )}
        </section>
      )}

      {rows.length === 0 ? <Empty>No incidents logged.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="table">
            <thead><tr><th>#</th><th>Reported</th><th>Type</th><th>Where it is</th><th>What happens next</th><th>By</th><th></th></tr></thead>
            <tbody>
              {rows.map(({ incident: i, stage }) => (
                <tr key={i.id}>
                  <td><Link href={`/cqi/incidents/${i.id}`} className="font-medium text-accent hover:underline">#{i.incidentNumber}</Link></td>
                  <td>{fmt(i.reportCreatedOn)}</td>
                  <td>{INCIDENT_TYPE_LABEL[i.type]}{i.type === "other" && i.typeOther ? `: ${i.typeOther}` : ""}</td>
                  <td><span className={`badge ${stage.level === "crit" ? "badge-crit" : stage.level === "warn" ? "badge-warn" : "badge-ok"}`}>{stage.label}</span></td>
                  <td className="text-xs text-ink-2">
                    {stage.automatic && <span className="badge badge-muted mr-1">automatic</span>}
                    {stage.next}
                  </td>
                  <td className="text-xs">{stage.dueOn ? fmt(stage.dueOn) : "—"}</td>
                  <td className="text-xs">
                    <form action={deleteIncident.bind(null, i.id)}>
                      <ConfirmButton
                        className="text-crit hover:underline"
                        message={`Delete incident #${i.incidentNumber} and everything recorded on it? This cannot be undone.`}
                      >
                        Delete
                      </ConfirmButton>
                    </form>
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
