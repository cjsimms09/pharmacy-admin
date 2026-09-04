import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { daysUntil, fmt } from "@/lib/dates";
import { CREDENTIAL_LABEL, PERSON_ROLE_LABEL } from "@/lib/labels";
import { PageHeader, Empty, StatusBadge } from "@/components/ui";

export const metadata = { title: "Staff & licenses" };

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requireUser();
  const { all } = await searchParams;
  const people = await db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName), asc(p.firstName)] });
  const creds = await db.query.credentials.findMany();
  const shown = people.filter((p) => (all ? true : p.active) && (user.role === "staff" ? p.id === user.personId : true));
  const canManage = user.role !== "staff";
  const former = people.filter((p) => !p.active).length;

  return (
    <>
      <PageHeader
        title="Staff & licenses"
        subtitle="Every licensee and registrant, their credentials, and when each expires."
        actions={
          <>
            <Link href="/staff/rotations" className="btn">Rotations</Link>
            <Link href="/staff/technician-list" className="btn">Technician list (C-900)</Link>
            {canManage && <Link href="/staff/new" className="btn btn-primary">Add staff member</Link>}
          </>
        }
      />
      {shown.length === 0 ? (
        <Empty>No staff yet. {canManage && <Link href="/staff/new" className="text-accent underline">Add the first person.</Link>}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Credentials</th>
                <th>Next expiration</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const pc = creds.filter((c) => c.personId === p.id);
                const withDates = pc.filter((c) => c.expiresOn).sort((a, b) => a.expiresOn!.localeCompare(b.expiresOn!));
                const next = withDates[0];
                return (
                  <tr key={p.id} className={p.active ? "" : "opacity-60"}>
                    <td>
                      <Link href={`/staff/${p.id}`} className="font-medium text-accent hover:underline">{p.lastName}, {p.firstName}</Link>
                      <div className="text-xs text-ink-3">
                        {p.isPic && <span className="badge badge-ok mr-1">PIC</span>}
                        {p.administersVaccines && <span className="badge badge-muted mr-1">vaccinator</span>}
                        {!p.active && <span className="badge badge-muted">left {fmt(p.endedOn)}</span>}
                        {p.title}
                      </div>
                    </td>
                    <td>{PERSON_ROLE_LABEL[p.role]}</td>
                    <td className="text-xs text-ink-2">
                      {pc.length === 0 ? <span className="text-crit">none on file</span> : pc.map((c) => <div key={c.id}>{c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type]}{c.number ? ` · ${c.number}` : ""}</div>)}
                    </td>
                    <td>
                      {next ? (
                        <div className="flex items-center gap-2">
                          <StatusBadge days={daysUntil(next.expiresOn)} />
                          <span className="text-xs text-ink-2">{fmt(next.expiresOn)} · {CREDENTIAL_LABEL[next.type]}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-ink-3">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-3">
        {all ? (
          <Link href="/staff" className="underline">Hide former staff</Link>
        ) : (
          <Link href="/staff?all=1" className="underline">
            Show former staff{former > 0 ? ` (${former})` : ""}
          </Link>
        )}
        {" — nobody is ever deleted. A former employee's licences, training records and signed attestations stay on their page and stay searchable for as long as the retention rules require."}
      </p>
    </>
  );
}
