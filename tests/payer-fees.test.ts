import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyFee, isSettledPayerFee, sameRemittance, countPayerFees, feesByMonth, feeKey, readFeeKey, lineSays, type FeeDecision, type FeeLine } from "../src/lib/payer-fees";
import { monthlyPL, type PLInputs } from "../src/lib/profit-and-loss";
import { countedTwice } from "../src/lib/books-check";

/*
 * What the payers took off the remittances, counted once.
 *
 * September 2026's net revenue was $145.89 too low because seven EFTs' fees were taken from the payment reports and
 * again from the adjustment report, and October's carried $46.95 of revenue nobody paid because a balance forward was
 * read as a fee. Both had correct arithmetic. The figures here are invented and round, so each total can be added in
 * the head: the thing under test is which record is believed, never the sum.
 */
const line = (over: Partial<FeeLine> = {}): FeeLine => ({ remittance: "EFT-9000001", month: "2026-09", code: "AH", reference: "", takenCents: 10_00, payer: "Example Atlas", ...over });
const paid = (remittance: string, feeCents: number) => ({ remittance, feeCents });
const REPORT = "the Health Mart Atlas payment report";

describe("which provider-level lines are fees", () => {
  test("an origination fee is a fee, however it is signed", () => {
    assert.equal(classifyFee({ code: "AH", takenCents: 10_00 }).fee, true);
    assert.equal(classifyFee({ code: " ah ", takenCents: -5_00 }).fee, true);
  });
  test("a recoupment is a fee and a credit from the payer is not", () => {
    assert.equal(classifyFee({ code: "CS", takenCents: 4_00 }).fee, true);
    const credit = classifyFee({ code: "CS", takenCents: -84 });
    assert.equal(credit.fee, false);
    assert.match(credit.fee ? "" : credit.why, /credit from the payer/);
  });
  test("a balance forward is not a fee, however it is coded, and says what it is", () => {
    for (const l of [{ code: "CS", reference: "balance forward", takenCents: -46_95 }, { code: "FB", reference: "", takenCents: 10_00 }, { code: "AH", reference: "Forwarding Balance", takenCents: 10_00 }]) {
      const k = classifyFee(l);
      assert.equal(k.fee, false, JSON.stringify(l));
      assert.match(k.fee ? "" : k.why, /balance carried to a later remittance/);
    }
  });
  test("a code nobody has explained is held, and the line names the code", () => {
    for (const code of ["WO", "Fee", "L6"]) {
      const k = classifyFee({ code, takenCents: 3_00 });
      assert.equal(k.fee, false, code);
      assert.match(k.fee ? "" : k.why, new RegExp(`"${code.toUpperCase()}" line, whose meaning is not settled`));
    }
  });
  test("only a balance forward is certain: a credit and an unexplained code are left for a person", () => {
    const byRule = (l: Parameters<typeof classifyFee>[0]) => {
      const k = classifyFee(l);
      return k.fee ? null : k.byRule;
    };
    assert.equal(byRule({ code: "CS", reference: "balance forward", takenCents: -46_95 }), true);
    assert.equal(byRule({ code: "FB", takenCents: 1_00 }), true);
    assert.equal(byRule({ code: "CS", takenCents: -84 }), false);
    assert.equal(byRule({ code: "WO", takenCents: 3_00 }), false);
    assert.equal(byRule({ code: "AH", takenCents: 3_00 }), null, "a fee is not in the question");
  });
  test("the predicate the payment-report reader books by is this one", () => {
    assert.equal(isSettledPayerFee("AH", 1_00), true);
    assert.equal(isSettledPayerFee("CS", -1_00), false);
    assert.equal(isSettledPayerFee("CS", 1_00, "balance forward"), false);
  });
});

describe("one remittance under different spellings", () => {
  test("an EFT number with and without its prefix is one remittance", () => {
    assert.equal(sameRemittance("EFT-9000001", "9000001"), true);
    assert.equal(sameRemittance("EFT 9000001", "eft9000001"), true);
  });
  test("a trace that carries the EFT number is the same remittance", () => {
    assert.equal(sameRemittance("TRN*1*9000001", "EFT-9000001"), true);
  });
  test("a short number does not match by accident, and nothing matches nothing", () => {
    assert.equal(sameRemittance("12345", "123456"), false);
    assert.equal(sameRemittance("9000001", "9000002"), false);
    assert.equal(sameRemittance("", ""), false);
    assert.equal(sameRemittance("EFT-", "9000001"), false);
  });
});

describe("one remittance, counted from one record", () => {
  test("a fee the payment report carries and the adjustment report repeats is counted once, from the payment report", () => {
    const r = countPayerFees({ paymentReports: [paid("EFT-9000001", 10_00)], from835: [], fromAdjustmentReport: [line({ remittance: "9000001" })] });
    assert.equal(r.counted.length, 0);
    assert.deepEqual(r.keptOut.map((k) => [k.takenCents, k.alreadyIn, k.from]), [[10_00, REPORT, "the adjustment report"]]);
    assert.equal(r.disagree.length, 0, "the two agree to the cent");
  });
  test("a fee the 835 carries and the adjustment report repeats is counted once, from the 835", () => {
    const r = countPayerFees({ paymentReports: [], from835: [line({ remittance: "TRN*1*9000001" })], fromAdjustmentReport: [line({ remittance: "9000001" })] });
    assert.deepEqual(r.counted.map((l) => l.takenCents), [10_00]);
    assert.deepEqual(r.keptOut.map((k) => [k.alreadyIn, k.from]), [["the 835", "the adjustment report"]]);
  });
  test("a remittance only the adjustment report carries is counted from it", () => {
    const r = countPayerFees({ paymentReports: [paid("EFT-9000002", 5_00)], from835: [], fromAdjustmentReport: [line({ remittance: "EFT-9000003", takenCents: 4_00 })] });
    assert.deepEqual(r.counted.map((l) => [l.remittance, l.takenCents]), [["EFT-9000003", 4_00]]);
  });
  test("whichever of the three records carry one fee, it is on the account exactly once", () => {
    for (let mask = 1; mask < 8; mask++) {
      const r = countPayerFees({
        paymentReports: mask & 1 ? [paid("EFT-9000001", 10_00)] : [],
        from835: mask & 2 ? [line({ remittance: "TRN*1*9000001" })] : [],
        fromAdjustmentReport: mask & 4 ? [line({ remittance: "9000001" })] : [],
      });
      const onTheAccount = (mask & 1 ? 10_00 : 0) + r.counted.reduce((n, l) => n + l.takenCents, 0);
      assert.equal(onTheAccount, 10_00, `records present: ${mask.toString(2).padStart(3, "0")}`);
    }
  });
  test("a balance forward is counted nowhere, and nobody is asked about it", () => {
    const r = countPayerFees({ paymentReports: [], from835: [line({ remittance: "TRN-70000001", month: "2026-10", code: "CS", reference: "balance forward", takenCents: -46_95, payer: "Example Claims Co" })], fromAdjustmentReport: [] });
    assert.equal(r.counted.length, 0);
    assert.equal(r.held.length, 0, "the rule is certain, so there is nothing for him to decide");
    assert.equal(r.notFees.length, 1);
    const oct = feesByMonth(r).get("2026-10")!;
    assert.equal(oct.countedCents, 0);
    assert.equal(oct.heldLines, 0);
    assert.equal(oct.notFeesCents, -46_95);
    assert.equal(oct.notFeesLines, 1);
    assert.match(oct.notFeesSays, /Example Claims Co CS "balance forward" \$46\.95 added to the remittance, on TRN-70000001: a balance carried to a later remittance/);
  });
  test("a credit from the payer is held; it is not netted against the fees beside it", () => {
    const r = countPayerFees({ paymentReports: [], from835: [], fromAdjustmentReport: [line({ remittance: "EFT-9000004", code: "CS", takenCents: 6_00 }), line({ remittance: "EFT-9000005", code: "CS", takenCents: -84 })] });
    const sep = feesByMonth(r).get("2026-09")!;
    assert.equal(sep.countedCents, 6_00);
    assert.equal(sep.heldCents, -84);
    assert.equal(sep.heldLines, 1);
  });
  test("a line that is not a fee, on a remittance a better record covers, is dropped rather than held a second time", () => {
    const r = countPayerFees({ paymentReports: [paid("EFT-9000001", 0)], from835: [], fromAdjustmentReport: [line({ remittance: "9000001", code: "WO", takenCents: 3_00 })] });
    assert.equal(r.held.length, 0);
    assert.equal(r.counted.length, 0);
    assert.equal(r.keptOut.length, 0);
  });
});

describe("two records that disagree", () => {
  test("the better record is counted and the difference is said, not hidden by the match on the number", () => {
    const r = countPayerFees({ paymentReports: [paid("EFT-9000002", 10_00)], from835: [], fromAdjustmentReport: [line({ remittance: "9000002", takenCents: 12_00 })] });
    assert.equal(r.counted.length, 0);
    assert.deepEqual(r.disagree, [{ remittance: "9000002", month: "2026-09", believedFrom: REPORT, believedCents: 10_00, otherFrom: "the adjustment report", otherCents: 12_00 }]);
    assert.match(feesByMonth(r).get("2026-09")!.differ, /9000002: the Health Mart Atlas payment report says \$10\.00 and the adjustment report says \$12\.00/);
  });
  test("a payment report that closed with no fee, against a record that says one was taken, is the same disagreement", () => {
    const r = countPayerFees({ paymentReports: [paid("EFT-9000002", 0)], from835: [], fromAdjustmentReport: [line({ remittance: "9000002", code: "CS", takenCents: 4_00 })] });
    assert.equal(feesByMonth(r).get("2026-09")!.countedCents, 0);
    assert.match(feesByMonth(r).get("2026-09")!.differ, /payment report says \$0\.00 and the adjustment report says \$4\.00/);
  });
  test("records that agree say nothing about a difference", () => {
    const r = countPayerFees({ paymentReports: [paid("EFT-9000001", 11_50)], from835: [], fromAdjustmentReport: [line({ remittance: "9000001", takenCents: 10_00 }), line({ remittance: "9000001", code: "CS", reference: "x", takenCents: 1_50 })] });
    assert.equal(feesByMonth(r).get("2026-09")!.differ, "");
  });
});

describe("by month", () => {
  test("each fee lands in its remittance's own month", () => {
    const r = countPayerFees({ paymentReports: [], from835: [], fromAdjustmentReport: [line({ remittance: "EFT-9000006", month: "2026-08", takenCents: 74 }), line({ remittance: "EFT-9000007", month: "2026-09", takenCents: 2_00 })] });
    const by = feesByMonth(r);
    assert.equal(by.get("2026-08")!.countedCents, 74);
    assert.equal(by.get("2026-09")!.countedCents, 2_00);
  });
  test("held lines are said three at a time, with the rest counted", () => {
    const held = [1, 2, 3, 4, 5].map((n) => line({ remittance: `EFT-90001${n}0`, code: "WO", takenCents: n * 1_00 }));
    const m = feesByMonth(countPayerFees({ paymentReports: [], from835: [], fromAdjustmentReport: held })).get("2026-09")!;
    assert.equal(m.heldLines, 5);
    assert.match(m.heldSays, /and 2 more$/);
    assert.equal(m.heldSays.split("; ").length, 4);
  });
  test("a held line with no remittance number is not said to be on nothing", () => {
    const r = countPayerFees({ paymentReports: [], from835: [line({ remittance: "", code: "WO", takenCents: 3_00, payer: "" })], fromAdjustmentReport: [] });
    const says = feesByMonth(r).get("2026-09")!.heldSays;
    assert.doesNotMatch(says, /, on :|, on /);
    assert.match(says, /^A payer WO \$3\.00 taken from the remittance: /);
  });
});

const said = (l: FeeLine, decision: FeeDecision["decision"], on = "2026-10-04T15:00:00.000Z", by = "the owner"): FeeDecision => ({ key: feeKey(l), decision, by, on });
const nothingElse = { paymentReports: [], from835: [], fromAdjustmentReport: [] };

describe("what a line is keyed on", () => {
  test("the remittance, the code and the amount, and it reads back the same way", () => {
    const k = feeKey(line({ remittance: "EFT-9000001", code: " cs ", takenCents: -84 }));
    assert.equal(k, "EFT-9000001|CS|-84");
    assert.deepEqual(readFeeKey(k), { remittance: "EFT-9000001", code: "CS", takenCents: -84 });
    assert.equal(readFeeKey("nothing like a key"), null);
    assert.equal(readFeeKey("EFT-9000001|CS|1.5"), null);
  });
  test("not the reference, which a better record of the same line may spell differently", () => {
    assert.equal(feeKey(line({ reference: "as one record spells it" })), feeKey(line({ reference: "as another does" })));
  });
  test("a remittance with no number is told apart by its month, and a stray bar cannot break the key", () => {
    assert.equal(feeKey(line({ remittance: "", month: "2026-09" })), "no remittance number, 2026-09|AH|1000");
    assert.notEqual(feeKey(line({ remittance: "", month: "2026-09" })), feeKey(line({ remittance: "", month: "2026-10" })));
    assert.ok(readFeeKey(feeKey(line({ remittance: "", month: "2026-09" }))));
    assert.equal(feeKey(line({ remittance: "EFT | 9000001 " })), "EFT 9000001|AH|1000");
  });
  test("a line in words says which payer, which code, how much, which way and on which remittance", () => {
    assert.equal(lineSays(line({ payer: "Example Atlas", code: "CS", reference: "balance forward", takenCents: -46_95, remittance: "TRN-70000001" })), 'Example Atlas CS "balance forward" $46.95 added to the remittance, on TRN-70000001');
    assert.equal(lineSays(line({ payer: "", code: "WO", takenCents: 3_00, remittance: "" })), "A payer WO $3.00 taken from the remittance");
  });
});

describe("a decision of his", () => {
  const credit = line({ remittance: "EFT-9000004", code: "CS", takenCents: -84 });
  const unexplained = line({ remittance: "EFT-9000006", code: "WO", takenCents: 3_00 });
  const fee = line({ remittance: "EFT-9000003", takenCents: 4_00 });

  test("a line waiting for him is counted when he says it is a fee, and the month says the figure moved", () => {
    const r = countPayerFees({ ...nothingElse, fromAdjustmentReport: [credit], decisions: [said(credit, "count")] });
    assert.equal(r.held.length, 0);
    assert.equal(r.counted.length, 1);
    assert.deepEqual(r.counted[0].decided, { decision: "count", by: "the owner", on: "2026-10-04T15:00:00.000Z", ruleCounted: false });
    const sep = feesByMonth(r).get("2026-09")!;
    assert.equal(sep.heldLines, 0);
    assert.equal(sep.countedCents, -84, "a credit he counts as a fee takes the month's fees down by what it gave back");
    assert.equal(sep.decidedSays, "1 line counted that the rule would not have (-$0.84)");
  });
  test("a line waiting for him is left out when he says it is not a fee, and no longer waits", () => {
    const r = countPayerFees({ ...nothingElse, fromAdjustmentReport: [unexplained], decisions: [said(unexplained, "leave_out")] });
    assert.equal(r.held.length, 0);
    assert.equal(r.counted.length, 0);
    assert.equal(r.leftOut.length, 1);
    assert.equal(r.leftOut[0].ruleSaid, 'a "WO" line, whose meaning is not settled');
    const sep = feesByMonth(r).get("2026-09")!;
    assert.equal(sep.heldLines, 0);
    assert.equal(sep.leftOutLines, 1);
    assert.equal(sep.leftOutCents, 3_00);
    assert.equal(sep.decidedSays, "", "the rule would not have counted it either, so the figure is what it would have been");
  });
  test("a fee the rule counts is left out when he says so, and the month says the figure moved", () => {
    const r = countPayerFees({ ...nothingElse, from835: [fee], decisions: [said(fee, "leave_out")] });
    assert.equal(r.counted.length, 0);
    assert.equal(r.leftOut.length, 1);
    assert.equal(r.leftOut[0].ruleSaid, "a fee, which the rule counts");
    const sep = feesByMonth(r).get("2026-09")!;
    assert.equal(sep.countedCents, 0);
    assert.equal(sep.decidedSays, "1 line the rule would have counted left out ($4.00)");
  });
  test("counting a fee the rule already counts changes nothing, and says nothing", () => {
    const r = countPayerFees({ ...nothingElse, from835: [fee], decisions: [said(fee, "count")] });
    assert.equal(r.counted.length, 1);
    assert.equal(r.counted[0].decided?.ruleCounted, true);
    assert.equal(feesByMonth(r).get("2026-09")!.countedCents, 4_00);
    assert.equal(feesByMonth(r).get("2026-09")!.decidedSays, "");
  });
  test("a decision moves only its own line", () => {
    const r = countPayerFees({ ...nothingElse, fromAdjustmentReport: [credit, unexplained, fee], decisions: [said(unexplained, "count")] });
    assert.deepEqual(r.held.map((l) => l.code), ["CS"]);
    assert.deepEqual(r.counted.map((l) => l.code).sort(), ["AH", "WO"]);
    assert.equal(feesByMonth(r).get("2026-09")!.countedCents, 7_00);
  });
  test("a line a better record carries is not his to decide: the figure counts it once, there", () => {
    const dup = line({ remittance: "9000001", takenCents: 10_00 });
    const r = countPayerFees({ paymentReports: [paid("EFT-9000001", 10_00)], from835: [], fromAdjustmentReport: [dup], decisions: [said(dup, "leave_out")] });
    assert.equal(r.keptOut.length, 1);
    assert.equal(r.leftOut.length, 0);
    assert.equal(r.counted.length, 0);
  });
  test("a decision survives a better record of the same line arriving, under another spelling and another reference", () => {
    const first = line({ remittance: "EFT-9000006", code: "WO", takenCents: 3_00, reference: "as the adjustment report spells it" });
    const later = line({ remittance: "TRN*1*9000006", code: "WO", takenCents: 3_00, reference: "as the 835 spells it" });
    const r = countPayerFees({ ...nothingElse, from835: [later], fromAdjustmentReport: [first], decisions: [said(first, "count")] });
    assert.equal(r.held.length, 0, "he has already said what it is");
    assert.deepEqual(r.counted.map((l) => l.from), ["the 835"]);
    assert.equal(feesByMonth(r).get("2026-09")!.countedCents, 3_00, "once, from the better record");
  });
  test("the latest word on a line stands, whichever spelling of its remittance it was said under", () => {
    const a = line({ remittance: "EFT-9000006", code: "WO", takenCents: 3_00 });
    const b = line({ remittance: "TRN*1*9000006", code: "WO", takenCents: 3_00 });
    const counted = said(a, "count", "2026-10-04T15:00:00.000Z");
    const undone = countPayerFees({ ...nothingElse, from835: [b], decisions: [counted, said(b, "reopen", "2026-10-05T09:00:00.000Z")] });
    assert.equal(undone.counted.length, 0);
    assert.equal(undone.held.length, 1, "back to the rule, which cannot place it");
    const changed = countPayerFees({ ...nothingElse, from835: [b], decisions: [counted, said(b, "leave_out", "2026-10-06T09:00:00.000Z")] });
    assert.equal(changed.leftOut.length, 1);
    assert.equal(changed.counted.length, 0);
    const stale = countPayerFees({ ...nothingElse, from835: [b], decisions: [said(b, "reopen", "2026-10-03T09:00:00.000Z"), counted] });
    assert.equal(stale.counted.length, 1, "an older undo does not beat a newer count, wherever it sits in the list");
  });
  test("two lines of one remittance with the same code and amount are decided together", () => {
    const a = line({ remittance: "EFT-9000007", code: "WO", takenCents: 2_00, reference: "first" });
    const b = line({ remittance: "EFT-9000007", code: "WO", takenCents: 2_00, reference: "second" });
    const r = countPayerFees({ ...nothingElse, fromAdjustmentReport: [a, b], decisions: [said(a, "count")] });
    assert.equal(r.counted.length, 2);
    assert.equal(feesByMonth(r).get("2026-09")!.countedCents, 4_00);
  });
  test("a line with no remittance number is decided with its own month only", () => {
    const sep = line({ remittance: "", month: "2026-09", code: "WO", takenCents: 3_00 });
    const oct = line({ remittance: "", month: "2026-10", code: "WO", takenCents: 3_00 });
    const r = countPayerFees({ ...nothingElse, from835: [sep, oct], decisions: [said(sep, "count")] });
    assert.deepEqual(r.counted.map((l) => l.month), ["2026-09"]);
    assert.deepEqual(r.held.map((l) => l.month), ["2026-10"]);
  });
  test("a decision on one line does not hide that two records disagree about the remittance", () => {
    const wo = line({ remittance: "EFT-9000002", code: "WO", takenCents: 3_00 });
    const r = countPayerFees({
      paymentReports: [],
      from835: [line({ remittance: "EFT-9000002", takenCents: 10_00 }), wo],
      fromAdjustmentReport: [line({ remittance: "9000002", takenCents: 12_00 })],
      decisions: [said(wo, "count")],
    });
    assert.equal(r.disagree.length, 1);
    assert.match(feesByMonth(r).get("2026-09")!.differ, /9000002: the 835 says \$10\.00 and the adjustment report says \$12\.00/);
  });
});

const account = (basis: "accrual" | "cash", over: Partial<PLInputs> = {}): PLInputs => ({
  month: "2026-09",
  basis,
  sales: basis === "cash" ? null : { retailCents: 0, rxPatientCents: 10_00, rxRemitCents: 500_00, totalCents: 510_00 },
  receipts: basis === "cash" ? [{ kind: "third_party", amountCents: 500_00 }] : [],
  laterMoneyCents: 0,
  claimsRevenueCents: 510_00,
  claimsCount: 1,
  dispensedCostCents: 420_00,
  purchasesCents: null,
  billedPurchasesCents: null,
  rebatesCents: null,
  expenses: [],
  ...over,
});
const FEE_LINE = /Payer fees and recoupments taken on remittances/;

describe("on the two accounts", () => {
  test("the accrual account takes what the payers took off revenue, once", () => {
    const pl = monthlyPL(account("accrual", { remitFeesCents: 3_26 }));
    assert.equal(pl.offsets.find((l) => FEE_LINE.test(l.label))!.amountCents, 3_26);
    assert.equal(pl.netRevenueCents, pl.revenueCents - 3_26);
  });
  test("the payment reports' fee expenses and the fee line are different remittances, and both come off", () => {
    const pbm = { categoryId: "pbm", categoryName: "PBM fees", kind: "revenue_offset" as const, amountCents: 14_00 };
    const pl = monthlyPL(account("accrual", { remitFeesCents: 3_26, expenses: [pbm] }));
    assert.equal(pl.revenueCents - pl.netRevenueCents, 17_26);
  });
  test("the cash account takes no fee line and does not claim there were none: the deposit is already net", () => {
    const pl = monthlyPL(account("cash", { remitFeesCents: 3_26, remitFeesHeld: { cents: -84, lines: 1, says: "a credit" }, remitFeesNotFees: { cents: -46_95, lines: 1, says: "a balance forward" }, remitFeesDecided: "1 line counted that the rule would not have (-$0.84)" }));
    assert.equal(pl.offsets.some((l) => FEE_LINE.test(l.label)), false);
    assert.equal(pl.caveats.some((c) => /Waiting for you|On neither account|Your decision changes|No fee taken after the sale/.test(c)), false);
  });
  test("a month whose only line is waiting for him says so, and does not pretend a fee was counted", () => {
    const pl = monthlyPL(account("accrual", { remitFeesCents: 0, remitFeesHeld: { cents: -84, lines: 1, says: "a credit of $0.84" } }));
    assert.equal(pl.offsets.some((l) => FEE_LINE.test(l.label)), false);
    assert.ok(pl.caveats.some((c) => c === "Waiting for you, and on neither account until you decide: a credit of $0.84. Count it or leave it out on the Money page."));
    assert.ok(pl.caveats.some((c) => /No fee taken after the sale is on file/.test(c)));
  });
  test("a balance forward is said, with nothing asked of him", () => {
    const pl = monthlyPL(account("accrual", { remitFeesCents: 0, remitFeesNotFees: { cents: -46_95, lines: 1, says: "a balance forward of $46.95" } }));
    assert.ok(pl.caveats.some((c) => c === "On neither account, and nothing for you to decide: a balance forward of $46.95."));
    assert.equal(pl.caveats.some((c) => /Waiting for you/.test(c)), false);
  });
  test("a decision that moved the figure is said, and the month does not then claim no fee is on file", () => {
    const moved = "1 line the rule would have counted left out ($4.00)";
    const pl = monthlyPL(account("accrual", { remitFeesCents: 0, remitFeesDecided: moved }));
    assert.ok(pl.caveats.some((c) => c === "Your decision changes this month's payer fees from what the rule gives: " + moved + ". The Money page lists each one, with a press to undo it."));
    assert.equal(pl.caveats.some((c) => /No fee taken after the sale is on file/.test(c)), false, "a fee line IS on file; he left it out");
  });
  test("two records that disagree about a remittance are said on the month", () => {
    const differ = "9000002: the Health Mart Atlas payment report says $10.00 and the adjustment report says $12.00";
    const pl = monthlyPL(account("accrual", { remitFeesCents: 0, remitFeesKept: { cents: 12_00, lines: 1, differ } }));
    assert.ok(pl.caveats.some((c) => c.includes("disagree about its fees, and the better record is the one counted: " + differ)));
  });
});

describe("the register entry for payer fees", () => {
  const entry = (i: PLInputs) => countedTwice(i, monthlyPL(i)).find((r) => r.what === "Payer fees taken on remittances")!;
  test("names what a better record kept out and what a weaker one supplied", () => {
    const e = entry(account("accrual", { remitFeesCents: 4_00, remitFeesKept: { cents: 17_50, lines: 3, differ: "" } }));
    assert.equal(e.bothPresent, true);
    assert.equal(e.keptOutCents, 17_50);
    assert.match(e.says, /3 fee lines, \$17\.50, already counted from a better record and not taken again; \$4\.00 counted from the 835 or the adjustment report/);
  });
  test("says what waits for him, what is not a fee and what his decision changed, and that a decision stays", () => {
    const e = entry(account("accrual", { remitFeesCents: 0, remitFeesHeld: { cents: -84, lines: 1, says: "a credit" }, remitFeesNotFees: { cents: -46_95, lines: 1, says: "a balance forward" }, remitFeesDecided: "1 line the rule would have counted left out ($4.00)" }));
    assert.match(e.says, /awaiting your decision, on neither account: a credit/);
    assert.match(e.says, /not a fee, on neither account: a balance forward/);
    assert.match(e.says, /your decision changes it: 1 line the rule would have counted left out \(\$4\.00\)/);
    assert.match(e.rule, /until a person counts it as a fee or leaves it out, and that stays decided across every import/);
  });
  test("says what it measured where there is nothing to keep out, and is not a cash-account question", () => {
    const none = entry(account("accrual", { remitFeesCents: 0 }));
    assert.equal(none.bothPresent, false);
    assert.equal(none.keptOutCents, null);
    assert.match(none.says, /No fee taken after the sale is on file/);
    const cash = entry(account("cash", { remitFeesCents: 4_00, remitFeesKept: { cents: 17_50, lines: 3, differ: "" } }));
    assert.equal(cash.bothPresent, false);
    assert.equal(cash.keptOutCents, null);
    assert.match(cash.says, /deposit is already net/);
  });
});
