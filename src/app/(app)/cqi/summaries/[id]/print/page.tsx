import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { fmt } from "@/lib/dates";
import { capsToEvaluate, incidentsInPeriod, rxNumbersOf } from "@/lib/cqi";
import { INCIDENT_TYPES } from "@/db/schema";
import { INCIDENT_TYPE_LABEL } from "@/lib/labels";
import { PrintFrame, SignatureLine, Check, Cell } from "@/components/print";
import { audit } from "@/lib/audit";

export const metadata = { title: "C-550" };

/** Kansas Form C-550: CQI Bimonthly Summary. */
export default async function SummaryPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireManager();
  const { id } = await params;
  const summary = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.id, id) });
  if (!summary) notFound();
  const [s, incidents, caps, people, reviews] = await Promise.all([
    getSettings(),
    incidentsInPeriod(summary.periodStart, summary.periodEnd),
    capsToEvaluate(summary.periodStart, summary.periodEnd),
    db.query.people.findMany(),
    db.query.cqiCapReviews.findMany({ where: eq(schema.cqiCapReviews.summaryId, id) }),
  ]);
  await audit({ action: "cqi.summary.print", userId: user.id, userName: user.name, entity: "cqi_summary", entityId: id });

  const dueMonth = Number(summary.dueOn.slice(5, 7));
  const year = summary.dueOn.slice(0, 4);
  const isNull = summary.isNullReport || incidents.length === 0;
  const pic = people.find((p) => p.id === summary.preparedByPersonId) ?? people.find((p) => p.isPic);
  const picName = pic ? `${pic.firstName} ${pic.lastName}` : "";
  const rxByType = (t: string) => incidents.filter((i) => i.type === t).flatMap((i) => rxNumbersOf(i)).join(", ");
  const otherList = incidents.filter((i) => i.type === "other").map((i) => `${i.typeOther ?? "Other"}: ${rxNumbersOf(i).join(", ")}`).join("; ");

  // CAP blocks: those with a review recorded on this summary (or due one), first block on page 1, rest on page 2 in pairs.
  const blocks = caps
    .map(({ incident: i, reviews: done, nextReviewNumber }) => {
      const mine = reviews.find((r) => r.incidentId === i.id);
      const reviewNumber = mine?.reviewNumber ?? nextReviewNumber;
      if (!mine && nextReviewNumber > 2) return null;
      return { i, reviewNumber, effective: mine?.effective ?? null, comments: mine?.comments ?? "", prior: done.filter((r) => r.summaryId !== id) };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
  const first = blocks[0];
  const rest = blocks.slice(1);
  const pages: (typeof rest)[] = [];
  for (let k = 0; k < rest.length; k += 2) pages.push(rest.slice(k, k + 2));
  const totalPages = 1 + Math.max(pages.length, 0);

  return (
    <PrintFrame formTitle="CQI Bimonthly Summary" formNumber="Form C-550" revised="2/2025" backHref={`/cqi/summaries/${id}`} pageLabel={`Page 1 of ${totalPages}`}>
      <div className="mb-3 border border-black">
        <div className="bg-neutral-300 px-2 py-0.5 text-sm font-bold">INSTRUCTIONS</div>
        <p className="px-2 py-1 text-[11px]">Maintain all Individual CQI Incident Report Evaluation forms (C-650) with corresponding CQI Bimonthly Summary (C-550).</p>
        <p className="px-2 pb-1 text-[11px]">K.A.R. 68-19-1 requires the PIC to complete a summary and communicate the information to all pharmacy personnel no later February 15, April 15, June 15, August 15, October 15, and December 15 each year.</p>
      </div>

      <div className="mb-1 text-sm font-bold">FACILITY INFORMATION</div>
      <table className="mb-3 w-full border-collapse">
        <tbody>
          <tr><Cell label="Facility Name" className="w-1/2">{s.pharmacy_name}</Cell><Cell label="Facility Registration Number">{s.pharmacy_registration_number}</Cell></tr>
          <tr><Cell label="Date Summary Communicated to Pharmacy Personnel">{fmt(summary.communicatedOn)}</Cell><Cell label="Method of Communication (i.e., meeting, email, webinar, etc.)">{summary.communicationMethod}</Cell></tr>
        </tbody>
      </table>

      <div className="mb-1 text-sm font-bold">SUMMARY TYPE <span className="text-[10px] font-normal">(Indicate which Bimonthly Summary this represents)</span></div>
      <div className="mb-2 grid grid-cols-3 gap-x-4 text-[11px]">
        <div>{[[2, "February"], [4, "April"], [6, "June"]].map(([m, name]) => <div key={m}><Check on={dueMonth === m} />{name}</div>)}</div>
        <div>{[[8, "August"], [10, "October"], [12, "December"]].map(([m, name]) => <div key={m}><Check on={dueMonth === m} />{name}</div>)}</div>
        <div>Year: <u>{year}</u></div>
      </div>
      <div className="mb-3 text-[11px]"><Check on={isNull} /><b>Null Report</b>: Check this box if this summary is being filed as a null report under K.A.R. 68-19-1(b)(4).</div>

      <div className="mb-1 text-sm font-bold">INCIDENT TYPE SUMMARY <span className="text-[10px] font-normal">(attach additional page if needed)</span></div>
      <table className="mb-3 w-full border-collapse text-[11px]">
        <thead><tr><th className="w-[45%] border border-black px-2 py-0.5 text-center">Incident type</th><th className="border border-black px-2 py-0.5 text-center">Rx numbers associated with incident type</th></tr></thead>
        <tbody>
          {INCIDENT_TYPES.filter((t) => t !== "other").map((t) => (
            <tr key={t}><td className="border border-black px-2 py-0.5">{INCIDENT_TYPE_LABEL[t]}</td><td className="border border-black px-2 py-0.5 font-mono">{isNull ? "" : rxByType(t)}</td></tr>
          ))}
          <tr><td className="border border-black px-2 py-0.5">Other (list): {isNull ? "" : otherList}</td><td className="border border-black px-2 py-0.5"></td></tr>
        </tbody>
      </table>

      <div className="text-sm font-bold">EVALUATION OF OUTCOME AND EFFECTIVENESS OF CORRECTIVE ACTION PLAN (CAP)</div>
      <p className="mb-1 text-[10px]">Use multiple copies of page 2, as needed, to address all incident types.</p>
      <CapBlock b={first} pso={s.pso_member === "yes"} />

      <div className="mt-4 text-sm font-bold">PIC CERTIFICATION</div>
      <p className="text-[11px] italic">The information contained in this form is true, correct, and complete to the best of my knowledge.</p>
      <div className="grid grid-cols-3 gap-6 text-[11px]"><div></div><div className="pt-6">{picName}</div><div className="pt-6">{fmt(summary.preparedOn)}</div></div>
      <SignatureLine />

      {pages.map((pair, idx) => (
        <div key={idx}>
          <div className="break-before-page pt-6" />
          <div className="mb-2 text-sm font-bold">SUPPLEMENTAL EVALUATION OF CAP</div>
          {pair.map((b) => <div key={b.i.id} className="mb-4"><CapBlock b={b} pso={s.pso_member === "yes"} /></div>)}
          <div className="mt-4 text-sm font-bold">PIC CERTIFICATION</div>
          <p className="text-[11px] italic">The information contained in this form is true, correct, and complete to the best of my knowledge.</p>
          <div className="grid grid-cols-3 gap-6 text-[11px]"><div></div><div className="pt-6">{picName}</div><div className="pt-6">{fmt(summary.preparedOn)}</div></div>
          <SignatureLine />
          <div className="mt-4 text-[10px] text-neutral-700">Page {idx + 2} of {totalPages}</div>
        </div>
      ))}
    </PrintFrame>
  );
}

function CapBlock({ b, pso }: { b: { i: { type: string; typeOther: string | null; capImplementedOn: string | null; correctiveActionPlan: string | null; incidentNumber: number }; reviewNumber: number; effective: boolean | null; comments: string; prior: { reviewNumber: number; effective: boolean | null; comments: string | null }[] } | undefined; pso: boolean }) {
  const t = b?.i.type as keyof typeof INCIDENT_TYPE_LABEL | undefined;
  return (
    <table className="w-full border-collapse text-[11px]">
      <tbody>
        <tr>
          <Cell label="Incident Type" className="w-1/2">{b ? `${INCIDENT_TYPE_LABEL[t!]}${b.i.type === "other" && b.i.typeOther ? `: ${b.i.typeOther}` : ""} (incident #${b.i.incidentNumber})` : ""}</Cell>
          <Cell label="CAP Implementation Date">{b ? fmt(b.i.capImplementedOn) : ""}</Cell>
        </tr>
        <tr>
          <td colSpan={2} className="border border-black px-2 py-1 align-top">
            <span className="block text-[9px] text-neutral-700">CAP Description (Completion of this field not required if active member of PSO)</span>
            <div className="min-h-[0.9in] whitespace-pre-wrap">{b ? (pso && !b.i.correctiveActionPlan ? "Not required — active PSO member." : b.i.correctiveActionPlan) : ""}</div>
          </td>
        </tr>
        <tr>
          <td className="border border-black px-2 py-1">CAP Review <Check on={b?.reviewNumber === 1} />First review <Check on={b?.reviewNumber === 2} />Second review</td>
          <td className="border border-black px-2 py-1">CAP effective? <Check on={b?.effective === true} />Yes <Check on={b?.effective === false} />No</td>
        </tr>
        <tr>
          <td colSpan={2} className="border border-black px-2 py-1 align-top">
            <span className="block text-[9px] text-neutral-700">Comments</span>
            <div className="min-h-[0.7in] whitespace-pre-wrap">
              {b?.comments}
              {b?.prior.map((p) => <div key={p.reviewNumber} className="text-neutral-700">Prior review {p.reviewNumber}: {p.effective === true ? "effective" : p.effective === false ? "not effective" : "—"}{p.comments ? ` — ${p.comments}` : ""}</div>)}
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
