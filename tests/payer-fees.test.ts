import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyFee, isSettledPayerFee, sameRemittance, countPayerFees, feesByMonth, type FeeLine } from "../src/lib/payer-fees";
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
  test("a balance forward is held and counted nowhere", () => {
    const r = countPayerFees({ paymentReports: [], from835: [line({ remittance: "TRN-70000001", month: "2026-10", code: "CS", reference: "balance forward", takenCents: -46_95, payer: "Example Claims Co" })], fromAdjustmentReport: [] });
    assert.equal(r.counted.length, 0);
    assert.equal(r.held.length, 1);
    const oct = feesByMonth(r).get("2026-10")!;
    assert.equal(oct.countedCents, 0);
    assert.equal(oct.heldCents, -46_95);
    assert.match(oct.heldSays, /Example Claims Co CS "balance forward" \$46\.95 added to the remittance, on TRN-70000001: a balance carried to a later remittance/);
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
    assert.match(says, /^A payer WO \$3\.00 taken from it: /);
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
    const pl = monthlyPL(account("cash", { remitFeesCents: 3_26, remitFeesHeld: { cents: -46_95, lines: 1, says: "a balance forward" } }));
    assert.equal(pl.offsets.some((l) => FEE_LINE.test(l.label)), false);
    assert.equal(pl.caveats.some((c) => /Not counted as fees|No fee taken after the sale/.test(c)), false);
  });
  test("a month whose only line was held says so, and does not pretend a fee was counted", () => {
    const pl = monthlyPL(account("accrual", { remitFeesCents: 0, remitFeesHeld: { cents: -46_95, lines: 1, says: "a balance forward of $46.95" } }));
    assert.equal(pl.offsets.some((l) => FEE_LINE.test(l.label)), false);
    assert.ok(pl.caveats.some((c) => /Not counted as fees, and on neither account: a balance forward of \$46\.95\./.test(c)));
    assert.ok(pl.caveats.some((c) => /No fee taken after the sale is on file/.test(c)));
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
