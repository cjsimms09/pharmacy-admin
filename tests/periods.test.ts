import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { periodKeyFor, periodLabel, periodEnds, previousPeriod, periodsBetween, stateOf } from "../src/lib/periods";

/**
 * This arithmetic decides what an inspector is shown. The failure that matters is a gap that
 * does not appear: a monthly duty done in January and again in April looks current under a
 * last-done/next-due model while three months are missing.
 */
describe("period keys", () => {
  test("monthly, quarterly and annual", () => {
    assert.equal(periodKeyFor("monthly", "2026-08-15"), "2026-08");
    assert.equal(periodKeyFor("quarterly", "2026-08-15"), "2026-Q3");
    assert.equal(periodKeyFor("annual", "2026-08-15"), "2026");
  });
  test("quarter boundaries land in the right quarter", () => {
    assert.equal(periodKeyFor("quarterly", "2026-03-31"), "2026-Q1");
    assert.equal(periodKeyFor("quarterly", "2026-04-01"), "2026-Q2");
    assert.equal(periodKeyFor("quarterly", "2026-12-31"), "2026-Q4");
  });
  test("as-needed duties have no periods at all", () => {
    assert.equal(periodKeyFor("as_needed", "2026-08-15"), null);
    assert.deepEqual(periodsBetween("as_needed", "2026-01-01", "2026-08-15"), []);
  });
});

describe("period ends", () => {
  test("month ends, including February in a leap year", () => {
    assert.equal(periodEnds("2026-08"), "2026-08-31");
    assert.equal(periodEnds("2026-02"), "2026-02-28");
    assert.equal(periodEnds("2024-02"), "2024-02-29");
    assert.equal(periodEnds("2026-09"), "2026-09-30");
  });
  test("quarter and year ends", () => {
    assert.equal(periodEnds("2026-Q1"), "2026-03-31");
    assert.equal(periodEnds("2026-Q4"), "2026-12-31");
    assert.equal(periodEnds("2026"), "2026-12-31");
  });
});

describe("previous period", () => {
  test("steps back across year boundaries", () => {
    assert.equal(previousPeriod("2026-01"), "2025-12");
    assert.equal(previousPeriod("2026-Q1"), "2025-Q4");
    assert.equal(previousPeriod("2026"), "2025");
  });
});

describe("periodsBetween", () => {
  test("every month is listed, so a gap cannot hide", () => {
    const p = periodsBetween("monthly", "2026-01-10", "2026-04-05");
    assert.deepEqual(p, ["2026-01", "2026-02", "2026-03", "2026-04"]);
  });

  test("the current period is included — it is the one to act on", () => {
    assert.ok(periodsBetween("monthly", "2026-08-01", "2026-08-15").includes("2026-08"));
  });

  test("nothing before the pharmacy started using the site", () => {
    // Inventing a year of failures on the first run makes the screen useless on day one.
    const p = periodsBetween("monthly", "2026-08-01", "2026-09-15");
    assert.deepEqual(p, ["2026-08", "2026-09"]);
  });

  test("quarterly duties list quarters", () => {
    assert.deepEqual(periodsBetween("quarterly", "2026-01-05", "2026-09-01"), ["2026-Q1", "2026-Q2", "2026-Q3"]);
  });

  test("a triennial duty does not become due every year", () => {
    const p = periodsBetween("triennial", "2020-01-01", "2026-06-01");
    assert.deepEqual(p, ["2020", "2023", "2026"]);
  });

  test("a biennial duty recurs every other year", () => {
    assert.deepEqual(periodsBetween("biennial", "2022-01-01", "2026-06-01"), ["2022", "2024", "2026"]);
  });
});

describe("stateOf", () => {
  const today = "2026-09-15";

  test("the current period with nothing filed is open, not a failure", () => {
    assert.equal(stateOf(0, 1, "2026-09", today), "open");
  });

  test("a past period with nothing filed is missed, and stays missed", () => {
    assert.equal(stateOf(0, 1, "2026-08", today), "missed");
    assert.equal(stateOf(0, 1, "2026-01", today), "missed");
  });

  test("enough evidence satisfies it", () => {
    assert.equal(stateOf(2, 2, "2026-08", today), "satisfied");
    assert.equal(stateOf(3, 2, "2026-08", today), "satisfied");
  });

  test("one of two temperature logs is partial, in a past month and the current one alike", () => {
    assert.equal(stateOf(1, 2, "2026-08", today), "partial");
    assert.equal(stateOf(1, 2, "2026-09", today), "partial");
  });

  test("a period ending today is not yet late", () => {
    assert.equal(stateOf(0, 1, "2026-09", "2026-09-30"), "open");
  });
});

describe("labels a person can read", () => {
  test("months, quarters and years", () => {
    assert.equal(periodLabel("2026-08"), "August 2026");
    assert.equal(periodLabel("2026-Q3"), "Q3 2026");
    assert.equal(periodLabel("2026"), "2026");
  });
});
