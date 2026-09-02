import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { INCIDENT_TYPES } from "@/db/schema";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { cqiPeriods, fmt, todayIso } from "@/lib/dates";
import { ExtractedPacket, type ExtractedPacketT } from "@/lib/ai";
import { PageHeader, BackLink, Notice, Field } from "@/components/ui";
import { applyImport, discardImport } from "../../ai-actions";

export default async function ImportReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  await requireManager();
  const { id } = await params;
  const { error } = await searchParams;
  const imp = await db.query.cqiImports.findFirst({ where: eq(schema.cqiImports.id, id) });
  if (!imp) notFound();
  if (imp.status === "applied") redirect("/cqi");
  if (imp.status === "failed") redirect(`/cqi/import?error=${encodeURIComponent(imp.error ?? "Extraction failed")}`);
  let data: ExtractedPacketT;
  try {
    data = ExtractedPacket.parse(JSON.parse(imp.resultJson));
  } catch {
    redirect(`/cqi/import?error=${encodeURIComponent("The extraction could not be read.")}`);
  }
  const people = await db.query.people.findMany();
  const y = Number(todayIso().slice(0, 4));
  const periods = cqiPeriods(y - 6, y).reverse();
  const summaries = data.summaries.length ? data.summaries : [{ dueOn: null, isNullReport: false, communicatedOn: null, communicationMethod: null, picName: null }];
  const matchId = (name: string | null) => {
    if (!name) return "";
    const n = name.trim().toLowerCase();
    const p =
      people.find((x) => `${x.firstName} ${x.lastName}`.toLowerCase() === n) ??
      people.find((x) => n.includes(x.lastName.toLowerCase()) && n.includes(x.firstName.toLowerCase())) ??
      people.find((x) => x.lastName.toLowerCase() === n || x.firstName.toLowerCase() === n);
    return p?.id ?? "";
  };
  const PersonSelect = ({ name, value, blank }: { name: string; value: string; blank: string }) => (
    <select name={name} className="field" defaultValue={value}>
      <option value="">{blank}</option>
      {people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}{p.isPic ? " (PIC)" : ""}</option>)}
    </select>
  );

  return (
    <>
      <BackLink href="/cqi/import">Imports</BackLink>
      <PageHeader title="Check what Claude read" subtitle="Correct anything that's wrong, pick the staff involved from your list, untick anything that shouldn't be saved, then create the records. Nothing is saved until you click the button at the bottom." />
      {people.length === 0 && <Notice kind="warn">No staff on file yet. Add your pharmacists and technicians under Staff first so they can be selected here.</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}
      {data.notes && <Notice kind="warn">Claude's notes: {data.notes}</Notice>}

      <form action={applyImport.bind(null, id)} className="max-w-5xl space-y-6">
        <input type="hidden" name="summary_count" value={summaries.length} />
        <input type="hidden" name="incident_count" value={data.incidents.length} />

        <section className="card">
          <h2 className="mb-3 font-semibold">Summary periods in this packet</h2>
          <div className="space-y-3">
            {summaries.map((s, i) => (
              <div key={i} className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-4">
                <label className="flex items-center gap-2 text-sm sm:col-span-4"><input type="checkbox" name={`sum_${i}_include`} defaultChecked /> Record this summary as filed (historical)</label>
                <Field label="Which summary">
                  <select name={`sum_${i}_dueOn`} className="field" defaultValue={s.dueOn ?? ""}>
                    <option value="">— choose —</option>
                    {periods.map((p) => <option key={p.dueOn} value={p.dueOn}>{p.label} (due {fmt(p.dueOn)})</option>)}
                  </select>
                </Field>
                <Field label="Communicated on"><input name={`sum_${i}_communicatedOn`} type="date" className="field" defaultValue={s.communicatedOn ?? ""} /></Field>
                <Field label="Method"><input name={`sum_${i}_method`} className="field" defaultValue={s.communicationMethod ?? ""} /></Field>
                <Field label="PIC named on form"><input name={`sum_${i}_pic`} className="field" defaultValue={s.picName ?? ""} /></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`sum_${i}_isNull`} defaultChecked={s.isNullReport} /> Null report</label>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="font-semibold">Incidents found: {data.incidents.length}</h2>
          {data.incidents.length === 0 && <p className="text-sm text-ink-2">No incident evaluations were found in this scan (a null-report period, or the C-650 pages weren't included).</p>}
          {data.incidents.map((inc, i) => (
            <div key={i} className="card grid gap-3 sm:grid-cols-3">
              <label className="flex items-center gap-2 text-sm font-medium sm:col-span-3"><input type="checkbox" name={`inc_${i}_include`} defaultChecked /> Incident {i + 1}</label>
              <Field label="Report created on"><input name={`inc_${i}_reportCreatedOn`} type="date" className="field" required defaultValue={inc.reportCreatedOn ?? ""} /></Field>
              <Field label="Occurred on"><input name={`inc_${i}_occurredOn`} type="date" className="field" defaultValue={inc.occurredOn ?? inc.reportCreatedOn ?? ""} /></Field>
              <Field label="Type">
                <select name={`inc_${i}_type`} className="field" defaultValue={inc.type}>
                  {INCIDENT_TYPES.map((t) => <option key={t} value={t}>{INCIDENT_TYPE_LABEL[t]}</option>)}
                </select>
              </Field>
              <Field label="If other"><input name={`inc_${i}_typeOther`} className="field" defaultValue={inc.typeOther ?? ""} /></Field>
              <Field label="Rx numbers" className="sm:col-span-2"><input name={`inc_${i}_rxNumbers`} className="field font-mono" defaultValue={inc.rxNumbers.join(", ")} /></Field>
              <Field label="Description" className="sm:col-span-3"><textarea name={`inc_${i}_description`} className="field" rows={2} defaultValue={inc.description} /></Field>
              <Field label="Reviewer (PIC or designee)" hint={inc.reviewerName ? `on the form: ${inc.reviewerName}` : undefined}>
                <input type="hidden" name={`inc_${i}_reviewerName`} value={inc.reviewerName ?? ""} />
                <PersonSelect name={`inc_${i}_reviewerPersonId`} value={matchId(inc.reviewerName)} blank="— choose —" />
              </Field>
              <Field label="Review started"><input name={`inc_${i}_reviewStartedOn`} type="date" className="field" defaultValue={inc.reviewStartedOn ?? ""} /></Field>
              <Field label="Review completed"><input name={`inc_${i}_reviewCompletedOn`} type="date" className="field" defaultValue={inc.reviewCompletedOn ?? ""} /></Field>
              <div className="sm:col-span-3">
                <div className="label">Personnel involved</div>
                <p className="hint mb-1">Employee · date reviewed with them · who reviewed it. Blank rows can be used to add someone the scan missed.</p>
                {[...inc.employees, { name: "", licenseNumber: null, reviewedOn: null, reviewedBy: null }, { name: "", licenseNumber: null, reviewedOn: null, reviewedBy: null }].map((e, k) => (
                  <div key={k} className="mb-1 grid gap-2 sm:grid-cols-3">
                    <div>
                      <input type="hidden" name={`inc_${i}_emp_${k}_name`} value={e.name} />
                      <PersonSelect name={`inc_${i}_emp_${k}_personId`} value={matchId(e.name)} blank={e.name ? `— not matched: “${e.name}” —` : "— add employee —"} />
                      {e.name && <div className="text-xs text-ink-3">on the form: {e.name}{e.licenseNumber ? ` · ${e.licenseNumber}` : ""}</div>}
                    </div>
                    <input name={`inc_${i}_emp_${k}_reviewedOn`} type="date" className="field" defaultValue={e.reviewedOn ?? ""} />
                    <PersonSelect name={`inc_${i}_emp_${k}_reviewedBy`} value={matchId(e.reviewedBy) || matchId(inc.reviewerName)} blank="— reviewed by —" />
                  </div>
                ))}
              </div>
              <Field label="Root cause analysis" className="sm:col-span-3"><textarea name={`inc_${i}_rootCauseAnalysis`} className="field" rows={3} defaultValue={inc.rootCauseAnalysis ?? ""} /></Field>
              <Field label="Corrective action plan" className="sm:col-span-3"><textarea name={`inc_${i}_correctiveActionPlan`} className="field" rows={3} defaultValue={inc.correctiveActionPlan ?? ""} /></Field>
              <Field label="CAP implemented on"><input name={`inc_${i}_capImplementedOn`} type="date" className="field" defaultValue={inc.capImplementedOn ?? ""} /></Field>
              <label className="flex items-start gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name={`inc_${i}_strengthen`} defaultChecked={(inc.rootCauseAnalysis ?? "").length + (inc.correctiveActionPlan ?? "").length < 600} className="mt-1" />
                <span>Strengthen the RCA and CAP with Claude when saving <span className="text-xs text-ink-3">(keeps the facts from the scan, expands them to the Board's expectations; the scanned text stays restorable on the incident)</span></span>
              </label>
              <div className="sm:col-span-3">
                <div className="label">CAP reviews recorded on summaries</div>
                {[0, 1].map((r) => {
                  const cr = inc.capReviews.find((x) => x.reviewNumber === r + 1);
                  return (
                    <div key={r} className="mb-1 grid gap-2 sm:grid-cols-4">
                      <div className="self-center text-xs text-ink-2">{r === 0 ? "First review" : "Second review"}</div>
                      <select name={`inc_${i}_cap_${r}_summaryDueOn`} className="field" defaultValue={cr?.summaryDueOn ?? ""}>
                        <option value="">— summary —</option>
                        {periods.map((p) => <option key={p.dueOn} value={p.dueOn}>{p.label}</option>)}
                      </select>
                      <select name={`inc_${i}_cap_${r}_effective`} className="field" defaultValue={cr?.effective === true ? "yes" : cr?.effective === false ? "no" : ""}>
                        <option value="">effective?</option><option value="yes">Yes</option><option value="no">No</option>
                      </select>
                      <input name={`inc_${i}_cap_${r}_comments`} className="field" placeholder="Comments" defaultValue={cr?.comments ?? ""} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit">Create these records</button>
        </div>
      </form>
      <form action={discardImport.bind(null, id)} className="mt-4"><button className="btn btn-danger">Discard this import</button></form>
    </>
  );
}
