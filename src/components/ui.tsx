import Link from "next/link";

/**
 * The shared pieces every screen is built from.
 *
 * They exist so that a section on the staff page and a section on the compliance page are
 * visibly the same kind of thing. The version of this site these replaced styled each screen by
 * hand, and the result was that nothing had a consistent weight: a page title and a footnote
 * were both grey 13px text in the same white box, so the eye had nowhere to land and every page
 * read as one long undifferentiated column.
 */

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-6">
      {back && (
        <Link href={back.href} className="mb-2 inline-block text-sm text-ink-2 hover:text-ink">
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1>{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * A section of a page.
 *
 * Always has a header bar, because a heading that sits inside the same padding as its content
 * does not separate anything. `tone` puts a coloured rule on the whole card for the one or two
 * sections on a screen that are genuinely the problem.
 */
export function Card({
  title,
  count,
  subtitle,
  actions,
  tone,
  id,
  children,
  className,
}: {
  title?: string;
  count?: number | string;
  subtitle?: string;
  actions?: React.ReactNode;
  tone?: "ok" | "warn" | "crit";
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const border = tone === "crit" ? "border-crit" : tone === "warn" ? "border-warn" : tone === "ok" ? "border-accent" : "";
  return (
    <section id={id} className={`card ${border} ${className ?? ""}`}>
      {title && (
        <div className="card-head">
          <h2 className="flex items-baseline gap-2">
            {title}
            {count !== undefined && <span className="text-sm font-normal text-ink-3">{count}</span>}
          </h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {subtitle && <p className="card-sub">{subtitle}</p>}
      {children}
    </section>
  );
}

/** A headline number. Large on purpose: this is the answer to the question asked from the doorway. */
export function Figure({
  value,
  label,
  sub,
  tone = "ok",
  href,
}: {
  value: number | string;
  label: string;
  sub?: string;
  tone?: "ok" | "warn" | "crit" | "muted";
  href?: string;
}) {
  const ring = tone === "crit" ? "border-crit" : tone === "warn" ? "border-warn" : "border-line";
  const ink = tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : tone === "muted" ? "text-ink-2" : "text-accent";
  const body = (
    <>
      <div className={`text-4xl font-bold leading-none tabular-nums ${ink}`}>{value}</div>
      <div className="mt-2.5 text-sm font-semibold">{label}</div>
      {sub && <div className="mt-0.5 text-xs leading-snug text-ink-3">{sub}</div>}
    </>
  );
  if (!href) return <div className={`card ${ring}`}>{body}</div>;
  return (
    <Link href={href} className={`card ${ring} block transition-colors hover:border-accent`}>
      {body}
    </Link>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3">{children}</div>;
}

export function Notice({ kind = "ok", children }: { kind?: "ok" | "warn" | "crit"; children: React.ReactNode }) {
  const cls = kind === "ok" ? "bg-accent-soft text-accent" : kind === "warn" ? "bg-warn-soft text-warn" : "bg-crit-soft text-crit";
  return <div className={`mb-4 rounded-md px-3.5 py-2.5 text-sm font-medium ${cls}`}>{children}</div>;
}

/**
 * A date's status, said in the fewest words that are still true.
 *
 * "no date" is a distinct state from "expired" and is shown as a warning rather than as fine,
 * because a record with no expiry passes every date check while being the least compliant thing
 * on the page.
 */
export function StatusBadge({ days, iso }: { days: number | null; iso?: string | null }) {
  if (days === null) return <span className="badge badge-warn">no date</span>;
  if (days < 0) return <span className="badge badge-crit" title={iso ?? undefined}>{-days}d late</span>;
  if (days <= 30) return <span className="badge badge-crit" title={iso ?? undefined}>{days}d</span>;
  if (days <= 90) return <span className="badge badge-warn" title={iso ?? undefined}>{days}d</span>;
  return <span className="badge badge-ok" title={iso ?? undefined}>current</span>;
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-sm text-ink-2 hover:text-ink">
      ← {children}
    </Link>
  );
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

/**
 * One line in a list of things needing attention.
 *
 * The whole row is the link. A four-word underlined phrase in the middle of a row is a target
 * people miss on a phone and hunt for on a desktop.
 */
export function Row({
  href,
  title,
  why,
  badge,
  children,
}: {
  href: string;
  title: React.ReactNode;
  why?: React.ReactNode;
  badge?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li>
      <Link href={href} className="row">
        <span className="min-w-0">
          <span className="row-title block">{title}</span>
          {why && <span className="row-why block">{why}</span>}
        </span>
        {badge}
      </Link>
      {children}
    </li>
  );
}
