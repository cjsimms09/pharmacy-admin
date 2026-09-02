import Link from "next/link";
import { db } from "@/db";
import { requireManager } from "@/lib/auth";
import { addDays, daysUntil, fmt } from "@/lib/dates";
import { PageHeader, Notice, Empty, StatusBadge } from "@/components/ui";
import { InventoryForm } from "./inventory-form";
import { createInventory } from "./actions";

export const metadata = { title: "Controlled substance inventories" };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireManager();
  const { error } = await searchParams;
  const [invs, people, docs] = await Promise.all([
    db.query.csInventories.findMany({ orderBy: (i, { desc }) => [desc(i.inventoryDate)] }),
    db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.documents.findMany({ where: (d, { isNotNull }) => isNotNull(d.csInventoryId) }),
  ]);
  const last = invs[0];
  const nextDue = last ? addDays(last.inventoryDate, 375) : null;

  return (
    <>
      <PageHeader title="Controlled substance inventories" subtitle="Kansas requires a complete count at least annually, no later than 375 days after the previous one, taken before opening or after close, with each participant's name, license number, and signature. Kept 5 years. Form C-250 is the cover sheet." />
      {error && <Notice kind="crit">{error}</Notice>}

      <section className="card mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-2">Next inventory due</div>
          <div className="text-xl font-bold">{nextDue ? fmt(nextDue) : "Unknown — record the last inventory"}</div>
          {last && <div className="text-xs text-ink-3">Last taken {fmt(last.inventoryDate)}</div>}
        </div>
        {nextDue && <StatusBadge days={daysUntil(nextDue)} />}
      </section>

      <section className="card mb-6">
        <h2 className="mb-3 font-semibold">Inventories on file</h2>
        {invs.length === 0 ? <Empty>None recorded yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Date</th><th>Taken at</th><th>Type</th><th>Covers</th><th>Participants</th><th>Signed sheet</th><th></th></tr></thead>
            <tbody>
              {invs.map((i) => {
                const ids: string[] = JSON.parse(i.participantIds || "[]");
                const d = docs.filter((x) => x.csInventoryId === i.id);
                return (
                  <tr key={i.id}>
                    <td><Link href={`/inventory/${i.id}`} className="font-medium text-accent hover:underline">{fmt(i.inventoryDate)}</Link></td>
                    <td className="text-xs">{i.takenAt === "opening" ? "Opening" : i.takenAt === "close" ? "Close" : `${i.timeStarted ?? ""}–${i.timeEnded ?? ""}`}</td>
                    <td className="text-xs">{[i.isKsAnnual && "KS annual", i.isDeaBiennial && "DEA biennial", i.isPicOutgoing && "PIC outgoing", i.isPicIncoming && "PIC incoming"].filter(Boolean).join(", ")}</td>
                    <td className="text-xs">{[i.coversCii && "CII", i.coversCiiiV && "CIII–V", i.coversDrugsOfConcern && "Drugs of concern"].filter(Boolean).join(", ")}</td>
                    <td className="text-xs">{ids.map((id) => people.find((p) => p.id === id)).filter(Boolean).map((p) => `${p!.firstName} ${p!.lastName}`).join(", ")}</td>
                    <td className="text-xs">{d.length ? d.map((x) => <a key={x.id} href={`/files/${x.id}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{x.title}</a>) : <span className="text-warn">not attached</span>}</td>
                    <td><Link href={`/inventory/${i.id}/print`} className="text-xs text-accent hover:underline">C-250</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Record an inventory</h2>
        <InventoryForm action={createInventory} people={people} submitLabel="Save inventory" />
      </section>
    </>
  );
}
