import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readSalesByPayment } from "../src/lib/sales-by-payment";
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
