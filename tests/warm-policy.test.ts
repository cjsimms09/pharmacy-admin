import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldWarm, warmPlan, headroom, WARM_STEPS, HEADROOM, GAP_SECONDS, LULL_SECONDS, type WarmState } from "../src/lib/warm-policy";

const GB = 1024 ** 3;
const state = (over: Partial<WarmState> = {}): WarmState => ({ idleSeconds: 600, heapUsedBytes: 0.5 * GB, rssBytes: 0.7 * GB, limitBytes: 2.5 * GB, ...over });

const first = WARM_STEPS.find((s) => s.tier === "first")!;
const later = WARM_STEPS.find((s) => s.tier === "later")!;

describe("warming only when there is room", () => {
  /*
   * The site sat at 1.6 GB on a 7.3 GB machine shared with the dispensing system, and the counter
   * had no page for ninety seconds. A warm step that allocates while somebody's page is also
   * allocating is what tips that into swapping — so warming is the first thing to stop.
   */
  test("a process near its ceiling warms nothing at all", () => {
    const tight = state({ heapUsedBytes: 2.2 * GB });
    assert.equal(shouldWarm(first, tight).run, false);
    assert.equal(shouldWarm(later, tight).run, false);
    assert.deepEqual(warmPlan(tight).run, []);
  });

  test("the refusal says what it costs instead, so it does not read as a fault", () => {
    const v = shouldWarm(first, state({ heapUsedBytes: 2.4 * GB }));
    assert.match(v.why, /% of the heap is free/);
    assert.match(v.why, /will compute this when it is opened/);
  });

  test("memory is tested before the gap, because memory is what took the machine down", () => {
    // Idle for an hour and nearly out of heap: still nothing.
    assert.equal(shouldWarm(first, state({ idleSeconds: 3_600, heapUsedBytes: 2.45 * GB })).run, false);
  });

  test("with room, the day's readings warm in an ordinary gap", () => {
    assert.equal(shouldWarm(first, state({ idleSeconds: GAP_SECONDS })).run, true);
    assert.equal(shouldWarm(first, state({ idleSeconds: GAP_SECONDS - 1 })).run, false);
  });

  test("the headroom is a fifth, and an unknown ceiling is not treated as no room", () => {
    assert.equal(HEADROOM, 0.2);
    assert.equal(headroom({ idleSeconds: 0, heapUsedBytes: 1 * GB, rssBytes: 1 * GB, limitBytes: 0 }), 1);
    assert.equal(headroom({ idleSeconds: 0, heapUsedBytes: 2 * GB, rssBytes: 1 * GB, limitBytes: 4 * GB }), 0.5);
  });

  test("resident memory counts, not only the heap — which is what this morning was", () => {
    /*
     * The site was at 1.6 GB resident with a 2.5 GB ceiling when the counter lost its page. A gate
     * on V8's heap alone sees a half-empty heap there and keeps warming, because a great deal of a
     * Node process is not old space: Buffers, a decoded zip, the driver's own allocations.
     */
    const thisMorning = state({ heapUsedBytes: 0.6 * GB, rssBytes: 2.1 * GB });
    assert.equal(shouldWarm(first, thisMorning).run, false, "the resident figure is what stops it");
    assert.equal(headroom(thisMorning), headroom({ ...thisMorning, heapUsedBytes: 0 }), "the worse of the two decides");
  });
});

describe("what warms first, and what waits for a lull", () => {
  test("a page a click deeper waits for two minutes of quiet, not five seconds", () => {
    const gap = state({ idleSeconds: 30 });
    assert.equal(shouldWarm(first, gap).run, true);
    assert.equal(shouldWarm(later, gap).run, false);
    assert.equal(shouldWarm(later, state({ idleSeconds: LULL_SECONDS })).run, true);
  });

  test("a cold start with nobody waiting is the best moment there is", () => {
    // Nothing served yet: not "zero seconds idle", which would refuse everything for ever.
    const cold = state({ idleSeconds: null });
    assert.equal(warmPlan(cold).skipped.length, 0);
    assert.equal(warmPlan(cold).run.length, WARM_STEPS.length);
    assert.match(shouldWarm(first, cold).why, /the life of this process/);
  });

  test("every step says which page it opens, so the tier is evidence and not an opinion", () => {
    for (const s of WARM_STEPS) {
      assert.ok(s.opens.length > 0, s.key);
      assert.ok(["first", "later"].includes(s.tier), s.key);
    }
    assert.equal(new Set(WARM_STEPS.map((s) => s.key)).size, WARM_STEPS.length, "no step warmed twice");
  });

  test("the dashboard and the buy list are what the morning starts on", () => {
    const firsts = WARM_STEPS.filter((s) => s.tier === "first").map((s) => s.key);
    // Read off `/` and `/purchasing`, plus the two readings underneath most of the rest.
    assert.deepEqual(firsts, ["allFills", "productLedger", "booksFor", "moneyPosition", "moneyFound", "buyListNow", "minimumsNow", "drugProfitNow", "overNadac28"]);
  });

  test("the six that serve one page each, and none of them the morning's, wait", () => {
    const laters = WARM_STEPS.filter((s) => s.tier === "later").map((s) => s.key);
    for (const k of ["floorReview", "leanShelfNow", "productsExtrasNow", "payerMap", "planRegister", "nadacCoverage"]) {
      assert.ok(laters.includes(k), `${k} should wait for a lull`);
    }
  });

  test("in a short gap the plan is the morning's readings and the reason for each of the rest", () => {
    const p = warmPlan(state({ idleSeconds: 10 }));
    assert.equal(p.run.every((s) => s.tier === "first"), true);
    assert.equal(p.skipped.every((s) => s.step.tier === "later"), true);
    assert.equal(p.skipped.every((s) => s.why.includes("a click deeper")), true);
  });

  test("somebody on the site right now stops the warm-up entirely", () => {
    assert.deepEqual(warmPlan(state({ idleSeconds: 1 })).run, []);
  });
});
