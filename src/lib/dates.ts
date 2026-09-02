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
