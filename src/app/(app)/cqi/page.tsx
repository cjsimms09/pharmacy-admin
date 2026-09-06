import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { cqiPeriods, daysUntil, fmt, periodLabel, todayIso } from "@/lib/dates";
import { PageHeader, Notice, Field, Empty } from "@/components/ui";
import { uploadHistoricalSummary } from "./actions";
import { carriedForward, ensureCurrentSummary, incidentsWithStage } from "@/lib/cqi";
import { AutoRefresh } from "@/components/auto-refresh";

export const metadata = { title: "CQI program" };
// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function CqiPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireManager();
  const { saved, error } = await searchParams;
  const today = todayIso();
  /*
   * The summary for the period now running is opened as soon as it exists, so incidents collect
   * into it as they are logged and there is never a "start it" step to forget.
   *
   * The heading, the due date and the buttons all come from this one summary. They used to come
   * from two places — the label and date from the calendar, the buttons from the outstanding
   * obligation — so once a summary was finalized the card named the finished period, called it
   * overdue, and opened the next one.
   */
  const { summary: current } = await ensureCurrentSummary();
  const next = { label: periodLabel(current.periodStart, current.periodEnd), dueOn: current.dueOn };
  const [summaries, rows, docs, carried] = await Promise.all([
    db.query.cqiSummaries.findMany({ orderBy: (s, { desc }) => [desc(s.periodStart)] }),
    incidentsWithStage(),
    db.query.documents.findMany({ where: eq(schema.documents.category, "cqi_summary") }),
    carriedForward(current.periodStart),
  ]);
  const open = rows.filter((r) => !r.stage.automatic && r.stage.key !== "closed");
  const busy = rows.filter((r) => r.stage.key === "drafting");
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
          <div className="flex flex-wrap gap-2">
            <span className={`badge ${current.status === "final" ? "badge-ok" : "badge-warn"}`}>{current.status === "final" ? "Finalized" : "Open and collecting"}</span>
            <Link href={`/cqi/summaries/${current.id}`} className="btn btn-primary">Open the summary</Link>
            <Link href={`/cqi/summaries/${current.id}/print`} className="btn">Print C-550</Link>
          </div>
        </div>
      </section>

      {busy.length > 0 && <AutoRefresh seconds={12} />}

      {carried.any && (
        <section className="card mb-6 border-warn bg-warn-soft">
          <h2 className="font-semibold">Carried forward from earlier summaries</h2>
          <p className="mt-1 text-xs text-ink-2">Nothing here has to be remembered — it is brought onto the current summary automatically until it is finished.</p>
          <ul className="mt-3 space-y-1 text-sm">
            {carried.openReviews.map((i) => (
              <li key={`o${i.id}`}><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link> — review from an earlier period is still open.</li>
            ))}
            {carried.thin.map((i) => (
              <li key={`t${i.id}`}><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link> — the write-up is too thin for the Board.</li>
            ))}
            {carried.capMissing.map((i) => (
              <li key={`c${i.id}`}><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link> — corrective action has no start date, so its effectiveness reviews cannot begin.</li>
            ))}
            {carried.ineffective.map(({ incident: i, on }) => (
              <li key={`e${i.id}`}><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link> — the corrective action was judged <b>not effective</b> on the {on} summary and needs a stronger plan.</li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-1 font-semibold">What needs you</h2>
          <p className="mb-3 text-xs text-ink-3">Everything else in the cycle happens on its own.</p>
          {open.length === 0 ? <p className="text-sm text-ink-3">Nothing. Every incident is either closed or waiting on a summary the site will carry it onto.</p> : (
            <ul className="divide-y divide-line">
              {open.map(({ incident: i, stage }) => (
                <li key={i.id} className="py-2">
                  <Link href={`/cqi/incidents/${i.id}`} className="font-medium text-accent hover:underline">Incident #{i.incidentNumber}</Link>
                  <span className={`badge ml-2 ${stage.level === "crit" ? "badge-crit" : "badge-warn"}`}>{stage.label}</span>
                  <div className="text-xs text-ink-2">{stage.next}</div>
                  {stage.dueOn && <div className={`text-xs ${daysUntil(stage.dueOn)! < 0 ? "text-crit" : "text-ink-3"}`}>By {fmt(stage.dueOn)}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="mb-3 font-semibold">Summaries on file</h2>
          {summaries.length === 0 ? <Empty>No summaries yet. Start the current one above, and upload previous signed summaries below.</Empty> : (
            <div className="overflow-x-auto">
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
            </div>
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
