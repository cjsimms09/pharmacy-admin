import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { coversTheMonth, coverage } from "../src/lib/monthly-checklist";

/**
 * An export taken before the month ended cannot hold the month.
 *
 * On 1 October 2026 September's two ProviderPay items both read as done. Every row in both came
 * from one pull on 18 September: 28 remittances and 31 payments, all of them stopping on the 18th,
 * against 8,928 claims running to the 30th. Twelve days of what the plans paid and twelve days of
 * the cash for it were absent, and the month's own checklist said they were in — and `month-close`
 * uses these items as its document gates, so September could have been called closed on them.
 *
 * The test is the day the export was read, which is the one thing about it that cannot be argued.
 * A payer does not remit every day, so a last remittance on the 28th proves nothing either way.
 */
describe("whether a month's export actually covers the month", () => {
  test("an export pulled inside the month does not cover it, however much it holds", () => {
    assert.equal(coversTheMonth(28, "2026-09-18T23:30:00.000Z", "2026-09"), false);
    assert.equal(coversTheMonth(999, "2026-09-30T23:59:00.000Z", "2026-09"), false, "the last day is still inside the month");
  });

  test("an export pulled once the month has ended covers it", () => {
    assert.equal(coversTheMonth(28, "2026-10-01T09:00:00.000Z", "2026-09"), true);
    assert.equal(coversTheMonth(1, "2026-11-14T09:00:00.000Z", "2026-09"), true, "late is still covered");
  });

  test("no rows is never covered, whenever it was looked at", () => {
    assert.equal(coversTheMonth(0, "2026-10-01T09:00:00.000Z", "2026-09"), false);
    assert.equal(coversTheMonth(0, null, "2026-09"), false);
  });

  test("rows with no pull date recorded are not taken on trust", () => {
    assert.equal(coversTheMonth(28, null, "2026-09"), false);
  });

  test("December rolls into the next year rather than month thirteen", () => {
    assert.equal(coversTheMonth(5, "2026-12-31T12:00:00.000Z", "2026-12"), false);
    assert.equal(coversTheMonth(5, "2027-01-01T08:00:00.000Z", "2026-12"), true);
  });

  /* The sentence beside the figure, because a part-month export looks exactly like a whole one. */
  test("a part-month export says when it was pulled and what it reaches", () => {
    const said = coverage("2026-09-18T23:30:00.000Z", "2026-09-18", "2026-09");
    assert.match(said, /pulled on 2026-09-18/);
    assert.match(said, /reaches 2026-09-18/);
    assert.match(said, /Pull it again/);
  });

  test("a whole-month export says nothing extra, so the line stays the figure", () => {
    assert.equal(coverage("2026-10-01T09:00:00.000Z", "2026-09-28", "2026-09"), "");
    assert.equal(coverage(null, null, "2026-09"), "");
  });
});
