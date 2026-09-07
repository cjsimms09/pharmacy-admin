import Link from "next/link";
import { Sparkline } from "./bars";

/**
 * Server-side pieces of the design system: tabs that are links, and a figure with its trend.
 *
 * Tabs are links with a query parameter rather than client state, so a tab is a URL somebody can
 * send, the back button works, and a server page needs no client code to have them.
 */
export function LinkTabs({ tabs, active, className }: { tabs: { key: string; label: string; href: string; count?: number | string }[]; active: string; className?: string }) {
  return (
    <nav className={`inline-flex flex-wrap overflow-hidden rounded-md border border-line text-sm ${className ?? ""}`} aria-label="Sections">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`px-3 py-1.5 ${t.key === active ? "bg-accent-soft font-semibold text-accent" : "text-ink-2 hover:bg-ground"}`}
          aria-current={t.key === active ? "page" : undefined}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-xs font-normal text-ink-3">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/**
 * A figure with where it came from and where it is going.
 *
 * The number, the label, the change against the period before it, and the small line of its
 * history. Green is up where up is good and red where it is not; the caller says which, because
 * a rising cost and a rising profit are the same shape and not the same news.
 */
export function Stat({
  value,
  label,
  sub,
  href,
  delta,
  history,
  upIsGood = true,
  tone,
  size = "lg",
}: {
  value: string;
  label: string;
  sub?: string;
  href?: string;
  /** The change against the period before, already formatted, and its sign. */
  delta?: { text: string; sign: -1 | 0 | 1 } | null;
  /** Older first, ending with this period. */
  history?: (number | null)[];
  upIsGood?: boolean;
  tone?: "ok" | "warn" | "crit" | "muted";
  size?: "lg" | "sm";
}) {
  const good = delta ? (delta.sign === 0 ? null : (delta.sign > 0) === upIsGood) : null;
  const ink = tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : tone === "muted" ? "text-ink-2" : "text-accent";
  const ring = tone === "crit" ? "border-crit" : tone === "warn" ? "border-warn" : "border-line";
  const body = (
    <>
      <div className="flex items-end justify-between gap-2">
        <div className={`${size === "sm" ? "text-2xl" : "text-4xl"} font-bold leading-none tabular-nums ${ink}`}>{value}</div>
        {history && history.filter((h) => h !== null).length >= 2 && <Sparkline values={history} tone={good === false ? "crit" : "accent"} />}
      </div>
      <div className="mt-2.5 text-sm font-semibold">{label}</div>
      {(delta || sub) && (
        <div className="mt-0.5 text-xs leading-snug text-ink-3">
          {delta && <span className={`font-medium ${good === null ? "text-ink-3" : good ? "text-accent" : "text-crit"}`}>{delta.sign > 0 ? "▲" : delta.sign < 0 ? "▼" : "▬"} {delta.text}</span>}
          {delta && sub && <span className="mx-1.5 text-ink-3">·</span>}
          {sub}
        </div>
      )}
    </>
  );
  if (!href) return <div className={`card ${ring}`}>{body}</div>;
  return (
    <Link href={href} className={`card ${ring} block transition-colors hover:border-accent`}>
      {body}
    </Link>
  );
}

/** The change between two figures, for a Stat's delta. Percent where the base is not nought. */
export function deltaOf(now: number, before: number | null | undefined, format: (c: number) => string): { text: string; sign: -1 | 0 | 1 } | null {
  if (before === null || before === undefined) return null;
  const d = now - before;
  const sign: -1 | 0 | 1 = d > 0 ? 1 : d < 0 ? -1 : 0;
  // A percentage against a near-empty period is noise ("1,105.9%"), so it is left off past tenfold.
  const ratio = before !== 0 ? Math.abs(d) / Math.abs(before) : null;
  const pct = ratio !== null && ratio <= 10 ? ` (${Math.round(ratio * 1000) / 10}%)` : "";
  return { text: `${format(Math.abs(d))}${pct} vs last`, sign };
}
