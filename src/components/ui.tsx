import Link from "next/link";
import { HelpPanel } from "./kit-client";

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
  help,
  tabs,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  /** The explanation, behind a "?" beside the title: paragraphs the page used to carry above its figures. */
  help?: React.ReactNode;
  /** The other sides of the same thing (`familyTabs` in `lib/families.ts`), as one row under the title. */
  tabs?: { active: string; items: { href: string; label: string }[] };
}) {
  return (
    <div className="mb-5">
      {back && (
        <Link href={back.href} className="mb-1.5 inline-flex items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink">
          <span aria-hidden="true">←</span> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 max-w-3xl">
          <h1 className="flex items-center gap-2">
            {title}
            {help && <HelpPanel title={title}>{help}</HelpPanel>}
          </h1>
          {subtitle && <p className="mt-1 text-sm leading-relaxed text-ink-2">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && (
        <nav className="mt-3 flex flex-wrap gap-1 border-b border-line" aria-label="Views of this page">
          {tabs.items.map((t) => {
            const on = t.href === tabs.active;
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${on ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink"}`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}

/**
 * A question that has been answered: one line, with the reasoning behind a disclosure.
 *
 * The owner, on a page whose every section explains itself at full length whether or not anything
 * is wrong: "this site is so hard to look at and follow."
 *
 * He is right, and the cause is that being fine costs as much room as being broken. The Money
 * page spends seven subsections of two paragraphs each to say nothing is counted twice, and
 * fourteen more to say where each feed lands. The invoice page gives four paragraphs to a card
 * headed "Delivered, and no invoice for it" whose content is that every delivery has one. On a
 * phone, between patients, that is minutes of scrolling past prose to reach a number.
 *
 * The prose is worth keeping — it is what makes a figure auditable, and he does audit. It is just
 * not what he came for. So a settled question collapses to its answer and opens on a tap.
 *
 * Only for states that ask nothing. A card with something to do stays open: hiding a job behind a
 * disclosure is the opposite mistake and a worse one.
 */
export function Settled({
  says,
  id,
  className,
  children,
}: {
  /** The answer, in one line. Not the question. */
  says: string;
  id?: string;
  className?: string;
  /** The reasoning, shown on a tap. */
  children?: React.ReactNode;
}) {
  return (
    <details id={id} className={`group rounded-lg border border-line bg-surface ${className ?? ""}`}>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-ink-2">
        <span aria-hidden className="text-accent">&#10003;</span>
        <span className="min-w-0 flex-1">{says}</span>
        {children && <span className="shrink-0 text-xs text-ink-3 group-open:hidden">why</span>}
      </summary>
      {children && <div className="border-t border-line px-3 py-2 text-xs text-ink-3">{children}</div>}
    </details>
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
  const edge = tone === "crit" ? "border-l-[3px] border-l-crit" : tone === "warn" ? "border-l-[3px] border-l-warn" : tone === "ok" ? "border-l-[3px] border-l-accent" : "";
  return (
    <section id={id} className={`card ${edge} ${className ?? ""}`}>
      {title && (
        <div className="card-head">
          <h2 className="flex items-baseline gap-2">
            {title}
            {count !== undefined && <span className="text-xs font-normal tabular-nums text-ink-3">{count}</span>}
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
  size = "lg",
}: {
  value: number | string;
  label: string;
  sub?: string;
  tone?: "ok" | "warn" | "crit" | "muted";
  href?: string;
  /** "sm" for a row of five dollar figures, which do not fit at the large size. */
  size?: "lg" | "sm";
}) {
  const state = tone === "crit" ? "kpi-crit" : tone === "warn" ? "kpi-warn" : tone === "ok" ? "kpi-ok" : "";
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${size === "sm" ? "text-xl" : ""}`}>{value}</div>
      {/*
        One fact to a line.
        
        Every caller builds this from two or three separate facts and joins them with a dot, so it
        arrived as "on $203,308.66 dispensed across 1,881 fills · $4,678.00 of it from cash ·
        $2,355.59 promised and unpaid" — a run-on in small grey type under a number somebody is
        trying to read at a glance. The owner: "this site is so hard to look at and follow."
        
        Split here rather than at each caller, so every figure on the site gains it at once. The
        first fact is the one that qualifies the number and stays legible; the rest step back.
      */}
      {sub && (
        <div className="kpi-sub">
          {String(sub)
            .split(" · ")
            .map((part, i) => (
              <span key={part} className={i === 0 ? "block" : "block text-ink-3"}>
                {part}
              </span>
            ))}
        </div>
      )}
    </>
  );
  if (!href) return <div className={`kpi ${state}`}>{body}</div>;
  return (
    <Link href={href} className={`kpi ${state} block`}>
      {body}
    </Link>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line-strong bg-surface/60 px-4 py-8 text-center text-sm text-ink-3">{children}</div>;
}

export function Notice({ kind = "ok", children }: { kind?: "ok" | "warn" | "crit"; children: React.ReactNode }) {
  const cls = kind === "ok" ? "border-accent bg-accent-soft text-accent" : kind === "warn" ? "border-warn bg-warn-soft text-warn" : "border-crit bg-crit-soft text-crit";
  return <div className={`mb-4 rounded-md border-l-[3px] px-3.5 py-2.5 text-sm font-medium leading-relaxed ${cls}`}>{children}</div>;
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

/**
 * Records that have been replaced: kept, findable, and out of the eye line.
 *
 * The instruction was precise — hide but retain, not prominent but findable if looking. A fold is
 * the honest shape for that: nothing is deleted, nothing is on another screen, and the count is on
 * the label so somebody can see there is history there without opening it.
 *
 * What goes in here is deliberately narrow. Only records that something newer has taken over. A
 * licence that expired and was never renewed is not history, it is a live gap, and it stays at
 * full weight on the page above — hiding that would be the expensive mistake this component could
 * easily cause if it were used to mean "expired".
 */
export function History({
  label,
  count,
  children,
  className,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  className?: string;
}) {
  if (count === 0) return null;
  return (
    <details className={`mt-4 rounded-md border border-line bg-ground/70 px-3 py-2 ${className ?? ""}`}>
      <summary className="cursor-pointer select-none text-sm text-ink-3">
        {label} <span className="text-ink-3">({count})</span>
      </summary>
      <div className="mt-3 border-t border-line pt-3 opacity-90">{children}</div>
      <p className="mt-2 text-xs text-ink-3">
        Kept in full and never deleted. These are records something newer has replaced — anything that has lapsed
        without a replacement stays on the page above.
      </p>
    </details>
  );
}
