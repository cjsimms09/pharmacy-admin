import type React from "react";

/**
 * Charts drawn as plain SVG, with no library behind them.
 *
 * Three reasons, all of them about this pharmacy rather than about taste. The site runs on a
 * computer in the dispensary and is expected to keep working when GitHub is unreachable, so a
 * charting dependency is a thing that can break an update. These charts are printed — the owner
 * asked for a monthly sheet he can put in front of an accountant — and canvas charts print as
 * blurred bitmaps or as nothing at all, while SVG prints at the printer's own resolution. And the
 * whole point of a chart here is one question answered at a glance; a library's default is a
 * legend, a tooltip and an animation, none of which survive being printed.
 *
 * Every value arrives already computed. Nothing here divides, converts or rounds money: a chart
 * that does its own arithmetic is a second definition of the figure beside it, and the two will
 * differ eventually.
 */

export type Series = {
  label: string;
  /** Already in the unit being drawn — cents, scripts, tenths of a percent. */
  value: number;
  /** Shown under the bar. Formatted by the caller, because money knows its own format. */
  display: string;
  /** False where the month is short of something material, so a dip is not read as a fall. */
  usable?: boolean;
};

const AXIS = "#cdd3d6";

/** The scale a set of bars is drawn against: nought to the largest, or spanning nought where any is negative. */
function bounds(values: number[]): { min: number; max: number } {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  // A flat series of zeroes still needs a height, or every bar divides by nought.
  return max === min ? { min, max: max + 1 } : { min, max };
}

/**
 * A column chart.
 *
 * Negative months drop below the baseline rather than being clipped to nought, because a month
 * that lost money is the one worth seeing.
 */
export function BarChart({
  series,
  height = 132,
  tone = "accent",
  title,
}: {
  series: Series[];
  height?: number;
  tone?: "accent" | "warn";
  title?: string;
}) {
  if (series.length === 0) return null;
  const { min, max } = bounds(series.map((s) => s.value));
  const span = max - min;
  const zeroY = (max / span) * height;
  const width = 100 / series.length;
  const fill = tone === "warn" ? "#8a5d0a" : "#0e6b5a";

  return (
    <figure className="m-0">
      {title && <figcaption className="mb-2 text-xs font-semibold text-ink-2">{title}</figcaption>}
      <div className="overflow-x-auto">
        <div style={{ minWidth: `${Math.max(280, series.length * 44)}px` }}>
          <svg
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={title ?? "chart"}
            className="block h-32 w-full"
          >
            {/* The baseline, drawn wherever nought falls, so a negative bar has something to hang from. */}
            <line x1="0" y1={zeroY} x2="100" y2={zeroY} stroke={AXIS} strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
            {series.map((s, i) => {
              const h = (Math.abs(s.value) / span) * height;
              const y = s.value >= 0 ? zeroY - h : zeroY;
              return (
                <rect
                  key={s.label}
                  x={i * width + width * 0.18}
                  y={y}
                  width={width * 0.64}
                  height={Math.max(h, 0.6)}
                  fill={s.value < 0 ? "#a5312a" : fill}
                  /* A month missing something material is drawn hollow: the figure is real as far as
                     it goes, and the bar should not claim to be the whole of it. */
                  fillOpacity={s.usable === false ? 0.35 : 1}
                  stroke={s.usable === false ? fill : "none"}
                  strokeWidth="0.5"
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{`${s.label}: ${s.display}`}</title>
                </rect>
              );
            })}
          </svg>
          <div className="flex" role="presentation">
            {series.map((s) => (
              <div key={s.label} className="min-w-0 flex-1 px-0.5 text-center">
                <div className="truncate text-[10px] leading-tight text-ink-3">{s.label}</div>
                <div className="truncate text-[10px] font-medium leading-tight tabular-nums text-ink-2">{s.display}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

/**
 * A line, for a rate rather than an amount.
 *
 * A margin is not a quantity of anything and a bar chart of one invites the eye to compare areas
 * that mean nothing. Scaled to the values themselves rather than to nought, because the whole
 * interest in a margin is a two-point move that a nought-based axis flattens into a straight line.
 */
export function LineChart({
  series,
  height = 132,
  title,
  suffix = "%",
}: {
  series: Series[];
  height?: number;
  title?: string;
  suffix?: string;
}) {
  const points = series.filter((s) => Number.isFinite(s.value));
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A little room above and below, so the highest point is not welded to the top edge.
  const pad = Math.max((hi - lo) * 0.15, 0.5);
  const min = lo - pad;
  const span = hi + pad - min;
  const x = (i: number) => (points.length === 1 ? 50 : (i / (points.length - 1)) * 100);
  const y = (v: number) => height - ((v - min) / span) * height;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");

  return (
    <figure className="m-0">
      {title && <figcaption className="mb-2 text-xs font-semibold text-ink-2">{title}</figcaption>}
      <div className="overflow-x-auto">
        <div style={{ minWidth: `${Math.max(280, points.length * 44)}px` }}>
          <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={title ?? "chart"} className="block h-32 w-full">
            <path d={path} fill="none" stroke="#0e6b5a" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            {points.map((p, i) => (
              <circle key={p.label} cx={x(i)} cy={y(p.value)} r="1.6" fill="#0e6b5a" vectorEffect="non-scaling-stroke">
                <title>{`${p.label}: ${p.display}`}</title>
              </circle>
            ))}
          </svg>
          <div className="flex" role="presentation">
            {points.map((p) => (
              <div key={p.label} className="min-w-0 flex-1 px-0.5 text-center">
                <div className="truncate text-[10px] leading-tight text-ink-3">{p.label}</div>
                <div className="truncate text-[10px] font-medium leading-tight tabular-nums text-ink-2">{p.display}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-1 text-[10px] text-ink-3">
        Scaled to the range shown, not to nought{suffix ? ` (${suffix})` : ""} — a two-point move in a margin matters and
        a nought-based axis hides it.
      </p>
    </figure>
  );
}

/** A figure with what it was last period beside it. */
export function Movement({
  label,
  value,
  change,
  sub,
  invert,
}: {
  label: string;
  value: string;
  /** Null where there is nothing to compare against, which is said rather than shown as 0%. */
  change: { display: string; percent: number | null } | null;
  sub?: string;
  /** True for a figure where up is bad — cost of goods, overheads. */
  invert?: boolean;
}): React.ReactElement {
  const p = change?.percent ?? null;
  const good = p === null ? null : invert ? p <= 0 : p >= 0;
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-2">{label}</div>
      {change ? (
        <div className={`mt-1 text-xs tabular-nums ${good === null ? "text-ink-3" : good ? "text-accent" : "text-crit"}`}>
          {change.display}
        </div>
      ) : (
        <div className="mt-1 text-xs text-ink-3">no earlier period to compare</div>
      )}
      {sub && <div className="mt-0.5 text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}
