/**
 * Which held readings to let go of, when there are too many.
 *
 * `held.ts` had a ceiling on how *old* a value could be and none on how *many* there could be.
 * Nothing ever removed an entry: `refreshStale` recomputes rather than drops, and `forgetHeld` only
 * fires when an import knows what it invalidated. So the cache grew for as long as the process
 * lived, and several keys carry a date or a range somebody browsed — `books:2026-09:2026-09-08`,
 * `recent:6:2026-09-08` — which means a new entry every day, each holding a whole period's object
 * graph, none of which will ever be read again.
 *
 * That is invisible on a cold start and obvious after a fortnight, and this machine is left running
 * for weeks: the site sat at 1.6 GB on a 7.3 GB computer it shares with the dispensing system, and
 * the counter lost its page for ninety seconds.
 *
 * ── Least recently *read*, not least recently computed ──
 *
 * The distinction decides whether this helps. A reading recomputed every idle tick by
 * `refreshStale` looks brand new by its computed time and may not have been looked at since
 * Tuesday; the reading somebody opens every morning is the one to keep. So the clock that matters
 * is the last time a reader was handed the value.
 *
 * A reading being computed right now is never dropped — something is waiting on it, and dropping it
 * frees nothing while guaranteeing the work is done twice.
 *
 * Pure, so the policy can be checked without a cache.
 */

export type HeldEntry = {
  key: string;
  /** When a reader was last handed this value. */
  readAt: number;
  /** True while a computation is in flight. Never evicted. */
  pending: boolean;
  /** False before the first value arrives. */
  has: boolean;
};

/**
 * How many readings to keep.
 *
 * Generous on purpose. The site has about thirty distinct readings and a handful of parameterised
 * ones; sixty leaves every page's working set resident through a normal day and still bounds the
 * dated keys, which are what actually grow. A ceiling that starts evicting things people use would
 * trade a memory problem for a speed one, and the speed one is what the owner noticed first.
 */
export const MAX_HELD = 60;

/**
 * The keys to drop so that at most `max` remain, oldest read first.
 *
 * Returns them rather than removing them, so the caller owns the map and this owns the policy.
 */
export function evictions(entries: HeldEntry[], max = MAX_HELD): string[] {
  const droppable = entries.filter((e) => !e.pending && e.has);
  // Everything in flight or not yet computed stays whatever the count is, so the ceiling is counted
  // against what is actually holding a value.
  const over = droppable.length - max;
  if (over <= 0) return [];
  return [...droppable].sort((a, b) => a.readAt - b.readAt).slice(0, over).map((e) => e.key);
}
