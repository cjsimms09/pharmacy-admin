import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconcileCogs, reconcileRevenue, TOLERANCE_CENTS, type Source } from "../src/lib/reconcile";

const src = (cents: number | null, from = "x"): Source => ({ cents, from });

describe("cost of goods, from three sources answering three questions", () => {
  test("buying more than was dispensed is stock building, never an error", () => {
    const r = reconcileCogs({
      dispensed: src(55_000_000),
      purchases: src(58_000_000),
      openingStock: src(null),
      closingStock: src(null),
    });
    const bought = r.checks[0];
    assert.equal(r.stockMovementCents, 3_000_000);
    assert.equal(bought.expected, true, "a difference here is a fact about the month, not a fault");
    assert.match(bought.says, /the shelf grew/);
    assert.match(bought.says, /balance sheet rather than in the profit/);
  });

  test("dispensing more than was bought is the shelf running down", () => {
    const r = reconcileCogs({ dispensed: src(58_000_000), purchases: src(55_000_000), openingStock: src(null), closingStock: src(null) });
    assert.equal(r.stockMovementCents, -3_000_000);
    assert.match(r.checks[0].says, /ran the shelf down/);
  });

  test("the shelf identity is the independent check, and agreeing means two records agree", () => {
    /*
     * Opening 40,000 + bought 58,000 − closing 43,000 = 55,000 dispensed. Not one figure in that
     * comes from the claims, so agreement is real corroboration rather than arithmetic restated.
     */
    const r = reconcileCogs({
      dispensed: src(55_000_000),
      purchases: src(58_000_000),
      openingStock: src(40_000_000),
      closingStock: src(43_000_000),
    });
    assert.equal(r.impliedCogsCents, 55_000_000);
    assert.equal(r.checks[1].agrees, true);
    assert.equal(r.checks[1].expected, false, "a difference here IS a fault");
    assert.match(r.checks[1].says, /Two separate records of the month agree/);
  });

  test("more left the shelf than the claims explain", () => {
    const r = reconcileCogs({
      dispensed: src(55_000_000),
      purchases: src(58_000_000),
      openingStock: src(40_000_000),
      closingStock: src(41_000_000),
    });
    assert.equal(r.checks[1].agrees, false);
    assert.equal(r.checks[1].differenceCents, 2_000_000);
    assert.match(r.checks[1].says, /went out without being dispensed/);
  });

  test("the claims explain more than the shelf lost", () => {
    const r = reconcileCogs({
      dispensed: src(55_000_000),
      purchases: src(58_000_000),
      openingStock: src(40_000_000),
      closingStock: src(45_000_000),
    });
    assert.equal(r.checks[1].differenceCents, -2_000_000);
    assert.match(r.checks[1].says, /arrived without an invoice/);
  });

  test("a missing count says what is needed rather than passing quietly", () => {
    const r = reconcileCogs({ dispensed: src(55_000_000), purchases: src(58_000_000), openingStock: src(null), closingStock: src(43_000_000) });
    assert.equal(r.impliedCogsCents, null);
    assert.equal(r.checks[1].agrees, null, "not held is not the same as agreeing");
    assert.match(r.checks[1].says, /Needs a count at each end/);
  });

  test("a difference under the tolerance is rounding, not a finding", () => {
    const r = reconcileCogs({
      dispensed: src(55_000_000),
      purchases: src(58_000_000),
      openingStock: src(40_000_000),
      closingStock: src(43_000_000 - (TOLERANCE_CENTS - 1)),
    });
    assert.equal(r.checks[1].agrees, true);
  });
});

describe("revenue, and which gaps mean something", () => {
  test("claims ahead of the till is billed and not sold", () => {
    const [rx] = reconcileRevenue({ claims: src(60_500_000), tillRx: src(60_000_000), banked: src(null) });
    assert.equal(rx.differenceCents, 500_000);
    assert.equal(rx.expected, false);
    assert.match(rx.says, /billed and not sold/);
  });

  test("till ahead of the claims is a missing day of the report", () => {
    const [rx] = reconcileRevenue({ claims: src(60_000_000), tillRx: src(60_500_000), banked: src(null) });
    assert.match(rx.says, /missing day of the transaction report/);
  });

  test("the bank differing from the month earned is timing and is never a discrepancy", () => {
    /*
     * The one comparison that must not be scored. A plan pays weeks after it adjudicates, so the
     * bank is always answering a different month's question; flagging it would bury the two checks
     * that do mean something.
     */
    const [, bank] = reconcileRevenue({ claims: src(60_000_000), tillRx: src(60_000_000), banked: src(45_000_000) });
    assert.equal(bank.expected, true);
    assert.equal(bank.agrees, null);
    assert.match(bank.says, /never treated as one/);
  });

  test("what is not held is said, not assumed", () => {
    const checks = reconcileRevenue({ claims: src(null), tillRx: src(60_000_000), banked: src(null) });
    assert.equal(checks[0].agrees, null);
    assert.match(checks[0].says, /Needs both the claims and the System Sales Summary/);
  });
});
