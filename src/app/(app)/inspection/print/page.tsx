import { requireUser } from "@/lib/auth";
import { inspectionReport } from "@/lib/inspection";
import { fmtLong } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inspection pack" };

/**
 * The pack, on paper.
 *
 * Not a substitute for the records themselves — an inspector wants the technician list and the
 * inventory, not a summary of them — but the sheet that says where each of those is and what
 * state it is in. Handing someone this at the start of a visit is the difference between an hour
 * of hunting and a conversation.
 */
export default async function InspectionPrintPage() {
  const user = await requireUser();
  const r = await inspectionReport();

  return (
    <PrintFrame ownDocument formTitle="Inspection readiness" formNumber="" revised="" backHref="/inspection">
      <div className="mb-4">
        <p className="text-lg font-bold">{r.pharmacy.name}</p>
        <p className="text-xs">{r.pharmacy.address}</p>
        <p className="text-xs">
          {r.pharmacy.registration ? `Kansas registration ${r.pharmacy.registration}` : "No registration number recorded"}
          {r.pharmacy.dea ? ` · DEA ${r.pharmacy.dea}` : ""}
        </p>
        <p className="mt-2 text-xs">
          Prepared {fmtLong(r.takenOn)} by {user.name}. This sheet says where each record is and what state it was in
          when it was printed; the records themselves are held in the system and can be produced on request.
        </p>
      </div>

      <p className="mb-3 border border-black p-2 text-sm font-semibold">{r.verdict}</p>

      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="border border-black px-2 py-1 text-left">Asked by</th>
            <th className="border border-black px-2 py-1 text-left">Asked for</th>
            <th className="border border-black px-2 py-1 text-left">State</th>
            <th className="border border-black px-2 py-1 text-left">What we hold</th>
            <th className="border border-black px-2 py-1 text-left">Authority</th>
          </tr>
        </thead>
        <tbody>
          {r.checks.map((c) => (
            <tr key={c.key} className="print-block">
              <td className="border border-black px-2 py-1 align-top">
                {c.who === "dea" ? "DEA" : c.who === "board" ? "Board" : "Both"}
              </td>
              <td className="border border-black px-2 py-1 align-top font-medium">{c.asks}</td>
              <td className="border border-black px-2 py-1 align-top">
                {c.state === "blocking" ? "FINDING" : c.state === "gap" ? "thin" : "ready"}
              </td>
              <td className="border border-black px-2 py-1 align-top">{c.answer}</td>
              <td className="border border-black px-2 py-1 align-top">{c.authority}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="print-signature mt-6">
        <p className="text-xs">Pharmacist-in-charge signature: ______________________________ Date: ______________</p>
      </div>
    </PrintFrame>
  );
}
