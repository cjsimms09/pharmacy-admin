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

/**
 * A stored moment, in the pharmacy's own clock.
 *
 * Every job's time is stored as ISO UTC, which is right for storing and wrong for reading: this pharmacy is six hours
 * behind it. On 16 September both sessions building this site read "the mail sweep ran 12:58" and took it for lunchtime
 * when it was 07:58 at the counter, and one of them reported the morning's PioneerRx pull as missed on the strength of
 * it. A pharmacist reading the same screen has no reason to do better.
 *
 * So a time shown to somebody is shown in their day: "today 07:58", "yesterday 08:40", "15 Sep 08:40". The word tells
 * them which day without arithmetic, which is the whole of what those screens are for.
 */
export function whenLocal(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "never";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "never";
  const clock = at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (day(at) === day(now)) return `today ${clock}`;
  if (day(at) === day(yesterday)) return `yesterday ${clock}`;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${clock}`;
}
