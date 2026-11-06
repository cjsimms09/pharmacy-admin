import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readRetailGrossProfit, looksLikeRetailGrossProfit } from "../src/lib/retail-gross-profit";
import { classify } from "../src/lib/autoroute";

/*
 * The layout PioneerRx's Retail Items Gross Profit Report arrived in from 1 November 2026, every item and figure invented: a title, the
 * period, a section per tax class each with its own totals, a sale below cost printed with its profit and per cent in brackets, and a grand
 * total whose profit is alone on the next line.
 */
const REPORT = [
  "﻿Retail Items Gross Profit Report",
  "Sale Date Between: 10/1/2026 and 10/31/2026Sale Time Between: 12:00:00 AM and 11:59:59 PM",
  "OTC",
  "Item Name",
  "Total Quantity,Total Paid,Total Preferred Cost,Total Gross Profit,GP %",
  "Example Vitamin 60ct,3.00,$30.00,$20.00,$10.00,33.33%",
  '"Example Brace, Large",1.00,"$1,000.00",$600.00,$400.00,40.00%',
  "Example Syrup 4oz,1.00,$10.00,$11.00,($1.00), (10.00%)",
  "OTC Totals:",
  '5.00,"$1,040.00",$631.00,"$409.00",39.33%',
  "OTC No Tax",
  "Item Name,Total Paid,Total Preferred Cost,Total Gross Profit,GP %",
  "Total Quantity",
  "Delivery Charge,1.00,$7.00,$0.00,$7.00,100.00%",
  "OTC No Tax Totals:",
  "1.00,$7.00,$0.00,$7.00,100.00%",
  "Total Quantity,Total Paid,Total Preferred Cost,Total Gross Profit,Total GP %",
  'Grand Total:,6.00,"$1,047.00",$631.00,39.73%',
  '"$416.00"',
  "Printed on: 11/5/2026 12:30:17 AM,Page 1 of 1",
].join("\n");

describe("the retail items gross profit report", () => {
  test("is recognised by its title, and routed as itself", () => {
    assert.equal(looksLikeRetailGrossProfit(REPORT), true);
    assert.equal(classify("Point of Sale Retail Item Gross Profit.txt", Buffer.from(REPORT)).kind, "retail_gross_profit");
  });

  test("reads every item, including a sale below cost and a name with a comma, and the period", () => {
    const r = readRetailGrossProfit(REPORT);
    assert.equal(r.items, 4);
    assert.equal(r.periodFrom, "2026-10-01");
    assert.equal(r.periodTo, "2026-10-31");
    assert.equal(r.paidCents, 104_700);
    assert.equal(r.costCents, 63_100);
    assert.equal(r.grossProfitCents, 41_600);
    assert.equal(r.unreadable.length, 0);
  });

  test("is proved only when the rows add up to the page's own grand total", () => {
    assert.equal(readRetailGrossProfit(REPORT).proved, true);
    assert.match(readRetailGrossProfit(REPORT).says, /add up to the grand total/);
  });

  test("a row lost from the page is not hidden: the total no longer agrees and the figures are not relied on", () => {
    const r = readRetailGrossProfit(REPORT.replace("Example Syrup 4oz,1.00,$10.00,$11.00,($1.00), (10.00%)\n", ""));
    assert.equal(r.proved, false);
    assert.match(r.says, /not relied on/);
  });

  test("a row whose profit is not its paid less its cost is not proved", () => {
    const r = readRetailGrossProfit(REPORT.replace("$30.00,$20.00,$10.00", "$30.00,$20.00,$11.00"));
    assert.equal(r.proved, false);
  });

  test("something else is not this report", () => {
    assert.equal(looksLikeRetailGrossProfit("Accrual System Sales Totals Summary"), false);
    assert.equal(readRetailGrossProfit("nothing here").items, 0);
  });
});
