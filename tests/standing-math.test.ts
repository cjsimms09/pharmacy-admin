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

/**
 * An estimate stands down by what has arrived, not for the first thing that arrives.
 *
 * The rule used to be "any bill from this vendor replaces the estimate", which is right when the
 * bill is the month's payroll and wrong when it is one run of two. $45,000 a month with a single
 * $12,000 run entered showed $12,000 and dropped the rest — a $33,000 understatement that nothing
 * on the account would have questioned, because a standing cost that has been replaced looks
 * exactly like one that was never there.
 */
describe("a partly billed standing cost", () => {
  const payroll = {
    id: "s1",
    name: "Payroll",
    categoryId: "wages",
    vendorId: "v-payroll",
    amountCents: 4_500_000,
    fromMonth: "2026-01",
    toMonth: null,
  };
  /* A whole month, so the accrued share is the whole figure and the arithmetic is easy to check. */
  const whole = (bills: { vendorId: string | null; categoryId?: string | null; amountCents?: number }[]) =>
    standingLines([payroll], "2026-09", "2026-09-30", bills)[0];

  test("one payroll run of two tops up to the month's figure rather than replacing it", () => {
    const l = whole([{ vendorId: "v-payroll", amountCents: 1_200_000 }]);
    assert.equal(l.replacedByBill, false);
    assert.equal(l.partlyBilled, true);
    assert.equal(l.billedCents, 1_200_000);
    assert.equal(l.toAccrueCents, 3_300_000);
  });

  test("bills reaching the whole figure drop the estimate", () => {
    const l = whole([{ vendorId: "v-payroll", amountCents: 3_000_000 }, { vendorId: "v-payroll", amountCents: 1_500_000 }]);
    assert.equal(l.replacedByBill, true);
    assert.equal(l.toAccrueCents, 0);
  });

  test("billed above the estimate adds nothing on top", () => {
    const l = whole([{ vendorId: "v-payroll", amountCents: 5_000_000 }]);
    assert.equal(l.replacedByBill, true);
    assert.equal(l.toAccrueCents, 0);
  });

  test("no bill at all carries the whole estimate", () => {
    const l = whole([]);
    assert.equal(l.partlyBilled, false);
    assert.equal(l.billedCents, 0);
    assert.equal(l.toAccrueCents, 4_500_000);
  });

  test("a bill with no amount given still replaces the estimate outright", () => {
    /* Older callers pass only the vendor. "There is a bill" has to keep meaning what it meant. */
    const l = whole([{ vendorId: "v-payroll" }]);
    assert.equal(l.replacedByBill, true);
    assert.equal(l.toAccrueCents, 0);
  });

  test("the top-up follows the month's share, not the whole figure, part way through", () => {
    /* On the 10th of a 30-day month the month expects $15,000; $12,000 is billed, so $3,000 is left. */
    const l = standingLines([payroll], "2026-09", "2026-09-10", [{ vendorId: "v-payroll", amountCents: 1_200_000 }])[0];
    assert.equal(l.toAccrueCents, 300_000);
  });

  test("a category match measures the category, not the vendor", () => {
    const noVendor = { ...payroll, vendorId: null };
    const l = standingLines([noVendor], "2026-09", "2026-09-30", [{ vendorId: null, categoryId: "wages", amountCents: 1_000_000 }])[0];
    assert.equal(l.toAccrueCents, 3_500_000);
    assert.equal(l.partlyBilled, true);
  });
});
