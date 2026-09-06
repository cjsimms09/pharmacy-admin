import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSystemSales, salesCents, looksLikeSystemSales } from "../src/lib/system-sales";

/**
 * The System Sales Summary: the only report the pharmacy has that carries the whole till.
 *
 * Every other figure on this site is dispensing. This one includes the front of shop, and it is
 * drawn by the calendar month rather than by the day a claim was transmitted — so it is the number
 * that reconciles against the bank, and the one thing that can say what the business actually took.
 *
 * The fixture is a real August, to the cent.
 */
const AUGUST = [
  "﻿System Sales Summary",
  "West Wichita Family Pharmacy",
  '"8200 W Central Ave, Ste 5 Wichita, KS 67212-3661"',
  "(316) 491-6428 (f) (316) 512-4001",
  "8/1/2026 - 8/31/2026",
  "Sales,Discounts,Returns,Subtotal,Tax Calculated,Total",
  "Amount,Amount,Amount",
  "Retail Sales",
  "OTC,5760.42,-656.02,-26.39,5078.01,380.8665,5458.8800",
  "Retail Sales Totals:,5760.42,-656.02,-26.39,5078.01,380.8665,5458.8800",
  "Rx Sales",
  "Rx Plan Customer Payments",
  "Cash,0.00,0.00,0.00,0.00,0.0000,0.0000",
  "Medicare Part D,8813.73,0.00,-18.42,8795.31,0.0000,8795.3100",
  "RxLocal,19859.50,0.00,-283.87,19575.63,0.0000,19575.6300",
  "Standard Third Party,64997.37,-14.83,-93.92,64888.62,0.0000,64888.6200",
  "Worker's Comp,0.00,0.00,0.00,0.00,0.0000,0.0000",
  "Rx Plan Customer Payments Subtotals:,93670.60,-14.83,-396.21,93259.56,0.0000,93259.5600",
  "Rx Plan Third Party Remit",
  "Cash,0.00,0.00,0.00,0.00,0.0000,0.0000",
  "Medicare Part D,108701.75,0.00,-16764.22,91937.53,0.0000,91937.5300",
  "RxLocal,2964.43,0.00,-3009.00,-44.57,0.0000,-44.5700",
  "Standard Third Party,576498.52,0.00,-97750.72,478747.80,0.0000,478747.8000",
  "Worker's Comp,98.18,0.00,40.00,138.18,0.0000,138.1800",
  "Rx Plan Third Party Remit Subtotals:,688262.88,0.00,-117483.94,570778.94,0.0000,570778.9400",
  "Rx Sales Totals:,781933.48,-14.83,-117880.15,664038.50,0.0000,664038.5000",
  "Sales Adjustments",
  "A/R Service & Finance Charges,0.00,0.00,0.00,0.00,0.0000,0.0000",
  "Sales Adjustments Totals:,0.00,0.00,0.00,0.00,0.0000,0.0000",
  "Totals:,787693.90,-670.85,-117906.54,669116.51,380.8665,669497.3800",
  "Other",
  "Customer A/R Payments,-11.86,0.00,0.00,-11.86,0.0000,-11.8600",
  "Other Totals:,-11.86,0.00,0.00,-11.86,0.0000,-11.8600",
  "Printed On: 9/5/2026,Page 1 of 1",
].join("\r\n");

const parsed = parseSystemSales(AUGUST);

describe("reading a month's takings", () => {
  test("it is recognised by its title, and by the name it is exported under", () => {
    assert.equal(looksLikeSystemSales(AUGUST), true);
    assert.equal(looksLikeSystemSales("something else", "Accrual_System_Sales_Totals_Summary.txt"), true);
    assert.equal(looksLikeSystemSales("Rx Transaction Details By Submission Type"), false);
  });

  test("the month it covers, so it can be filed against one", () => {
    assert.deepEqual(parsed.period, { from: "2026-08-01", to: "2026-08-31" });
    assert.equal(parsed.month, "2026-08");
    assert.equal(parsed.printedOn, "2026-09-05");
    assert.deepEqual(parsed.problems, []);
  });

  test("the whole till, and the three genuinely different things inside it", () => {
    /*
     * Front of shop, what patients handed over, and what the plans remitted. Nothing else on this
     * site can see the first of those at all — the transaction report is dispensing only, so read
     * as total revenue it understates the business by every OTC sale in the month.
     */
    assert.equal(parsed.retailCents, 545_888, "$5,458.88 over the counter");
    assert.equal(parsed.rxPatientCents, 9_325_956, "$93,259.56 from patients");
    assert.equal(parsed.rxRemitCents, 57_077_894, "$570,778.94 from the plans");
    assert.equal(parsed.rxCents, 66_403_850, "$664,038.50 of prescriptions");
    assert.equal(parsed.totalCents, 66_949_738, "$669,497.38 in total");
  });

  test("retail plus prescriptions is the total the report itself printed", () => {
    // The check that the three figures above were read off the right lines rather than plausible ones.
    assert.equal(parsed.retailCents! + parsed.rxCents!, parsed.totalCents);
  });

  test("a totals line belongs to the section it closes, not the last heading printed", () => {
    /*
     * "Rx Sales Totals:" is printed after the two sub-headings nested inside Rx Sales, so the
     * heading in hand when it arrives is "Rx Plan Third Party Remit". Filing $664,038.50 of all
     * prescription sales under third-party remittance would lose the only line that adds the two
     * halves together — and would overstate what the plans paid by $93,259.56.
     */
    const rxTotal = parsed.rows.find((r) => r.section === "Rx Sales" && r.kind === "subtotal");
    assert.ok(rxTotal, "the Rx Sales total is filed under Rx Sales");
    assert.equal(rxTotal!.totalCents, 66_403_850);
  });

  test("the same label under two headings stays two different figures", () => {
    /*
     * "Medicare Part D" appears twice: $8,795.31 of patient payments and $91,937.53 of plan
     * remittance. Read as one list they would be added together under a single name.
     */
    const partD = parsed.rows.filter((r) => r.label === "Medicare Part D");
    assert.equal(partD.length, 2);
    assert.equal(partD.find((r) => r.section === "Rx Plan Customer Payments")!.totalCents, 879_531);
    assert.equal(partD.find((r) => r.section === "Rx Plan Third Party Remit")!.totalCents, 9_193_753);
  });

  test("A/R movement is kept but is not takings", () => {
    // "Other Totals:" sits below the grand total and is not part of it. Adding it would be wrong twice.
    const other = parsed.rows.find((r) => r.section === "Other" && r.kind === "subtotal");
    assert.equal(other!.totalCents, -1_186);
    assert.equal(parsed.totalCents, 66_949_738, "the grand total is unaffected by it");
  });

  test("returns are already in the figures, and they are not small", () => {
    // $117,880.15 of returns in one month. A reader that dropped this column would be wildly out.
    const rxTotal = parsed.rows.find((r) => r.section === "Rx Sales" && r.kind === "subtotal")!;
    assert.equal(rxTotal.returnsCents, -11_788_015);
    assert.equal(rxTotal.salesCents! + rxTotal.discountsCents! + rxTotal.returnsCents!, rxTotal.subtotalCents);
  });

  test("a row whose columns do not add up is reported rather than kept quietly", () => {
    /*
     * The only defence against the columns moving. A shifted layout gives figures that are each
     * individually plausible, and nothing else here could notice.
     */
    const bent = parseSystemSales(
      ["System Sales Summary", "8/1/2026 - 8/31/2026", "Retail Sales", "OTC,100.00,0.00,0.00,999.00,0.0000,999.0000"].join("\r\n"),
    );
    assert.ok(bent.problems.some((p) => /does not add up/.test(p)));
  });

  test("four-decimal figures round to the cent rather than truncating", () => {
    assert.equal(salesCents("380.8665"), 38_087);
    assert.equal(salesCents("-656.02"), -65_602);
    assert.equal(salesCents(""), null);
    assert.equal(salesCents("Totals:"), null);
  });
});
