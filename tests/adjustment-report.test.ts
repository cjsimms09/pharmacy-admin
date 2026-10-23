import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAdjustmentReport, takenByMonth } from "../src/lib/adjustment-report";

/*
 * The reconciliation service's adjustment report, in its own shape, with invented numbers. The footer is the gate:
 * a report whose lines do not add to its own total is refused.
 */
const HEAD = "Location,Location Name,Adjustment Code,Adjustment Identifier,Adjustment Amount,Remittance Number,Remit Date,Posted Date,Payer Name,Document Sequence Number,Line Item Number";
const report = (...body: string[]) => [HEAD, ...body].join("\r\n");
const good = report(
  "1000001,Example Pharmacy (1000001),AH,32T,-17,9000001,9/22/2026,9/19/2026,EXAMPLE SCRIPTS INC,5E+14,1",
  "1000001,Example Pharmacy (1000001),AH,32T,-15.2,9000002,9/15/2026,9/11/2026,EXAMPLE SCRIPTS INC,5E+14,1",
  "1000001,Example Pharmacy (1000001),CS,AH[MEDONE01],-0.3,EFT-90000001,9/16/2026,9/17/2026,Example Atlas,5E+14,1",
  "1000001,Example Pharmacy (1000001),CS,AH[MEDONE01],-0.18,EFT-90000002,8/31/2026,9/1/2026,Example Atlas,5E+14,1",
  ",,,,,,,,,,",
  ",,,,-32.68,,,,,,",
);

describe("the adjustment report", () => {
  test("reads every line, checks the footer, names what each payer took and by which code", () => {
    const r = parseAdjustmentReport(good, "Example_Pharmacy_1000001_Adjustment_Report_20260901_20260930.csv");
    assert.ok(r.ok, (r as { why?: string }).why);
    if (!r.ok) return;
    assert.equal(r.lines.length, 4);
    assert.equal(r.totalCents, -3_268);
    assert.deepEqual([r.periodFrom, r.periodTo], ["2026-09-01", "2026-09-30"]);
    assert.deepEqual(r.lines[0], { code: "AH", identifier: "32T", amountCents: -1_700, remittanceNumber: "9000001", remitOn: "2026-09-22", postedOn: "2026-09-19", payer: "EXAMPLE SCRIPTS INC", lineItem: "1" });
    assert.match(r.says, /4 adjustments, \$32\.68 taken: EXAMPLE SCRIPTS INC 2 \(\$32\.20, AH origination fee\); Example Atlas 2 \(\$0\.48, CS adjustment\)/);
  });
  test("by the remittance's month, positive where the payer took money", () => {
    const r = parseAdjustmentReport(good);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual([...takenByMonth(r.lines)], [["2026-09", 3_250], ["2026-08", 18]]);
  });
  test("a report whose lines do not add to its own total is refused, with both figures", () => {
    const bad = good.replace(",,,,-32.68,,,,,,", ",,,,-40.00,,,,,,");
    const r = parseAdjustmentReport(bad);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.why, /\$32\.68.*\$40\.00/);
  });
  test("a report with no total line, or the wrong header, is refused", () => {
    assert.equal(parseAdjustmentReport(report("1000001,Example Pharmacy (1000001),AH,32T,-17,9000001,9/22/2026,9/19/2026,EXAMPLE SCRIPTS INC,5E+14,1")).ok, false);
    assert.equal(parseAdjustmentReport("Rx Number,Status,Amount\n900000-0,P,$1.00").ok, false);
  });
});
