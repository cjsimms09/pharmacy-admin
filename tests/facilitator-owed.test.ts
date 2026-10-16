import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { owedByPayer, type Receivable, type Received } from "../src/lib/payer-owed";

/*
 * The Medicare Transaction Facilitator's refund, paid on top of what the plan paid.
 *
 * On a negotiated-price drug the plan pays its own share at adjudication and the facilitator pays the manufacturer's refund
 * weeks later, on its own remittance. The refund is the facilitator's debt and not the plan's (claim-lifecycle.md, Rule 1),
 * so settling the plan's share with it read every such fill as overpaid by the refund: measured on 5 October 2026, 13 of the
 * 20 shares this page called overpaid, $3,181.68 of $3,739.05. Figures invented, in the shape of one fill.
 */
const BIN = "610014";
const PLAN = 8_447;
const REFUND = 24_075;

const share: Receivable = { bin: BIN, name: "Example Plan", dateFilled: "2026-09-20", cents: PLAN, cashPlan: false, claimId: "c1", portion: "plan" };
const planPaid = (over: Partial<Received> = {}): Received => ({ bin: BIN, payer: "Example Plan", cents: PLAN, receivedOn: "2026-09-28", matched: true, claimId: "c1", portion: "plan", ...over });
const refund = (over: Partial<Received> = {}): Received => planPaid({ cents: REFUND, receivedOn: "2026-10-02", facilitator: true, ...over });

describe("the facilitator's refund on a claim the plan has paid", () => {
  test("the plan's payment settles its share, and the refund tied to the same claim leaves it square and not overpaid", () => {
    const s = owedByPayer([share], [planPaid(), refund()], "2026-10-20");
    const line = s.lines[0];
    assert.equal(line.receivedCents, PLAN);
    assert.equal(line.outstandingCents, 0);
    assert.equal(line.overpaidCents, 0);
    assert.equal(line.state, "settled");
    assert.equal(s.receivedCents, PLAN);
    assert.deepEqual(s.claimBalances.map((c) => [c.receivedCents, c.outstandingCents]), [[PLAN, 0]]);
  });

  test("it is its own figure, so the money is on the page and not lost", () => {
    const s = owedByPayer([share], [planPaid(), refund()], "2026-10-20");
    assert.deepEqual(s.facilitator, { count: 1, cents: REFUND });
  });

  test("the same amount from anybody else IS an overpayment, so the flag is the whole difference", () => {
    const s = owedByPayer([share], [planPaid(), refund({ facilitator: false })], "2026-10-20");
    assert.equal(s.lines[0].overpaidCents, REFUND);
    assert.equal(s.lines[0].state, "overpaid");
    assert.deepEqual(s.facilitator, { count: 0, cents: 0 });
  });
});

describe("the facilitator's refund on a claim the plan has not paid", () => {
  test("it does not pay the plan: the plan still owes its share, and is not one that has paid before", () => {
    const s = owedByPayer([share], [refund()], "2026-10-20");
    assert.equal(s.lines[0].outstandingCents, PLAN);
    assert.equal(s.lines[0].receivedCents, 0);
    assert.equal(s.lines[0].state, "waiting");
    assert.equal(s.outstandingCents, PLAN);
  });
});

describe("which payments are the facilitator's figure", () => {
  test("one tied to no claim stays with the payments tied to none, and is not counted here", () => {
    const s = owedByPayer([share], [refund({ matched: false, claimId: null, cause: "no_claim_yet" })], "2026-10-20");
    assert.equal(s.unattached.count, 1);
    assert.deepEqual(s.facilitator, { count: 0, cents: 0 });
  });

  test("one tied to a claim this period does not bill is still the facilitator's, and is not 'outside'", () => {
    const s = owedByPayer([share], [refund({ claimId: "older" })], "2026-10-20");
    assert.deepEqual(s.facilitator, { count: 1, cents: REFUND });
    assert.deepEqual(s.outside, { count: 0, cents: 0 });
  });

  test("its take-back nets in the figure and settles nothing either", () => {
    const s = owedByPayer([share], [planPaid(), refund(), refund({ cents: -REFUND, receivedOn: "2026-10-09" })], "2026-10-20");
    assert.deepEqual(s.facilitator, { count: 2, cents: 0 });
    assert.equal(s.lines[0].outstandingCents, 0);
    assert.equal(s.lines[0].overpaidCents, 0);
  });
});
