import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { driverCostOf, driverPaidBy } from "../src/lib/driver-cost";

const invoices = [
  { month: "2026-08", status: "superseded", totalCents: 40_000, sentAt: "2026-08-29T10:00:00Z" },
  { month: "2026-08", status: "sent", totalCents: 42_000, sentAt: "2026-09-01T09:00:00Z" },
  { month: "2026-09", status: "draft", totalCents: 9_000, sentAt: null },
];

describe("the delivery round on the books", () => {
  test("the pharmacy pays unless the setting says the clinic does", () => {
    assert.equal(driverPaidBy(undefined), "pharmacy");
    assert.equal(driverPaidBy(""), "pharmacy");
    assert.equal(driverPaidBy("pharmacy"), "pharmacy");
    assert.equal(driverPaidBy("clinic"), "clinic");
  });

  test("accrual: the month carries its invoice, the draft's running total included, never a superseded one", () => {
    assert.equal(driverCostOf(invoices, "2026-08", "accrual", "pharmacy"), 42_000);
    assert.equal(driverCostOf(invoices, "2026-09", "accrual", "pharmacy"), 9_000, "the month in progress carries the days driven so far");
  });

  test("cash: a sent invoice on the day it went out; a draft is not cash", () => {
    assert.equal(driverCostOf(invoices, "2026-08", "cash", "pharmacy"), 0, "August's invoice went out in September");
    assert.equal(driverCostOf(invoices, "2026-09", "cash", "pharmacy"), 42_000);
  });

  test("where the clinic pays the driver, the round is nothing on either basis", () => {
    assert.equal(driverCostOf(invoices, "2026-09", "accrual", "clinic"), 0);
    assert.equal(driverCostOf(invoices, "2026-09", "cash", "clinic"), 0);
  });
});
