import { INCIDENT_TYPES } from "@/db/schema";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { todayIso } from "@/lib/dates";
import { Field } from "@/components/ui";
import type { EmployeeReview } from "@/lib/cqi";

type Person = { id: string; firstName: string; lastName: string; isPic: boolean; active: boolean };

export function IncidentForm({
  action,
  people,
  incident,
  rxNumbers,
  employeeReviews,
  submitLabel,
}: {
  action: (fd: FormData) => Promise<void>;
  people: Person[];
  incident?: {
    occurredOn: string;
    reportCreatedOn: string;
    type: string;
    typeOther: string | null;
    description: string;
    reachedPatient: boolean | null;
    reviewerPersonId: string | null;
    reviewStartedOn: string | null;
    reviewCompletedOn: string | null;
    employeeCommunication: string | null;
    rootCauseAnalysis: string | null;
    correctiveActionPlan: string | null;
    capImplementedOn: string | null;
    externalReportRef: string | null;
  };
  rxNumbers?: string[];
  employeeReviews?: EmployeeReview[];
  submitLabel: string;
}) {
  const today = todayIso();
  const pic = people.find((p) => p.isPic);
  const rows: (EmployeeReview | null)[] = [...(employeeReviews ?? [])];
  while (rows.length < 4) rows.push(null);

  return (
    <form action={action} className="space-y-6">
      <section className="card grid gap-4 sm:grid-cols-3">
        <h2 className="font-semibold sm:col-span-3">Incident</h2>
        <Field label="Date of incident"><input name="occurredOn" type="date" className="field" required defaultValue={incident?.occurredOn ?? today} /></Field>
        <Field label="Date incident report created" hint="Starts the 7-day and 30-day review clocks."><input name="reportCreatedOn" type="date" className="field" required defaultValue={incident?.reportCreatedOn ?? today} /></Field>
        <Field label="Reached the patient?">
          <select name="reachedPatient" className="field" defaultValue={incident?.reachedPatient === true ? "yes" : incident?.reachedPatient === false ? "no" : ""}>
            <option value="">Unknown</option>
            <option value="yes">Yes</option>
            <option value="no">No (near miss)</option>
          </select>
        </Field>
        <Field label="Incident type (Board categories)" className="sm:col-span-2">
          <select name="type" className="field" defaultValue={incident?.type ?? "wrong_drug"}>
            {INCIDENT_TYPES.map((t) => <option key={t} value={t}>{INCIDENT_TYPE_LABEL[t]}</option>)}
          </select>
        </Field>
        <Field label="If other, describe"><input name="typeOther" className="field" defaultValue={incident?.typeOther ?? ""} /></Field>
        <Field label="Prescription number(s)" hint="Separate with commas. Stored encrypted; printed on the C-550 as the Board requires." className="sm:col-span-3">
          <input name="rxNumbers" className="field font-mono" defaultValue={(rxNumbers ?? []).join(", ")} />
        </Field>
        <Field label="What happened" hint="Describe the error and how it was found. Do not include the patient's name, date of birth, phone, or address." className="sm:col-span-3">
          <textarea name="description" className="field" rows={4} required defaultValue={incident?.description ?? ""} />
        </Field>
        <Field label="Where the full incident report is filed" hint="e.g. PioneerRx incident #, binder, or PSO reference" className="sm:col-span-3">
          <input name="externalReportRef" className="field" defaultValue={incident?.externalReportRef ?? ""} />
        </Field>
      </section>

      <section className="card grid gap-4 sm:grid-cols-3">
        <h2 className="font-semibold sm:col-span-3">Review (PIC or designee)</h2>
        <Field label="Reviewer">
          <select name="reviewerPersonId" className="field" defaultValue={incident?.reviewerPersonId ?? pic?.id ?? ""}>
            <option value="">—</option>
            {people.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}{p.isPic ? " (PIC)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Date review started" hint="Within 7 days of the report."><input name="reviewStartedOn" type="date" className="field" defaultValue={incident?.reviewStartedOn ?? ""} /></Field>
        <Field label="Date review completed" hint="Within 30 days of the report."><input name="reviewCompletedOn" type="date" className="field" defaultValue={incident?.reviewCompletedOn ?? ""} /></Field>

        <div className="sm:col-span-3">
          <div className="label">Pharmacy personnel involved</div>
          <p className="hint mb-2">Each employee involved must be communicated with as part of the review. License numbers print from their staff record.</p>
          <div className="grid gap-2">
            {rows.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-3">
                <select name={`emp_${i}_personId`} className="field" defaultValue={r?.personId ?? ""}>
                  <option value="">— employee —</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                </select>
                <input name={`emp_${i}_reviewedOn`} type="date" className="field" title="Date incident reviewed with employee" defaultValue={r?.reviewedOn ?? ""} />
                <select name={`emp_${i}_reviewedBy`} className="field" defaultValue={r?.reviewedByPersonId ?? pic?.id ?? ""}>
                  <option value="">— reviewed by —</option>
                  {people.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
        <Field label="Communication with employees (notes)" className="sm:col-span-3">
          <textarea name="employeeCommunication" className="field" rows={2} defaultValue={incident?.employeeCommunication ?? ""} />
        </Field>
      </section>

      <section className="card grid gap-4">
        <h2 className="font-semibold">Root cause analysis and corrective action plan</h2>
        <Field label="Root cause analysis (RCA)" hint="Examine all issues and processes that led to the incident.">
          <textarea name="rootCauseAnalysis" className="field" rows={5} defaultValue={incident?.rootCauseAnalysis ?? ""} />
        </Field>
        <Field label="Corrective action plan (CAP)" hint="Measures to be taken to ensure the incident doesn't recur. Its effectiveness is evaluated on the next two bimonthly summaries.">
          <textarea name="correctiveActionPlan" className="field" rows={5} defaultValue={incident?.correctiveActionPlan ?? ""} />
        </Field>
        <Field label="CAP implementation date" className="max-w-xs"><input name="capImplementedOn" type="date" className="field" defaultValue={incident?.capImplementedOn ?? ""} /></Field>
      </section>

      <button className="btn btn-primary" type="submit">{submitLabel}</button>
    </form>
  );
}
