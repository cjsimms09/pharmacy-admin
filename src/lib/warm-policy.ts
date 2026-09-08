/**
 * Which readings to warm before anybody asks, and when not to warm at all.
 *
 * Everything a page needs that takes more than a moment is held between requests and computed in
 * the gaps, which is right: computing it on the first page of the morning makes that page pay for
 * the night's imports. But two things about *this* machine were not in the plan.
 *
 * **A step is not small, and the idle check is between steps.** The database is one serialized
 * connection and every libsql call blocks the event loop completely — 200,000 rows is 1.7 seconds
 * during which the web server answers nothing. So `isIdle(5)` before a step that runs for several
 * seconds promises something it cannot deliver: a person arriving a moment after the check waits
 * for the whole step. The guard can only be honest at the granularity of what it guards, so the
 * answer is to be more careful about *which* steps run in a short gap, not to check more often.
 *
 * **Warming into a nearly full heap is what costs the page.** The site sat at 1.6 GB on a 7.3 GB
 * computer shared with the dispensing system, a browser and Defender, and the counter had no page
 * for ninety seconds. A step that allocates a hundred megabytes while somebody's page is also
 * allocating is what tips that into swapping. So a warm-up now asks whether there is room, and a
 * process near its ceiling warms nothing — the readings it would have computed are computed by
 * their next reader, which is slower for one page and does not take the machine down.
 *
 * ── The two tiers, from what the pages actually read ──
 *
 * The scheduler's own comment says the intent: *"first the readings Today and Buying open with,
 * then whatever is stale."* The list never implemented it — eighteen steps ran in a fixed order,
 * six of them serving exactly one page each, none of those a page the day opens with.
 *
 * So each step now says which page it serves, taken from reading those pages rather than from
 * anybody's opinion about what the pharmacy uses. `first` is the dashboard and the buy list, which
 * is where the morning starts. `later` is everything a click deeper, and it waits for a real lull
 * rather than the first five-second gap.
 *
 * Pure, so the policy can be checked without a scheduler, a clock or a database.
 */

export type WarmTier = "first" | "later";

export type WarmStep = {
  key: string;
  /** The page that opens with it. Written down so the tier is evidence and not an opinion. */
  opens: string;
  tier: WarmTier;
};

/**
 * Every held reading warmed before anybody asks, and what each one is for.
 *
 * The `first` tier is what `/` and `/purchasing` read, which is the morning. `allFills` and
 * `productLedger` are underneath most of the rest, so they lead.
 */
export const WARM_STEPS: WarmStep[] = [
  { key: "allFills", opens: "underneath almost every page", tier: "first" },
  { key: "productLedger", opens: "underneath the buy list and the drug pages", tier: "first" },
  { key: "booksFor", opens: "the dashboard, and /money", tier: "first" },
  { key: "moneyPosition", opens: "the dashboard", tier: "first" },
  { key: "moneyFound", opens: "the dashboard, and /money/found", tier: "first" },
  { key: "buyListNow", opens: "/purchasing", tier: "first" },
  { key: "minimumsNow", opens: "/purchasing", tier: "first" },
  { key: "drugProfitNow", opens: "/purchasing", tier: "first" },
  { key: "overNadac28", opens: "/purchasing", tier: "first" },
  { key: "overNadac7", opens: "/purchasing/over-nadac", tier: "later" },
  { key: "floorReview", opens: "/claims/floor", tier: "later" },
  { key: "leanShelfNow", opens: "/purchasing/shelf", tier: "later" },
  { key: "recentMonths", opens: "/money", tier: "later" },
  { key: "monthlyTrend", opens: "/money/report", tier: "later" },
  { key: "productsExtrasNow", opens: "/purchasing/products", tier: "later" },
  { key: "payerMap", opens: "/payers/performance", tier: "later" },
  { key: "planRegister", opens: "/plans", tier: "later" },
  { key: "nadacCoverage", opens: "/nadac", tier: "later" },
];

/**
 * How much of the heap must be free before anything is warmed.
 *
 * A fifth. Warming is an optimisation and it is the first thing that should stop mattering when the
 * machine is under pressure: the reading it skips costs one page a few seconds, and the swap it
 * avoids cost the counter ninety.
 */
export const HEADROOM = 0.2;

/** Nobody for five seconds is a gap; nobody for two minutes is a lull. */
export const GAP_SECONDS = 5;
export const LULL_SECONDS = 120;

export type WarmState = {
  /** Seconds since the last page was served. Null where nothing has been served yet. */
  idleSeconds: number | null;
  /** V8's own heap. What the ceiling is actually enforced against. */
  heapUsedBytes: number;
  /** Everything the operating system has given this process, heap and otherwise. */
  rssBytes: number;
  /** The launcher's ceiling, read from the heap statistics. */
  limitBytes: number;
};

export type WarmVerdict = { run: boolean; why: string };

/**
 * The share of the allowance still free, 0 to 1 — measured against whichever figure is worse.
 *
 * Two numbers, and using either alone gets this wrong. `used_heap_size` is what the ceiling is
 * enforced against, so it is what decides whether the process is about to die. But it is not what
 * the *machine* feels: the site was at 1.6 GB resident on a 7.3 GB computer when the counter lost
 * its page, and a large part of a Node process is not V8's old space at all — Buffers, the zip a
 * file import decoded, the driver's own allocations. Gate on the heap alone and a process at 1.6 GB
 * resident with a half-empty heap keeps warming, which is exactly this morning.
 *
 * So the worse of the two decides, against the same ceiling. The launcher's figure was chosen as
 * what the app may have on this machine in total, not as a fact about V8's old space, and treating
 * it that way is the reading that matches why it was set.
 */
export function headroom(state: WarmState): number {
  if (state.limitBytes <= 0) return 1;
  const worst = Math.max(state.heapUsedBytes, state.rssBytes);
  return Math.max(0, 1 - worst / state.limitBytes);
}

/**
 * Whether to warm this step now.
 *
 * The order of the tests is the order of what matters: memory first, because that is what took the
 * machine down; then the length of the gap, because a step is not interruptible once it starts.
 */
export function shouldWarm(step: WarmStep, state: WarmState): WarmVerdict {
  const free = headroom(state);
  if (free < HEADROOM) {
    return {
      run: false,
      why: `only ${Math.round(free * 100)}% of the heap is free, and warming into a nearly full one is what costs somebody their page — ${step.opens} will compute this when it is opened`,
    };
  }
  // Nothing served yet means a cold start with nobody waiting, which is the best moment there is.
  const idle = state.idleSeconds ?? Number.POSITIVE_INFINITY;
  const needs = step.tier === "first" ? GAP_SECONDS : LULL_SECONDS;
  if (idle < needs) {
    return {
      run: false,
      why:
        step.tier === "first"
          ? `somebody was on the site ${Math.round(idle)}s ago`
          : `${step.opens} is a click deeper, so it waits for a real lull — the last page was ${Math.round(idle)}s ago`,
    };
  }
  return { run: true, why: `${step.opens}, and nothing has been served for ${Number.isFinite(idle) ? `${Math.round(idle)}s` : "the life of this process"}` };
}

/** Which steps to run now, in order, and why each of the rest is being left. */
export function warmPlan(state: WarmState, steps: WarmStep[] = WARM_STEPS): { run: WarmStep[]; skipped: { step: WarmStep; why: string }[] } {
  const run: WarmStep[] = [];
  const skipped: { step: WarmStep; why: string }[] = [];
  for (const step of steps) {
    const v = shouldWarm(step, state);
    if (v.run) run.push(step);
    else skipped.push({ step, why: v.why });
  }
  return { run, skipped };
}
