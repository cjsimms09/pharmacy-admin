import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mapColumns, parseClaimDate, normalizeClaimNdc, resolvePayer } from "../src/lib/claims";
import { receivedCents } from "../src/lib/money";
import { excelSerialToIso, columnIndex } from "../src/lib/xlsx";

/**
 * Every claim that reaches a rate comparison passes through here. The failure that matters is
 * the quiet one: a column matched to the wrong field, or a payer attached on a guess. Both
 * produce a table that looks right and is wrong.
 */

describe("mapColumns against the real PioneerRx headers", () => {
  const headers = [
    "Rx Number", "Prescribed Item", "Dispensed Item Name", "Date Filled", "Written Quantity", "Pay Method",
    "Primary", "DAW", "Dispensed Quantity", "Acquisition Cost", "Gross Profit", "Dispensed Item NDC",
    "Primary Third Party", "Dispensed AWP", "Primary Group Number", "Primary Third Party Bin",
    "Primary Third Party PCN", "Primary Copay Amount", "Primary Remit Amount", "Primary Plan Type",
    "Primary Basis of Reimbursement", "Primary Network Reimbursement", "Primary Received EDI Plan ID",
    "Primary Third Party Pharmacy Service Type", "Primary Basis Of Cost Determination",
  ];
  const { map, unmapped } = mapColumns(headers);

  test("finds the routing key", () => {
    assert.equal(map.bin, "Primary Third Party Bin");
    assert.equal(map.pcn, "Primary Third Party PCN");
    assert.equal(map.groupNumber, "Primary Group Number");
    assert.equal(map.networkId, "Primary Network Reimbursement");
  });

  test("finds the money", () => {
    assert.equal(map.remit, "Primary Remit Amount");
    assert.equal(map.copay, "Primary Copay Amount");
    assert.equal(map.grossProfit, "Gross Profit");
    assert.equal(map.acquisition, "Acquisition Cost");
  });

  test('the bare "Primary" column does not steal the payer name from "Primary Third Party"', () => {
    assert.equal(map.payerLabel, "Primary Third Party");
  });

  test('"Written Quantity" is never taken for the dispensed quantity', () => {
    assert.equal(map.quantity, "Dispensed Quantity");
    assert.ok(!Object.values(map).includes("Written Quantity"));
  });

  test("columns we do not use are reported, not silently dropped", () => {
    assert.ok(unmapped.includes("Written Quantity"));
    assert.ok(unmapped.includes("Prescribed Item"));
  });

  test("a renamed export still maps", () => {
    const { map: m } = mapColumns(["Rx", "Fill Date", "BIN", "PCN", "Quantity Dispensed", "Days Supply", "Amount Paid"]);
    assert.equal(m.rxNumber, "Rx");
    assert.equal(m.dateFilled, "Fill Date");
    assert.equal(m.bin, "BIN");
    assert.equal(m.quantity, "Quantity Dispensed");
    assert.equal(m.daysSupply, "Days Supply");
  });
});

describe("dates", () => {
  test("the Excel serial PioneerRx actually sends", () => {
    assert.equal(parseClaimDate("46262"), "2026-08-28");
    assert.equal(excelSerialToIso(46262), "2026-08-28");
  });
  test("ISO and US formats", () => {
    assert.equal(parseClaimDate("2026-08-28"), "2026-08-28");
    assert.equal(parseClaimDate("8/28/2026"), "2026-08-28");
  });
  test("a number outside any plausible date range is not turned into one", () => {
    // A quantity or a dollar amount landing in the date column must not come back as a date.
    assert.equal(excelSerialToIso(30), null);
    assert.equal(excelSerialToIso(1_000_000), null);
    assert.equal(parseClaimDate("90"), null);
  });
  test("junk is null", () => {
    for (const v of ["", "  ", "n/a", "-", undefined]) assert.equal(parseClaimDate(v), null);
  });
});

describe("NDCs", () => {
  test("11 digits pass through, hyphens are stripped", () => {
    assert.equal(normalizeClaimNdc("83980001110"), "83980001110");
    assert.equal(normalizeClaimNdc("83980-0011-10"), "83980001110");
  });
  test("a leading zero lost to a numeric cell is restored", () => {
    assert.equal(normalizeClaimNdc("3858001101"), "03858001101");
  });
  test("anything else is null rather than padded into shape", () => {
    assert.equal(normalizeClaimNdc("123"), null);
    assert.equal(normalizeClaimNdc(""), null);
    assert.equal(normalizeClaimNdc("839800011101234"), null);
  });
});

describe("resolvePayer", () => {
  const byBin = new Map<string, Set<string>>([
    ["610455", new Set(["Prime Therapeutics"])],
    ["610502", new Set(["Aetna", "CVS Caremark"])],
  ]);
  const resolver = { resolve: (s: string) => ({ name: /aetna/i.test(s) ? "Aetna" : /humana/i.test(s) ? "Humana" : s }) };

  test("a BIN owned by one PBM settles it", () => {
    const r = resolvePayer("610455", "Prime", byBin, resolver);
    assert.equal(r.pbmName, "Prime Therapeutics");
    assert.equal(r.method, "bin");
  });

  test("a shared BIN is settled by a name that is one of its own candidates", () => {
    const r = resolvePayer("610502", "Aetna Medicare", byBin, resolver);
    assert.equal(r.pbmName, "Aetna");
    assert.equal(r.method, "bin_and_name");
    assert.equal(r.ambiguous, false);
  });

  test("a name that disagrees with the BIN does not win — the claim is marked ambiguous", () => {
    // Attaching this to Humana would put it under a contract that never priced it.
    const r = resolvePayer("610502", "Humana", byBin, resolver);
    assert.equal(r.pbmName, null);
    assert.equal(r.ambiguous, true);
  });

  test("a shared BIN with no name stays ambiguous", () => {
    const r = resolvePayer("610502", null, byBin, resolver);
    assert.equal(r.pbmName, null);
    assert.equal(r.ambiguous, true);
  });

  test("a BIN absent from the listing is unresolved, and is not the same as ambiguous", () => {
    const r = resolvePayer("610014", "610014 (MEDDPRIME)", byBin, resolver);
    assert.equal(r.pbmName, null);
    assert.equal(r.method, "unresolved");
    assert.equal(r.ambiguous, false, "an unlisted BIN is a missing contract, not a tie to break");
  });
});

describe("receivedCents", () => {
  test("what the payer sent plus what the patient paid", () => {
    assert.equal(receivedCents(718, 0), 718);
    assert.equal(receivedCents(40, 1000), 1040);
  });
  test("a missing half still counts the half we have", () => {
    assert.equal(receivedCents(718, null), 718);
    assert.equal(receivedCents(null, 500), 500);
  });
  test("both missing is null, not zero — unknown is not the same as unpaid", () => {
    assert.equal(receivedCents(null, null), null);
  });
});

describe("spreadsheet column references", () => {
  test("letters to index", () => {
    assert.equal(columnIndex("A1"), 0);
    assert.equal(columnIndex("Z9"), 25);
    assert.equal(columnIndex("AA1"), 26);
    assert.equal(columnIndex("BC12"), 54);
  });
});
