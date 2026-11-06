import type { ObligationCadence } from "@/db/schema";

/**
 * Compliance measured by period rather than by a single next-due date.
 *
 * A "last done / next due" pair cannot express the thing a PIC actually needs to know, which is
 * whether every month has been covered. It hides a gap: do a monthly duty in January and again
 * in April and the pair says you are current, when three months are missing and always will be.
 *
 * So each duty owns a series of periods, and a period is either satisfied or it is not, forever.
 * A month that was missed does not become fine because the next one was done.
 *
 * Pure functions, no database — the arithmetic decides what an inspector is shown, so it has to
 * be checkable on its own.
 */

/** "2026-08" · "2026-Q3" · "2026". Sortable as text, which is why the shapes are what they are. */
export type PeriodKey = string;

export function periodKeyFor(cadence: ObligationCadence, iso: string): PeriodKey | null {
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return null;
  switch (cadence) {
    case "monthly":
      return `${y}-${String(m).padStart(2, "0")}`;
    case "quarterly":
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case "annual":
    case "biennial":
    case "triennial":
      return String(y);
    case "as_needed":
      return null;
  }
}

/** A period a person can read: "August 2026", "Q3 2026", "2026". */
export function periodLabel(key: PeriodKey): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) return `${months[Number(m[2]) - 1]} ${m[1]}`;
  const q = /^(\d{4})-Q(\d)$/.exec(key);
  if (q) return `Q${q[2]} ${q[1]}`;
  return key;
}

/** The last day of a period — when it stops being possible to satisfy it on time. */
export function periodEnds(key: PeriodKey): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) {
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`;
  }
  const q = /^(\d{4})-Q(\d)$/.exec(key);
  if (q) {
    const endMonth = Number(q[2]) * 3;
    const last = new Date(Date.UTC(Number(q[1]), endMonth, 0)).getUTCDate();
    return `${q[1]}-${String(endMonth).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  }
  return `${key}-12-31`;
}

/** The period before this one. */
export function previousPeriod(key: PeriodKey): PeriodKey {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  }
  const q = /^(\d{4})-Q(\d)$/.exec(key);
  if (q) {
    const y = Number(q[1]);
    const n = Number(q[2]);
    return n === 1 ? `${y - 1}-Q4` : `${y}-Q${n - 1}`;
  }
  return String(Number(key) - 1);
}

/**
 * Every period a duty should have been satisfied in, oldest first.
 *
 * Starts from when the pharmacy began using the site rather than from the beginning of time —
 * inventing a year of failures on the first run would make the whole screen useless on day one,
 * and nobody is served by being told they missed a month before the software existed.
 *
 * The current period is included: it is not late yet, but it is the one to act on.
 */
export function periodsBetween(cadence: ObligationCadence, startIso: string, todayIso: string): PeriodKey[] {
  if (cadence === "as_needed") return [];
  const first = periodKeyFor(cadence, startIso);
  const now = periodKeyFor(cadence, todayIso);
  if (!first || !now) return [];

  const out: PeriodKey[] = [];
  let cursor = now;
  // Walk backwards from the current period; a mis-specified start can never loop forever.
  for (let i = 0; i < 400 && cursor >= first; i++) {
    out.push(cursor);
    cursor = previousPeriod(cursor);
  }
  // Biennial and triennial duties recur less often than their period key implies.
  const step = cadence === "biennial" ? 2 : cadence === "triennial" ? 3 : 1;
  const ordered = out.reverse();
  return step === 1 ? ordered : ordered.filter((_, i) => (ordered.length - 1 - i) % step === 0);
}

export type PeriodState = "satisfied" | "partial" | "open" | "missed";

/**
 * Where one period stands.
 *
 * "Open" and "missed" are kept apart deliberately. The current month with nothing filed yet is
 * not a failure and must not be shown as one; last month with nothing filed is, and no later
 * activity changes that.
 */
export function stateOf(have: number, expected: number, periodKey: PeriodKey, todayIso: string): PeriodState {
  if (have >= expected) return "satisfied";
  const ended = periodEnds(periodKey) < todayIso;
  if (!ended) return have > 0 ? "partial" : "open";
  return have > 0 ? "partial" : "missed";
}
