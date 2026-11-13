import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { countPayerFees, feeKey, type FeeLine } from "../src/lib/payer-fees";
import { feesView } from "../src/lib/payer-fees-view";

/*
 * What the Money page's payer-fee card says, line by line and in total, and which presses it offers. Invented remittances.
 * The sentences are asserted in full: they are what he reads before he presses anything, and the arithmetic under them being
 * right is not the same as their being true (CLAUDE.md, rule 6).
 */
const line = (o: Partial<FeeLine> & { remittance: string; code: string; takenCents: number }): FeeLine => ({ month: "2026-09", reference: "", payer: "Example Atlas", ...o });
const EMPTY = { paymentReports: [], from835: [], fromAdjustmentReport: [] };
const dayOf = (iso: string) => iso.slice(0, 10);
const view = (i: Parameters<typeof countPayerFees>[0], months = ["2026-09"], label = "September 2026") => feesView(countPayerFees(i), months, label, dayOf);
const ROW = `"Payer fees and recoupments taken on remittances"`;
const OWNER = { by: "The Owner", on: "2026-10-04T15:00:00.000Z" };

const credit = line({ remittance: "EFT-9000004", code: "CS", takenCents: -84 });
const unknown = line({ remittance: "EFT-9000006", code: "ZZ", takenCents: 300, payer: "Example Payer" });
const ah = line({ remittance: "EFT-9000003", code: "AH", takenCents: 400, payer: "Example Express" });

describe("the headline, and what it says when there is nothing", () => {
  test("nothing on file says that none has been read, which is not that none was taken", () => {
    const v = view(EMPTY);
    assert.equal(v.headline, "No payer-fee line from an 835 or the adjustment report is on file for September 2026. That means none has been read, not that none was taken.");
    assert.deepEqual([v.waiting, v.counted, v.leftOut, v.notFees, v.keptOut, v.differ], [[], [], [], [], [], []]);
    assert.equal(v.empty, true);
  });
  test("what waits and what is counted, each in its own words, and where the counted figure lands", () => {
    const v = view({ ...EMPTY, from835: [unknown], fromAdjustmentReport: [credit, ah] });
    assert.equal(v.headline, `2 lines wait for you and are on neither account until you decide. $4.00 is counted over 1 line, in the account's ${ROW} row (accrual only).`);
    assert.equal(v.countedCents, 400);
    assert.equal(v.empty, false);
  });
  test("one line waiting is said in the singular", () => {
    const v = view({ ...EMPTY, fromAdjustmentReport: [credit] });
    assert.equal(v.headline, `1 line waits for you and is on neither account until you decide. No fee from these records is counted in the account's ${ROW} row.`);
  });
  test("a total that is a net credit says so rather than printing a minus sign as if it were a cost", () => {
    const v = view({ ...EMPTY, fromAdjustmentReport: [line({ remittance: "EFT-9000007", code: "AH", takenCents: -250 })] });
    assert.equal(v.headline, `Nothing waits for you. A net credit of $2.50 is counted over 1 line, in the account's ${ROW} row (accrual only).`);
  });
});

describe("the lines, their sources and their presses", () => {
  const v = view({ ...EMPTY, from835: [unknown], fromAdjustmentReport: [credit, ah] });
  test("a line that waits says why, from which record, and offers both words in the right name for its sign", () => {
    assert.deepEqual(v.waiting.map((r) => r.says), ["Example Payer ZZ $3.00 taken from the remittance, on EFT-9000006", "Example Atlas CS $0.84 added to the remittance, on EFT-9000004"]);
    assert.deepEqual(v.waiting.map((r) => r.source), ["The 835", "The adjustment report"]);
    assert.deepEqual(v.waiting.map((r) => r.note), ['A "ZZ" line, whose meaning is not settled.', "A credit from the payer rather than a recoupment, and what it reverses is not on the report."]);
    assert.deepEqual(v.waiting.map((r) => r.presses.map((p) => p.label)), [["Count as a fee", "Leave out"], ["Count against the fees", "Leave out"]]);
    assert.deepEqual(v.waiting.map((r) => r.key), [feeKey(unknown), feeKey(credit)]);
  });
  test("a line the rule counts says that the rule did, and can only be left out", () => {
    assert.equal(v.counted[0].note, "Counted by the rule, on its code (AH).");
    assert.deepEqual(v.counted[0].presses.map((p) => p.to), ["leave_out"]);
  });
  test("a line only another month's record carries is not on this period's card, and a line with no date is on every card", () => {
    const october = line({ remittance: "EFT-9000008", code: "AH", takenCents: 100, month: "2026-10" });
    const dateless = line({ remittance: "EFT-9000009", code: "AH", takenCents: 200, month: "" });
    const i = { ...EMPTY, fromAdjustmentReport: [october, dateless] };
    assert.deepEqual(view(i).counted.map((r) => r.key), [feeKey(dateless)]);
    assert.deepEqual(view(i, ["2026-10"], "October 2026").counted.map((r) => r.key), [feeKey(october), feeKey(dateless)]);
    assert.equal(view(i).countedCents, 200);
  });
});

describe("what a person said, who said it, and the presses that would change something", () => {
  const said = (l: FeeLine, decision: "count" | "leave_out" | "reopen") => ({ key: feeKey(l), decision, ...OWNER });
  test("counted by him where the rule would not: said so, and he can leave it out or undo", () => {
    const v = view({ ...EMPTY, fromAdjustmentReport: [credit], decisions: [said(credit, "count")] });
    assert.equal(v.counted[0].note, "Counted by The Owner on 2026-10-04; the rule would not have counted it.");
    assert.deepEqual(v.counted[0].presses.map((p) => p.to), ["leave_out", "reopen"]);
    assert.equal(v.headline, `Nothing waits for you. A net credit of $0.84 is counted over 1 line, in the account's ${ROW} row (accrual only).`);
  });
  test("counted by him where the rule counts it too: said so", () => {
    const v = view({ ...EMPTY, fromAdjustmentReport: [ah], decisions: [said(ah, "count")] });
    assert.equal(v.counted[0].note, "Counted by The Owner on 2026-10-04; the rule counts it too.");
  });
  test("left out where the rule would have counted it: only undo is offered, since counting it is what undo does", () => {
    const v = view({ ...EMPTY, fromAdjustmentReport: [ah], decisions: [said(ah, "leave_out")] });
    assert.equal(v.leftOut[0].note, "Left out by The Owner on 2026-10-04. The rule said: a fee, which the rule counts.");
    assert.deepEqual(v.leftOut[0].presses.map((p) => p.to), ["reopen"]);
    assert.equal(v.headline, `Nothing waits for you. No fee from these records is counted in the account's ${ROW} row. Also on file: 1 line left out.`);
  });
  test("left out where the rule held it: he can still count it, or undo", () => {
    const v = view({ ...EMPTY, fromAdjustmentReport: [credit], decisions: [said(credit, "leave_out")] });
    assert.equal(v.leftOut[0].note, "Left out by The Owner on 2026-10-04. The rule said: a credit from the payer rather than a recoupment, and what it reverses is not on the report.");
    assert.deepEqual(v.leftOut[0].presses.map((p) => p.label), ["Count against the fees", "Undo"]);
  });
  test("an undone decision is back to the rule: the line waits again with both words open", () => {
    const v = view({ ...EMPTY, fromAdjustmentReport: [credit], decisions: [said(credit, "count"), { ...said(credit, "reopen"), on: "2026-10-04T16:00:00.000Z" }] });
    assert.equal(v.waiting.length, 1);
    assert.equal(v.counted.length, 0);
  });
  test("a decision with no name on it says someone, not nobody", () => {
    const v = view({ ...EMPTY, fromAdjustmentReport: [credit], decisions: [{ ...said(credit, "count"), by: "" }] });
    assert.equal(v.counted[0].note, "Counted by someone on 2026-10-04; the rule would not have counted it.");
  });
});

describe("lines nobody can decide, and records that disagree", () => {
  test("a line a better record already counted has no press, says where it is counted, and a disagreement is said with the one the account goes by", () => {
    const v = view({ paymentReports: [{ remittance: "EFT-9000001", feeCents: 500 }], from835: [], fromAdjustmentReport: [line({ remittance: "EFT-9000001", code: "AH", takenCents: 400 })] });
    assert.equal(v.keptOut[0].note, "Already counted once, from the Health Mart Atlas payment report; this copy, from the adjustment report, adds nothing.");
    assert.deepEqual(v.keptOut[0].presses, []);
    assert.deepEqual(v.differ, ["EFT-9000001: the Health Mart Atlas payment report says $5.00 and the adjustment report says $4.00. The account goes by the Health Mart Atlas payment report."]);
    assert.equal(v.headline, `Nothing waits for you. No fee from these records is counted in the account's ${ROW} row. Also on file: 1 line already counted once from a better record.`);
  });
  test("a disagreement is never hidden behind the line that nothing is on file: it is shown whatever else is or is not there", () => {
    const fees = { counted: [], keptOut: [], held: [], notFees: [], leftOut: [], disagree: [{ remittance: "EFT-9000010", month: "2026-09", believedFrom: "the Health Mart Atlas payment report", believedCents: 500, otherFrom: "the 835", otherCents: 400 }] };
    const v = feesView(fees, ["2026-09"], "September 2026", dayOf);
    assert.equal(v.empty, false);
    assert.deepEqual(v.differ, ["EFT-9000010: the Health Mart Atlas payment report says $5.00 and the 835 says $4.00. The account goes by the Health Mart Atlas payment report."]);
    assert.equal(feesView(fees, ["2026-10"], "October 2026", dayOf).empty, true, "another month's disagreement is not this card's");
  });
  test("a balance forward is said not to be a fee, with no press, and the headline counts it", () => {
    const bf = line({ remittance: "TRN-70000001", code: "CS", takenCents: -4695, reference: "balance forward", month: "2026-10" });
    const v = view({ ...EMPTY, from835: [bf] }, ["2026-10"], "October 2026");
    assert.equal(v.notFees[0].note, "A balance carried to a later remittance, which moves no money by itself: not a fee and not revenue.");
    assert.deepEqual(v.notFees[0].presses, []);
    assert.equal(v.headline, `Nothing waits for you. No fee from these records is counted in the account's ${ROW} row. Also on file: 1 line not a fee.`);
  });
});
