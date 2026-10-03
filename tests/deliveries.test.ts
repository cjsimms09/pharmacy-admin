import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { weekdaysIn, isWeekday, weekdayName, monthLabel, money } from "../src/lib/deliveries";

/**
 * The driver's month.
 *
 * The whole design turns on one distinction: a weekday nobody has answered for yet and a weekday
 * with no deliveries on it are different things. A blank is unfinished work; a zero is a fact.
 * Conflating them either sends the invoice short or leaves a month that can never be finished —
 * and the month finishing is what sends the invoice, so that would leave the driver unpaid and
 * nothing saying why.
 *
 * These pin the arithmetic that decides when a month is finished.
 */
describe("which days are invoiced", () => {
  test("Monday to Friday, and nothing else", () => {
    assert.equal(isWeekday("2026-09-07"), true); // Monday
    assert.equal(isWeekday("2026-09-11"), true); // Friday
    assert.equal(isWeekday("2026-09-12"), false); // Saturday
    assert.equal(isWeekday("2026-09-13"), false); // Sunday
  });

  test("a month lists every weekday in it, in order", () => {
    const days = weekdaysIn("2026-09");
    assert.equal(days.length, 22);
    assert.equal(days[0], "2026-09-01");
    assert.equal(days.at(-1), "2026-09-30");
    assert.deepEqual([...days].sort(), days);
  });

  test("no weekend ever appears, whatever the month starts on", () => {
    for (const m of ["2026-01", "2026-02", "2026-05", "2026-08", "2026-11"]) {
      for (const d of weekdaysIn(m)) assert.ok(isWeekday(d), `${d} in ${m}`);
    }
  });

  test("February knows about leap years", () => {
    assert.equal(weekdaysIn("2028-02").length, 21);
    assert.equal(weekdaysIn("2026-02").length, 20);
  });

  test("the last weekday is the one that triggers the invoice, not the last day", () => {
    // 31 May 2026 is a Sunday; the invoice must not wait for it.
    assert.equal(weekdaysIn("2026-05").at(-1), "2026-05-29");
    assert.equal(weekdayName("2026-05-29"), "Friday");
  });

  test("a nonsense month is empty rather than throwing", () => {
    assert.deepEqual(weekdaysIn(""), []);
    assert.deepEqual(weekdaysIn("not-a-month"), []);
  });
});

describe("what the invoice says", () => {
  test("money is written the way an accounts department expects", () => {
    assert.equal(money(900), "$9.00");
    assert.equal(money(91800), "$918.00");
    assert.equal(money(123456), "$1,234.56");
    assert.equal(money(0), "$0.00");
  });

  test("a month reads as a person would say it", () => {
    assert.equal(monthLabel("2026-09"), "September 2026");
  });

  test("a full month at the agreed rate comes to what it should", () => {
    // 22 weekdays, one mail trip each, plus 81 deliveries, at $9.
    const trips = 81 + 22;
    assert.equal(money(trips * 900), "$927.00");
  });
});
