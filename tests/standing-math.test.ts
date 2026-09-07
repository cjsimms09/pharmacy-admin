import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shareOfMonth, accruedCents, paidCents, standingLines } from "../src/lib/standing-math";

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

/** The cash account asks a different question: has the money left. */
describe("on the cash basis", () => {
  const payroll = { id: "pay", name: "Payroll", categoryId: "wages", vendorId: null, amountCents: 3_000_000, fromMonth: "2026-01", toMonth: null, paidDay: 15 };
  const rent = { id: "rent", name: "Rent", categoryId: "rent", vendorId: "v-landlord", amountCents: 400_000, fromMonth: "2026-01", toMonth: null, paidDay: null };
  test("a cost counts in full on the day it is paid and not at all before it", () => {
    assert.equal(standingLines([payroll], "2026-09", "2026-09-14", [], "cash")[0].accruedCents, 0);
    assert.equal(standingLines([payroll], "2026-09", "2026-09-15", [], "cash")[0].accruedCents, 3_000_000);
    assert.equal(standingLines([payroll], "2026-09", "2026-10-02", [], "cash")[0].accruedCents, 3_000_000);
    assert.equal(paidCents(100, 31, "2026-02", "2026-02-28"), 100, "a paid day past the end of a short month is its last day");
  });
  test("a cost with no paid day is left out of the cash account and says so, and still accrues by the day on the accrual account", () => {
    const cash = standingLines([rent], "2026-09", "2026-09-20", [], "cash")[0];
    assert.equal(cash.accruedCents, 0);
    assert.equal(cash.noPaidDay, true);
    const accrual = standingLines([rent], "2026-09", "2026-09-15", [], "accrual")[0];
    assert.equal(accrual.accruedCents, 200_000);
    assert.equal(accrual.noPaidDay, false);
  });
  test("a cost with no vendor is replaced by a bill in its category, so payroll typed and payroll entered are not both counted", () => {
    const lines = standingLines([payroll], "2026-09", "2026-09-30", [{ vendorId: null, categoryId: "wages" }]);
    assert.equal(lines[0].replacedByBill, true);
    const other = standingLines([payroll], "2026-09", "2026-09-30", [{ vendorId: null, categoryId: "rent" }]);
    assert.equal(other[0].replacedByBill, false);
  });
});
