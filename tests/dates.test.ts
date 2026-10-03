import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { addDays, cqiPeriods, daysBetween, lastDayOfMonth, nextCqiPeriod, periodLabel } from "../src/lib/dates";

/**
 * Date maths decides Board deadlines. A wrong period here means a late C-550, so every rule in
 * K.A.R. 68-19-1 that this file implements is pinned by a test.
 */

describe("addDays", () => {
  test("crosses month and year boundaries", () => {
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });
  test("handles a leap day", () => {
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addDays("2028-02-29", 1), "2028-03-01");
  });
  test("the 7 and 30 day CQI review windows", () => {
    assert.equal(addDays("2026-08-20", 7), "2026-08-27");
    assert.equal(addDays("2026-08-20", 30), "2026-09-19");
  });
});

describe("daysBetween", () => {
  test("counts inclusive of DST changes", () => {
    // US DST starts 2026-03-08. A naive local-time subtraction returns 30.958… and floors to 30.
    assert.equal(daysBetween("2026-03-01", "2026-04-01"), 31);
    assert.equal(daysBetween("2026-11-01", "2026-12-01"), 30);
  });
  test("is signed", () => {
    assert.equal(daysBetween("2026-05-10", "2026-05-01"), -9);
    assert.equal(daysBetween("2026-05-10", "2026-05-10"), 0);
  });
});

describe("lastDayOfMonth", () => {
  test("knows February", () => {
    assert.equal(lastDayOfMonth(2026, 2), "2026-02-28");
    assert.equal(lastDayOfMonth(2028, 2), "2028-02-29");
    assert.equal(lastDayOfMonth(2026, 12), "2026-12-31");
    assert.equal(lastDayOfMonth(2026, 4), "2026-04-30");
  });
});

describe("cqiPeriods", () => {
  const y = cqiPeriods(2026, 2026);

  test("produces the six bimonthly periods the Board requires", () => {
    assert.equal(y.length, 6);
    assert.deepEqual(
      y.map((p) => p.dueOn),
      ["2026-02-15", "2026-04-15", "2026-06-15", "2026-08-15", "2026-10-15", "2026-12-15"],
    );
  });

  test("each period covers the two calendar months before its due month", () => {
    const aug = y.find((p) => p.dueOn === "2026-08-15")!;
    assert.equal(aug.periodStart, "2026-06-01");
    assert.equal(aug.periodEnd, "2026-07-31");
  });

  test("the February summary reaches back into the previous year", () => {
    const feb = y.find((p) => p.dueOn === "2026-02-15")!;
    assert.equal(feb.periodStart, "2025-12-01");
    assert.equal(feb.periodEnd, "2026-01-31");
  });

  test("period end is always the true last day of the month", () => {
    const apr = y.find((p) => p.dueOn === "2026-04-15")!;
    assert.equal(apr.periodStart, "2026-02-01");
    assert.equal(apr.periodEnd, "2026-03-31");
  });
});

describe("nextCqiPeriod", () => {
  test("returns the obligation currently in hand, not the next one to open", () => {
    // 2 Sep: the Jun-Jul summary was due 15 Aug and is late. That is the one that needs work.
    assert.equal(nextCqiPeriod("2026-09-02").dueOn, "2026-08-15");
  });
  test("moves on once the old one is more than 45 days past", () => {
    assert.equal(nextCqiPeriod("2026-10-01").dueOn, "2026-10-15");
  });
  test("works on the due date itself", () => {
    assert.equal(nextCqiPeriod("2026-08-15").dueOn, "2026-08-15");
  });
  test("rolls across the new year", () => {
    assert.equal(nextCqiPeriod("2027-01-10").dueOn, "2026-12-15");
    assert.equal(nextCqiPeriod("2027-02-01").dueOn, "2027-02-15");
  });
  test("never returns a period whose start is after its end", () => {
    for (const d of ["2026-01-01", "2026-06-30", "2026-09-02", "2026-12-31"]) {
      const p = nextCqiPeriod(d);
      assert.ok(p.periodStart < p.periodEnd, `${d} -> ${p.periodStart}..${p.periodEnd}`);
      assert.ok(p.periodEnd < p.dueOn, `${d}: period must end before the summary is due`);
    }
  });
});

describe("periodLabel", () => {
  test("names a same-year period", () => {
    assert.equal(periodLabel("2026-06-01", "2026-07-31"), "June–July 2026");
  });
  test("names a period spanning a year boundary", () => {
    assert.equal(periodLabel("2025-12-01", "2026-01-31"), "December 2025–January 2026");
  });
});
