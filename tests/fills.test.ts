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

  test("payers remitting more than any row said the drug cost is flagged, not asserted", () => {
    /*
     * Two rows each paying $90 on a $100 drug. Whatever these are — two primaries, a rebill read as
     * a coordination — they are not one chain, and the patient's share cannot be worked out from
     * them. It is floored at nothing and said to be uncertain rather than invented.
     */
    const [f] = groupIntoFills([
      claim({ bin: "610011", remitCents: 9_000, copayCents: 1_000 }),
      claim({ bin: "610502", remitCents: 9_000, copayCents: 1_000 }),
    ]);
    assert.equal(f.patientShareUncertain, true);
    assert.equal(f.patientPaidCents, 0);
  });

  test("a single-payer fill is unchanged by any of this", () => {
    const [f] = groupIntoFills([claim({ remitCents: 1_283, copayCents: 0, acquisitionCents: 1_080 })]);
    assert.equal(f.coordinated, false);
    assert.equal(f.revenueCents, 1_283);
    assert.equal(f.marginCents, 203);
  });

  test("a row on its own would have looked like a loss, and that is counted and named", () => {
    /*
     * The real Synthroid again, from the other end. The plan's row carries the whole bottle against
     * nothing at all — $0.00 paid, $0.00 assessed, $128.68 of drug — and read on its own it is a
     * $128.68 loss. The money came in on the card's row, which carries no cost. One bottle, and the
     * loss is invented by reading the two rows as two claims.
     */
    const fills = groupIntoFills([
      claim({ bin: "610455", payerLabel: "Blue Cross Blue Shield", remitCents: 0, patientTotalCents: 0, acquisitionCents: 12_868 }),
      claim({ bin: "601341", payerLabel: "Change Healthcare", remitCents: 4_625, patientTotalCents: 11_557, acquisitionCents: 0 }),
    ]);
    assert.equal(fills[0].revenueCents, 16_182);
    assert.equal(fills[0].marginCents, 16_182 - 12_868);
    assert.ok(fills[0].marginCents! > 0, "the fill made money once both rows are one bottle");
    const e = coordinationEffect(fills);
    assert.equal(e.coordinatedFills, 1);
    assert.equal(e.falseLosses, 1);
    assert.equal(e.falseLossCents, 12_868, "$128.68 of loss that was never real");
  });

  test("counting money the report did not is a reading error, and is named as one", () => {
    /*
     * The check that can catch a mis-read column from the inside.
     *
     * Column positions in the daily report are worked out by counting. A report whose columns shift
     * by one gives figures that are each individually plausible and collectively wrong, and nothing
     * inside our own arithmetic can notice. PioneerRx computes its own gross profit from the same
     * row, so where this site holds *more* than the report did and nothing arrived later to explain
     * it, that cannot be a timing difference: a column is not where this reader thinks it is.
     */
    const [wrong] = groupIntoFills([
      claim({ remitCents: 20_000, copayCents: 0, patientTotalCents: 0, acquisitionCents: 12_868, grossProfitCents: 3_315 }),
    ]);
    assert.equal(wrong.marginCents, 20_000 - 12_868);
    assert.equal(wrong.reportedMarginCents, 3_315);
    assert.equal(wrong.agreesWithReport, false, "the site and the report cannot both be right");
    assert.equal(wrong.awaitedCents, null, "and nothing here is owed to the pharmacy");

    const [right] = groupIntoFills([
      claim({ remitCents: 4_626, copayCents: 0, patientTotalCents: 11_557, acquisitionCents: 12_868, grossProfitCents: 3_315 }),
    ]);
    assert.equal(right.marginCents, 3_315);
    assert.equal(right.agreesWithReport, true);
    assert.equal(right.awaitedCents, null);
  });

  test("the report ahead of the bank is a receivable, not a bug, and it closes when the money lands", () => {
    /*
     * Rx 332359, a real fill. PioneerRx books the facilitator's share at adjudication, because the
     * plan's response says what it will be; the money itself arrives weeks later from the Medicare
     * Transaction Facilitator. So the report reads $22.52 made and this site reads a $123.66 loss,
     * and the whole of the difference is the $146.18 still to come.
     *
     * Calling that a reading error put a red banner across the claims screen for thirty-two fills
     * that were simply waiting to be paid. It is the opposite of a bug: it is a list of money owed.
     */
    const [waiting] = groupIntoFills([
      claim({ rxNumber: "332359", fillNumber: 1, dateFilled: "2026-09-05", remitCents: 20_457, copayCents: 0, patientTotalCents: 0, acquisitionCents: 32_823, grossProfitCents: 2_252 }),
    ]);
    assert.equal(waiting.marginCents, -12_366);
    assert.equal(waiting.awaitedCents, 14_618, "$146.18 the report counted and the pharmacy has not got");
    assert.equal(waiting.agreesWithReport, true, "nothing here says a column was mis-read");

    const [paid] = groupIntoFills(
      [claim({ rxNumber: "332359", fillNumber: 1, dateFilled: "2026-09-05", ndc11: "81968004560", remitCents: 20_457, copayCents: 0, patientTotalCents: 0, acquisitionCents: 32_823, grossProfitCents: 2_252 })],
      [{ rxNumber: "332359", fillNumber: 1, dateFilled: "2026-09-05", ndc11: "81968004560", source: "mtf", payer: "Medicare Transaction Facilitator", amountCents: 14_618 }],
    );
    assert.equal(paid.marginCents, 2_252, "which is exactly what the report said all along");
    assert.equal(paid.awaitedCents, null, "nothing outstanding once it is matched to the fill");
    assert.equal(paid.agreesWithReport, true);
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
      claim({ rxNumber: "305766", fillNumber: 2, dateFilled: "2026-08-31", ndc11: "00074662490", itemName: "SYNTHROID 100 MCG TABLET", bin: "610455", groupNumber: "MT207", payerLabel: "Blue Cross Blue Shield", quantityThousandths: 90_000, remitCents: 0, copayCents: 0, patientTotalCents: 0, acquisitionCents: 12_868, grossProfitCents: -12_868 }),
      claim({ rxNumber: "305766", fillNumber: 2, dateFilled: "2026-08-31", ndc11: "00074662490", itemName: "SYNTHROID 100 MCG TABLET", bin: "601341", groupNumber: "OH9010121", payerLabel: "Change Healthcare", quantityThousandths: 0, remitCents: 4_625, copayCents: 11_557, patientTotalCents: 11_557, acquisitionCents: 0, grossProfitCents: 16_182 }),
    ]);
    assert.equal(f.remitCents, 4_625, "the plan paid nothing; the card paid $46.25");
    assert.equal(f.patientPaidCents, 11_557, "the $161.82 price, less the $46.25 the card paid down");
    assert.equal(f.revenueCents, 16_182);
    assert.equal(f.acquisitionCents, 12_868, "the bottle, from the row that carried it — counted once");
    assert.equal(f.quantityThousandths, 90_000, "ninety tablets, not the card row's zero");
    assert.equal(f.marginCents, 3_314, "$33.14 made, against the $82.43 loss the site was showing");
    assert.equal(f.reportedMarginCents, 3_314, "which is what the report itself printed");
    assert.equal(f.agreesWithReport, true);
    assert.equal(f.awaitedCents, null, "nothing outstanding: this money is already in hand");
  });

  test("the same answer when the plan that paid nothing was never stored", () => {
    /*
     * A plan paying nothing is a rejection to the importer, so the only row held for a fill like
     * this can be the card's. The arithmetic has to survive that, and it does: the card's own copay
     * already has the plan's contribution taken out of it, so remit plus that copay is still the
     * whole of what the pharmacy took.
     */
    const [f] = groupIntoFills([
      claim({ rxNumber: "305766", fillNumber: 2, dateFilled: "2026-08-31", ndc11: "00074662490", bin: "601341", payerLabel: "Change Healthcare", remitCents: 4_625, copayCents: 11_557, patientTotalCents: 11_557, acquisitionCents: 12_868 }),
    ]);
    assert.equal(f.revenueCents, 16_182);
    assert.equal(f.marginCents, 3_314);
  });

  test("an ordinary coordination: each plan pays, and the patient pays what is left", () => {
    // Primary pays $10 and leaves $20; the secondary is billed that $20, pays $15, leaves $5.
    const [f] = groupIntoFills([
      claim({ remitCents: 1_000, copayCents: 2_000, acquisitionCents: 2_000 }),
      claim({ remitCents: 1_500, copayCents: 500, acquisitionCents: 2_000 }),
    ]);
    assert.equal(f.remitCents, 2_500);
    assert.equal(f.patientPaidCents, 500);
    assert.equal(f.revenueCents, 3_000);
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

  test("a chain that closes is not flagged: the residuals are consistent with one price", () => {
    /*
     * The primary establishes $30 and pays $10; the secondary is billed the remaining $20, pays $15
     * and leaves $5. The payers took $25 of a $30 drug, the patient the last $5. Nothing is in
     * doubt here and nothing is flagged — the flag is for rows that cannot be one chain.
     */
    const [f] = groupIntoFills([
      claim({ bin: "610011", remitCents: 1_000, copayCents: 2_000 }),
      claim({ bin: "610502", remitCents: 1_500, copayCents: 500 }),
    ]);
    assert.equal(f.patientShareUncertain, false);
    assert.equal(f.patientPaidCents, 500, "what the last plan left, not both copays added");
    assert.equal(f.revenueCents, 3_000);
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
