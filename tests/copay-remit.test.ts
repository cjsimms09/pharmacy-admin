import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseCopayRemit, parseCopayRemitLine, netCopayLines, copayRemitSummary, COPAY_PAYER } from "../src/lib/copay-remit";

const text = fs.readFileSync("fixtures/copay-remit-redsail.txt", "utf8");

/*
 * The copay-voucher remittance, which is the arriving half of money the claim was already promised.
 *
 * The owner's ask was for the process to be right before the volume turns up: "we probably dont
 * have these claims in our system but lets make sure this process is set up and correct for
 * future." So the tests are about the three ways this can be wrong quietly — a row misread into
 * three figures that do not agree, a reversal counted as a payment, and a statement whose rows do
 * not add to what it says it paid.
 */
describe("reading the statement", () => {
  const r = parseCopayRemit(text);

  test("the payment's own identity comes off the header, because that is what stops it being banked twice", () => {
    assert.equal(r.paidOn, "2026-09-01");
    assert.equal(r.reference, "10261385");
    assert.equal(r.paymentAmountCents, 17_725);
    assert.equal(r.npi, "1548737182");
    assert.equal(r.payer, COPAY_PAYER);
  });

  test("every printed row is read, reversals included", () => {
    assert.equal(r.lines.length, 14);
    assert.deepEqual(r.unreadable, [], "nothing on this statement should defeat the reader");
  });

  test("the pharmacy's own street address is not mistaken for an item row", () => {
    // It begins with a digit, which was the first and wrong test for an item row.
    assert.ok(!r.unreadable.some((u) => /Prairie Street/.test(u)));
    assert.ok(!r.lines.some((l) => /Prairie/.test(l.drug)));
  });

  test("a prescription number broken across two runs by the text layer is still one number", () => {
    // The fixture prints "0000004 07155"; the claim it settles is 407155.
    const l = r.lines.find((x) => x.rxNumber === "407155");
    assert.ok(l, "the split prescription number was not put back together");
    assert.equal(l.ndc11, "00002150680");
    assert.equal(l.paidCents, 17_431);
  });

  test("an NDC broken across two runs is put back together too", () => {
    const trelegy = r.lines.filter((x) => x.ndc11 === "00173089310");
    assert.equal(trelegy.length, 2, "the Trelegy pair, printed with the NDC split");
    assert.equal(trelegy[0].dateOfService, "2026-08-17");
  });

  test("the twelve-digit reference keeps its zeros for tracing but the prescription number does not", () => {
    const l = r.lines[0];
    assert.equal(l.reference, "000000410088");
    assert.equal(l.rxNumber, "410088");
  });
});

describe("the three arithmetic gates", () => {
  test("a row that does not hold together is returned unreadable, not as three plausible figures", () => {
    // Submitted less patient paid is 174.31; this row claims 174.13, two digits transposed.
    const bad = "000000410088 20260821 00002150680 Mounjaro 2.5 MG/0.5ML SOPN 2.00 1331.24 1156.93 174.13";
    const r = parseCopayRemitLine(bad);
    assert.ok("why" in r);
    assert.match(r.why, /submitted less patient paid is 174\.31, but the row pays 174\.13/);
  });

  test("the identity survives a reversal, because every figure on it is negated together", () => {
    const rev = "000000410088 20260821 00002150680 Mounjaro 2.5 MG/0.5ML SOPN -2.00 -1331.24 -1156.93 -174.31";
    const r = parseCopayRemitLine(rev);
    assert.ok("line" in r);
    assert.equal(r.line.paidCents, -17_431);
    assert.equal(r.line.quantityThousandths, -2_000);
  });

  test("eight digits that are not a date mean the fields are not where they look", () => {
    // 20261332: no thirteenth month. A row that borrowed a digit reads exactly like this.
    const shifted = "000000410088 20261332 00002150680 Mounjaro 2.5 MG SOPN 2.00 1331.24 1156.93 174.31";
    const r = parseCopayRemitLine(shifted);
    assert.ok("why" in r);
    assert.match(r.why, /is not a date/);
  });

  test("the rows net to the printed total, which is what lets any of it be stored", () => {
    const r = parseCopayRemit(text);
    assert.equal(r.netCents, 17_725);
    assert.equal(r.totals.paidCents, 17_725);
    assert.equal(r.totals.claimsCents, 17_725);
    assert.equal(r.totals.feeCents, 0);
    assert.equal(r.totals.balanceForwardCents, 0);
    assert.equal(r.reconciles, true);
  });

  test("a statement whose rows do not add to its total says so rather than storing most of it", () => {
    const short = text.replace("Total Amount Paid: 177.25", "Total Amount Paid: 180.19");
    const r = parseCopayRemit(short);
    assert.equal(r.reconciles, false);
    assert.match(copayRemitSummary(r), /do not add to the printed total/);
  });

  test("no total printed is unverifiable, which is not the same as disagreeing", () => {
    const none = text
      .replace("Total Amount Paid: 177.25", "")
      .replace("Total Claims: 177.25", "")
      .replace("Payment Amount: 177.25", "");
    assert.equal(parseCopayRemit(none).reconciles, null);
  });
});

describe("netting a fill against its reversal", () => {
  const r = parseCopayRemit(text);

  test("fourteen printed rows are seven prescriptions once reversals are folded in", () => {
    assert.equal(r.net.length, 7);
  });

  test("a fill paid and taken back records nothing and is counted as reversed", () => {
    const mounjaro = r.net.find((n) => n.rxNumber === "410088")!;
    assert.equal(mounjaro.rows, 2);
    assert.equal(mounjaro.paidCents, 0);
    assert.equal(mounjaro.reversed, true);
  });

  test("only two prescriptions are actually owed money, and they are the printed total", () => {
    const toRecord = r.net.filter((n) => !n.reversed);
    assert.equal(toRecord.length, 2);
    assert.deepEqual(toRecord.map((n) => n.rxNumber).sort(), ["407155", "410265"]);
    assert.equal(toRecord.reduce((n, x) => n + x.paidCents, 0), 17_725);
  });

  test("a fill reversed and re-paid at a different submitted amount nets to one real payment", () => {
    // Eliquis: 288.40 paid, reversed, then re-submitted at 155.00. The voucher pays 2.94 once.
    const eliquis = r.net.find((n) => n.rxNumber === "410265")!;
    assert.equal(eliquis.rows, 3);
    assert.equal(eliquis.reversed, false, "three rows that do not cancel are a payment, not a reversal");
    assert.equal(eliquis.paidCents, 294);
    assert.equal(eliquis.submittedCents, 15_500, "the surviving submission, not the sum of all three");
    assert.equal(eliquis.patientPaidCents, 15_206);
    // The line's own identity has to survive netting, or the net is not a line.
    assert.equal(eliquis.submittedCents - eliquis.patientPaidCents, eliquis.paidCents);
  });

  test("two fills of the same drug on different prescriptions are not netted together", () => {
    const mounjaro = r.net.filter((n) => n.ndc11 === "00002150680");
    assert.equal(mounjaro.length, 2, "410088 and 407155 are different fills of the same product");
  });

  test("two prescriptions alike in every field but the number stay two", () => {
    /*
     * The pair the real statement carries: same drug, same NDC, same date of service, same
     * quantity, same money, both paid and both reversed. Everything about them matches except
     * whose prescription it is. A key that left the prescription number out would fold four rows
     * into one and lose a patient's fill entirely.
     */
    const wegovy = r.net.filter((n) => n.ndc11 === "00169452514");
    assert.equal(wegovy.length, 2);
    assert.deepEqual(wegovy.map((n) => n.rxNumber).sort(), ["414100", "414277"]);
    assert.ok(wegovy.every((n) => n.reversed && n.rows === 2));
  });

  test("netting an empty statement is empty, not a payment of nothing", () => {
    assert.deepEqual(netCopayLines([]), []);
  });
});

describe("what it says about itself", () => {
  test("the summary counts the rows, the payments and the reversals", () => {
    const s = copayRemitSummary(parseCopayRemit(text));
    assert.match(s, /14 rows netting to 2 payments of \$177\.25/);
    assert.match(s, /5 paid and reversed in the same period, which record nothing/);
  });

  test("a statement with no rows says that, rather than saying nothing was paid", () => {
    assert.match(copayRemitSummary(parseCopayRemit("Payment Amount: 0.00")), /No item row could be read/);
  });
});
