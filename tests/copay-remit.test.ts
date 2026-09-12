import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseCopayRemit, parseCopayRemitLine, netCopayLines, copayRemitSummary, COPAY_PAYER , looksLikeCopayRemit, SITE_STARTS_ON } from "../src/lib/copay-remit";

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

  test("a statement whose rows do not add to the claims total says so rather than storing most of it", () => {
    const short = text.replace("Total Claims: 177.25", "Total Claims: 180.19");
    const r = parseCopayRemit(short);
    assert.equal(r.reconciles, false);
    assert.match(copayRemitSummary(r), /do not add to the printed total/);
  });

  test("a footer that contradicts itself is a separate finding from rows that do not add up", () => {
    /*
     * The rows can be perfect while the footer is not. Folding the two into one verdict would
     * either refuse a statement whose claims are all correct, or pass one whose own totals
     * disagree — and the second is how a fee nobody accounted for goes unnoticed.
     */
    const oddFooter = text.replace("Total Amount Paid: 177.25", "Total Amount Paid: 180.19");
    const r = parseCopayRemit(oddFooter);
    assert.equal(r.reconciles, true, "the rows still add to the claims total, which is what they are");
    assert.equal(r.totalsAgree, false, "but the footer does not hang together");
    assert.match(copayRemitSummary(r), /the footer does not agree with itself/);
  });

  test("the sample statement footer agrees with itself", () => {
    assert.equal(parseCopayRemit(text).totalsAgree, true);
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

/*
 * Recognising the statement by what is in it, because its name will tell us nothing.
 *
 * RedSail is about to push these to the pharmacy's SFTP host under whatever name their system
 * chooses, as .txt, .dat or PDF. So the recogniser cannot look at the name, and it must not be so
 * loose that a covering email about the voucher programme routes as a remittance and gets read for
 * money.
 */
describe("recognising one of these files", () => {
  test("the real statement is recognised", () => {
    assert.equal(looksLikeCopayRemit(text), true);
  });

  test("it is recognised with the title stripped, on the header and the rows alone", () => {
    // The name says nothing, so neither may the recogniser depend on it.
    const noTitle = text.replace(/Remittance Advice.*\n/, "").replace(/RedSail Technologies\n/, "");
    assert.equal(looksLikeCopayRemit(noTitle), true);
  });

  test("a covering email that mentions the programme is not a remittance", () => {
    assert.equal(
      looksLikeCopayRemit("Subject: RAS Copay Voucher Reimbursement\n\nYour remittance advice for September is attached. Please contact us with any questions."),
      false,
    );
  });

  test("a table of figures with no marker is not one either", () => {
    const rowsOnly = text.split("\n").filter((l) => /^\d/.test(l.trim())).join("\n");
    assert.equal(looksLikeCopayRemit(rowsOnly), false, "rows alone could be anything");
  });

  test("one row is not enough, because one line of numbers is an accident", () => {
    const oneRow = "Payment Date: 09/01/2026\nPayment Amount: 174.31\n000000410088 20260821 00002150680 Mounjaro 2.5 MG/0.5ML SOPN 2.00 1331.24 1156.93 174.31";
    assert.equal(looksLikeCopayRemit(oneRow), false);
  });

  test("an empty or tiny file is not one", () => {
    assert.equal(looksLikeCopayRemit(""), false);
    assert.equal(looksLikeCopayRemit("Payment Date: 09/01/2026"), false);
  });

  test("an 835 is not mistaken for one, which is why the X12 test runs first", () => {
    const x12 = "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260901*1200*^*00501*000000001*0*P*:~GS*HP*S*R*20260901*1200*1*X*005010X221A1~ST*835*0001~";
    assert.equal(looksLikeCopayRemit(x12), false);
  });
});

/*
 * The fills this statement settles are all before 1 September 2026.
 *
 * The owner settled that nothing before then is being uploaded and the site starts clean, so these
 * will never match a claim however long anybody waits. That is not a failure to match — it is money
 * for dispensings this site was not keeping records for, and it has to be counted apart from the
 * unmatched or the one payment worth chasing is lost among a permanent, growing number.
 */
describe("what the site's start date means for these", () => {
  test("every payable line on the sample statement predates the site's records", () => {
    const r = parseCopayRemit(text);
    const payable = r.net.filter((n) => !n.reversed && n.paidCents !== 0);
    assert.equal(payable.length, 2);
    assert.ok(payable.every((n) => n.dateOfService < SITE_STARTS_ON), "so none of them can ever match a claim");
  });

  test("the start date is the day the owner named, not a guess", () => {
    assert.equal(SITE_STARTS_ON, "2026-09-01");
  });
});

/*
 * The rows are claims, so they are checked against the claims subtotal.
 *
 * This preferred "Total Amount Paid" and was right only by luck: the fee on the statement in hand
 * is zero, so the two figures are equal. The invoice reader had exactly this fault and it cost
 * real money — item lines checked against the amount due rather than the goods subtotal, so ten
 * dollars of IPC's shipping refused an otherwise perfect reading and $4,878.56 of purchases went
 * unread. The moment RedSail prints a fee the same thing happens here: every row correct, the
 * statement refused, nothing stored.
 */
describe("the statement gate compares like with like", () => {
  test("a fee that the payment includes and the claims total does not still reconciles", () => {
    const withFee = text
      .replace("Total Fee: 0.00", "Total Fee: 12.50")
      .replace("Total Amount Paid: 177.25", "Total Amount Paid: 189.75");
    const r = parseCopayRemit(withFee);
    assert.equal(r.netCents, 17_725, "the rows are unchanged");
    assert.equal(r.totals.claimsCents, 17_725);
    assert.equal(r.totals.feeCents, 1_250);
    assert.equal(r.totals.paidCents, 18_975);
    assert.equal(r.reconciles, true, "the rows add to the claims total, which is what they are");
  });

  test("rows that genuinely disagree with the claims total still fail", () => {
    const wrong = text.replace("Total Claims: 177.25", "Total Claims: 180.19");
    assert.equal(parseCopayRemit(wrong).reconciles, false);
  });

  test("a statement printing only the amount paid is still checkable against it", () => {
    const noClaims = text.replace("Total Claims: 177.25", "");
    const r = parseCopayRemit(noClaims);
    assert.equal(r.totals.claimsCents, null);
    assert.equal(r.reconciles, true, "the payment total stands in where the claims total is absent");
  });
});
