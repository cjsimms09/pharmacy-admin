import Link from "next/link";
import { computeAlerts } from "@/lib/compliance";
import { fmt, nextCqiPeriod } from "@/lib/dates";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { PageHeader, Empty } from "@/components/ui";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const alerts = await computeAlerts();
  const period = nextCqiPeriod();
  const [people, docs] = await Promise.all([
    db.query.people.findMany({ where: eq(schema.people.active, true) }),
    db.select({ id: schema.documents.id }).from(schema.documents),
  ]);
  const crit = alerts.filter((a) => a.level === "crit");
  const warn = alerts.filter((a) => a.level === "warn");
  const info = alerts.filter((a) => a.level === "info");

  return (
    <>
      <PageHeader title="Dashboard" subtitle="What needs attention, soonest first." />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Active staff" value={String(people.length)} href="/staff" />
        <Stat label="Documents on file" value={String(docs.length)} href="/documents" />
        <Stat label="Next CQI summary due" value={fmt(period.dueOn)} href="/cqi" sub={period.label} />
      </div>

      {alerts.length === 0 ? (
        <Empty>Nothing needs attention. Add staff and their licenses to start tracking expirations.</Empty>
      ) : (
        <div className="space-y-5">
          <AlertGroup title="Act now" items={crit} tone="crit" />
          <AlertGroup title="Coming up" items={warn} tone="warn" />
          <AlertGroup title="For information" items={info} tone="info" />
        </div>
      )}
    </>
  );
}

function Stat({ label, value, href, sub }: { label: string; value: string; href: string; sub?: string }) {
  return (
    <Link href={href} className="card hover:border-accent">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-ink-3">{sub}</div>}
    </Link>
  );
}

function AlertGroup({ title, items, tone }: { title: string; items: { title: string; detail: string; href: string; dueOn?: string }[]; tone: "crit" | "warn" | "info" }) {
  if (items.length === 0) return null;
  const dot = tone === "crit" ? "bg-crit" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-2">{title}</h2>
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
