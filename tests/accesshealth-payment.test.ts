import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeAccessHealthPayment, readAccessHealthPayment } from "../src/lib/accesshealth-payment";

/*
 * The shape of a Health Mart Atlas AccessHealth payment report as `pdfText` returns it. Line order, spellings and the
 * run-together fields are the real reports' (31 August to 11 September 2026); every figure, number, plan and pharmacy
 * is invented, and chosen so the report's own totals agree.
 *
 * Two plans. The first ends at the foot of a page, and the second plan's name is printed before the page footer, as
 * three of the nine real reports do. Each plan's name is repeated after its own Paid claims line.
 */
const REPORT = [
  "Health Mart Atlas",
  "1 Test Road, Suite 1",
  "Testville, OH   00000-0000",
  "Test Pharmacy (9999999)",
  "1 Main St",
  "Testtown, KS   00000",
  "Sep 04, 2026",
  "EFT-12345678Total Paid: $118.77",
  "PLAN ONE",
  "Fill DateRx NumberBilledAllowedDisp. FeeTaxCo-PayAmountRej.",
  "08/05/26100001       200.00       110.00         0.00         0.00        10.00       100.00",
  "08/06/26100002        50.00         0.00         0.00         0.00         0.00         0.0070",
  "08/06/26100003       -40.00       -15.00         0.00         0.00         0.00       -15.00",
  "12/31/26Adj-CS1234567         0.00        -0.33         0.00         0.00         0.00        -0.33",
  "Paid claims: 4Paid Amount: $84.67",
  "PLAN ONE",
  "PLAN TWO",
  "9/7/2026Page 1 of",
  "2",
  "Fill DateRx NumberBilledAllowedDisp. FeeTaxCo-PayAmountRej.",
  "08/07/26100004        40.00        34.10         0.00         0.00         0.00        34.10MR",
  "9/7/2026Page 2 of",
  "2",
  "Fill DateRx NumberBilledAllowedDisp. FeeTaxCo-PayAmountRej.",
  "08/08/26100005        12.00         0.00         0.00         0.00         0.00         0.00",
  "Paid claims: 2Paid Amount: $34.10",
  "PLAN TWO",
  "Adj-xx Glossary:",
  "50: Late ChargeCS, CS-02: Adjustment",
].join("\n");

describe("the Health Mart Atlas AccessHealth payment report", () => {
  test("is recognised by its own words", () => {
    assert.equal(looksLikeAccessHealthPayment(REPORT), true);
    assert.equal(looksLikeAccessHealthPayment("The electronic funds transfer for 9/14/2026 is complete."), false);
  });

  test("reads the EFT, both plans across the page break, every row and the adjustment", () => {
    const r = readAccessHealthPayment(REPORT, "9999999");
    assert.ok(r.ok, r.ok ? "" : r.why);
    const p = r.report;
    assert.equal(p.eftNumber, "EFT-12345678");
    assert.equal(p.paidOn, "2026-09-04");
    assert.equal(p.totalPaidCents, 11877);
    assert.deepEqual(p.sections.map((s) => [s.plan, s.claims.length, s.adjustments.length, s.statedPaidCents]), [["PLAN ONE", 3, 1, 8467], ["PLAN TWO", 2, 0, 3410]]);
    assert.deepEqual(p.sections[0].claims[0], { fillDate: "2026-08-05", rxNumber: "100001", billedCents: 20000, allowedCents: 11000, dispensingFeeCents: 0, taxCents: 0, copayCents: 1000, amountCents: 10000, rejection: null });
    assert.equal(p.sections[0].claims[1].rejection, "70");
    assert.equal(p.sections[0].claims[1].amountCents, 0);
    assert.equal(p.sections[0].claims[2].amountCents, -1500);
    assert.equal(p.sections[1].claims[0].rejection, "MR");
    assert.deepEqual(p.sections[0].adjustments[0], { on: "2026-12-31", code: "CS", reference: "1234567", amountCents: -33 });
    assert.equal(p.claimRows, 5);
    assert.equal(p.adjustmentCents, -33);
  });

  test("a claim amount that does not add to its section refuses the whole report", () => {
    const r = readAccessHealthPayment(REPORT.replace("       100.00\n", "       101.00\n"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /PLAN ONE section's rows come to \$85\.67 against its Paid Amount of \$84\.67/);
  });

  test("a section total that does not add to the EFT refuses it", () => {
    const r = readAccessHealthPayment(REPORT.replace("Total Paid: $118.77", "Total Paid: $118.78"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /sections come to \$118\.77 against the EFT's Total Paid of \$118\.78/);
  });

  test("a row the reader cannot parse is not skipped quietly", () => {
    const r = readAccessHealthPayment(REPORT.replace("08/08/26100005        12.00", "08/08/26100005        twelve"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /could not be read|rows against its Paid claims/);
  });

  test("a negative section total is read as negative", () => {
    const negative = REPORT.replace("08/07/26100004        40.00        34.10         0.00         0.00         0.00        34.10MR", "08/07/26100004       -40.00       -34.10         0.00         0.00         0.00       -34.10")
      .replace("Paid claims: 2Paid Amount: $34.10", "Paid claims: 2Paid Amount: -$34.10")
      .replace("Total Paid: $118.77", "Total Paid: $50.57");
    const r = readAccessHealthPayment(negative);
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.report.sections[1].statedPaidCents, -3410);
  });

  test("a report paid to another pharmacy is refused", () => {
    const r = readAccessHealthPayment(REPORT, "1111111");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /NCPDP 9999999, not this pharmacy's 1111111/);
  });

  test("a section with no plan name before it is refused rather than guessed", () => {
    const r = readAccessHealthPayment(REPORT.replace("PLAN ONE\nPLAN TWO\n", "PLAN ONE\n"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /repeats the name of the PLAN ONE section/);
  });
});
