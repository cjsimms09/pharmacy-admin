import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { useScratchDb } from "./support/scratch-db";

/*
 * The return-soon list is stored by the engine and read by the pages. Measured 2 October 2026: the dashboard rebuilt it
 * from cold in fifteen seconds and kept six hundred megabytes afterwards, and "cold" was most of the time. These pin
 * the two rules of the store: nothing stored reads as "not computed", in words, never as an empty list; and a pass on
 * unchanged inputs on the same day writes nothing.
 */
describe("the return-soon list is stored by the engine, not rebuilt on open", () => {
  let done: () => void;
  before(async () => {
    done = await useScratchDb();
  });
  after(() => done());

  test("recompute only when the inputs or the day moved", async () => {
    const { shouldRecompute } = await import("../src/lib/engine/return-soon");
    assert.equal(shouldRecompute(null, "a", "2026-10-02"), true);
    assert.equal(shouldRecompute({ fingerprint: "a", computedOn: "2026-10-02" }, "a", "2026-10-02"), false);
    assert.equal(shouldRecompute({ fingerprint: "a", computedOn: "2026-10-02" }, "b", "2026-10-02"), true);
    assert.equal(shouldRecompute({ fingerprint: "a", computedOn: "2026-10-01" }, "a", "2026-10-02"), true);
  });

  test("nothing stored says so; a pass stores a run; the next pass on the same inputs is free", async () => {
    const { readReturnSoon, writeReturnSoon } = await import("../src/lib/engine/return-soon");
    const empty = await readReturnSoon();
    assert.equal(empty.computedAt, null);
    assert.equal(empty.rows.length, 0);
    assert.match(empty.notes.join(" "), /not computed yet/i);

    const first = await writeReturnSoon("2026-10-02", "2026-10-02T14:00:00.000Z");
    assert.equal(first.computed, true);
    const again = await writeReturnSoon("2026-10-02", "2026-10-02T14:30:00.000Z");
    assert.equal(again.computed, false);

    const read = await readReturnSoon();
    assert.equal(read.computedAt, "2026-10-02T14:00:00.000Z");
    assert.match(read.notes.join(" "), /Computed /);
    assert.doesNotMatch(read.notes.join(" "), /not computed yet/i);

    const { returnSoonNow, returnWarningNow } = await import("../src/lib/return-soon");
    assert.equal((await returnSoonNow()).computedAt, "2026-10-02T14:00:00.000Z");
    assert.equal(await returnWarningNow("2026-10-02"), null);
  });
});
