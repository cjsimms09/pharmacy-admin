import { requireUser } from "@/lib/auth";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { getSettings } from "@/lib/settings";
import { CHECKLIST, itemFor } from "@/lib/self-inspection-checklist";
import { history } from "@/lib/self-inspection";
import { fmt, fmtLong, todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Self-inspection record" };

/**
 * The walkthrough, on paper.
 *
 * Deliberately prints the findings before the clean items. Anyone reading this is looking for
 * what was found and what happened next; making them scroll past forty green rows to reach it
 * suggests the document is trying to bury something, which is the opposite of the impression a
 * self-inspection exists to create.
 */
export default async function WalkPrintPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const user = await requireUser();
  const { id } = await searchParams;
  const [s, all] = await Promise.all([getSettings(), history()]);

  const insp = id ? all.find((x) => x.id === id) : all.find((x) => x.completedOn) ?? all[0];
  if (!insp) {
    return (
      <PrintFrame ownDocument formTitle="Self-inspection record" formNumber="" revised="" backHref="/inspection/walk">
        <p className="text-sm">No walkthrough has been recorded yet.</p>
      </PrintFrame>
    );
  }

  const items = await db.query.selfInspectionItems.findMany({
    where: eq(schema.selfInspectionItems.inspectionId, insp.id),
  });
  const answerFor = (key: string) => items.find((i) => i.itemKey === key);
  const findings = items.filter((i) => i.result === "finding");

  return (
    <PrintFrame ownDocument formTitle="Self-inspection record" formNumber="" revised="" backHref="/inspection/walk">
      <div className="mb-4">
        <p className="text-lg font-bold">{s.pharmacy_name || "This pharmacy"}</p>
        <p className="text-xs">
          {[s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="text-xs">
          {s.pharmacy_registration_number ? `Kansas pharmacy registration ${s.pharmacy_registration_number}` : ""}
          {s.pharmacy_dea ? ` · DEA ${s.pharmacy_dea}` : ""}
        </p>
        <p className="mt-2 text-xs">
          Walked {fmt(insp.startedOn)}
          {insp.completedOn ? ` and completed ${fmt(insp.completedOn)} by ${insp.completedBy}` : " — not yet finished"}.
          {" "}{insp.answered} items assessed, {insp.findings} requiring correction.
          Printed {fmtLong(todayIso())} by {user.name}.
        </p>
        {insp.notes && <p className="mt-1 text-xs italic">{insp.notes}</p>}
      </div>

      {/* ── What was found, first ── */}
      <div className="mb-1 text-sm font-bold">
        {findings.length === 0 ? "NOTHING WAS FOUND REQUIRING CORRECTION" : `FINDINGS (${findings.length})`}
      </div>
      {findings.length === 0 ? (
        <p className="mb-6 border border-black p-2 text-[11px]">
          Every item was assessed as in order or as not applicable to this pharmacy. The full assessment is below.
        </p>
      ) : (
        <table className="mb-6 w-full border-collapse text-[10px]">
          <thead>
            <tr>
              <th className="border border-black px-2 py-1 text-left">What was found</th>
              <th className="border border-black px-2 py-1 text-left">Detail</th>
              <th className="border border-black px-2 py-1 text-left">What was done, and when</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f) => (
              <tr key={f.id} className="print-block">
                <td className="border border-black px-2 py-1 align-top font-medium">{itemFor(f.itemKey)?.ask ?? f.itemKey}</td>
                <td className="border border-black px-2 py-1 align-top">{f.note ?? "—"}</td>
                <td className="border border-black px-2 py-1 align-top">
                  {f.correctiveAction
                    ? `${f.correctiveAction} — ${fmt(f.correctedOn)}, ${f.correctedBy}`
                    : "OPEN — not yet corrected."}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ── The whole assessment ── */}
      <div className="mb-1 text-sm font-bold">FULL ASSESSMENT</div>
      {CHECKLIST.map((sec) => (
        <div key={sec.key} className="print-block mb-3">
          <div className="border border-b-0 border-black bg-neutral-200 px-2 py-1 text-[11px] font-bold">
            {sec.title} — {sec.where}
          </div>
          <table className="w-full border-collapse text-[10px]">
            <tbody>
              {sec.items.map((item) => {
                const a = answerFor(item.key);
                return (
                  <tr key={item.key}>
                    <td className="border border-black px-2 py-1 align-top">{item.ask}</td>
                    <td className="w-28 border border-black px-2 py-1 align-top">
                      {a?.result === "finding" ? "FINDING" : a?.result === "na" ? "not applicable" : a ? "in order" : "not assessed"}
                    </td>
                    <td className="w-64 border border-black px-2 py-1 align-top">{a?.note ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div className="print-signature mt-6">
        <p className="text-xs">
          I certify that I walked this pharmacy against each of the items above on the dates shown, and that the
          findings and corrections recorded here are true.
        </p>
        <p className="mt-4 text-xs">
          {insp.completedBy ?? "Pharmacist-in-charge"}: ______________________________ Date: ______________
        </p>
      </div>
    </PrintFrame>
  );
}
