import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { groupIntoFills, fillsAtALoss, coordinationEffect, type ClaimRow } from "../src/lib/fills";

/**
 * A prescription billed to a primary plan and then to a secondary is one dispensing, not two.
 *
 * The daily report has a row per transmission. Counted as two claims, the bottle's cost is counted
 * twice, the patient's responsibility is counted twice, and the primary row alone reads as a
 * catastrophic loss. That is what put a real day's claims $459 in the red on the first live file.
 */
const claim = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  id: Math.random().toString(36).slice(2),
  rxNumber: "400010",
  fillNumber: 1,
  dateFilled: "2026-09-04",
  ndc11: "81968004560",
  itemName: "OZEMPIC 1MG PEN",
  bin: "004336",
  pbmName: null,
  payerLabel: "004336 (ADV)",
  quantityThousandths: 30_000,
  remitCents: 60_738,
  copayCents: 0,
  patientTotalCents: null,
  acquisitionCents: 57_676,
  grossProfitCents: null,
  status: "paid",
  ...over,
});

describe("one fill, however many payers priced it", () => {
  test("a primary and a secondary on the same fill are one dispensing", () => {
    const f = groupIntoFills([
      claim({ bin: "610011", remitCents: 1_000, copayCents: 2_000 }),
      claim({ bin: "610502", remitCents: 1_500, copayCents: 500 }),
    ]);
    assert.equal(f.length, 1);
    assert.equal(f[0].coordinated, true);
    assert.equal(f[0].payers.length, 2);
  });

  test("cost is the bottle, counted once, not once per transmission", () => {
    const [f] = groupIntoFills([
      claim({ bin: "610011", remitCents: 1_000, copayCents: 2_000 }),
      claim({ bin: "610502", remitCents: 1_500, copayCents: 500 }),
    ]);
    assert.equal(f.acquisitionCents, 57_676, "the same bottle, whatever it was transmitted against");
    assert.equal(f.quantityThousandths, 30_000, "not sixty thousand");
  });

  test("the patient pays once — the primary's copay is what the secondary is billed", () => {
    /*
     * Primary pays $10 and leaves $20 owing; the secondary is billed that $20, pays $15 and leaves
     * $5. The pharmacy receives $10 + $15 + $5 = $30. Summing the copays would count the $20 the
     * secondary was billed as money the pharmacy was handed, and report $50.
     */
    const [f] = groupIntoFills([
      claim({ bin: "610011", remitCents: 1_000, copayCents: 2_000, acquisitionCents: 2_000 }),
      claim({ bin: "610502", remitCents: 1_500, copayCents: 500, acquisitionCents: 2_000 }),
    ]);
    assert.equal(f.remitCents, 2_500);
    assert.equal(f.patientPaidCents, 500);
    assert.equal(f.revenueCents, 3_000);
    assert.equal(f.marginCents, 1_000);
  });

  test("a single-payer fill is unchanged by any of this", () => {
    const [f] = groupIntoFills([claim({ remitCents: 1_283, copayCents: 0, acquisitionCents: 1_080 })]);
    assert.equal(f.coordinated, false);
    assert.equal(f.revenueCents, 1_283);
    assert.equal(f.marginCents, 203);
  });

  test("the primary alone would have looked like a loss, and that is counted and named", () => {
    // A $576.76 pen: the primary pays $8 and passes the rest on, the secondary pays $590 and
    // leaves the patient $10. Read as two claims, the primary row is a $568.76 loss.
    const fills = groupIntoFills([
      claim({ bin: "610011", remitCents: 800, copayCents: 0, acquisitionCents: 57_676 }),
      claim({ bin: "610502", remitCents: 59_000, copayCents: 1_000, acquisitionCents: 57_676 }),
    ]);
    assert.equal(fills[0].revenueCents, 59_800);
    assert.equal(fills[0].marginCents, 59_800 - 57_676);
    assert.ok(fills[0].marginCents! > 0, "the fill made money once both plans are counted");
    const e = coordinationEffect(fills);
    assert.equal(e.coordinatedFills, 1);
    assert.equal(e.falseLosses, 1);
    assert.equal(e.falseLossCents, 57_676 - 800, "$568.76 of loss that was never real");
  });

  test("the report's own gross profit is used to check ours, and a mismatch is named", () => {
    /*
     * The check that can catch a mis-read column from the inside.
     *
     * Column positions in the daily report are worked out by counting. A report whose columns shift
     * by one gives figures that are each individually plausible and collectively wrong, and nothing
     * inside our own arithmetic can notice. PioneerRx computes its own gross profit from the same
     * row, so when ours and theirs disagree, a column is not where this reader thinks it is.
     */
    const [wrong] = groupIntoFills([
      claim({ remitCents: 4_626, copayCents: 0, patientTotalCents: 0, acquisitionCents: 12_868, grossProfitCents: 3_315 }),
    ]);
    assert.equal(wrong.marginCents, 4_626 - 12_868);
    assert.equal(wrong.reportedMarginCents, 3_315);
    assert.equal(wrong.agreesWithReport, false, "the site and the report cannot both be right");

    const [right] = groupIntoFills([
      claim({ remitCents: 4_626, copayCents: 0, patientTotalCents: 11_557, acquisitionCents: 12_868, grossProfitCents: 3_315 }),
    ]);
    assert.equal(right.marginCents, 3_315);
    assert.equal(right.agreesWithReport, true);
  });

  test("a fill carrying money that arrived later is not checked against a figure printed on the day", () => {
    // The report could not have known about it, so a disagreement there is evidence of nothing.
    const [f] = groupIntoFills(
      [claim({ remitCents: 20_457, copayCents: 0, patientTotalCents: 0, acquisitionCents: 32_823, grossProfitCents: -12_366 })],
      [{ rxNumber: "400010", fillNumber: 1, dateFilled: "2026-09-04", ndc11: "81968004560", source: "mtf", payer: "MTF", amountCents: 14_618 }],
    );
    assert.equal(f.agreesWithReport, null);
  });

  test("a copay card takes money off the copay; the rest does not disappear", () => {
    /*
     * Rx 305766, a real fill, and the one that proved this wrong.
     *
     * Blue Cross paid nothing and left the patient owing $160.57. The copay card then paid $46.26
     * and left the patient owing $115.57. The patient paid that. The pharmacy took $161.83 on a
     * drug that cost $128.68 — $33.14 of margin — and the site called it an $82.43 loss, because it
     * counted the card's $46.26 and nothing else.
     *
     * Two mistakes in one. The patient's residual was read from the "Copay" column, which is zero
     * on a deductible fill, instead of "Total", which is what they were actually left owing. And
     * the residual after the *last* adjudication is what the patient hands over — a card reduces
     * the copay, it does not make the remainder vanish.
     */
    const [f] = groupIntoFills([
      claim({ rxNumber: "305766", fillNumber: 2, dateFilled: "2026-08-31", ndc11: "00074433902", itemName: "SYNTHROID", bin: "610455", payerLabel: "Blue Cross Blue Shield", remitCents: 0, copayCents: 0, patientTotalCents: 16_057, acquisitionCents: 12_868 }),
      claim({ rxNumber: "305766", fillNumber: 2, dateFilled: "2026-08-31", ndc11: "00074433902", itemName: "SYNTHROID", bin: "610020", payerLabel: "Change Healthcare", remitCents: 4_626, copayCents: 0, patientTotalCents: 11_557, acquisitionCents: 12_868 }),
    ]);
    assert.equal(f.remitCents, 4_626, "the plan paid nothing; the card paid $46.26");
    assert.equal(f.patientPaidCents, 11_557, "the patient paid what the card left, not nothing and not both copays");
    assert.equal(f.revenueCents, 16_183);
    assert.equal(f.acquisitionCents, 12_868);
    assert.equal(f.marginCents, 3_315, "$33.15 made, against the $82.43 loss the site was showing");
  });

  test("money that arrives later is added to the fill it belongs to", () => {
    /*
     * A Medicare Transaction Facilitator payment reaches the pharmacy weeks after the claim, names
     * a prescription rather than a claim id, and is real revenue. Held only as what the daily report
     * said on the day, a fill sits on the "dispensed at a loss" list because of a payment that has
     * since arrived.
     */
    const [f] = groupIntoFills(
      [claim({ rxNumber: "332359", fillNumber: 1, dateFilled: "2026-09-05", remitCents: 20_457, copayCents: 0, patientTotalCents: 0, acquisitionCents: 32_823 })],
      [{ rxNumber: "332359", fillNumber: 1, dateFilled: "2026-09-05", ndc11: "81968004560", source: "mtf", payer: "Medicare Transaction Facilitator", amountCents: 14_618 }],
    );
    assert.equal(f.laterPaymentsCents, 14_618);
    assert.equal(f.revenueCents, 20_457 + 14_618);
    assert.equal(f.marginCents, 35_075 - 32_823, "a $123.66 loss becomes $22.52 made once the facilitator payment lands");
    assert.deepEqual(f.laterPayments.map((p) => p.source), ["mtf"]);
  });

  test("where the plans disagree about the patient's share, the figure is flagged not asserted", () => {
    const [f] = groupIntoFills([
      claim({ bin: "610011", remitCents: 1_000, copayCents: 2_000 }),
      claim({ bin: "610502", remitCents: 1_500, copayCents: 500 }),
    ]);
    assert.equal(f.patientShareUncertain, true);
    assert.equal(f.patientPaidCents, 500, "the smallest, which is right whenever each plan reduces what is left");
  });

  test("a reversal that matches nothing held is not a loss", () => {
    /*
     * It reverses a dispensing from before the feed began, whose revenue this site never counted.
     * Subtracting it invents a loss out of a correction to a figure that was never here. Six of
     * them on the first live file came to more than twelve hundred dollars against one BIN.
     */
    const fills = groupIntoFills([
      claim({ rxNumber: "400099", remitCents: -120_425, acquisitionCents: -115_352, unmatchedReversal: true }),
      claim({ rxNumber: "400100", remitCents: 1_283, copayCents: 0, acquisitionCents: 1_080 }),
    ]);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].rxNumber, "400100");
  });

  test("a reversed claim is not revenue either", () => {
    assert.deepEqual(groupIntoFills([claim({ status: "reversed" })]), []);
  });

  test("nothing is claimed where the report carried no acquisition cost", () => {
    const [f] = groupIntoFills([claim({ acquisitionCents: null })]);
    assert.equal(f.acquisitionCents, null);
    assert.equal(f.marginCents, null);
    assert.deepEqual(fillsAtALoss([f]), [], "no cost is not a loss");
  });

  test("different fills of the same prescription stay apart", () => {
    const f = groupIntoFills([claim({ fillNumber: 0 }), claim({ fillNumber: 1 })]);
    assert.equal(f.length, 2);
  });

  test("the same prescription on a different day is a different fill", () => {
    const f = groupIntoFills([claim({ dateFilled: "2026-09-04" }), claim({ dateFilled: "2026-09-05" })]);
    assert.equal(f.length, 2);
  });
});
