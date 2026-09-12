import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { fmt } from "@/lib/dates";
import { employeeReviewsOf, rxNumbersOf } from "@/lib/cqi";
import { INCIDENT_TYPES } from "@/db/schema";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { PrintFrame, SignatureLine, Check, Cell } from "@/components/print";
import { audit } from "@/lib/audit";

export const metadata = { title: "C-650" };

/** Kansas Form C-650: CQI Incident Report Evaluation. */
export default async function IncidentPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireManager();
  const { id } = await params;
  const inc = await db.query.cqiIncidents.findFirst({ where: eq(schema.cqiIncidents.id, id) });
  if (!inc) notFound();
  const [s, people, creds] = await Promise.all([getSettings(), db.query.people.findMany(), db.query.credentials.findMany()]);
  await audit({ action: "cqi.incident.print", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: id });
  const name = (pid: string | null) => {
    const p = people.find((x) => x.id === pid);
    return p ? `${p.firstName} ${p.lastName}` : "";
  };
  const licenseOf = (pid: string) => creds.find((c) => c.personId === pid && ["pharmacist_license", "technician_registration", "intern_registration"].includes(c.type))?.number ?? "";
  const rx = rxNumbersOf(inc).join(", ");
  const emps = employeeReviewsOf(inc);
  const rows = [...emps];
  while (rows.length < 6) rows.push({ personId: "", reviewedOn: null, reviewedByPersonId: null });
  const picName = name(people.find((p) => p.isPic)?.id ?? null);
  const boardTypes = INCIDENT_TYPES.filter((t) => t !== "other");
  const labelC650: Record<string, string> = { ...INCIDENT_TYPE_LABEL, serious_harm: "Dispensed drug resulted in (or has potential to result in) serious harm to patient" };

  return (
    <PrintFrame formTitle="CQI Incident Report Evaluation" formNumber="Form C-650" revised="1/2025" backHref={`/cqi/incidents/${id}`} pageLabel="Page 2 of 2">
      <div className="mb-3 border border-black">
        <div className="bg-neutral-300 px-2 py-0.5 text-sm font-bold">INSTRUCTIONS</div>
        <p className="px-2 py-1 text-[11px]">Maintain all completed CQI Incident Report Evaluation forms (C-650) with corresponding CQI Bimonthly Summary form (C-550).</p>
      </div>
      <div className="print-heading mb-1 text-sm font-bold">INCIDENT INFORMATION</div>
      <table className="mb-4 w-full border-collapse">
        <tbody>
          <tr><Cell label="Facility Name" className="w-1/2">{s.pharmacy_name}</Cell><Cell label="Facility Registration Number">{s.pharmacy_registration_number}</Cell></tr>
          <tr><Cell label="Prescription Number">{rx}</Cell><Cell label="Date incident report created">{fmt(inc.reportCreatedOn)}</Cell></tr>
          <tr>
            <td colSpan={2} className="border border-black px-2 py-1 text-[11px]">
              <div className="mb-1">Incident type:</div>
              {boardTypes.map((t) => <div key={t}><Check on={inc.type === t} />{labelC650[t]}</div>)}
              <div><Check on={inc.type === "other"} />Other {inc.type === "other" ? inc.typeOther ?? "" : "________________________________________________"}</div>
            </td>
          </tr>
          <tr><Cell label="Date PIC (or designee) started review">{fmt(inc.reviewStartedOn)}</Cell><Cell label="Name of Reviewer">{name(inc.reviewerPersonId)}</Cell></tr>
        </tbody>
      </table>

      <div className="print-heading mb-1 text-sm font-bold">PHARMACY PERSONNEL INVOLVED <span className="text-[10px] font-normal">(Attach additional pages if needed.)</span></div>
      <table className="mb-4 w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="border border-black px-2 py-1 text-left">Employee Name</th>
            <th className="border border-black px-2 py-1 text-left">License/Registration #</th>
            <th className="border border-black px-2 py-1 text-left">Date Incident Reviewed</th>
            <th className="border border-black px-2 py-1 text-left">Name of Person reviewing incident with Employee</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="h-8 border border-black px-2 py-1">{name(r.personId || null)}</td>
              <td className="border border-black px-2 py-1">{r.personId ? licenseOf(r.personId) : ""}</td>
              <td className="border border-black px-2 py-1">{r.reviewedOn ? fmt(r.reviewedOn) : ""}</td>
              <td className="border border-black px-2 py-1">{name(r.reviewedByPersonId)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="print-heading mb-1 text-sm font-bold">PSO EXEMPTION</div>
      <div className="mb-4 text-[11px]">
        <Check on={s.pso_member === "yes"} />Yes <Check on={s.pso_member !== "yes"} />No <b>Do you actively participate in a Patient Safety Organization (PSO)?</b>
        <div className="ml-6">If yes, Name of PSO: {s.pso_member === "yes" ? s.pso_name : "______________________"} Membership Expiration Date: {s.pso_member === "yes" ? fmt(s.pso_expires_on) : "______________"}</div>
        <div className="ml-6">If yes, the Root Cause Analysis (RCA) and Corrective Action Plan (CAP) are not required.</div>
      </div>

      <div className="text-sm font-bold">PIC CERTIFICATION</div>
      <p className="text-[11px] italic">The information contained in this form is true, correct, and complete to the best of my knowledge.</p>
      <div className="grid grid-cols-3 gap-6 text-[11px]"><div></div><div className="pt-6">{picName}</div><div className="pt-6">{fmt(inc.reviewCompletedOn)}</div></div>
      <SignatureLine dateLabel="DATE REVIEW COMPLETED" />
      <div className="mt-4 text-[10px] text-neutral-700">Page 1 of 2</div>

      <div className="break-before-page pt-6" />
      <div className="print-heading mb-1 text-sm font-bold">PRESCRIPTION INFORMATION</div>
      <table className="mb-4 w-full border-collapse"><tbody><tr><Cell label="Prescription number" className="w-1/2">{rx}</Cell><Cell label="Date incident report created">{fmt(inc.reportCreatedOn)}</Cell></tr></tbody></table>
      <div className="text-sm font-bold">ROOT CAUSE ANALYSIS (RCA)</div>
      <p className="mb-1 text-[11px]">Examine all issues and processes that led to the incident. Attach additional pages, if necessary.</p>
      <div className="print-prose mb-4 min-h-[2.6in] whitespace-pre-wrap border border-black px-2 py-1 text-[11px]">{s.pso_member === "yes" && !inc.rootCauseAnalysis ? "Not required — active PSO member." : inc.rootCauseAnalysis}</div>
      <div className="text-sm font-bold">CORRECTIVE ACTION PLAN (CAP)</div>
      <p className="mb-1 text-[11px]">List measures to be taken to ensure incident doesn’t recur. Attach additional pages, if necessary.</p>
      <div className="print-prose mb-4 min-h-[2.6in] whitespace-pre-wrap border border-black px-2 py-1 text-[11px]">{s.pso_member === "yes" && !inc.correctiveActionPlan ? "Not required — active PSO member." : inc.correctiveActionPlan}</div>
      <div className="text-sm font-bold">PIC CERTIFICATION</div>
      <p className="text-[11px] italic">The information contained in this form is true, correct, and complete to the best of my knowledge.</p>
      <div className="grid grid-cols-3 gap-6 text-[11px]"><div></div><div className="pt-6">{picName}</div><div className="pt-6">{fmt(inc.reviewCompletedOn)}</div></div>
      <SignatureLine dateLabel="DATE REVIEW COMPLETED" />
    </PrintFrame>
  );
}
