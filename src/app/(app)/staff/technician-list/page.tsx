import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { PrintFrame } from "@/components/print";
import { snapshotFor, filedMonths } from "@/lib/technician-list";
import { periodLabel } from "@/lib/periods";

export const metadata = { title: "Technician list (C-900)" };
export const dynamic = "force-dynamic";

/**
 * Kansas Form C-900: the list of pharmacy technicians employed, K.S.A. 65-1663(i).
 *
 * Two things this shows, and the second one was unreachable until now. Today's list is the one
 * the Board asks to see on a visit. But the site also files a snapshot at the end of every month,
 * automatically, and those are what answer the harder question — who was registered here last
 * March — which is the version that matters after an incident. Filing them and providing no way
 * to open them was the same as not filing them.
 */
export default async function TechnicianListPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireUser();
  const { month } = await searchParams;
  const s = await getSettings();
  const months = await filedMonths();
  const archived = month ? await snapshotFor(month) : null;

  const techs = await db.query.people.findMany({ where: and(eq(schema.people.role, "technician"), eq(schema.people.active, true)), orderBy: (p, { asc }) => [asc(p.lastName)] });
  const creds = await db.query.credentials.findMany({ where: eq(schema.credentials.type, "technician_registration") });

  const rows = archived
    ? archived.technicians
        .filter((t) => t.role === "technician")
        .map((t) => {
          const [first, ...rest] = t.name.split(" ");
          return { name: `${rest.join(" ")}, ${first}`, number: t.registrationNumber ?? "" };
        })
    : techs.map((t) => ({ name: `${t.lastName}, ${t.firstName}`, number: creds.find((c) => c.personId === t.id)?.number ?? "" }));
  while (rows.length < 17) rows.push({ name: "", number: "" });

  return (
    <PrintFrame formTitle="REGISTRATION APPLICATION: Pharmacy Technician List" formNumber="Form C-900" revised="02/2023" backHref="/staff">
      <div className="mb-3 border border-black">
        <div className="bg-neutral-300 px-2 py-0.5 text-sm font-bold">INSTRUCTIONS</div>
        <p className="px-2 py-1 text-[11px] leading-snug">
          Complete the following information pursuant to K.S.A. 65-1663(i): “Each pharmacy shall at all times maintain a list of the names of pharmacy technicians employed by the pharmacy”. Use additional copies of the form as needed. This list should be available for inspector review. This form does not replace Form LA-50 (Change in Employment).
        </p>
      </div>
      <table className="mb-4 w-full border-collapse text-[11px]">
        <tbody>
          <tr>
            <td className="w-1/2 border border-black px-2 py-1 align-top"><span className="block text-[9px]">Name of Pharmacy</span>{s.pharmacy_name}</td>
            <td className="border border-black px-2 py-1 align-top"><span className="block text-[9px]">Pharmacy License Number</span>{s.pharmacy_registration_number}</td>
          </tr>
          <tr><td colSpan={2} className="border border-black px-2 py-1 align-top"><span className="block text-[9px]">Pharmacy Physical Address</span>{s.pharmacy_address}</td></tr>
        </tbody>
      </table>
      <table className="mb-4 w-full border-collapse text-[11px]">
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1"><span className="block text-[9px]">City</span>{s.pharmacy_city}</td>
            <td className="border border-black px-2 py-1"><span className="block text-[9px]">State</span>{s.pharmacy_state}</td>
            <td className="border border-black px-2 py-1"><span className="block text-[9px]">Zip</span>{s.pharmacy_zip}</td>
            <td className="border border-black px-2 py-1"><span className="block text-[9px]">County</span>{s.pharmacy_county}</td>
          </tr>
        </tbody>
      </table>
      <div className="no-print mb-4 rounded-lg border border-line bg-surface p-3">
        <p className="text-sm font-semibold">
          {archived ? `Filed list for ${periodLabel(month!)}` : "Today's list"}
        </p>
        <p className="mt-0.5 text-xs text-ink-3">
          A snapshot is filed automatically at the end of every month and kept, so the list for any past month can be
          produced exactly as it stood — not reconstructed from who happens to be on staff now.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Link href="/staff/technician-list" className={`btn btn-sm ${archived ? "" : "btn-primary"}`}>Today</Link>
          {months.slice(0, 24).map((m) => (
            <Link
              key={m}
              href={`/staff/technician-list?month=${m}`}
              className={`btn btn-sm ${m === month ? "btn-primary" : ""}`}
            >
              {periodLabel(m)}
            </Link>
          ))}
          {months.length === 0 && (
            <span className="text-xs text-ink-3">
              No months filed yet — the first is filed once a whole month has passed.
            </span>
          )}
        </div>
      </div>

      <div className="mb-1 text-sm font-bold">
        TECHNICIAN LIST{archived ? ` — as filed for ${periodLabel(month!)}` : ""}
      </div>
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="h-8 w-2/3 border border-black px-2 py-0.5 align-top"><span className="block text-[9px]">Name</span>{r.name}</td>
              <td className="border border-black px-2 py-0.5 align-top"><span className="block text-[9px]">Registration Number</span>{r.number}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </PrintFrame>
  );
}
