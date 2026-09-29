import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readSalesByPayment, describeSalesByPayment } from "../src/lib/sales-by-payment";
import { classify } from "../src/lib/autoroute";

/*
 * The shape of PioneerRx's "System Sales Totals By Payment Type" as exported on 15 September 2026. Line
 * order, headings, four-decimal payment figures and two-decimal totals rows are the real report's; the
 * pharmacy and every figure are invented, and chosen so the report holds together.
 */
const REPORT = [
  "System Sales Totals By Payment Type",
  "Test Pharmacy",
  '"1 Main St, Wichita, KS 67000"',
  "(316) 000-0000 (f) (316) 000-0001",
  "9/14/2026 - 9/14/2026",
  "Cash,Check,Credit/Debit,A/R / Direct Dep,Coupons,Returns (Cash/Check),Returns (Credit/Debit),Returns (A/R / DD),Returns (Coupons),Totals",
  "Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Tax Collected,Tax Calculated",
  "Retail Sales",
  "OTC,10.0000,0.0000,97.5000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,100.0000,7.50,7.5000",
  "Retail Sales Totals:,10.00,0.00,97.50,0.00,0.00,0.00,0.00,0.00,0.00,100.00,7.50,7.5000",
  "Rx Sales",
  "Rx Plan Customer Payments",
  "Medicare Part D,1.2345,0.0000,50.7655,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,52.0000,0.00,0.0000",
  "Standard Third Party,0.0000,20.0000,300.0000,15.0000,0.0000,0.0000,-25.0000,0.0000,0.0000,310.0000,0.00,0.0000",
  "Rx Plan Third Party Remit",
  "Medicare Part D,,,,,,,,,,1000.0000,0.00,0.0000",
  "Standard Third Party,,,,,,,,,,-40.0000,0.00,0.0000",
  "Rx Sales Totals:,1.23,20.00,350.77,15.00,0.00,0.00,-25.00,0.00,0.00,1322.00,0.00,0.0000",
  "Sales Adjustments",
  "A/R Service & Finance Charges,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.00,0.0000",
  "Sales Adjustments Totals:,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.0000",
  "Totals:,11.23,20.00,448.27,15.00,0.00,0.00,-25.00,0.00,0.00,1422.00,7.50,7.5000",
  "Printed On: 9/15/2026,Page 1 of 1",
  "",
].join("\r\n");

describe("PioneerRx's sales by payment type", () => {
  test("is routed as itself, not as the monthly System Sales Summary its file name also matches", () => {
    const c = classify("Accrual_System_Sales_Totals_By_Payment_Type.txt", Buffer.from(REPORT));
    assert.equal(c.kind, "sales_by_payment");
  });

  test("reads how the day was paid, with card refunds netted and tax kept apart", () => {
    const r = readSalesByPayment(REPORT);
    assert.ok(r.ok, r.ok ? "" : r.why);
    const s = r.report;
    assert.equal(s.periodFrom, "2026-09-14");
    assert.equal(s.periodTo, "2026-09-14");
    assert.equal(s.printedOn, "2026-09-15");
    assert.equal(s.payments.card, 44827);
    assert.equal(s.payments.returnsCard, -2500);
    assert.equal(s.cardNetCents, 42327);
    assert.equal(s.payments.cash, 1123);
    assert.equal(s.payments.check, 2000);
    assert.equal(s.accountNetCents, 1500);
    assert.equal(s.retailCents, 10000);
    assert.equal(s.retailTaxCents, 750);
    assert.equal(s.rxPatientCents, 36200);
    assert.equal(s.rxRemitCents, 96000);
    assert.equal(s.totalCents, 142200);
  });

  test("a row whose payments do not come to its total with tax refuses the report", () => {
    const r = readSalesByPayment(REPORT.replace("OTC,10.0000,0.0000,97.5000", "OTC,10.0000,0.0000,99.5000"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /"OTC" payments come to \$109\.50/);
  });

  test("a totals row that is not the sum of its rows refuses it", () => {
    const r = readSalesByPayment(REPORT.replace("Rx Sales Totals:,1.23,20.00,350.77", "Rx Sales Totals:,1.23,20.00,360.77"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /"Rx Sales Totals:" Credit\/Debit/);
  });

  test("a column PioneerRx has renamed refuses it rather than reading the wrong figure", () => {
    const r = readSalesByPayment(REPORT.replace(",Credit/Debit,", ",Card,"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /"Credit\/Debit" column is missing/);
  });
});

/**
 * The "Other" block, which PioneerRx prints BELOW the Totals: line and does not include in it.
 *
 * On 17 September 2026 it carried one row — Customer A/R Payments, −$30.00 — and the reader summed
 * every parsed row into the grand-total check. It therefore reported the report's own total as
 * thirty dollars too high on both the card column and the Totals column, refused the whole day, and
 * that day's takings went unrecorded because of a section the report had correctly excluded.
 *
 * The exclusion is right and not a quirk: a Customer A/R payment is money collected against an
 * account billed earlier, not a sale made today. Counting it as takings would put the revenue in
 * twice — once when the sale was rung up, again when the customer settled.
 *
 * Every figure here is invented; the shape and the line order are the real report's.
 */
const WITH_OTHER = [
  "System Sales Totals By Payment Type",
  "Test Pharmacy",
  '"1 Main St, Wichita, KS 67000"',
  "(316) 000-0000 (f) (316) 000-0001",
  "9/14/2026 - 9/14/2026",
  "Cash,Check,Credit/Debit,A/R / Direct Dep,Coupons,Returns (Cash/Check),Returns (Credit/Debit),Returns (A/R / DD),Returns (Coupons),Totals",
  "Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Tax Collected,Tax Calculated",
  "Retail Sales",
  "OTC,0.0000,0.0000,200.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,180.0000,20.00,20.0000",
  "Retail Sales Totals:,0.00,0.00,200.00,0.00,0.00,0.00,0.00,0.00,0.00,180.00,20.00,20.0000",
  "Rx Sales",
  "Rx Plan Customer Payments",
  "Standard Third Party,50.0000,0.0000,100.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,150.0000,0.00,0.0000",
  "Rx Plan Third Party Remit",
  "Standard Third Party,,,,,,,,,,900.0000,0.00,0.0000",
  "Rx Sales Totals:,50.00,0.00,100.00,0.00,0.00,0.00,0.00,0.00,0.00,1050.00,0.00,0.0000",
  "Sales Adjustments",
  "A/R Service & Finance Charges,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.00,0.0000",
  "Sales Adjustments Totals:,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.0000",
  "Totals:,50.00,0.00,300.00,0.00,0.00,0.00,0.00,0.00,0.00,1230.00,20.00,20.0000",
  "Other",
  "Customer A/R Payments,0.0000,0.0000,-30.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,-30.0000,0.00,0.0000",
  "Other Totals:,0.00,0.00,-30.00,0.00,0.00,0.00,0.00,0.00,0.00,-30.00,0.00,0.0000",
  "Printed On: 9/15/2026,Page 1 of 1",
  "",
].join("\r\n");

describe("the Other block below the totals", () => {
  test("REGRESSION: a Customer A/R payment printed under Totals: does not make the day fail to balance", () => {
    const r = readSalesByPayment(WITH_OTHER);
    assert.ok(r.ok, r.ok ? "" : r.why);
  });

  test("the grand total is the three sales sections, and the A/R payment is not in the takings", () => {
    const r = readSalesByPayment(WITH_OTHER);
    assert.ok(r.ok);
    if (!r.ok) return;
    /* 200.00 retail + 100.00 Rx on the card column, and not the -30.00 below the line. */
    assert.equal(r.report.payments.card, 30000);
    assert.equal(r.report.payments.cash, 5000);
  });
});

/*
 * A Sunday. The shop is shut, so PioneerRx prints no sales sections at all — it leaves a section
 * off the page entirely where it has no rows — and the page carries the adjustments block, a
 * "Totals:" line of nought, and nothing else. Line for line the shape of 27 September 2026.
 */
const CLOSED_DAY = [
  "System Sales Totals By Payment Type",
  "Test Pharmacy",
  '"1 Main St, Wichita, KS 67000"',
  "(316) 000-0000 (f) (316) 000-0001",
  "9/27/2026 - 9/27/2026",
  "Cash,Check,Credit/Debit,A/R / Direct Dep,Coupons,Returns (Cash/Check),Returns (Credit/Debit),Returns (A/R / DD),Returns (Coupons),Totals",
  "Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Tax Collected,Tax Calculated",
  "Sales Adjustments",
  "A/R Service & Finance Charges,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.00,0.0000",
  "Sales Adjustments Totals:,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.0000",
  "Totals:,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0,0.00,0.0000",
  "Printed On: 9/27/2026,Page 1 of 1",
  "",
].join("\r\n");

describe("a day the shop was shut", () => {
  test("no sales sections and a nil total is a closed day, not a report that failed", () => {
    const r = readSalesByPayment(CLOSED_DAY);
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.report.nothingSold, true);
    assert.equal(r.report.totalCents, 0);
    assert.equal(r.report.cardNetCents, 0);
    assert.equal(r.report.retailCents, 0);
  });

  test("it says the till was read rather than listing nine noughts", () => {
    const r = readSalesByPayment(CLOSED_DAY);
    assert.ok(r.ok);
    assert.match(describeSalesByPayment(r.report), /nothing was sold/);
    assert.match(describeSalesByPayment(r.report), /read, not missed/);
  });

  /*
   * The guard that keeps the one above honest. A file cut off after a section of real sales is
   * missing the same rows a closed day is missing — the difference is that its printed grand total
   * still holds the sales that were cut away, so it must not become a quiet zero.
   */
  test("a file cut off mid-report is still refused, because its printed total is not nil", () => {
    const truncated = CLOSED_DAY.replace(
      "Totals:,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0,0.00,0.0000",
      "Totals:,11.23,20.00,448.27,15.00,0.00,0.00,-25.00,0.00,0.00,1422.00,7.50,7.5000",
    );
    const r = readSalesByPayment(truncated);
    assert.equal(r.ok, false);
  });

  /*
   * A day that opened and took nothing prints its sections with noughts in them, and reads the
   * same way — deliberately. The flag says nothing was sold, which is true of both, and the
   * sentence says so without claiming to know the shop was shut, which it cannot tell.
   */
  test("a day that printed its sections and still took nothing reads the same, and the words do not overclaim", () => {
    const openButEmpty = REPORT.replace(/,(-?[\d.]+)/g, (_m, n: string) => `,${Number(n) === 0 ? n : "0.0000"}`)
      .replace(/Totals:,[^\n\r]*/g, (m) => m.replace(/,(-?[\d.]+)/g, ",0.00"));
    const r = readSalesByPayment(openButEmpty);
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.report.nothingSold, true);
    assert.doesNotMatch(describeSalesByPayment(r.report), /no sales sections/);
  });
});

/*
 * A cash-price prescription: dispensed and sold without billing a plan, so it prints under its own
 * heading, "Non-Adjudicated Rx Sales". The reader matched Rx headings with /^Rx / and missed it, and
 * on 25 September 2026 that put $180.00 outside the Rx total, outside the grand total, and outside
 * the split between what patients paid and what plans remitted — four complaints about PioneerRx's
 * arithmetic on a report that added up perfectly.
 */
const WITH_NON_ADJUDICATED = [
  "System Sales Totals By Payment Type",
  "Test Pharmacy",
  '"1 Main St, Wichita, KS 67000"',
  "(316) 000-0000 (f) (316) 000-0001",
  "9/25/2026 - 9/25/2026",
  "Cash,Check,Credit/Debit,A/R / Direct Dep,Coupons,Returns (Cash/Check),Returns (Credit/Debit),Returns (A/R / DD),Returns (Coupons),Totals",
  "Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Amount,Tax Collected,Tax Calculated",
  "Retail Sales",
  "OTC,10.0000,0.0000,97.5000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,100.0000,7.50,7.5000",
  "Retail Sales Totals:,10.00,0.00,97.50,0.00,0.00,0.00,0.00,0.00,0.00,100.00,7.50,7.5000",
  "Rx Sales",
  "Non-Adjudicated Rx Sales",
  "Rx Direct Sales,0.0000,0.0000,180.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,180.0000,0.00,0.0000",
  "Rx Plan Customer Payments",
  "Medicare Part D,0.0000,0.0000,50.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,50.0000,0.00,0.0000",
  "Rx Plan Third Party Remit",
  "Standard Third Party,,,,,,,,,,1000.0000,0.00,0.0000",
  "Rx Sales Totals:,0.00,0.00,230.00,0.00,0.00,0.00,0.00,0.00,0.00,1230.00,0.00,0.0000",
  "Sales Adjustments",
  "A/R Service & Finance Charges,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,0.00,0.0000",
  "Sales Adjustments Totals:,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.0000",
  "Totals:,10.00,0.00,327.50,0.00,0.00,0.00,0.00,0.00,0.00,1330.00,7.50,7.5000",
  "Printed On: 9/25/2026,Page 1 of 1",
  "",
].join("\r\n");

describe("a prescription sold without billing a plan", () => {
  test("the report is read rather than refused for not adding up", () => {
    const r = readSalesByPayment(WITH_NON_ADJUDICATED);
    assert.ok(r.ok, r.ok ? "" : r.why);
  });

  test("its money is on the patients' side of the split, not in neither", () => {
    const r = readSalesByPayment(WITH_NON_ADJUDICATED);
    assert.ok(r.ok);
    assert.equal(r.report.rxPatientCents, 23_000, "$180.00 cash-price plus $50.00 of copay");
    assert.equal(r.report.rxRemitCents, 100_000);
  });

  test("the two halves come back to the prescription total the report prints", () => {
    const r = readSalesByPayment(WITH_NON_ADJUDICATED);
    assert.ok(r.ok);
    assert.equal(r.report.rxPatientCents + r.report.rxRemitCents, 123_000);
  });

  /*
   * The general form of the same fault. A heading nobody has seen before used to drop its rows out
   * of every total silently, and the reader then blamed PioneerRx's arithmetic. It now says which
   * heading it could not place, which is the one sentence somebody can act on.
   */
  test("a heading this reader cannot place is named rather than silently left out", () => {
    const withUnknown = WITH_NON_ADJUDICATED.replace("Non-Adjudicated Rx Sales", "Something Entirely New");
    const r = readSalesByPayment(withUnknown);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /Something Entirely New/);
    assert.match(r.ok ? "" : r.why, /does not place/);
  });
});
