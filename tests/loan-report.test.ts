import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeLoanReport, readLoanReport, describeLoanReport } from "../src/lib/loan-report";

/*
 * The shape of PioneerRx's "Loan Search Results" as it arrived on 30 September 2026, with invented
 * locations, drugs and figures. Every column runs into the next with no separator, which is the real
 * report's own layout and the reason the NDC is the anchor.
 *
 * It arrived as a scheduled delivery and was filed as "a PDF this does not recognise", with 35 sales
 * to a clinic and a surgery centre on it and nothing anywhere saying so.
 */
const REPORT = [
  "Loan Search Results",
  "Test Pharmacy",
  "Loan Type: Sale",
  "Loan Status: Active",
  "Prescriber or External LocationItemNDCQuantityPriceLoaned OnReturned OnStatusType",
  "Example Clinic (*1)AMIODARONE 150 MG/3 ML VIAL00143-9875-2575.00$38.449/1/2026PendingSale",
  "Example Surgery Center (*3)SODIUM CHLORIDE 0.9% SOL00264-7800-0036000.00$115.819/2/2026PendingSale",
  "DESTROYSValacyclovir Hcl 1 Gram Tablet16714-0697-0330.00$19.569/8/20269/8/2026PendingSale",
  "Example Clinic (*1)Botox 200 Unit Vial00023-3921-021.00$1,556.789/4/2026PendingSale",
  "Printed On: 9/30/2026Page 1 of 1",
  "",
].join("\n");

describe("PioneerRx's Loan Search Results", () => {
  test("it is recognised by its title and its column heading together", () => {
    assert.equal(looksLikeLoanReport(REPORT), true);
    assert.equal(looksLikeLoanReport("Loan Search Results\nnothing else at all"), false);
  });

  test("every row is read, and the quantity is not mistaken for part of the price", () => {
    const r = readLoanReport(REPORT);
    assert.ok(r);
    assert.equal(r.rows.length, 4);
    assert.equal(r.unreadable.length, 0);
    assert.equal(r.loanType, "Sale");
    assert.equal(r.loanStatus, "Active");
    assert.equal(r.printedOn, "2026-09-30");
    const botox = r.rows.find((x) => /Botox/i.test(x.item));
    assert.equal(botox?.quantity, 1);
    assert.equal(botox?.cents, 155_678, "a thousands separator in the price is not a quantity digit");
  });

  test("the NDC is kept the way every other code in this system is", () => {
    const r = readLoanReport(REPORT);
    assert.equal(r?.rows[0].ndc11, "00143987525");
  });

  /*
   * PioneerRx marks an external location `(*n)`, and that marker is the only place the prefix can be
   * cut honestly — location and drug name run together with no separator. Where there is no marker
   * the two cannot be told apart, so the whole prefix is kept rather than guessed at.
   */
  test("an external location is split from the drug on PioneerRx's own marker", () => {
    const r = readLoanReport(REPORT);
    const first = r!.rows[0];
    assert.equal(first.location, "Example Clinic (*1)");
    assert.equal(first.item, "AMIODARONE 150 MG/3 ML VIAL");
  });

  test("a row with no marker keeps its prefix whole rather than inventing a split", () => {
    const destroys = readLoanReport(REPORT)!.rows.find((x) => /Valacyclovir/i.test(x.item));
    assert.equal(destroys?.location, null);
    assert.match(destroys!.item, /^DESTROYS/);
  });

  test("a returned date is read where there is one, and null is a real state where there is not", () => {
    const r = readLoanReport(REPORT)!;
    assert.equal(r.rows.find((x) => /Valacyclovir/i.test(x.item))?.returnedOn, "2026-09-08");
    assert.equal(r.rows[0].returnedOn, null);
  });

  /*
   * The report prints no total, so there is nothing on the page to check the arithmetic against.
   * Every other reader here is proved by a figure its document states; this one cannot be, and the
   * sentence has to say so rather than presenting the sum as the report's own.
   */
  test("the sum is this reader's arithmetic and the sentence says so", () => {
    const r = readLoanReport(REPORT)!;
    assert.equal(r.addedUpCents, 3_844 + 11_581 + 1_956 + 155_678);
    const said = describeLoanReport(r);
    assert.match(said, /prints no total of its own/);
    assert.match(said, /Nothing is booked/);
  });

  test("a line carrying an NDC that cannot be read is counted, never dropped in silence", () => {
    const broken = REPORT.replace("75.00$38.449/1/2026PendingSale", "garbage");
    const r = readLoanReport(broken);
    assert.ok(r);
    assert.equal(r.rows.length, 3);
    assert.equal(r.unreadable.length, 1);
    assert.match(describeLoanReport(r), /could not be read/);
  });

  test("a page with the headings and no rows yields nothing rather than an empty report", () => {
    const empty = REPORT.split("\n").filter((l) => !/\d{5}-\d{4}-\d{2}/.test(l)).join("\n");
    assert.equal(readLoanReport(empty), null);
  });
});
