import Link from "next/link";
import { computeAlerts, cqiSnapshot, csInventoryStatus, staffCompliance, type StaffRow } from "@/lib/compliance";
import { daysUntil, fmt } from "@/lib/dates";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { PageHeader, Empty } from "@/components/ui";
import { PERSON_ROLE_LABEL } from "@/lib/labels";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [alerts, staff, cqi, cs, docs, unread] = await Promise.all([
    computeAlerts(),
    staffCompliance(),
    cqiSnapshot(),
    csInventoryStatus(),
    db.select({ id: schema.documents.id }).from(schema.documents),
    db.query.inboxItems.findMany({ where: eq(schema.inboxItems.status, "stored"), orderBy: (i, { desc }) => [desc(i.sweptAt)], limit: 25 }),
  ]);

  const crit = alerts.filter((a) => a.level === "crit");
  const soon = alerts.filter((a) => a.level === "warn");
  const later = alerts.filter((a) => a.level === "info");
  const cqiDays = daysUntil(cqi.dueOn)!;
  // A finalized summary is never late, whatever the due date says.
  const cqiFiled = cqi.status === "final";
  const csDays = cs.dueOn ? daysUntil(cs.dueOn) : null;
  // "New" in the swept mailbox means arrived in the last week — there is no read/unread flag.
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentMail = unread.filter((m) => m.sweptAt >= weekAgo);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Everything with a deadline, soonest first." />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Needs you now"
          value={String(crit.length)}
          tone={crit.length > 0 ? "crit" : "ok"}
          sub={crit.length === 0 ? "Nothing overdue" : "Past a deadline"}
          href="#act-now"
        />
        <Stat label="Due within 30 days" value={String(soon.length)} tone={soon.length > 0 ? "warn" : "ok"} sub="Licenses, reviews, filings" href="#due-soon" />
        <Stat
          label={`CQI summary · ${cqi.label}`}
          value={cqiFiled ? "Filed" : cqiDays >= 0 ? `${cqiDays}d` : `${-cqiDays}d late`}
          tone={cqiFiled ? "ok" : cqiDays < 0 ? "crit" : cqiDays <= 14 ? "warn" : "ok"}
          sub={
            cqiFiled
              ? `Finalized · next due ${fmt(cqi.dueOn)}`
              : `Due ${fmt(cqi.dueOn)} · ${cqi.incidentCount} incident${cqi.incidentCount === 1 ? "" : "s"} · ${cqi.status}`
          }
          href={cqi.summaryId ? `/cqi/summaries/${cqi.summaryId}` : "/cqi"}
        />
        <Stat
          label="Annual CS inventory"
          value={csDays === null ? "—" : csDays >= 0 ? `${csDays}d` : `${-csDays}d late`}
          tone={csDays === null ? "warn" : csDays < 0 ? "crit" : csDays <= 60 ? "warn" : "ok"}
          sub={cs.last ? `Last taken ${fmt(cs.last)}` : "None on file"}
          href="/inventory"
        />
      </div>

      {cqi.needingYou > 0 || cqi.drafting > 0 ? (
        <section className="card mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">CQI cycle</h2>
              <p className="text-sm text-ink-2">
                {cqi.needingYou > 0 && <>{cqi.needingYou} incident{cqi.needingYou === 1 ? "" : "s"} need you. </>}
                {cqi.drafting > 0 && <>Claude is drafting {cqi.drafting} right now. </>}
                Everything else is carried onto the next summary on its own.
              </p>
            </div>
            <div className="flex gap-2">
              <Link href="/cqi/incidents" className="btn">Incidents</Link>
              {cqi.summaryId && <Link href={`/cqi/summaries/${cqi.summaryId}`} className="btn btn-primary">Open the summary</Link>}
            </div>
          </div>
        </section>
      ) : null}

      {recentMail.length > 0 && (
        <section className="card mb-6 border-accent">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm"><b>{recentMail.length}</b> report{recentMail.length === 1 ? "" : "s"} arrived in the swept mailbox this week.</p>
            <Link href="/inbox" className="btn">Open the inbox</Link>
          </div>
        </section>
      )}

      {alerts.length === 0 ? (
        <Empty>Nothing needs attention. Add staff and their licenses to start tracking expirations.</Empty>
      ) : (
        <div className="mb-6 space-y-5">
          <AlertGroup id="act-now" title="Act now — past a deadline" items={crit} tone="crit" />
          <AlertGroup id="due-soon" title="Due within 30 days" items={soon} tone="warn" />
          <AlertGroup id="later" title="Coming up — 30 to 90 days out" items={later} tone="info" />
        </div>
      )}

      <section className="card mb-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Staff and licenses</h2>
          <Link href="/staff" className="text-sm text-accent hover:underline">Manage staff →</Link>
        </div>
        {staff.length === 0 ? (
          <p className="text-sm text-ink-3">No active staff yet. <Link href="/staff/new" className="text-accent underline">Add the first person.</Link></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Licence / registration</th><th>Expires</th><th>CPR</th><th>Immunization</th></tr>
              </thead>
              <tbody>
                {staff.map((p) => <StaffLine key={p.id} p={p} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active staff" value={String(staff.length)} href="/staff" />
        <Stat label="Documents on file" value={String(docs.length)} href="/documents" />
        <Stat label="CS inventories recorded" value={String(cs.count)} href="/inventory" />
      </div>
    </>
  );
}

function StaffLine({ p }: { p: StaffRow }) {
  return (
    <tr>
      <td>
        <Link href={`/staff/${p.id}`} className="font-medium text-accent hover:underline">{p.name}</Link>
        <div className="text-xs text-ink-3">{PERSON_ROLE_LABEL[p.role as keyof typeof PERSON_ROLE_LABEL] ?? p.role}{p.isPic ? " · PIC" : ""}</div>
      </td>
      <td className="font-mono text-xs">{p.licenseNumber ?? <span className="text-warn">not recorded</span>}</td>
      <td><Expiry iso={p.licenseExpires} /></td>
      <td>{p.cprExpires ? <Expiry iso={p.cprExpires} /> : p.administersVaccines ? <span className="badge badge-crit">required</span> : <span className="text-xs text-ink-3">—</span>}</td>
      <td className="text-xs">
        {p.immunizationOnFile ? <span className="badge badge-ok">on file</span> : p.administersVaccines ? <span className="badge badge-crit">missing</span> : <span className="text-ink-3">—</span>}
      </td>
    </tr>
  );
}

function Expiry({ iso }: { iso: string | null }) {
  if (!iso) return <span className="badge badge-warn">no date</span>;
  const d = daysUntil(iso)!;
  const cls = d < 0 ? "badge-crit" : d <= 60 ? "badge-warn" : "badge-ok";
  return (
    <span className={`badge ${cls}`} title={fmt(iso)}>
      {fmt(iso)}{d < 0 ? " · expired" : d <= 90 ? ` · ${d}d` : ""}
    </span>
  );
}

function Stat({ label, value, href, sub, tone }: { label: string; value: string; href: string; sub?: string; tone?: "ok" | "warn" | "crit" }) {
  const ring = tone === "crit" ? "border-crit" : tone === "warn" ? "border-warn" : "border-line";
  const text = tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : "";
  return (
    <Link href={href} className={`card hover:border-accent ${ring}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-2">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${text}`}>{value}</div>
      {sub && <div className="text-xs text-ink-3">{sub}</div>}
    </Link>
  );
}

function AlertGroup({ id, title, items, tone }: { id: string; title: string; items: { title: string; detail: string; href: string; dueOn?: string }[]; tone: "crit" | "warn" | "info" }) {
  if (items.length === 0) return null;
  const dot = tone === "crit" ? "bg-crit" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <section id={id}>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-2">{title} <span className="text-ink-3">({items.length})</span></h2>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
        {items.map((a, i) => (
          <li key={i}>
            <Link href={a.href} className="flex items-start gap-3 px-4 py-3 hover:bg-ground">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{a.title}</div>
                <div className="text-xs text-ink-2">{a.detail}</div>
              </div>
              {a.dueOn && <div className="shrink-0 text-xs text-ink-3">{fmt(a.dueOn)}</div>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
