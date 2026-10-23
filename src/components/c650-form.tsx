import { INCIDENT_TYPES } from "@/db/schema";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { fitRcaCap } from "@/lib/cqi-print";
import { Check, Cell } from "@/components/print";

const labelC650: Record<string, string> = { ...INCIDENT_TYPE_LABEL, serious_harm: "Dispensed drug resulted in (or has potential to result in) serious harm to patient" };

export type C650Data = {
  facility: string;
  registration: string;
  rx: string;
  createdOn: string;
  type: string;
  typeOther: string;
  reviewStartedOn: string;
  reviewer: string;
  /** Always six rows; blank ones are the lines the pharmacist fills in by hand. */
  people: { name: string; license: string; reviewedOn: string; reviewedBy: string }[];
  pso: boolean;
  psoName: string;
  psoExpires: string;
  picName: string;
  completedOn: string;
  rca: string | null;
  cap: string | null;
};

/**
 * The Board's Form C-650: two sides of one sheet, and the page breaks are the form's own.
 *
 * Every side is built to fit a letter page at a 0.4 in margin, and scripts/check-c650-pages.ts prints it to a PDF and counts
 * the pages, so a change that pushes it onto a third sheet fails there instead of at the printer.
 */
export function C650Body({ d }: { d: C650Data }) {
  const fit = fitRcaCap(d.rca, d.cap);
  const boardTypes = INCIDENT_TYPES.filter((t) => t !== "other");
  const certification = (
    <div className="print-block">
      <div className="text-xs font-bold">PIC CERTIFICATION</div>
      <p className="text-[10px] italic">The information contained in this form is true, correct, and complete to the best of my knowledge.</p>
      <div className="grid grid-cols-3 gap-6 text-[10px]"><div></div><div className="pt-3">{d.picName}</div><div className="pt-3">{d.completedOn}</div></div>
      <div className="print-signature mt-4 grid grid-cols-3 gap-6 text-[9px]"><div className="border-t border-black pt-0.5">SIGNATURE</div><div className="border-t border-black pt-0.5">PRINTED NAME</div><div className="border-t border-black pt-0.5">DATE REVIEW COMPLETED</div></div>
    </div>
  );
  const box = (text: string | null, which: string) => (
    <div className={`print-prose mb-2 min-h-[2.2in] whitespace-pre-wrap border border-black px-2 py-1 ${fit.cls}`}>
      {d.pso && !text ? "Not required — active PSO member." : fit.attach ? `See attached sheet (${which}).` : text}
    </div>
  );

  return (
    <>
      <style>{"@page { size: letter; margin: 0.4in; }"}</style>
      <div className="c650-side text-[10px] leading-tight" style={{ breakAfter: "page" }}>
        <div className="mb-2 flex items-baseline gap-2 border border-black">
          <div className="bg-neutral-300 px-2 py-0.5 text-xs font-bold">INSTRUCTIONS</div>
          <p className="px-1 py-0.5 text-[10px]">Maintain all completed CQI Incident Report Evaluation forms (C-650) with corresponding CQI Bimonthly Summary form (C-550).</p>
        </div>
        <div className="print-heading mb-1 text-xs font-bold">INCIDENT INFORMATION</div>
        <table className="mb-2 w-full border-collapse">
          <tbody>
            <tr><Cell label="Facility Name" className="w-1/2">{d.facility}</Cell><Cell label="Facility Registration Number">{d.registration}</Cell></tr>
            <tr><Cell label="Prescription Number">{d.rx}</Cell><Cell label="Date incident report created">{d.createdOn}</Cell></tr>
            <tr>
              <td colSpan={2} className="border border-black px-2 py-1 text-[10px]">
                <div className="mb-0.5">Incident type:</div>
                <div className="grid grid-cols-2 gap-x-3">
                  {boardTypes.map((t) => <div key={t}><Check on={d.type === t} />{labelC650[t]}</div>)}
                  <div><Check on={d.type === "other"} />Other {d.type === "other" ? d.typeOther : "_______________________________"}</div>
                </div>
              </td>
            </tr>
            <tr><Cell label="Date PIC (or designee) started review">{d.reviewStartedOn}</Cell><Cell label="Name of Reviewer">{d.reviewer}</Cell></tr>
          </tbody>
        </table>

        <div className="print-heading mb-1 text-xs font-bold">PHARMACY PERSONNEL INVOLVED <span className="text-[9px] font-normal">(Attach additional pages if needed.)</span></div>
        <table className="mb-2 w-full border-collapse text-[10px]">
          <thead>
            <tr>
              <th className="border border-black px-2 py-0.5 text-left">Employee Name</th>
              <th className="border border-black px-2 py-0.5 text-left">License/Registration #</th>
              <th className="border border-black px-2 py-0.5 text-left">Date Incident Reviewed</th>
              <th className="border border-black px-2 py-0.5 text-left">Name of Person reviewing incident with Employee</th>
            </tr>
          </thead>
          <tbody>
            {d.people.map((r, i) => (
              <tr key={i}>
                <td className="h-5 border border-black px-2 py-0.5">{r.name}</td>
                <td className="border border-black px-2 py-0.5">{r.license}</td>
                <td className="border border-black px-2 py-0.5">{r.reviewedOn}</td>
                <td className="border border-black px-2 py-0.5">{r.reviewedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="print-heading mb-1 text-xs font-bold">PSO EXEMPTION</div>
        <div className="mb-2 text-[10px]">
          <Check on={d.pso} />Yes <Check on={!d.pso} />No <b>Do you actively participate in a Patient Safety Organization (PSO)?</b> If yes, the Root Cause Analysis (RCA) and Corrective Action Plan (CAP) are not required.
          <div className="ml-6">If yes, Name of PSO: {d.pso ? d.psoName : "______________________"} Membership Expiration Date: {d.pso ? d.psoExpires : "______________"}</div>
        </div>
        {certification}
        <div className="mt-2 text-[9px] text-neutral-700">Page 1 of 2</div>
      </div>

      <div className="c650-side text-[10px] leading-tight" style={fit.attach ? { breakAfter: "page" } : undefined}>
        <div className="print-heading mb-1 text-xs font-bold">PRESCRIPTION INFORMATION</div>
        <table className="mb-2 w-full border-collapse"><tbody><tr><Cell label="Prescription number" className="w-1/2">{d.rx}</Cell><Cell label="Date incident report created">{d.createdOn}</Cell></tr></tbody></table>
        <div className="text-xs font-bold">ROOT CAUSE ANALYSIS (RCA)</div>
        <p className="mb-1 text-[10px]">Examine all issues and processes that led to the incident. Attach additional pages, if necessary.</p>
        {box(d.rca, "RCA")}
        <div className="text-xs font-bold">CORRECTIVE ACTION PLAN (CAP)</div>
        <p className="mb-1 text-[10px]">List measures to be taken to ensure incident doesn’t recur. Attach additional pages, if necessary.</p>
        {box(d.cap, "CAP")}
        {certification}
      </div>

      {fit.attach && (
        <div className="c650-side">
          <div className="print-heading mb-1 text-xs font-bold">ATTACHED SHEET: Form C-650, prescription number {d.rx}</div>
          <div className="text-xs font-bold">ROOT CAUSE ANALYSIS (RCA)</div>
          <div className="mb-3 whitespace-pre-wrap border border-black px-2 py-1 text-[10px]">{d.rca}</div>
          <div className="text-xs font-bold">CORRECTIVE ACTION PLAN (CAP)</div>
          <div className="mb-3 whitespace-pre-wrap border border-black px-2 py-1 text-[10px]">{d.cap}</div>
        </div>
      )}
    </>
  );
}
