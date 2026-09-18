import Link from "next/link";

/**
 * Grouped bars and a sparkline, each bar a link.
 *
 * Plain SVG, no library, like `charts.tsx`: a bar is a rectangle and the number is printed on it,
 * so the chart is read rather than interpreted. This file draws several series per label and
 * links every group to the rows it was drawn from; `charts.tsx` draws one series with a printed
 * sheet in mind. The two should become one when the Money pages settle.
 */

export type BarSeries = { label: string; values: (number | null)[]; tone?: "accent" | "ink" | "warn" | "crit" };

const FILL: Record<NonNullable<BarSeries["tone"]>, string> = {
  accent: "var(--color-accent)",
  ink: "var(--color-ink-3)",
  warn: "var(--color-warn)",
  crit: "var(--color-crit)",
};

function short(cents: number): string {
  const d = cents / 100;
  const a = Math.abs(d);
  const s = a >= 1_000_000 ? `${(d / 1_000_000).toFixed(1)}m` : a >= 10_000 ? `${Math.round(d / 1000)}k` : a >= 1_000 ? `${(d / 1000).toFixed(1)}k` : d.toFixed(0);
  return `$${s}`;
}

/**
 * Grouped bars: one group per label, one bar per series, in cents.
 *
 * Negative values hang below the axis. A null value draws nothing and leaves a gap, which is the
 * honest picture of a month with no account.
 */
export function Bars({
  labels,
  series,
  hrefs,
  height = 160,
  format = short,
}: {
  labels: string[];
  series: BarSeries[];
  /** One link per label, for the whole group. */
  hrefs?: (string | null)[];
  height?: number;
  format?: (v: number) => string;
}) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  /*
   * Drawn in a box as wide as the card it usually sits in, and scaled to the real width while
   * keeping its shape. A 100-unit box stretched to fit (the earlier drawing) turned every printed
   * figure into a smear ten times too wide; the shape has to be kept for text to stay text.
   */
  const W = 1000;
  const groupW = W / Math.max(1, labels.length);
  const barW = (groupW * 0.7) / Math.max(1, series.length);
  const top = 18;
  const bottom = 18;
  const plotH = height - top - bottom;
  const y0 = top + (max / span) * plotH;
  /* A figure is printed on a bar only where it fits; the rest are read from the tooltip. */
  const printed = (j: number) => barW >= 44 || j === 0;

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${height}`} className="h-auto w-full" role="img" aria-label={series.map((s) => s.label).join(", ")}>
        <line x1="0" x2={W} y1={y0} y2={y0} stroke="var(--color-line-strong)" strokeWidth="1" />
        {labels.map((label, i) => {
          const gx = i * groupW + groupW * 0.15;
          const group = series.map((s, j) => {
            const v = s.values[i];
            if (v === null || v === undefined) return null;
            const h = (Math.abs(v) / span) * plotH;
            const y = v >= 0 ? y0 - h : y0;
            const x = gx + j * barW;
            return (
              <g key={s.label}>
                <rect x={x} y={y} width={barW * 0.9} height={Math.max(h, 1)} rx="1.5" fill={FILL[s.tone ?? "accent"]} opacity={j === 0 ? 1 : 0.55}>
                  <title>{`${s.label}, ${label}: ${format(v)}`}</title>
                </rect>
                {printed(j) && (
                  <text x={x + barW * 0.45} y={v >= 0 ? y - 4 : y + h + 11} textAnchor="middle" fontSize="11" fill="var(--color-ink-2)" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {format(v)}
                  </text>
                )}
              </g>
            );
          });
          const body = (
            <g>
              <rect x={i * groupW} y={0} width={groupW} height={height} fill="transparent" />
              {group}
              <text x={i * groupW + groupW / 2} y={height - 4} textAnchor="middle" fontSize="11" fill="var(--color-ink-3)">
                {label}
              </text>
            </g>
          );
          const href = hrefs?.[i];
          return href ? (
            <Link key={label} href={href} className="[&>g>rect:first-child]:hover:fill-[var(--color-ground)]">
              {body}
            </Link>
          ) : (
            <g key={label}>{body}</g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-ink-3">
        {series.map((s, j) => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm" style={{ background: FILL[s.tone ?? "accent"], opacity: j === 0 ? 1 : 0.55 }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A figure with the small line of its history under it. */
export function Sparkline({ values, tone = "accent", width = 80, height = 22 }: { values: (number | null)[]; tone?: BarSeries["tone"]; width?: number; height?: number }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return null;
  const max = Math.max(...pts.map((p) => p[1]));
  const min = Math.min(...pts.map((p) => p[1]));
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2);
  const d = pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="inline-block align-middle" aria-hidden="true">
      <path d={d} fill="none" stroke={FILL[tone ?? "accent"]} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
