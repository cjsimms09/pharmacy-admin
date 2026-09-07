import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shareOfMonth, accruedCents, standingLines } from "../src/lib/standing-math";

/** Payroll by the day: the owner's rule, in his own example. */
describe("a standing cost's share of the month", () => {
  test("thirty thousand is ten thousand by the tenth, twenty by the twentieth, all of it after the month", () => {
    assert.equal(accruedCents(3_000_000, "2026-09", "2026-09-10"), 1_000_000);
    assert.equal(accruedCents(3_000_000, "2026-09", "2026-09-20"), 2_000_000);
    assert.equal(accruedCents(3_000_000, "2026-09", "2026-09-30"), 3_000_000);
    assert.equal(accruedCents(3_000_000, "2026-09", "2026-10-01"), 3_000_000);
    assert.equal(accruedCents(3_000_000, "2026-09", "2026-08-31"), 0);
  });
  test("the calendar decides the denominator: February is 28, a leap February 29, July 31", () => {
    assert.deepEqual(shareOfMonth("2026-02", "2026-02-14"), { days: 14, of: 28 });
    assert.deepEqual(shareOfMonth("2028-02", "2028-02-29"), { days: 29, of: 29 });
    assert.deepEqual(shareOfMonth("2026-07", "2026-07-31"), { days: 31, of: 31 });
  });
  test("a cost applies from its first month to its last, and a real bill from its vendor replaces it", () => {
    const costs = [
      { id: "pay", name: "Payroll", categoryId: "c1", vendorId: "v-payroll", amountCents: 3_000_000, fromMonth: "2026-01", toMonth: null },
      { id: "rent", name: "Rent", categoryId: "c2", vendorId: "v-landlord", amountCents: 400_000, fromMonth: "2026-01", toMonth: "2026-06" },
      { id: "later", name: "New loan", categoryId: "c3", vendorId: null, amountCents: 100_000, fromMonth: "2026-10", toMonth: null },
    ];
    const lines = standingLines(costs, "2026-09", "2026-09-15", [{ vendorId: "v-payroll" }, { vendorId: null }]);
    assert.deepEqual(lines.map((l) => l.id), ["pay"]);
    assert.equal(lines[0].replacedByBill, true);
    assert.equal(lines[0].accruedCents, 1_500_000);
    const june = standingLines(costs, "2026-06", "2026-09-15", []);
    assert.deepEqual(june.map((l) => [l.id, l.accruedCents, l.replacedByBill]), [["pay", 3_000_000, false], ["rent", 400_000, false]]);
  });
});
