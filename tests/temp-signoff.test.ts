import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { periodOf } from "../src/lib/imonnit";

/**
 * Which months are the pharmacy's problem.
 *
 * The readings file themselves, permanently, tagged with the month they belong to. What does not
 * and must not happen automatically is the sign-off: a system that closed a month on its own would
 * be manufacturing the one part of the record that is supposed to mean a person looked at it.
 *
 * That makes the boundary between "in progress" and "over and unsigned" the thing worth pinning.
 * Counting the month in progress as late would cry wolf every single day; not counting a month
 * that ended would let it sit unsigned indefinitely, which is what happened while the page merely
 * counted signed months and coloured the count green whatever it was.
 */
describe("which month a reading belongs to", () => {
  test("a reading is filed under its own calendar month", () => {
    assert.equal(periodOf("2026-08-14T09:30:00.000Z"), "2026-08");
    assert.equal(periodOf("2026-01-01T00:00:00.000Z"), "2026-01");
  });

  test("the last instant of a month does not leak into the next", () => {
    assert.equal(periodOf("2026-08-31T23:59:59.000Z"), "2026-08");
  });

  test("period keys sort chronologically as plain strings, which is what oldest-first relies on", () => {
    const keys = ["2026-01", "2025-12", "2026-10", "2026-02"];
    assert.deepEqual([...keys].sort((a, b) => a.localeCompare(b)), ["2025-12", "2026-01", "2026-02", "2026-10"]);
  });

  test("a month in progress compares as not-yet-past against the current one", () => {
    const current = periodOf("2026-09-04T12:00:00.000Z");
    assert.equal(current, "2026-09");
    assert.ok("2026-08" < current, "a finished month must count as over");
    assert.ok(!("2026-09" < current), "the month in progress must not count as over");
    assert.ok(!("2026-10" < current), "a future month must not count as over");
  });

  test("rubbish in does not silently become a real month", () => {
    assert.equal(periodOf("not a date"), "not a d");
  });
});
