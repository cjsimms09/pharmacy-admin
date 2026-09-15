import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Audit log" };

export default async function AuditPage() {
  await requireManager();
  const rows = await db.select().from(schema.auditEvents).orderBy(desc(schema.auditEvents.at)).limit(500);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every sign-in, upload, view, and change. Append-only; most recent first." />
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="table">
          <thead><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap font-mono text-xs">{r.at.replace("T", " ").slice(0, 19)}</td>
                <td>{r.userName ?? "—"}</td>
                <td className="font-mono text-xs">{r.action}</td>
                <td className="text-xs text-ink-2">{r.entity ? `${r.entity} ${r.entityId?.slice(0, 8) ?? ""}` : ""}</td>
                <td className="text-xs text-ink-2">{r.details ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
