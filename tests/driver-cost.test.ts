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

/**
 * A month in progress carries the round it has already driven.
 *
 * The note at the top of `driver-cost.ts` has always said the accrual account carries "what the
 * round has cost so far — the draft invoice is the running total of days already driven". There is
 * no draft: an invoice is only raised on a finished month. So a month in progress had no invoice,
 * and no invoice meant no cost — September showed $0.00 of delivery on 11 September with 47
 * deliveries and 7 mail trips entered and $486.00 owed.
 */
describe("the round before it is invoiced", () => {
  const none: { month: string; status: string; totalCents: number; sentAt: string | null }[] = [];

  test("days entered are the cost until an invoice exists", () => {
    assert.equal(driverCostOf(none, "2026-09", "accrual", "pharmacy", 48_600), 48_600);
  });

  test("the invoice replaces the running total, never adds to it", () => {
    const issued = [{ month: "2026-09", status: "issued", totalCents: 52_200, sentAt: null }];
    /* 54 trips accrued, then the finished month invoiced at 58 — the document wins, not the sum. */
    assert.equal(driverCostOf(issued, "2026-09", "accrual", "pharmacy", 48_600), 52_200);
  });

  test("a superseded invoice does not resurrect itself as the cost", () => {
    const gone = [{ month: "2026-09", status: "superseded", totalCents: 52_200, sentAt: null }];
    assert.equal(driverCostOf(gone, "2026-09", "accrual", "pharmacy", 48_600), 48_600);
  });

  test("cash is unmoved: a day driven is not money out", () => {
    assert.equal(driverCostOf(none, "2026-09", "cash", "pharmacy", 48_600), 0);
    const sent = [{ month: "2026-09", status: "sent", totalCents: 52_200, sentAt: "2026-10-01" }];
    /* Sent in October, so September's cash account carries nothing for it. */
    assert.equal(driverCostOf(sent, "2026-09", "cash", "pharmacy", 48_600), 0);
  });

  test("where the clinic pays him, the round is still nothing on either basis", () => {
    assert.equal(driverCostOf(none, "2026-09", "accrual", "clinic", 48_600), 0);
    assert.equal(driverCostOf(none, "2026-09", "cash", "clinic", 48_600), 0);
  });

  test("no days entered accrues nothing rather than guessing a month", () => {
    assert.equal(driverCostOf(none, "2026-09", "accrual", "pharmacy", 0), 0);
  });
});
