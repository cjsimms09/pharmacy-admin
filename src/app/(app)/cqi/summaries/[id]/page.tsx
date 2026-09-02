import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { daysUntil, fmt, periodLabel, todayIso } from "@/lib/dates";
import { capsToEvaluate, carriedForward, incidentsInPeriod, isThin, rxNumbersOf } from "@/lib/cqi";
import { AutoRefresh } from "@/components/auto-refresh";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { PageHeader, BackLink, Notice, Field } from "@/components/ui";
import { DocumentList, UploadForm } from "@/components/documents";
import { deleteSummary, reopenSummary, updateSummary } from "../../actions";
import { draftEvaluationsForSummary, prepareSummary } from "../../ai-actions";
import { hasApiKey } from "@/lib/ai";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function SummaryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string; ai?: string; preparing?: string }> }) {
  await requireManager();
  const { id } = await params;
  const { error, saved, ai, preparing } = await searchParams;
  const aiReady = await hasApiKey();
  const summary = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, id) });
  if (!summary) notFound();
  const [incidents, caps, people, docs, reviews, carried] = await Promise.all([
    incidentsInPeriod(summary.periodStart, summary.periodEnd),
    capsToEvaluate(summary.periodStart, summary.periodEnd),
    db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.documents.findMany({ where: eq(schema.documents.cqiSummaryId, id) }),
    db.query.cqiCapReviews.findMany({ where: eq(schema.cqiCapReviews.summaryId, id) }),
    carriedForward(summary.periodStart),
  ]);
  const busy = incidents.filter((i) => i.aiState === "queued");
  const needsWork = incidents.filter((i) => !i.reviewStartedOn || isThin(i.rootCauseAnalysis, i.correctiveActionPlan));
  // The C-550 asks for "Rx numbers associated with incident type" — a blank column is the first thing
  // an inspector notices, and imports from a C-550 alone often miss them.
  const noRx = incidents.filter((i) => rxNumbersOf(i).length === 0);
  const here = `/cqi/summaries/${id}`;
  const label = periodLabel(summary.periodStart, summary.periodEnd);
  const final = summary.status === "final";
  const communicated: string[] = JSON.parse(summary.communicatedTo || "[]");
  const d = daysUntil(summary.dueOn)!;
  const incomplete = incidents.filter((i) => !i.reviewCompletedOn);

  return (
    <>
      <BackLink href="/cqi">CQI program</BackLink>
      <PageHeader
        title={`Bimonthly summary: ${label}`}
        subtitle={`Due ${fmt(summary.dueOn)} · ${d >= 0 ? `${d} days left` : `${-d} days overdue`} · ${final ? "Finalized" : "Draft"}`}
        actions={
          <>
            {aiReady && !final && (needsWork.length > 0 || caps.length > 0) && (
              <form action={prepareSummary.bind(null, id)}><button className="btn btn-primary" type="submit">Prepare this summary with Claude</button></form>
            )}
            {aiReady && !final && caps.length > 0 && <form action={draftEvaluationsForSummary.bind(null, id)}><button className="btn">Draft CAP evaluations only</button></form>}
            <Link href={`${here}/print`} className="btn btn-primary">Print C-550</Link>
            {final && <form action={reopenSummary.bind(null, id)}><button className="btn">Reopen</button></form>}
          </>
        }
      />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>Saved.</Notice>}
      {ai && <Notice kind="warn">Claude drafted the CAP evaluations below from what's on record (mainly whether the same type of incident recurred). Confirm each "effective" answer and edit the comments before finalizing.</Notice>}
      {preparing && (
        <Notice kind="warn">
          Preparing the summary: {preparing} review{preparing === "1" ? "" : "s"} opened and being drafted, then the corrective-action evaluations. About a minute each — this page updates on its own. Everything comes back as a draft for you to read, correct and sign.
        </Notice>
      )}
      {busy.length > 0 && (
        <>
          <AutoRefresh seconds={12} />
          <Notice kind="warn">Claude is drafting {busy.length} review{busy.length === 1 ? "" : "s"} ({busy.map((b) => `#${b.incidentNumber}`).join(", ")}).</Notice>
        </>
      )}
      {carried.any && (
        <section className="card mb-5 border-warn bg-warn-soft">
          <h2 className="font-semibold">Brought forward onto this summary</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {carried.openReviews.map((i) => <li key={`o${i.id}`}><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link> — review still open from an earlier period.</li>)}
            {carried.thin.map((i) => <li key={`t${i.id}`}><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link> — write-up too thin for the Board.</li>)}
            {carried.capMissing.map((i) => <li key={`c${i.id}`}><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link> — corrective action has no start date.</li>)}
            {carried.ineffective.map(({ incident: i, on }) => <li key={`e${i.id}`}><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">Incident #{i.incidentNumber}</Link> — judged <b>not effective</b> on the {on} summary; needs a stronger plan.</li>)}
          </ul>
        </section>
      )}
      {noRx.length > 0 && (
        <Notice kind="warn">
          {noRx.length === 1 ? "Incident" : "Incidents"} {noRx.map((i) => `#${i.incidentNumber}`).join(", ")} {noRx.length === 1 ? "has" : "have"} no Rx number recorded, so the “Rx numbers associated with incident type” column on the C-550 will print blank. Open {noRx.length === 1 ? "it" : "each one"} and add the prescription number.
        </Notice>
      )}
      {incomplete.length > 0 && <Notice kind="warn">{incomplete.length} incident{incomplete.length === 1 ? "" : "s"} in this period still {incomplete.length === 1 ? "has" : "have"} an open review. Complete them so the RCA and CAP appear on the summary.</Notice>}

      <form action={updateSummary.bind(null, id)} className="max-w-4xl space-y-6">
        <section className="card">
          <h2 className="mb-3 font-semibold">Incidents in this period ({incidents.length})</h2>
          {incidents.length === 0 ? (
            <p className="text-sm text-ink-2">No incident reports were created between {fmt(summary.periodStart)} and {fmt(summary.periodEnd)}. This summary is filed as a <b>null report</b> under K.A.R. 68-19-1(b)(4).</p>
          ) : (
            <table className="table">
              <thead><tr><th>#</th><th>Type</th><th>Rx numbers</th><th>Report created</th><th>Review</th><th>CAP</th></tr></thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id}>
                    <td><Link href={`/cqi/incidents/${i.id}`} className="text-accent hover:underline">#{i.incidentNumber}</Link></td>
                    <td>{INCIDENT_TYPE_LABEL[i.type]}{i.type === "other" && i.typeOther ? `: ${i.typeOther}` : ""}</td>
                    <td className="font-mono text-xs">{rxNumbersOf(i).join(", ") || "—"}</td>
                    <td>{fmt(i.reportCreatedOn)}</td>
                    <td className="text-xs">{i.reviewCompletedOn ? <span className="badge badge-ok">complete</span> : <span className="badge badge-warn">open</span>}</td>
                    <td className="text-xs">{i.correctiveActionPlan ? "written" : <span className="text-crit">missing</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {incidents.length > 0 && (
            <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" name="isNullReport" defaultChecked={summary.isNullReport} disabled={final} /> File as a null report anyway (not recommended when incidents exist)</label>
          )}
        </section>

        <section className="card">
          <h2 className="mb-1 font-semibold">Evaluation of corrective action plans ({caps.length})</h2>
          <p className="mb-3 text-xs text-ink-3">Each CAP from the previous four months is reviewed on two consecutive summaries (the C-550's "first review" and "second review"). Record whether it has been effective.</p>
          {caps.length === 0 ? <p className="text-sm text-ink-2">No corrective action plans are due for evaluation.</p> : (
            <div className="space-y-4">
              {caps.map(({ incident: i, reviews: done, nextReviewNumber }) => {
                const mine = reviews.find((r) => r.incidentId === i.id);
                const reviewNumber = mine?.reviewNumber ?? nextReviewNumber;
                if (!mine && nextReviewNumber > 2) return null;
                return (
                  <div key={i.id} className="rounded-md border border-line p-3">
                    <input type="hidden" name="cap_incident_id" value={i.id} />
                    <input type="hidden" name={`cap_${i.id}_review_number`} value={reviewNumber} />
                    <div className="mb-1 text-sm font-medium">Incident #{i.incidentNumber} · {INCIDENT_TYPE_LABEL[i.type]} · CAP implemented {fmt(i.capImplementedOn)} · <span className="badge badge-muted">{reviewNumber === 1 ? "First review" : "Second review"}</span></div>
                    <div className="mb-2 whitespace-pre-wrap rounded bg-ground p-2 text-xs text-ink-2">{i.correctiveActionPlan}</div>
                    {done.filter((r) => r.summaryId !== id).map((r) => <div key={r.id} className="mb-1 text-xs text-ink-3">Review {r.reviewNumber}: {r.effective === true ? "effective" : r.effective === false ? "not effective" : "—"}{r.comments ? ` — ${r.comments}` : ""}</div>)}
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Field label="CAP effective?">
                        <select name={`cap_${i.id}_effective`} className="field" defaultValue={mine?.effective === true ? "yes" : mine?.effective === false ? "no" : ""} disabled={final}>
                          <option value="">—</option><option value="yes">Yes</option><option value="no">No</option>
                        </select>
                      </Field>
                      <Field label="Comments" className="sm:col-span-2"><input name={`cap_${i.id}_comments`} className="field" defaultValue={mine?.comments ?? ""} disabled={final} /></Field>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="card grid gap-4 sm:grid-cols-2">
          <h2 className="font-semibold sm:col-span-2">Communication and certification</h2>
          <Field label="Prepared by (PIC)">
            <select name="preparedByPersonId" className="field" defaultValue={summary.preparedByPersonId ?? ""} disabled={final}>
              <option value="">—</option>
              {people.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}{p.isPic ? " (PIC)" : ""}</option>)}
            </select>
          </Field>
          <Field label="Date prepared"><input name="preparedOn" type="date" className="field" defaultValue={summary.preparedOn ?? todayIso()} disabled={final} /></Field>
          <Field label="Date communicated to pharmacy personnel"><input name="communicatedOn" type="date" className="field" defaultValue={summary.communicatedOn ?? ""} disabled={final} /></Field>
          <Field label="Method of communication" hint="meeting, email, webinar, etc."><input name="communicationMethod" className="field" defaultValue={summary.communicationMethod ?? ""} disabled={final} /></Field>
          <div className="sm:col-span-2">
            <div className="label">Communicated to</div>
            <div className="grid gap-1 sm:grid-cols-3">
              {people.filter((p) => p.active).map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="communicatedTo" value={p.id} defaultChecked={communicated.includes(p.id)} disabled={final} /> {p.firstName} {p.lastName}</label>
              ))}
            </div>
          </div>
          <Field label="Additional notes (printed under Other / comments if needed)" className="sm:col-span-2"><textarea name="additionalNotes" className="field" rows={2} defaultValue={summary.additionalNotes ?? ""} disabled={final} /></Field>
        </section>

        {!final && (
          <div className="flex flex-wrap gap-2">
            <button className="btn" type="submit">Save draft</button>
            <button className="btn btn-primary" type="submit" name="finalize" value="1">Finalize and print</button>
          </div>
        )}
      </form>

      <section className="card mt-6 max-w-4xl">
        <h2 className="mb-3 font-semibold">Signed copy</h2>
        <p className="mb-3 text-xs text-ink-3">After printing and signing, scan the signed C-550 (with its C-650s) and attach it here. Retained five years.</p>
        <DocumentList docs={docs} redirectTo={here} canManage />
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-accent">Upload signed copy</summary>
          <div className="mt-3"><UploadForm redirectTo={here} hidden={{ cqiSummaryId: id }} categories={["cqi_summary", "cqi_incident", "other"]} defaultCategory="cqi_summary" compact /></div>
        </details>
      </section>

      {!final && <form action={deleteSummary.bind(null, id)} className="mt-6"><button className="btn btn-danger">Delete draft</button></form>}
    </>
  );
}
