import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mapSupplierColumns, unitCostFrom } from "../src/lib/suppliers";

/**
 * Supplier files disagree about everything, so the mapping is loose. What must never be loose is
 * the arithmetic: a unit cost that is wrong by a factor of the pack size turns a good buy into a
 * bad one and does it silently, because both numbers look plausible.
 */

describe("unitCostFrom", () => {
  test("a stated unit cost is taken as given, to five decimals", () => {
    const r = unitCostFrom("0.02410", "24.10", "1000");
    assert.equal(r.unitCostMicros, 24_100);
    assert.equal(r.how, "stated");
  });

  test("derives from pack cost and count when no unit cost is stated", () => {
    // $24.10 for 1000 tablets = $0.0241 each
    const r = unitCostFrom(undefined, "24.10", "1000");
    assert.equal(r.unitCostMicros, 24_100);
    assert.equal(r.how, "derived");
  });

  test("a sub-cent unit price survives the derivation", () => {
    // $2.41 per 1000 = $0.00241 each, which is zero in cents
    const r = unitCostFrom(undefined, "2.41", "1000");
    assert.equal(r.unitCostMicros, 2_410);
  });

  test("a fractional pack count still divides correctly", () => {
    // $47.32 for 473.176 mL
    const r = unitCostFrom(undefined, "47.32", "473.176");
    assert.equal(r.unitCostMicros, 100_005);
  });

  test("no count means no derivation — a pack cost alone is not a unit cost", () => {
    const r = unitCostFrom(undefined, "24.10", undefined);
    assert.equal(r.unitCostMicros, null);
    assert.equal(r.packCostCents, 2410);
    assert.equal(r.how, "none");
  });

  test("a zero count does not divide by zero or produce infinity", () => {
    const r = unitCostFrom(undefined, "24.10", "0");
    assert.equal(r.unitCostMicros, null);
  });

  test("no price at all is null throughout", () => {
    const r = unitCostFrom(undefined, undefined, "100");
    assert.equal(r.unitCostMicros, null);
    assert.equal(r.packCostCents, null);
  });

  test("formatted prices from a spreadsheet are read", () => {
    assert.equal(unitCostFrom(undefined, "$1,234.56", "100").unitCostMicros, 12_345_600);
  });
});

describe("mapSupplierColumns", () => {
  test("a McKesson-shaped header row", () => {
    const { map } = mapSupplierColumns(["NDC", "Item Description", "Manufacturer", "Pack Size", "Units Per Pack", "Net Cost", "Contract", "Availability"]);
    assert.equal(map.ndc, "NDC");
    assert.equal(map.description, "Item Description");
    assert.equal(map.packCost, "Net Cost");
    assert.equal(map.units, "Units Per Pack");
    assert.equal(map.contractFlag, "Contract");
  });

  test("a secondary wholesaler using different words", () => {
    const { map } = mapSupplierColumns(["NDC Number", "Product Name", "MFR", "Size", "Your Cost", "In Stock"]);
    assert.equal(map.ndc, "NDC Number");
    assert.equal(map.description, "Product Name");
    assert.equal(map.manufacturer, "MFR");
    assert.equal(map.packCost, "Your Cost");
    assert.equal(map.availability, "In Stock");
  });

  test("a stated unit price is not mistaken for a pack price", () => {
    const { map } = mapSupplierColumns(["NDC", "Description", "Unit Price", "Price"]);
    assert.equal(map.unitCost, "Unit Price");
    assert.equal(map.packCost, "Price");
  });

  test("columns we do not understand are reported", () => {
    const { unmapped } = mapSupplierColumns(["NDC", "Description", "Net Cost", "Rebate Tier", "Warehouse"]);
    assert.ok(unmapped.includes("Rebate Tier"));
    assert.ok(unmapped.includes("Warehouse"));
  });
});

describe("a catalogue's contract column, as the comparisons read it", () => {
  test("yes-words are rebated, no-words are not, and anything else cannot tell", async () => {
    const { contractFlagOf } = await import("../src/lib/suppliers");
    for (const y of ["Y", "yes", "1", "Contract", "OneStop", "rebated"]) assert.equal(contractFlagOf(y), "rebated", y);
    for (const n of ["N", "no", "0", "not rebated", "Off"]) assert.equal(contractFlagOf(n), "not rebated", n);
    for (const u of ["", "  ", "Q", "special"]) assert.equal(contractFlagOf(u), null, JSON.stringify(u));
  });
});
