/**
 * Drugs this pharmacy treats as controlled although federal law does not.
 *
 * Pseudoephedrine is a List I chemical federally, sold from behind the counter under the Combat
 * Methamphetamine Epidemic Act, and the FDA directory and PioneerRx both record it as unscheduled.
 * The owner, 22 September 2026: "Yes we treat like schedule 5". So it is filed with the Schedule
 * III-V records, and a PSE invoice left among the ordinary ones is a filing error even though every
 * federal source would call it correct.
 *
 * Found that afternoon: of six invoices carrying pseudoephedrine, one was in the Schedule III-V
 * drawer — because McKesson happened to split it — and five were filed as ordinary.
 *
 * Pure. The rule only ever raises a schedule, never lowers one: a line or an invoice already more
 * controlled than this keeps what it has.
 */

/**
 * Whether a line is a pseudoephedrine product.
 *
 * The directory's ingredient list first, which catches every brand the FDA has registered — 560
 * packages. The description second, and deliberately narrowly, for the store brands the directory
 * does not list at all: F&T's Loratadine-D carries NDC 01093995535 and the directory has never heard
 * of it. Only shapes a decongestant combination actually takes — "PSE" as McKesson abbreviates it,
 * the word itself, a "-D 12HR/24HR" antihistamine, Mucinex D — because a looser test would catch
 * vitamin D.
 */
export function isPseudoephedrine(input: { substances?: string | null; description?: string | null }): boolean {
  if (/PSEUDOEPHEDRINE/i.test(input.substances ?? "")) return true;
  const d = String(input.description ?? "").toUpperCase();
  if (/PSEUDOEPH/.test(d)) return true;
  if (/^PSE\b/.test(d.trim())) return true;
  if (/\b[A-Z]+-D\s+(12|24)\s*HR\b/.test(d)) return true;
  if (/\bMUCINEX\s+D\b/.test(d)) return true;
  return false;
}

/** The schedule the state rule puts a line at, or null where it has nothing to say. */
export function stateScheduleOf(input: { substances?: string | null; description?: string | null }): "schedule_3_5" | null {
  return isPseudoephedrine(input) ? "schedule_3_5" : null;
}

const RANK: Record<string, number> = { none: 0, schedule_3_5: 1, schedule_2: 2 };

/** The more controlled of two schedules. Unknown or null never outranks a known one. */
export function higherSchedule<T extends string>(a: T | null | undefined, b: T | null | undefined): T | null {
  const ra = a != null && a in RANK ? RANK[a] : -1;
  const rb = b != null && b in RANK ? RANK[b] : -1;
  if (ra < 0 && rb < 0) return null;
  return (ra >= rb ? a : b) ?? null;
}
