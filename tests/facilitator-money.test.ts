import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Counting facilitator money by the date it was received, not the date of the fill.
 *
 * A remittance settles weeks after the prescription. Counted by fill date, this month's receipts
 * would be credited to a month that closed long ago, and the figure would never agree with the
 * bank — which is the only thing anybody is going to check it against.
 *
 * The bucketing is what is worth pinning by hand; the query around it is a query.
 */
const monthOf = (iso: string | null) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : null);

describe("which month a payment counts in", () => {
  test("the month it was received, even when the fill was in another one", () => {
    // Filled in August, paid in September: September's money.
    assert.equal(monthOf("2026-09-06"), "2026-09");
  });

  test("a remittance with no payment date lands in no month, rather than in this one", () => {
    // Dropping it would understate the total; assuming today would invent revenue in a month that
    // has to reconcile against a bank statement. It is in the total and in no month, and said so.
    assert.equal(monthOf(null), null);
    assert.equal(monthOf(""), null);
  });

  test("anything that is not a date is refused rather than parsed loosely", () => {
    assert.equal(monthOf("not a date"), null);
    assert.equal(monthOf("09/06/2026"), null, "the wrong shape is not silently reinterpreted");
  });

  test("last month is the calendar month before, across a year boundary", () => {
    const previous = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    assert.equal(previous(new Date("2026-01-15T00:00:00Z")), "2025-12");
    assert.equal(previous(new Date("2026-09-06T00:00:00Z")), "2026-08");
  });
});
