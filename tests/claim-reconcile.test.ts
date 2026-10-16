import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconcileClaim, reconcileFill, groupMeaning, RECONCILE_TOLERANCE_CENTS, type Leg } from "../src/lib/claim-reconcile";

const cas = (groupCode: string, reasonCode: string, amountCents: number) => ({ groupCode, reasonCode, amountCents });

describe("one payer: did we get what PioneerRx expected", () => {
  test("the ordinary claim — contract written off, patient share left, expected amount paid", () => {
    /*
     * A $100 charge. The plan writes off $30 under contract, leaves $10 to the patient, sends $60.
     * PioneerRx expected $60 because it knows the contract. Nothing is wrong with this claim, and an
     * earlier version of this code called it "overpaid" by subtracting the contractual write-off
     * from a figure that already contained it.
     */
    const r = reconcileClaim({
      expectedCents: 6_000,
      chargedCents: 10_000,
      paidCents: 6_000,
      adjustments: [cas("CO", "45", 3_000), cas("PR", "2", 1_000)],
    });
    assert.equal(r.state, "reconciled");
    assert.equal(r.shortfallCents, 0);
    assert.equal(r.revenueAdjustmentCents, 0, "a contract working normally adjusts nothing");
    assert.equal(r.payerArithmeticOffCents, 0, "100 − 30 − 10 = 60");
  });

  test("a payer-initiated reduction explains a shortfall and reduces revenue", () => {
    const r = reconcileClaim({
      expectedCents: 6_000,
      chargedCents: 10_000,
      paidCents: 5_500,
      adjustments: [cas("CO", "45", 3_000), cas("PR", "2", 1_000), cas("PI", "B7", 500)],
    });
    assert.equal(r.state, "short_explained");
    assert.equal(r.shortfallCents, 500);
    assert.equal(r.explainedCents, 500);
    assert.equal(r.unexplainedCents, 0);
    assert.equal(r.revenueAdjustmentCents, 500);
  });

  test("short with nothing to explain it is the only state needing a person", () => {
    const r = reconcileClaim({ expectedCents: 6_000, chargedCents: 10_000, paidCents: 5_500, adjustments: [cas("CO", "45", 4_500)] });
    assert.equal(r.state, "unexplained");
    assert.equal(r.unexplainedCents, 500);
    assert.equal(r.revenueAdjustmentCents, 0, "nobody has said this money is not owed");
  });

  test("a contractual write-off can never explain a shortfall", () => {
    // The trap: CO is already inside the expected figure. Letting it explain would make every claim
    // reconcile no matter how short it came.
    const r = reconcileClaim({ expectedCents: 6_000, paidCents: 4_000, adjustments: [cas("CO", "45", 9_000)] });
    assert.equal(r.state, "unexplained");
    assert.equal(r.unexplainedCents, 2_000);
  });

  test("the plan charging the patient more than we did explains the gap", () => {
    /*
     * We took $10 at the counter because that is what PioneerRx said. The plan paid as though the
     * patient owed $15. The $5 gap is explained — the money exists, the patient simply was not asked
     * for it — rather than missing.
     */
    const r = reconcileClaim({
      expectedCents: 6_000,
      paidCents: 5_500,
      adjustments: [cas("PR", "2", 1_500)],
      copayCents: 1_000,
    });
    assert.equal(r.state, "short_explained");
    assert.equal(r.copayDisagreesCents, -500);
    assert.equal(r.explainedCents, 500);
  });

  test("the plan charging the patient LESS than we did does not explain a shortfall", () => {
    // We collected more than the plan expected. That cannot be why less arrived.
    const r = reconcileClaim({
      expectedCents: 6_000,
      paidCents: 5_500,
      adjustments: [cas("PR", "2", 500)],
      copayCents: 1_000,
    });
    assert.equal(r.copayDisagreesCents, 500);
    assert.equal(r.state, "unexplained");
    assert.equal(r.unexplainedCents, 500);
  });

  test("explanation is capped at the shortfall, never more", () => {
    // A $2 shortfall with a $5 payer reduction explains $2, not $5, or revenue would be cut twice.
    const r = reconcileClaim({ expectedCents: 6_000, paidCents: 5_800, adjustments: [cas("PI", "B7", 500)] });
    assert.equal(r.shortfallCents, 200);
    assert.equal(r.explainedCents, 200);
    assert.equal(r.revenueAdjustmentCents, 200);
  });

  test("more than expected is overpaid, and adjusts nothing", () => {
    const r = reconcileClaim({ expectedCents: 5_000, paidCents: 5_500, adjustments: [] });
    assert.equal(r.state, "overpaid");
    assert.equal(r.shortfallCents, -500);
    assert.equal(r.revenueAdjustmentCents, 0);
  });

  test("no remittance yet is awaiting, not short", () => {
    const r = reconcileClaim({ expectedCents: 5_000, paidCents: null, adjustments: [] });
    assert.equal(r.state, "awaiting");
    assert.equal(r.revenueAdjustmentCents, 0);
    assert.equal(r.payerArithmeticOffCents, null);
  });

  test("a cent or two is rounding, not a finding", () => {
    for (const off of [0, 1, 2, -1, -2]) {
      assert.equal(reconcileClaim({ expectedCents: 5_000, paidCents: 5_000 - off, adjustments: [] }).state, "reconciled");
    }
    assert.equal(
      reconcileClaim({ expectedCents: 5_000, paidCents: 5_000 - (RECONCILE_TOLERANCE_CENTS + 1), adjustments: [] }).state,
      "unexplained",
    );
  });

  test("the payer's own arithmetic is checked, and reported apart from the money", () => {
    // Charge 100, adjustments 35, paid 60 — the file does not add up. That is a reading fault, not a
    // shortfall, and it must never be reported as one.
    const r = reconcileClaim({
      expectedCents: 6_000,
      chargedCents: 10_000,
      paidCents: 6_000,
      adjustments: [cas("CO", "45", 2_500), cas("PR", "2", 1_000)],
    });
    assert.equal(r.state, "reconciled", "the money is right even though the file does not balance");
    assert.equal(r.payerArithmeticOffCents, 500);
  });

  test("several adjustments in one group are added, not just the first", () => {
    // A CAS segment carries up to six triplets; reading one is the standard way this is got wrong.
    const r = reconcileClaim({
      expectedCents: 6_000,
      chargedCents: 10_000,
      paidCents: 6_000,
      adjustments: [cas("CO", "45", 2_000), cas("CO", "131", 1_000), cas("PR", "3", 1_000)],
    });
    assert.equal(r.contractualCents, 3_000);
    assert.equal(r.payerArithmeticOffCents, 0);
  });

  test("an unknown group is kept as printed and can explain a shortfall", () => {
    const r = reconcileClaim({ expectedCents: 6_000, paidCents: 5_700, adjustments: [cas("ZZ", "99", 300)] });
    assert.equal(r.otherCents, 300);
    assert.equal(r.state, "short_explained");
    assert.equal(groupMeaning("ZZ").label, "ZZ");
  });

  test("a contractual write-off is not described as costing us", () => {
    assert.equal(groupMeaning("CO").costsUs, false, "it is already inside what PioneerRx expected");
    assert.equal(groupMeaning("PR").costsUs, false);
    assert.equal(groupMeaning("PI").costsUs, true);
  });
});

describe("the copay cross-check", () => {
  test("agreement is silence", () => {
    const r = reconcileClaim({ expectedCents: 6_000, paidCents: 6_000, adjustments: [cas("PR", "3", 1_000)], copayCents: 1_000 });
    assert.equal(r.copayDisagreesCents, 0);
  });

  test("a remittance naming no adjustments has not disagreed", () => {
    const r = reconcileClaim({ expectedCents: 6_000, paidCents: 6_000, adjustments: [], copayCents: 1_000 });
    assert.equal(r.copayDisagreesCents, null);
  });

  test("an unknown copay asks nothing", () => {
    const r = reconcileClaim({ expectedCents: 6_000, paidCents: 6_000, adjustments: [cas("PR", "3", 1_000)] });
    assert.equal(r.copayDisagreesCents, null);
  });
});

describe("two payers on one fill", () => {
  /*
   * The worked example, and the one that catches the double-count.
   *
   * A $100 fill. The primary pays $60, writes off $30, leaves $10 to the patient. The secondary is
   * billed for exactly that $10 and pays $8, leaving $2. The patient hands over $2.
   *
   * Received $68 from plans and $2 from the patient.
   */
  const primary = (): Leg => ({
    payer: "Primary Plan",
    expectedCents: 6_000,
    chargedCents: 10_000,
    paidCents: 6_000,
    adjustments: [cas("CO", "45", 3_000), cas("PR", "2", 1_000)],
  });
  const secondary = (paid: number | null): Leg => ({
    payer: "Secondary Plan",
    expectedCents: 800,
    chargedCents: 1_000,
    paidCents: paid,
    adjustments: paid === null ? [] : [cas("PR", "3", 200)],
  });

  test("both in: the patient owed $2, not $12", () => {
    const f = reconcileFill([primary(), secondary(800)]);
    assert.equal(f.state, "reconciled");
    assert.equal(f.paidCents, 6_800);
    assert.equal(f.patientShareCents, 200, "the last payer's share, not the sum of both legs");
    assert.equal(f.coveredByAnotherPayerCents, 1_000, "the primary's $10 was picked up by the secondary");
    assert.equal(f.stillOwedCents, 0);
    assert.equal(f.revenueAdjustmentCents, 0);
  });

  test("secondary silent: the $10 is owed, not collected and not written off", () => {
    /*
     * The distinction the owner asked for. With the secondary yet to remit, the primary's $10
     * patient share is a receivable from that secondary. Treating it as collected books money that
     * has not arrived; treating it as written off gives up on money nobody has refused.
     */
    const f = reconcileFill([primary(), secondary(null)]);
    assert.equal(f.state, "awaiting");
    assert.equal(f.paidCents, 6_000);
    assert.equal(f.stillOwedCents, 1_800, "the secondary's $8 leg plus the $10 handed to it");
    assert.equal(f.writtenOffCents, 0, "nothing has been written off");
    assert.equal(f.coveredByAnotherPayerCents, 0, "nobody has covered it yet");
    assert.ok(f.says.includes("Secondary Plan"), "says who is being waited on");
  });

  test("money owed and money written off are never the same figure", () => {
    const short: Leg = {
      payer: "Secondary Plan",
      expectedCents: 800,
      paidCents: 500,
      adjustments: [cas("PI", "B7", 300)],
    };
    const f = reconcileFill([primary(), short]);
    assert.equal(f.state, "short_explained");
    assert.equal(f.writtenOffCents, 300, "the plan said it was not paying it");
    assert.equal(f.stillOwedCents, 0, "so it is not owed");
    assert.equal(f.revenueAdjustmentCents, 300);
  });

  test("an unexplained leg outranks everything and is reported as owed", () => {
    const bad: Leg = { payer: "Secondary Plan", expectedCents: 800, paidCents: 500, adjustments: [] };
    const f = reconcileFill([primary(), bad]);
    assert.equal(f.state, "unexplained");
    assert.equal(f.stillOwedCents, 300);
    assert.equal(f.writtenOffCents, 0);
    assert.ok(f.says.includes("$3.00"));
  });

  test("three payers: only the last one's share is the patient's", () => {
    const legs: Leg[] = [
      { payer: "A", expectedCents: 5_000, paidCents: 5_000, adjustments: [cas("PR", "2", 2_000)] },
      { payer: "B", expectedCents: 1_500, paidCents: 1_500, adjustments: [cas("PR", "2", 500)] },
      { payer: "C", expectedCents: 400, paidCents: 400, adjustments: [cas("PR", "3", 100)] },
    ];
    const f = reconcileFill(legs);
    assert.equal(f.state, "reconciled");
    assert.equal(f.patientShareCents, 100);
    assert.equal(f.coveredByAnotherPayerCents, 2_500, "A's and B's shares were both handed on");
    assert.equal(f.paidCents, 6_900);
  });

  test("a single-payer fill works through the same path", () => {
    const f = reconcileFill([{ payer: "Only Plan", expectedCents: 5_000, paidCents: 5_000, adjustments: [cas("PR", "3", 1_000)] }]);
    assert.equal(f.state, "reconciled");
    assert.equal(f.patientShareCents, 1_000);
    assert.equal(f.coveredByAnotherPayerCents, 0);
  });

  test("an overpaid leg surfaces rather than netting away against a good one", () => {
    const over: Leg = { payer: "Secondary Plan", expectedCents: 800, paidCents: 1_200, adjustments: [] };
    const f = reconcileFill([primary(), over]);
    assert.equal(f.state, "overpaid");
    assert.ok(f.says.includes("clawed back"));
  });

  test("a fill nobody has remitted on is owed in full", () => {
    const f = reconcileFill([
      { payer: "Primary Plan", expectedCents: 6_000, paidCents: null, adjustments: [] },
      { payer: "Secondary Plan", expectedCents: 800, paidCents: null, adjustments: [] },
    ]);
    assert.equal(f.state, "awaiting");
    assert.equal(f.stillOwedCents, 6_800);
    assert.equal(f.paidCents, 0);
  });
});
