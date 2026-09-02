import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { fmt } from "@/lib/dates";
import { PrintFrame, Check, Cell } from "@/components/print";
import { audit } from "@/lib/audit";

export const metadata = { title: "C-250" };

/** Kansas Form C-250: Controlled Substance Inventory Cover Page (optional). */
export default async function InventoryPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireManager();
  const { id } = await params;
  const inv = await db.query.csInventories.findFirst({ where: eq(schema.csInventories.id, id) });
  if (!inv) notFound();
  const [s, people, creds] = await Promise.all([getSettings(), db.query.people.findMany(), db.query.credentials.findMany()]);
  await audit({ action: "cs_inventory.print", userId: user.id, userName: user.name, entity: "cs_inventory", entityId: id });
  const dea = creds.find((c) => !c.personId && c.type === "dea_registration")?.number ?? "";
  const ids: string[] = JSON.parse(inv.participantIds || "[]");
  const rows = ids.map((pid) => {
    const p = people.find((x) => x.id === pid);
    const lic = creds.find((c) => c.personId === pid && ["pharmacist_license", "technician_registration", "intern_registration"].includes(c.type))?.number ?? "";
    return { name: p ? `${p.firstName} ${p.lastName}` : "", lic };
  });
  while (rows.length < 5) rows.push({ name: "", lic: "" });

  return (
    <PrintFrame formTitle="Controlled Substance Inventory Cover Page (Optional)" formNumber="Form C-250" revised="12/2024 (New)" backHref={`/inventory/${id}`} pageLabel="Page 1 of 1">
      <div className="mb-3 border border-black">
        <div className="bg-neutral-300 px-2 py-0.5 text-sm font-bold">INSTRUCTIONS</div>
        <p className="px-2 py-1 text-[11px] leading-snug">
          Print one cover sheet for each inventory. The CII inventory shall be maintained separately from the CIII-V inventory. Include all on hand schedule II-V drugs and drugs of concern listed in K.A.R. 68-21-7. Each required inventory of schedule II controlled substances and nonliquid dosage forms of other controlled substances and drugs of concern shall be taken by exact count.<br />
          <u>Retail pharmacies</u>: Include will call bins, expired controlled drugs, C-V OTC drugs, &amp; non-automated long term care facility e-kits.<br />
          <u>Medical care facilities</u>: Include expired controlled drugs, all locations, automated dispensing cabinets, emergency/operating rooms, crash carts, etc.
        </p>
      </div>
      <table className="mb-3 w-full border-collapse">
        <tbody>
          <tr><Cell label="Facility Name" className="w-[38%]">{s.pharmacy_name}</Cell><Cell label="Facility Registration Number">{s.pharmacy_registration_number}</Cell><Cell label="Facility DEA Number">{dea}</Cell></tr>
          <tr><td colSpan={2} className="border border-black px-2 py-1 align-top"><span className="block text-[9px] text-neutral-700">Facility Address</span><span className="text-[11px]">{s.pharmacy_address}</span></td><Cell label="Facility City, State, and Zip code">{[s.pharmacy_city, s.pharmacy_state, s.pharmacy_zip].filter(Boolean).join(", ")}</Cell></tr>
        </tbody>
      </table>

      <div className="mb-4 border border-black px-3 py-2 text-[11px]">
        <div className="mb-2"><b>Date of Inventory</b>: <u>{fmt(inv.inventoryDate)}</u> (K.S.A. 68-20-16(b): No later than 375 days after the date of the previous inventory)</div>
        <div className="mb-1">Inventory taken at: <Check on={inv.takenAt === "opening"} />Opening of Business <span className="ml-6"><Check on={inv.takenAt === "close"} />Close of business</span></div>
        <div className="mb-1 text-center"><b>OR</b> (if open 24 hours)</div>
        <div className="mb-2 text-center">Time Started: <u>{inv.takenAt === "24h" ? inv.timeStarted ?? "" : "______________"}</u> &nbsp;&nbsp; Time Ended: <u>{inv.takenAt === "24h" ? inv.timeEnded ?? "" : "______________"}</u></div>
        <div>Check all that apply:</div>
        <div className="ml-4"><Check on={inv.isKsAnnual} /><b>KS Annual</b></div>
        <div className="ml-4"><Check on={inv.isDeaBiennial} /><b>DEA Biennial</b></div>
        <div className="ml-4"><Check on={inv.isPicOutgoing || inv.isPicIncoming} /><b>PIC Change</b>: <span className="ml-4"><Check on={inv.isPicOutgoing} /><b>Outgoing</b></span> <span className="ml-4"><Check on={inv.isPicIncoming} /><b>Incoming</b></span></div>
        <ul className="ml-8 list-disc text-[10px]">
          <li><u>Outgoing PIC</u> - K.S.A. 68-1-9(h)(2): No more than 2 days before ceasing &amp; no later than the day ceasing to serve as PIC</li>
          <li><u>Incoming PIC</u> – K.S.A. 68-1-9(h)(3): No more than 2 days after beginning to serve as PIC.</li>
          <li>The PIC change inventory may be taken simultaneously on the outgoing PIC’s last day if both pharmacists are present, participate in, and sign the inventory.</li>
        </ul>
        <div className="mt-2 flex gap-10"><span><Check on={inv.coversCii} /><b>Schedule II</b></span><span><Check on={inv.coversCiiiV} /><b>Schedule III-V</b></span><span><Check on={inv.coversDrugsOfConcern} /><b>Drugs of Concern</b></span></div>
      </div>

      <div className="mb-1 text-[11px] font-bold">Individuals participating in the inventory <span className="font-normal">(Attach additional sheets as needed.)</span></div>
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="h-10 w-[38%] border border-black px-2 py-0.5 align-top"><span className="block text-[9px] text-neutral-700">Name</span>{r.name}</td>
              <td className="w-[22%] border border-black px-2 py-0.5 align-top"><span className="block text-[9px] text-neutral-700">License/Registration Number</span>{r.lic}</td>
              <td className="border border-black px-2 py-0.5 align-top"><span className="block text-[9px] text-neutral-700">Signature</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </PrintFrame>
  );
}
