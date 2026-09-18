import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseDispensedExport, mapDispensedColumns, exportDate, exportNdc } from "../src/lib/dispensed-export";

/*
 * PioneerRx's dispensed export as the sheet reader hands it over: the 51 headers in the report's
 * own words, one row per prescription. Identifiers invented; the column names are the real ones.
 */
const headers = [
  "Rx Number", "Dispensed Item Name", "Expiration Date", "Primary", "DAW", "Days Supply", "Refill Number", "Dispensed Quantity", "Dispensing Fee Paid", "Acquisition Cost",
  "Dispensed Item NDC", "Dispensed AWP", "Dispensed WAC Current", "Primary Group Number", "Primary Third Party Bin", "Secondary Third Party Bin", "Primary Third Party PCN", "Primary Copay Amount", "Secondary Remit Amount", "Primary Remit Amount",
  "Completed On", "Secondary Copay Amount", "Secondary Group Number", "Secondary Third Party PCN", "Primary Other Coverage Code", "Secondary Other Coverage Code", "Dispensed Item GCN", "Primary Basis of Reimbursement", "Primary Network Reimbursement", "DIR Fee",
  "Dispensed Item Price Basis", "Dispensed NADAC", "Filled On", "Net Profit", "Dispensed MAC", "Primary Basis Of Cost Determination", "Secondary Basis Of Cost Determination", "Evoucher Amount Paid", "Primary Received EDI Plan ID", "Secondary Received EDI Plan ID",
  "Primary Third Party Plan Code", "Secondary Claim Authorization Number", "Dispensed NADAC Changed On", "Primary Other Payer Amount Recognized", "Secondary Other Payer Amount Recognized", "Primary Patient Copay Method", "Secondary Patient Copay Method", "Primary Contract ID", "Secondary Contract ID", "Secondary Network Reimbursement", "SDRA",
];
const row = (over: Record<string, string>) => headers.map((h) => over[h] ?? "");

describe("PioneerRx's dispensed export", () => {
  test("every column the site uses is found by the report's own name", () => {
    const { map, unmapped } = mapDispensedColumns(headers);
    assert.equal(map.rxNumber, 0);
    assert.equal(map.awp, 11);
    assert.equal(map.pContract, 47);
    assert.equal(map.sNetwork, 49);
    assert.ok(unmapped.includes("SDRA"), "what the site does not read is named, not lost");
  });

  test("a row reads onto both payer sides, with money in cents and dates as days", () => {
    const p = parseDispensedExport([
      headers,
      row({
        "Rx Number": "100001", "Dispensed Item Name": "Wegovy 4 Mg Tablet", "Refill Number": "0", "Days Supply": "30", "Dispensed Quantity": "30", "DAW": "No Product Selection Indicated",
        "Dispensing Fee Paid": "0.4", "Acquisition Cost": "1308.55", "Dispensed Item NDC": "00169440431", "Dispensed AWP": "1618.821", "Dispensed WAC Current": "1349.01999", "Dispensed NADAC": "1304.4423",
        "Primary Third Party Bin": "19158", "Primary Third Party PCN": "CNRX", "Primary Group Number": "AC20029003", "Primary Copay Amount": "199", "Primary Remit Amount": "1132.07", "Primary Network Reimbursement": "NET=9180",
        "Secondary Third Party Bin": "610011", "Secondary Third Party PCN": "IRX", "Secondary Remit Amount": "461.89", "Secondary Copay Amount": "0",
        "Completed On": "46269.6576388889", "Filled On": "9/4/2026 2:28:45 PM", "Primary Contract ID": "CX1", "DIR Fee": "0", "Net Profit": "(8.24)",
      }),
    ]);
    assert.equal(p.problems.length, 0);
    assert.equal(p.rows.length, 1);
    const r = p.rows[0];
    assert.equal(r.primary.bin, "019158", "a five-digit BIN gets its leading zero back");
    assert.equal(r.primary.remitCents, 113207);
    assert.equal(r.primary.copayCents, 19900);
    assert.equal(r.primary.networkId, "NET=9180");
    assert.equal(r.primary.contractId, "CX1");
    assert.equal(r.secondary?.bin, "610011");
    assert.equal(r.secondary?.remitCents, 46189);
    assert.equal(r.awpCents, 161882);
    assert.equal(r.wacCents, 134902);
    assert.equal(r.nadacDispensedCents, 130444);
    assert.equal(r.daysSupply, 30);
    assert.equal(r.quantityThousandths, 30000);
    assert.equal(r.completedOn, "2026-09-04");
    assert.equal(r.filledOn, "2026-09-04");
    assert.equal(r.netProfitCents, -824, "a bracketed figure is a loss");
  });

  test("dates and NDCs as the export prints them", () => {
    assert.equal(exportDate("46269.44375"), "2026-09-04");
    assert.equal(exportDate("9/4/2026 9:57:01 AM"), "2026-09-04");
    assert.equal(exportDate(""), null);
    assert.equal(exportNdc("0169440431"), "00169440431", "a ten-digit NDC gets its leading zero back");
    assert.equal(exportNdc("169440431"), null, "nine digits is not an NDC");
    assert.equal(exportNdc("00169440431"), "00169440431");
    assert.equal(exportNdc("abc"), null);
  });

  test("a sheet that is not the export is refused in words", () => {
    const p = parseDispensedExport([["Drug", "Size", "NDC"], ["Acarbose", "100", "00054-0140-25"]]);
    assert.equal(p.rows.length, 0);
    assert.match(p.problems[0], /not PioneerRx's dispensed export/);
  });
});
