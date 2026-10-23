import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { daysWithoutPaymentReport, sellingWeekdays, eachDay, judgeDailyFeeds, sayDays } from "../src/lib/daily-feeds";

/*
 * September 2026: the payment-type report was on file for 16 days and absent for nine weekdays, and the month-close strip read closed.
 * The card batch is deliberately not asked for: it arrives only when forwarded by hand, and the bank statement proves the card deposits. Every amount and day below is invented to the same shape.
 */
describe("the days a month is open to sell", () => {
  test("weekdays, less the holidays a wholesaler keeps", () => {
    const d = sellingWeekdays("2026-09");
    assert.equal(d.length, 21, "22 weekdays less Labor Day");
    assert.ok(!d.includes("2026-09-07"));
    assert.ok(d.includes("2026-09-01") && d.includes("2026-09-30"));
  });
  test("a range is every day in it", () => {
    assert.deepEqual(eachDay("2026-09-29", "2026-10-02"), ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});

describe("weekdays no payment-type report covers", () => {
  const one = (d: string) => ({ periodFrom: d, periodTo: d });
  test("days with a report are covered, the rest are named", () => {
    const have = ["2026-09-05", "2026-09-06", ...Array.from({ length: 16 }, (_, i) => `2026-09-${String(15 + i).padStart(2, "0")}`)].map(one);
    assert.deepEqual(daysWithoutPaymentReport("2026-09", have), ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"]);
  });
  test("one report for 1 to 14 September covers all of them", () => {
    const have = [{ periodFrom: "2026-09-01", periodTo: "2026-09-14" }, ...Array.from({ length: 16 }, (_, i) => one(`2026-09-${String(15 + i).padStart(2, "0")}`))];
    assert.deepEqual(daysWithoutPaymentReport("2026-09", have), []);
  });
  test("an empty month names every selling weekday", () => {
    assert.equal(daysWithoutPaymentReport("2026-09", []).length, 21);
  });
});

describe("what it says", () => {
  test("it names the days and the report to pull, once for the range", () => {
    const g = judgeDailyFeeds({ month: "2026-09", payment: ["2026-09-01", "2026-09-02", "2026-09-14"] });
    assert.equal(g.length, 1);
    assert.match(g[0].says, /No payment-type report is on file for 1, 2 and 14 Sep/);
    assert.match(g[0].says, /System Sales Totals By Payment Type for 2026-09-01 to 2026-09-14/);
    assert.match(g[0].says, /one report can cover the whole range/);
  });
  test("a month with every day on file adds nothing", () => {
    assert.deepEqual(judgeDailyFeeds({ month: "2026-09", payment: [] }), []);
  });
  test("days read aloud with their month", () => {
    assert.equal(sayDays("2026-09", ["2026-09-15"]), "15 Sep");
  });
});
