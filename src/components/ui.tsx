import Link from "next/link";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-ink-3">{children}</div>;
}

export function Notice({ kind = "ok", children }: { kind?: "ok" | "warn" | "crit"; children: React.ReactNode }) {
  const cls = kind === "ok" ? "bg-accent-soft text-accent" : kind === "warn" ? "bg-warn-soft text-warn" : "bg-crit-soft text-crit";
  return <div className={`mb-4 rounded-md px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export function StatusBadge({ days }: { days: number | null }) {
  if (days === null) return <span className="badge badge-muted">no date</span>;
  if (days < 0) return <span className="badge badge-crit">expired</span>;
  if (days <= 30) return <span className="badge badge-crit">{days} d</span>;
  if (days <= 90) return <span className="badge badge-warn">{days} d</span>;
  return <span className="badge badge-ok">{days} d</span>;
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="text-sm text-ink-2 hover:text-ink">← {children}</Link>;
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
