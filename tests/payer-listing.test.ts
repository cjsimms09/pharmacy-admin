import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parsePayerListing, reconcileListing } from "../src/lib/payer-listing";

/** The reconciliation service's payer list: two columns, the PSAO marker on the name, a totals line. */
const CSV = `Payer name,BIN number
OptumRx (HMA),610011
Caremark (HMA),004336
Kansas Medicaid,600428
DST/Argus GLP-1 bridge,600428
_Totals,
RedSail Discount card program,
`;

describe("reading the listing", () => {
  test("names and BINs, the PSAO read off the name, totals and blank BINs left out", () => {
    const rows = parsePayerListing(CSV);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], { bin: "610011", rawName: "OptumRx (HMA)", cleanName: "OptumRx", viaPsao: "HMA" });
    assert.deepEqual(rows[2], { bin: "600428", rawName: "Kansas Medicaid", cleanName: "Kansas Medicaid", viaPsao: null });
  });
});

describe("against the crosswalk", () => {
  test("new BINs are added, agreeing ones keep the spelling as an alias, disagreeing ones are a conflict for a person", () => {
    const r = reconcileListing(parsePayerListing(CSV), [{ bin: "004336", pbmName: "CVS Caremark" }, { bin: "600428", pbmName: "Kansas Medicaid" }], (l) => (l === "Caremark" ? "CVS Caremark" : l));
    assert.deepEqual(r.add.map((x) => x.bin), ["610011"]);
    assert.deepEqual(r.same.map((x) => [x.bin, x.canonical]), [["004336", "CVS Caremark"], ["600428", "Kansas Medicaid"]]);
    assert.deepEqual(r.conflict.map((x) => [x.bin, x.cleanName, x.listedAs]), [["600428", "DST/Argus GLP-1 bridge", "Kansas Medicaid"]]);
  });
});
