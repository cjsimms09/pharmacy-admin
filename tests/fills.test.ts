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

  test("the patient's residual sits on one row, and is taken from that row", () => {
    /*
     * Rx 336765, a real coordinated fill and the one that disproved this module's founding
     * assumption. OptumRx paid $461.89 on the dispensing row; a second plan paid $100 and left the
     * patient owing $733.52. The pharmacy took $1,295.41 on a pen costing $1,302.73 — a $7.32 loss,
     * which is what PioneerRx says too.
     *
     * The old arithmetic worked the patient's share out backwards, subtracting every remittance from
     * a price no row states. That gave $271.63 and a $469.21 loss. It was invented from one example
     * and nothing could contradict it until this fill arrived.
     */
    const [f] = groupIntoFills([
      claim({ rxNumber: "336765", bin: "019158", payerLabel: "CNRX", remitCents: 10_000, copayCents: 73_352, patientTotalCents: 73_352, acquisitionCents: 0, quantityThousandths: 0, grossProfitCents: 83_352 }),
      claim({ rxNumber: "336765", bin: "610011", payerLabel: "OptumRx", remitCents: 46_189, copayCents: 0, patientTotalCents: 0, acquisitionCents: 130_273, quantityThousandths: 2_000, grossProfitCents: -84_084 }),
    ]);
    assert.equal(f.remitCents, 56_189, "both plans' money");
    assert.equal(f.patientPaidCents, 73_352, "what the one row leaving a residual actually left");
    assert.equal(f.revenueCents, 129_541);
    assert.equal(f.acquisitionCents, 130_273, "the pen, from the row that dispensed it");
    assert.equal(f.marginCents, -732);
    assert.equal(f.agreesWithReport, true, "and the report says the same");
  });

  test("a fill the plans covered outright is not a puzzle: the patient paid nothing", () => {
    /*
     * Rx 333968, a real fill. CVS paid $279.77 and a copay card $69.94 towards a $472.01 drug, and
     * every row reads $0.00 still owing. That is not ambiguity — it is a patient who paid nothing.
     *
     * With no residual reported anywhere, "the largest price any row established" collapses to the
     * largest single remittance, and the two payers have between them sent more than that. Read as
     * a contradiction it is indistinguishable from two primaries, and the site put "patient share
     * unclear" on ordinary coordinated claims all day. A residual is only worked out where one was
     * actually reported.
     */
    const [f] = groupIntoFills([
      claim({ rxNumber: "333968", bin: "004336", payerLabel: "CVS Caremark", remitCents: 27_977, copayCents: 0, patientTotalCents: 0, acquisitionCents: 47_201 }),
      claim({ rxNumber: "333968", bin: "024284", payerLabel: "ACR", remitCents: 6_994, copayCents: 0, patientTotalCents: 0, acquisitionCents: 0 }),
    ]);
    assert.equal(f.patientShareUncertain, false, "nothing about this is unclear");
    assert.equal(f.patientPaidCents, 0);
    assert.equal(f.revenueCents, 34_971, "what the two payers actually sent");
    assert.equal(f.marginCents, 34_971 - 47_201, "a real loss, and the report agrees it is one");
  });

  test("two rows both leaving the patient owing is flagged, because it may be one residual twice", () => {
    /*
     * The one assumption the plain arithmetic rests on: the report puts the patient's residual on
     * the single row where it actually stays with them. That holds on every one of 1,199 real fills.
     *
     * If it ever stops holding, adding the rows would invent revenue — so the case is named rather
     * than assumed away. The figure is still given, because it is the best available; it is the
     * certainty that is withheld.
     */
    const [f] = groupIntoFills([
      claim({ bin: "610011", remitCents: 9_000, copayCents: 1_000, patientTotalCents: 1_000 }),
      claim({ bin: "610502", remitCents: 9_000, copayCents: 1_000, patientTotalCents: 1_000 }),
    ]);
    assert.equal(f.patientShareUncertain, true);
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

  test("the identity: what we make, less what arrived later, is what the report made of it", () => {
    /*
     * ── The check that would have caught every mistake this file has ever had ──
     *
     * PioneerRx prints GrossProfit = Amount + Total − Acq. Inv. Cost for every row. Added over the
     * live rows of one dispensing, that is the report's answer for that bottle. Ours is revenue less
     * the cost taken once. They are the same arithmetic over the same numbers, so they must agree to
     * the cent — and the only legitimate difference is money the report could not have known about,
     * which is what arrives afterwards from a facilitator or a credit memo.
     *
     *     ourMargin − laterMoney = reportedMargin
     *
     * Every error here was a rule inferred from one example that nothing independent could
     * contradict: the smallest copay, the patient's residual taken from the wrong column, a gap
     * called a facilitator payment, a reversal left unpaired so one bottle counted twice. This
     * contradicts all of them, on every fill, every day.
     */
    const [right] = groupIntoFills([
      claim({ remitCents: 4_626, copayCents: 0, patientTotalCents: 11_557, acquisitionCents: 12_868, grossProfitCents: 3_315 }),
    ]);
    assert.equal(right.marginCents, 3_315);
    assert.equal(right.agreesWithReport, true);
    assert.equal(right.unreconciledCents, null);
  });

  test("a fill that fails the identity is named, whichever way it fails", () => {
    /*
     * Both directions are the same fact — a column is not where this reader thinks it is — and
     * treating them as two different stories is how a queue of receivables that were never coming
     * got built out of ordinary reading errors.
     */
    const [over] = groupIntoFills([
      claim({ remitCents: 20_000, copayCents: 0, patientTotalCents: 0, acquisitionCents: 12_868, grossProfitCents: 3_315 }),
    ]);
    assert.equal(over.marginCents, 20_000 - 12_868);
    assert.equal(over.agreesWithReport, false, "we cannot be holding money the report never counted");
    assert.equal(over.unreconciledCents, 3_315 - (20_000 - 12_868));

    /*
     * Rx 316890, from the report as it used to be printed: $7.85 in on a $13.90 drug, which is a
     * $6.05 loss, against a gross profit column reading −$0.49 because it was quietly carrying an
     * estimated rebate. The identity puts the $5.56 on screen instead of leaving it to be found in
     * a PDF weeks later.
     */
    const [under] = groupIntoFills([
      claim({ rxNumber: "316890", remitCents: 785, copayCents: 0, patientTotalCents: 0, acquisitionCents: 1_390, grossProfitCents: -49 }),
    ]);
    assert.equal(under.marginCents, -605);
    assert.equal(under.agreesWithReport, false);
    assert.equal(under.unreconciledCents, 556);
  });

  test("money that arrived later is the one difference the identity allows", () => {
    /*
     * Rx 332359. The report, now that its gross profit column is only gross profit, makes this a
     * $123.66 loss — and so do we, exactly. The $146.18 the plan promised sits in its own column,
     * and when the facilitator pays it the fill becomes $22.52 while the identity still holds,
     * because the payment is subtracted before the comparison.
     */
    const row = {
      rxNumber: "332359",
      fillNumber: 1,
      dateFilled: "2026-09-05",
      ndc11: "00597015290",
      remitCents: 20_457,
      copayCents: 0,
      patientTotalCents: 0,
      acquisitionCents: 32_823,
      grossProfitCents: -12_366,
      expectedFacilitatorCents: 14_618,
    };

    const [waiting] = groupIntoFills([claim(row)]);
    assert.equal(waiting.marginCents, -12_366);
    assert.equal(waiting.agreesWithReport, true, "the books balance even while the money is outstanding");
    assert.equal(waiting.facilitatorOutstandingCents, 14_618);

    const [paid] = groupIntoFills(
      [claim(row)],
      [{ rxNumber: "332359", fillNumber: 1, dateFilled: "2026-09-05", ndc11: "00597015290", source: "mtf", payer: "MTF", amountCents: 14_618 }],
    );
    assert.equal(paid.marginCents, 2_252, "the script is worth $22.52 once the money lands");
    assert.equal(paid.agreesWithReport, true, "and the identity still holds, because the payment is taken out of both sides");
    assert.equal(paid.unreconciledCents, null);
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
    assert.equal(f.unreconciledCents, null, "nothing outstanding: this money is already in hand");
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

  test("the bottle is counted from the row that dispensed it, and the others carry zero", () => {
    /*
     * This module was built believing every row of a coordinated fill repeats the acquisition cost,
     * so it took the largest. It does not: across 1,199 real fills, not one has two live rows
     * carrying a cost. The coordination row carries zero, and adding is both simpler and right.
     */
    const [f] = groupIntoFills([
      claim({ bin: "004336", remitCents: 27_977, copayCents: 0, patientTotalCents: 0, acquisitionCents: 47_201, quantityThousandths: 30_000 }),
      claim({ bin: "024284", remitCents: 6_994, copayCents: 0, patientTotalCents: 0, acquisitionCents: 0, quantityThousandths: 0 }),
    ]);
    assert.equal(f.acquisitionCents, 47_201, "once, from the dispensing row");
    assert.equal(f.quantityThousandths, 30_000, "and the quantity likewise, not the card row's zero");
  });

  test("a cost repeated on both rows is still counted once", () => {
    /*
     * The guard for the belief this was built on. It never fires on the real file — but if the
     * report ever does start repeating the cost of the bottle, the answer has to degrade to right
     * rather than to double, which was the original bug and cost a real day $459.
     */
    const [f] = groupIntoFills([
      claim({ bin: "610455", remitCents: 800, copayCents: 0, patientTotalCents: 0, acquisitionCents: 57_676 }),
      claim({ bin: "610502", remitCents: 59_000, copayCents: 1_000, patientTotalCents: 1_000, acquisitionCents: 57_676 }),
    ]);
    assert.equal(f.acquisitionCents, 57_676, "one bottle, not two");
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

  test("an ordinary coordination is not flagged: only one row leaves a residual", () => {
    // Rx 336765 again, which is the shape every real coordinated fill has.
    const [f] = groupIntoFills([
      claim({ bin: "019158", remitCents: 10_000, copayCents: 73_352, patientTotalCents: 73_352, acquisitionCents: 0 }),
      claim({ bin: "610011", remitCents: 46_189, copayCents: 0, patientTotalCents: 0, acquisitionCents: 130_273 }),
    ]);
    assert.equal(f.patientShareUncertain, false, "nothing here is in doubt");
    assert.equal(f.patientPaidCents, 73_352);
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

describe("money a plan promised and has not sent", () => {
  test("the promise is carried on the fill, and what is still owed falls as payments land", () => {
    /*
     * Rx 332359, a real fill. The report's own column says $146.18 of facilitator money — the plan
     * named it when it adjudicated the claim — and the pharmacy took $204.57 on a $328.23 drug.
     *
     * Read without the promise that is a $123.66 loss and looks exactly like a rate worth arguing
     * over. It is neither: it is a bill nobody has paid yet.
     */
    const row = {
      rxNumber: "332359",
      fillNumber: 1,
      dateFilled: "2026-09-05",
      ndc11: "00597015290",
      remitCents: 20_457,
      copayCents: 0,
      patientTotalCents: 0,
      acquisitionCents: 32_823,
      expectedFacilitatorCents: 14_618,
    };

    const [waiting] = groupIntoFills([claim(row)]);
    assert.equal(waiting.expectedFacilitatorCents, 14_618);
    assert.equal(waiting.facilitatorOutstandingCents, 14_618, "none of it has arrived");
    assert.equal(waiting.marginCents, -12_366, "and until it does, the fill is genuinely in the red");

    const [paid] = groupIntoFills(
      [claim(row)],
      [{ rxNumber: "332359", fillNumber: 1, dateFilled: "2026-09-05", ndc11: "00597015290", source: "mtf", payer: "MTF", amountCents: 14_618 }],
    );
    assert.equal(paid.facilitatorOutstandingCents, 0, "nothing outstanding once it is matched");
    assert.equal(paid.marginCents, 2_252, "and the fill made $22.52 all along");
  });

  test("one promise on one bottle, however many rows carry it", () => {
    /*
     * A coordinated fill can print the same promised payment on both of its transmissions. It is
     * one manufacturer share on one dispensing — adding them would invent money, in the direction
     * that flatters the pharmacy, on a figure somebody is going to chase a payer over.
     */
    const [f] = groupIntoFills([
      claim({ bin: "610097", remitCents: 10_000, copayCents: 0, patientTotalCents: 0, acquisitionCents: 30_000, expectedFacilitatorCents: 14_618 }),
      claim({ bin: "610455", remitCents: 5_000, copayCents: 0, patientTotalCents: 0, acquisitionCents: 0, expectedFacilitatorCents: 14_618 }),
    ]);
    assert.equal(f.expectedFacilitatorCents, 14_618);
  });

  test("a report that promised nothing leaves nothing outstanding", () => {
    const [f] = groupIntoFills([claim({ remitCents: 785, copayCents: 0, patientTotalCents: 0, acquisitionCents: 1_390 })]);
    assert.equal(f.expectedFacilitatorCents, null, "no column, so no claim either way");
    assert.equal(f.facilitatorOutstandingCents, null);
  });

  test("a promise of zero is a fact, and it is not money owed", () => {
    const [f] = groupIntoFills([claim({ remitCents: 785, copayCents: 0, patientTotalCents: 0, acquisitionCents: 1_390, expectedFacilitatorCents: 0 })]);
    assert.equal(f.expectedFacilitatorCents, 0);
    assert.equal(f.facilitatorOutstandingCents, 0);
  });
});

/**
 * Accounts receivable: sold, counted, and not collected.
 *
 * The pharmacy's own report carries five of these in its first six days, and setting them aside is
 * exactly why this site's gross profit came to $2,849.76 more than PioneerRx's. The dispensing is
 * ordinary — the drug left the shelf and the acquisition cost is real — so every figure is
 * computed as normal. Only "has the money arrived" differs.
 */
describe("on account", () => {
  test("an account sale is an ordinary dispensing, with its margin computed the usual way", () => {
    // Rx 309233-2 off the live report: nothing from the plan, $1,492.61 on the account, cost
    // $1,152.94. PioneerRx's own gross profit column says $339.67.
    const [f] = groupIntoFills([
      claim({ rxNumber: "309233", fillNumber: 2, onAccount: true, remitCents: 0, copayCents: 149_261, patientTotalCents: 149_261, acquisitionCents: 115_294, grossProfitCents: 33_967 }),
    ]);
    assert.equal(f.marginCents, 33_967, "the margin is revenue less cost, exactly as for any other fill");
    assert.equal(f.agreesWithReport, true);
    assert.equal(f.onAccount, true);
  });

  test("the whole of an account sale's revenue is outstanding, not part of it", () => {
    const [f] = groupIntoFills([
      claim({ onAccount: true, remitCents: 0, copayCents: 149_261, patientTotalCents: 149_261, acquisitionCents: 115_294 }),
    ]);
    assert.equal(f.receivableCents, f.revenueCents);
    assert.equal(f.receivableCents, 149_261);
  });

  test("cost out of the door with nothing billed is reported separately from a debt", () => {
    /*
     * The quieter and worse case. A charge raised and uncollected is a debt somebody can chase; a
     * dispensing with no charge at all is not owed by anyone, appears as a debt nowhere, and reads
     * as a fill that lost its whole acquisition cost — which is what it will keep looking like.
     */
    const [f] = groupIntoFills([
      claim({ rxNumber: "336264", fillNumber: 0, onAccount: true, remitCents: 0, copayCents: 0, patientTotalCents: 0, acquisitionCents: 98_400, grossProfitCents: -98_400 }),
    ]);
    assert.equal(f.unbilledCostCents, 98_400);
    assert.equal(f.receivableCents, 0);
    assert.equal(f.marginCents, -98_400, "still a loss on the day, because it is one until it is billed");
  });

  test("a fill that was collected owes nothing and has nothing unbilled", () => {
    const [f] = groupIntoFills([claim()]);
    assert.equal(f.onAccount, false);
    assert.equal(f.receivableCents, 0);
    assert.equal(f.unbilledCostCents, null);
  });

  test("one leg on account puts the whole fill on account", () => {
    /*
     * A fill coordinated across two payers where one leg went to an account is still a fill whose
     * money is not all in hand. Treating it as collected because the other leg was is the error
     * that hides the balance.
     */
    const [f] = groupIntoFills([
      claim({ bin: "004336", remitCents: 800, copayCents: 0, acquisitionCents: 57_676 }),
      claim({ bin: "024368", remitCents: 0, copayCents: 60_000, patientTotalCents: 60_000, onAccount: true, acquisitionCents: 0 }),
    ]);
    assert.equal(f.coordinated, true);
    assert.equal(f.onAccount, true);
  });

  test("a zero-cost account row is unbilled-unknown, never a confident zero", () => {
    const [f] = groupIntoFills([
      claim({ onAccount: true, remitCents: 0, copayCents: 0, patientTotalCents: 0, acquisitionCents: null }),
    ]);
    assert.equal(f.unbilledCostCents, null, "no cost known means no claim about how much went out unbilled");
  });
});
