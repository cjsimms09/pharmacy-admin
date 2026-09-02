import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { cqiPeriods, daysUntil, fmt, nextCqiPeriod, periodLabel, todayIso } from "@/lib/dates";
import { PageHeader, Notice, Field, Empty } from "@/components/ui";
import { uploadHistoricalSummary } from "./actions";
import { reviewCompleteDeadline, reviewStartDeadline } from "@/lib/cqi";

export const metadata = { title: "CQI program" };
// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function CqiPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireManager();
  const { saved, error } = await searchParams;
  const today = todayIso();
  const next = nextCqiPeriod(today);
  const [summaries, incidents, docs] = await Promise.all([
    db.query.cqiSummaries.findMany({ orderBy: (s, { desc }) => [desc(s.periodStart)] }),
    db.query.cqiIncidents.findMany({ orderBy: (i, { desc }) => [desc(i.reportCreatedOn)] }),
    db.query.documents.findMany({ where: eq(schema.documents.category, "cqi_summary") }),
  ]);
  const current = summaries.find((s) => s.periodStart === next.periodStart);
  const open = incidents.filter((i) => !i.reviewCompletedOn);
  const y = Number(today.slice(0, 4));
  const periodOptions = cqiPeriods(y - 6, y).filter((p) => p.dueOn <= today).reverse();

  return (
    <>
      <PageHeader
        title="Continuous Quality Improvement"
        subtitle="K.A.R. 68-19-1 · Incident reviews within 7 and 30 days · Bimonthly summary (Form C-550) by the 15th of Feb, Apr, Jun, Aug, Oct, Dec · Kept 5 years."
        actions={
          <>
            <Link href="/cqi/import" className="btn">Import packets with Claude</Link>
            <Link href="/cqi/incidents" className="btn">Incidents</Link>
            <Link href="/cqi/incidents/new" className="btn btn-primary">Log incident</Link>
          </>
        }
      />
      {saved && <Notice>Saved.</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <section className="card mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Current summary: {next.label}</h2>
            <p className="text-sm text-ink-2">Due {fmt(next.dueOn)} ({daysUntil(next.dueOn)! >= 0 ? `${daysUntil(next.dueOn)} days left` : `${-daysUntil(next.dueOn)!} days overdue`})</p>
          </div>
          {current ? (
            <div className="flex gap-2">
              <span className={`badge ${current.status === "final" ? "badge-ok" : "badge-warn"}`}>{current.status === "final" ? "Finalized" : "Draft"}</span>
              <Link href={`/cqi/summaries/${current.id}`} className="btn">Open</Link>
              <Link href={`/cqi/summaries/${current.id}/print`} className="btn btn-primary">Print C-550</Link>
            </div>
          ) : (
            <Link href={`/cqi/summaries/new?due=${next.dueOn}`} className="btn btn-primary">Start this summary</Link>
          )}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 font-semibold">Open incident reviews</h2>
          {open.length === 0 ? <p className="text-sm text-ink-3">No incidents awaiting review.</p> : (
            <ul className="divide-y divide-line">
              {open.map((i) => {
                const startDue = reviewStartDeadline(i.reportCreatedOn);
                const doneDue = reviewCompleteDeadline(i.reportCreatedOn);
                return (
                  <li key={i.id} className="py-2">
                    <Link href={`/cqi/incidents/${i.id}`} className="font-medium text-accent hover:underline">Incident #{i.incidentNumber}</Link>
                    <div className="text-xs text-ink-2">
                      Report created {fmt(i.reportCreatedOn)} · {i.reviewStartedOn ? `review started ${fmt(i.reviewStartedOn)}` : <span className={daysUntil(startDue)! < 0 ? "text-crit" : ""}>start by {fmt(startDue)}</span>} · <span className={daysUntil(doneDue)! < 0 ? "text-crit" : ""}>complete by {fmt(doneDue)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="mb-3 font-semibold">Summaries on file</h2>
          {summaries.length === 0 ? <Empty>No summaries yet. Start the current one above, and upload previous signed summaries below.</Empty> : (
            <table className="table">
              <thead><tr><th>Period</th><th>Due</th><th>Type</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {summaries.map((s) => {
                  const d = docs.filter((x) => x.cqiSummaryId === s.id);
                  return (
                    <tr key={s.id}>
                      <td>{periodLabel(s.periodStart, s.periodEnd)}</td>
                      <td>{fmt(s.dueOn)}</td>
                      <td className="text-xs">{s.isNullReport ? "Null report" : "Summary"}{s.isHistorical && " · uploaded"}</td>
                      <td><span className={`badge ${s.status === "final" ? "badge-ok" : "badge-warn"}`}>{s.status}</span></td>
                      <td className="text-xs">
                        {!s.isHistorical && <Link href={`/cqi/summaries/${s.id}`} className="text-accent hover:underline">Open</Link>}
                        {d.map((x) => <a key={x.id} href={`/files/${x.id}`} target="_blank" rel="noreferrer" className="ml-2 text-accent hover:underline">PDF</a>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card mt-6 max-w-3xl">
        <h2 className="mb-1 font-semibold">Upload a previous signed summary (file only)</h2>
        <p className="mb-3 text-xs text-ink-3">Keeps the scan for the five-year record without reading it. To have the incidents and CAPs pulled out so the next summary builds on them, use <Link href="/cqi/import" className="text-accent underline">Import packets with Claude</Link> instead.</p>
        <form action={uploadHistoricalSummary} className="grid gap-3 sm:grid-cols-3" encType="multipart/form-data">
          <Field label="Which summary">
            <select name="dueOn" className="field" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {periodOptions.map((p) => <option key={p.dueOn} value={p.dueOn}>{p.label} (due {fmt(p.dueOn)})</option>)}
            </select>
          </Field>
          <Field label="File"><input name="file" type="file" className="field" required accept=".pdf,.jpg,.jpeg,.png" /></Field>
          <div className="flex items-end pb-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isNullReport" /> This was a null report</label></div>
          <div className="sm:col-span-3"><button className="btn btn-primary">Upload</button></div>
        </form>
      </section>
    </>
  );
}
