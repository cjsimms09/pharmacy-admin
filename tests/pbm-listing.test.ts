import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parsePbmListing, binsIn, collisions } from "../src/lib/pbm-listing";

/*
 * The PSAO's listing as the spreadsheet reader hands it over: a title row, a header row beginning
 * "PBM", one row per PBM with newlines inside the cells, and a confidentiality footer. Identifiers
 * here are invented; the shape is the 2026 listing's.
 */
const sheet: string[][] = [
  ["   2026 PBM Contracted Listing ", "", "", ""],
  ["PBM", "Contracted\r\nLines of Business", "BINs*", "PBM Help Desk Numbers"],
  ["Alpha Rx (under Beta Network)", "Commercial & Extended Day\r\nVaccines", "610999", "P: 1-800-000-0001"],
  ["Beta Scripts\r\n(Gamma)", "Medicare D & Extended Day\r\nClearNetwork", "003001, 610999,  17001", "P: 800-000-0002\r\nE: help@beta.example"],
  ["Delta Health", "Discount Card Program", "Commercial BINs no longer active under Delta 02/02/24\r\n004001, 004002", ""],
  ["Epsilon", "Copay Program", "", "P: 800-000-0003"],
  [" McKesson Corporation confidential and proprietary", "", "", ""],
];

describe("the PSAO's contracted PBM listing", () => {
  test("a BIN cell yields six-digit BINs, restoring a leading zero a spreadsheet dropped", () => {
    assert.deepEqual(binsIn("003001, 610999,  17001"), ["003001", "610999", "017001"]);
    assert.deepEqual(binsIn("no numbers here"), []);
  });

  test("each PBM row is read with its lines of business, BINs and help desk; the title and footer are not rows", () => {
    const p = parsePbmListing(sheet);
    assert.equal(p.title, "2026 PBM Contracted Listing");
    assert.deepEqual(p.rows.map((r) => r.pbm), ["Alpha Rx (under Beta Network)", "Beta Scripts (Gamma)", "Delta Health", "Epsilon"]);
    assert.deepEqual(p.rows[1].linesOfBusiness, ["Medicare D & Extended Day", "ClearNetwork"]);
    assert.deepEqual(p.rows[1].bins, ["003001", "610999", "017001"]);
    assert.equal(p.rows[1].helpDesk, "P: 800-000-0002 E: help@beta.example");
    assert.match(p.rows[2].binNote ?? "", /no longer active/);
    assert.deepEqual(p.problems, ["Epsilon: no BIN on the row."]);
  });

  test("a BIN under two PBMs is a collision the listing states, not a choice to make", () => {
    const c = collisions(parsePbmListing(sheet).rows);
    assert.deepEqual([...c.entries()], [["610999", ["Alpha Rx (under Beta Network)", "Beta Scripts (Gamma)"]]]);
  });

  test("a sheet without the header is refused in words", () => {
    const p = parsePbmListing([["Drug", "Size", "NDC"], ["Acarbose", "100", "00054-0140-25"]]);
    assert.equal(p.rows.length, 0);
    assert.match(p.problems[0], /not the PSAO's contracted PBM listing/);
  });
});
