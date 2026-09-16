/** Date helpers. All app dates are ISO "YYYY-MM-DD" strings in local pharmacy time. */

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const [y1, m1, d1] = fromIso.split("-").map(Number);
  const [y2, m2, d2] = toIso.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return daysBetween(todayIso(), iso);
}

export function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function fmtLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * A stored timestamp as the clock on the pharmacy's wall reads it.
 *
 * Every timestamp in this database is UTC — `strftime('%Y-%m-%dT%H:%M:%fZ','now')` on every table — and this pharmacy is
 * six hours behind it. Screens have been printing the stored characters, so "last checked 12:58" was the truth about
 * Greenwich and five hours in the future here, and the reader has no way to tell which they are looking at. On the
 * morning of 16 September both sessions read the same settings and disagreed about whether a scheduled job had run:
 * 13:40Z was 08:40 on the wall, which was the job working exactly as intended.
 *
 * The dates in this database are the other way round — `todayIso` writes the local day — so only stamps go through here.
 * A value with no zone marker is read as UTC, because that is what wrote it.
 */
export function atLocal(iso: string | null | undefined): string {
  if (!iso) return "—";
  const text = String(iso);
  const d = new Date(/([Zz]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
  if (!Number.isFinite(d.getTime())) return text.replace("T", " ").slice(0, 16);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function monthName(m: number): string {
  return new Date(2000, m - 1, 1).toLocaleDateString("en-US", { month: "long" });
}

export function lastDayOfMonth(y: number, m: number): string {
  const d = new Date(y, m, 0).getDate();
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * K.A.R. 68-19-1: a summary is due by the 15th of Feb, Apr, Jun, Aug, Oct, Dec,
 * covering the two previous calendar months.
 * Returns the period whose summary is next due on or after `fromIso`.
 */
export function cqiPeriods(fromYear: number, toYear: number) {
  const out: { periodStart: string; periodEnd: string; dueOn: string; label: string }[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (const dueMonth of [2, 4, 6, 8, 10, 12]) {
      const m1 = dueMonth - 2; // first covered month
      const m2 = dueMonth - 1; // second covered month
      const y1 = m1 <= 0 ? y - 1 : y;
      const mm1 = m1 <= 0 ? m1 + 12 : m1;
      out.push({
        periodStart: `${y1}-${pad(mm1)}-01`,
        periodEnd: lastDayOfMonth(y, m2),
        dueOn: `${y}-${pad(dueMonth)}-15`,
        label: `${monthName(mm1)}–${monthName(m2)} ${y}`,
      });
    }
  }
  return out;
}

/**
 * The bimonthly period the calendar says is due about now.
 *
 * It knows nothing about what has been filed, and goes on naming a period for six weeks after its
 * due date. Nothing that shows a person a due date should call this: use `currentCqiObligation`,
 * which walks past the summaries already finalized. A screen that used this told the pharmacy a
 * summary it had finished and locked was twenty-two days overdue.
 */
export function nextCqiPeriod(today = todayIso()) {
  const y = Number(today.slice(0, 4));
  const all = cqiPeriods(y - 1, y + 1);
  // The "current" obligation is the one whose period has ended (or is ending) and whose due date is the nearest not yet long past.
  const upcoming = all.filter((p) => p.dueOn >= addDays(today, -45));
  return upcoming[0] ?? all[all.length - 1];
}

export function periodLabel(periodStart: string, periodEnd: string): string {
  const [y1, m1] = periodStart.split("-").map(Number);
  const [y2, m2] = periodEnd.split("-").map(Number);
  return y1 === y2 ? `${monthName(m1)}–${monthName(m2)} ${y2}` : `${monthName(m1)} ${y1}–${monthName(m2)} ${y2}`;
}

/** The bimonthly period immediately after the one starting on `periodStart`. */
export function cqiPeriodAfter(periodStart: string) {
  const y = Number(periodStart.slice(0, 4));
  const all = cqiPeriods(y - 1, y + 2);
  const i = all.findIndex((p) => p.periodStart === periodStart);
  return i >= 0 && i + 1 < all.length ? all[i + 1] : null;
}
