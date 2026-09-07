import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { countsToKeep, KEEP_RECENT_DAYS } from "../src/lib/count-retention";

describe("which daily counts are worth keeping", () => {
  test("the last count of a finished month is kept, and the days around it are not", () => {
    // The accounts close on the month's last count; the days in between are a shelf that has moved.
    const r = countsToKeep(["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"], "2026-09-07");
    assert.deepEqual(r.keep, ["2026-07-31"]);
    assert.deepEqual(r.drop, ["2026-07-28", "2026-07-29", "2026-07-30"]);
    assert.equal(r.why.get("2026-07-31"), "month end");
  });

  test("the last week is kept whatever else is true, so a wrong file is recoverable", () => {
    const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"];
    const r = countsToKeep(days, "2026-09-07");
    assert.deepEqual(r.drop, [], "nothing inside the week is dropped");
    assert.equal(r.why.get("2026-09-07"), "month end", "the newest is also this month's closing position");
    assert.equal(r.why.get("2026-09-03"), "recent");
  });

  test("a day older than the week and not a month end goes", () => {
    const r = countsToKeep(["2026-08-31", "2026-08-30", "2026-09-06", "2026-09-07"], "2026-09-07");
    assert.deepEqual(r.keep, ["2026-08-31", "2026-09-06", "2026-09-07"]);
    assert.deepEqual(r.drop, ["2026-08-30"]);
  });

  test("the newest count is never dropped, however stale it is", () => {
    // A pharmacy that has not uploaded since June must not have June deleted for being old — it is
    // the only thing every screen that spends money reads.
    const r = countsToKeep(["2026-06-14"], "2026-09-07");
    assert.deepEqual(r.keep, ["2026-06-14"]);
    assert.deepEqual(r.drop, []);
  });

  test("this rule never empties the table", () => {
    // Whatever the dates, every month contributes its last count.
    for (const today of ["2026-09-07", "2027-01-01", "2026-06-14"]) {
      const r = countsToKeep(["2026-06-01", "2026-06-14", "2026-07-02", "2026-08-31"], today);
      assert.ok(r.keep.length >= 3, `${today}: one per month at least`);
    }
  });

  test("a repeated date is one count, because a day has one shelf", () => {
    const r = countsToKeep(["2026-07-31", "2026-07-31"], "2026-09-07");
    assert.deepEqual(r.keep, ["2026-07-31"]);
  });

  test("the week is exactly a week", () => {
    assert.equal(KEEP_RECENT_DAYS, 7);
    // Seven days back is outside it; six is inside.
    const r = countsToKeep(["2026-09-01", "2026-09-02", "2026-09-30"], "2026-09-08");
    assert.ok(r.drop.includes("2026-09-01"), "seven days back is outside the week");
    assert.ok(r.keep.includes("2026-09-02"), "six days back is inside it");
  });
});
