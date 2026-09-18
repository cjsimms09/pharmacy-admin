import "server-only";
import { refreshStale } from "./held";
import { warmPlan, type WarmState, type WarmStep } from "./warm-policy";

/**
 * Warm the readings the day starts with, then refresh whatever is stale.
 *
 * Run by the scheduler in the gaps, so a person never waits behind it. Each call is a no-op for a
 * reading that is fresh and keyed to the current data.
 *
 * What decides *whether* and *which* is `warm-policy.ts`, kept apart from the work so it can be
 * checked without a scheduler or a database. Two things it knows that this used to not:
 *
 * A step is not interruptible. The database is one serialized connection and every libsql call
 * blocks the event loop completely, so `isIdle(5)` before a step that runs for seconds promises
 * something it cannot deliver. The answer is to be careful about which steps run in a short gap.
 *
 * And warming into a nearly full heap is what costs somebody their page. A process near its ceiling
 * warms nothing: the readings it skips are computed by their next reader, which is slower for one
 * page and does not take the machine down.
 */

/** What a warm-up did, so the feeds page can say why a reading is not held. */
export type WarmReport = {
  warmed: string[];
  /** Left for now, each with the reason in words. */
  skipped: { key: string; why: string }[];
  /** Steps that were due but stopped for because somebody arrived mid-run. */
  interrupted: string[];
  failed: { key: string; why: string }[];
  refreshed: number;
};

/**
 * What this process is using, both ways, and the ceiling the launcher set.
 *
 * Both, because either alone answers the wrong question: the heap is what the ceiling is enforced
 * against and so what decides whether the process dies, and the resident figure is what the machine
 * feels — and a great deal of a Node process is not V8's old space. See `headroom`.
 */
export async function heapState(idleSeconds: number | null): Promise<WarmState> {
  const v8 = await import("node:v8");
  const h = v8.getHeapStatistics();
  return { idleSeconds, heapUsedBytes: h.used_heap_size, rssBytes: process.memoryUsage().rss, limitBytes: h.heap_size_limit };
}

const steps: Record<string, () => Promise<unknown>> = {
  allFills: async () => (await import("./claims")).allFills(),
  productLedger: async () => (await import("./product-ledger")).productLedger(),
  booksFor: async () => {
    const { booksFor } = await import("./ledger-store");
    const { parsePeriod } = await import("./ledger");
    const { todayIso } = await import("./dates");
    const period = parsePeriod(todayIso().slice(0, 7));
    if (period) await booksFor(period);
  },
  moneyPosition: async () => (await import("./money-position")).moneyPosition(),
  moneyFound: async () => (await import("./money-found")).moneyFound(),
  buyListNow: async () => (await import("./shelf")).buyListNow(),
  minimumsNow: async () => (await import("./minimum-store")).minimumsNow(),
  drugProfitNow: async () => (await import("./drug-profit-store")).drugProfitNow(),
  overNadac28: async () => (await import("./over-nadac-store")).overNadacNow(28),
  overNadac7: async () => (await import("./over-nadac-store")).overNadacNow(7),
  floorReview: async () => (await import("./floor-review")).floorReview(),
  leanShelfNow: async () => (await import("./shelf")).leanShelfNow(),
  recentMonths: async () => (await import("./ledger-store")).recentMonths(6),
  monthlyTrend: async () => (await import("./profit-and-loss")).monthlyTrend(12),
  productsExtrasNow: async () => (await import("./products-store")).productsExtrasNow(),
  payerMap: async () => (await import("./payer-map")).payerMap(),
  planRegister: async () => (await import("./plans")).planRegister(),
  nadacCoverage: async () => (await import("./nadac")).nadacCoverage(),
};

/**
 * `state()` is asked again before every step rather than once at the top, because both things it
 * reports change while this runs: somebody arrives, and the previous step allocated.
 */
export async function warmHeld(state: () => Promise<WarmState>): Promise<WarmReport> {
  const report: WarmReport = { warmed: [], skipped: [], interrupted: [], failed: [], refreshed: 0 };
  const plan = warmPlan(await state());
  for (const s of plan.skipped) report.skipped.push({ key: s.step.key, why: s.why });

  for (const step of plan.run) {
    /*
     * Asked again, because a person arriving outranks the warm-up and the last step may have taken
     * seconds. Named as interrupted rather than skipped: it was due, and the next tick picks it up.
     */
    const now = await state();
    const still = warmPlan(now, [step]);
    if (still.run.length === 0) {
      report.interrupted.push(step.key);
      continue;
    }
    try {
      await steps[step.key]?.();
      report.warmed.push(step.key);
    } catch (e) {
      // Its page says what it is missing; a reading that will not warm must not stop the rest.
      report.failed.push({ key: step.key, why: e instanceof Error ? e.message : String(e) });
    }
  }

  // Only in a lull, and only with room: refreshing everything held is the heaviest thing here.
  const last = await state();
  if (warmPlan(last, [{ key: "refresh", opens: "everything already held", tier: "later" } as WarmStep]).run.length > 0) {
    report.refreshed = await refreshStale();
  }
  return report;
}
