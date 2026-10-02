import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { useScratchDb } from "./support/scratch-db";

/*
 * The money list is stored by the engine and read by the pages. Measured 2 October 2026: the dashboard rebuilt it from
 * cold in seventeen seconds and kept nine hundred megabytes afterwards. These pin the store's two rules — nothing stored
 * reads as an empty list with no computed time, never as an error; a pass on unchanged inputs on the same day writes
 * nothing — and that the engine's pass plan is null where the child cannot run, so a test never spawns one.
 */
describe("the money list is stored by the engine, not rebuilt on open", () => {
  let done: () => void;
  before(async () => {
    done = await useScratchDb();
  });
  after(() => done());

  test("the pass runs in a child only where tsx, the script and its tsconfig are on disk", async () => {
    const { enginePassPlan } = await import("../src/lib/engine/run");
    assert.equal(enginePassPlan("/nowhere", () => false), null);
    const plan = enginePassPlan("/root", () => true);
    assert.ok(plan);
    assert.equal(plan.command, process.execPath);
    assert.match(plan.args.join(" "), /engine-pass\.ts/);
    assert.match(plan.args.join(" "), /tsconfig\.script\.json/);
  });

  test("recompute only when the inputs or the day moved", async () => {
    const { shouldRecompute } = await import("../src/lib/engine/money-found");
    assert.equal(shouldRecompute(null, "a", "2026-10-02"), true);
    assert.equal(shouldRecompute({ fingerprint: "a", computedOn: "2026-10-02" }, "a", "2026-10-02"), false);
    assert.equal(shouldRecompute({ fingerprint: "a", computedOn: "2026-10-02" }, "b", "2026-10-02"), true);
    assert.equal(shouldRecompute({ fingerprint: "a", computedOn: "2026-10-01" }, "a", "2026-10-02"), true);
  });

  test("nothing stored reads as empty with no computed time; a pass stores a run; the next pass on the same inputs is free", async () => {
    const { readMoneyFound, writeMoneyFound } = await import("../src/lib/engine/money-found");
    const empty = await readMoneyFound("2026-10-02");
    assert.equal(empty.computedAt, null);
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.firstYearCents, 0);

    const first = await writeMoneyFound("2026-10-02", "2026-10-02T14:00:00.000Z");
    assert.equal(first.computed, true);
    const again = await writeMoneyFound("2026-10-02", "2026-10-02T14:30:00.000Z");
    assert.equal(again.computed, false);

    const read = await readMoneyFound("2026-10-02");
    assert.equal(read.computedAt, "2026-10-02T14:00:00.000Z");
    assert.ok(Array.isArray(read.blocked));
    assert.ok(Array.isArray(read.watch));

    const { moneyFound } = await import("../src/lib/money-found");
    assert.equal((await moneyFound()).computedAt, "2026-10-02T14:00:00.000Z");
  });
});
