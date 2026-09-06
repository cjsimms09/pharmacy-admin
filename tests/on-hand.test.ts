import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseOnHand, looksLikeOnHand, countDate, mapHeader, onHandTotals } from "../src/lib/on-hand";

const tabbed = [
  "West Wichita Family Pharmacy — Inventory On Hand",
  "As Of: 9/6/2026",
  "",
  "NDC\tDescription\tItem Number\tQuantity On Hand\tUnit\tUnit Cost\tExtended Cost",
  "0093-1056-01\tLisinopril 10mg Tab\t123456\t180\tEA\t0.02410\t$4.34",
  "00378-1805-05\tMetformin 500mg Tab\t223344\t60.5\tEA\t0.01500\t",
  "",
  "Page 1 of 3",
].join("\n");

describe("reading a daily on-hand export", () => {
  test("reads the rows, the units and the value", () => {
    const p = parseOnHand(tabbed);
    assert.equal(p.problems.length, 0);
    assert.equal(p.rows.length, 2);
    const [lis, met] = p.rows;
    assert.equal(lis.ndc11, "00093105601");
    assert.equal(lis.description, "Lisinopril 10mg Tab");
    assert.equal(lis.quantityThousandths, 180_000);
    assert.equal(lis.valueCents, 434, "the printed extended cost is taken as printed");
    // No extended column on this line, so it is computed: 0.015 × 60.5 = $0.9075 → 91c.
    assert.equal(met.quantityThousandths, 60_500);
    assert.equal(met.valueCents, 91);
  });

  test("the count date comes off the labelled line", () => {
    assert.equal(parseOnHand(tabbed).countedOn, "2026-09-06");
    assert.equal(countDate("Report Run Date: 2026-08-31\n"), "2026-08-31");
    assert.equal(countDate("nothing here"), null);
  });

  test("commas, semicolons and pipes read the same as tabs", () => {
    for (const sep of [",", ";", "|"]) {
      const text = `Inventory On Hand\nAs Of: 9/6/2026\n\n${["NDC", "Description", "Quantity On Hand"].join(sep)}\n${["0093-1056-01", "Lisinopril", "180"].join(sep)}`;
      const p = parseOnHand(text);
      assert.equal(p.rows.length, 1, `separator ${JSON.stringify(sep)}`);
      assert.equal(p.rows[0].quantityThousandths, 180_000);
    }
  });

  test("a quoted description containing a comma does not split the row", () => {
    const text = 'Inventory On Hand\nNDC,Description,Quantity On Hand\n0093-1056-01,"Lisinopril 10mg, 100ct",180';
    const p = parseOnHand(text);
    assert.equal(p.rows[0].description, "Lisinopril 10mg, 100ct");
    assert.equal(p.rows[0].quantityThousandths, 180_000);
  });

  test("an unreadable quantity is refused, never read as an empty shelf", () => {
    const text = "Inventory On Hand\nNDC\tQuantity On Hand\n0093-1056-01\t\n00378-1805-05\t12";
    const p = parseOnHand(text);
    assert.equal(p.rows.length, 1);
    assert.equal(p.rows[0].ndc11, "00378180505");
    assert.equal(p.skipped["quantity unreadable"], 1);
  });

  test("a zero on hand is a real answer and is kept", () => {
    const p = parseOnHand("Inventory On Hand\nNDC\tQuantity On Hand\n0093-1056-01\t0");
    assert.equal(p.rows.length, 1);
    assert.equal(p.rows[0].quantityThousandths, 0);
  });

  test("one NDC on several lines is one shelf, added up", () => {
    const text = [
      "Inventory On Hand",
      "NDC\tQuantity On Hand\tExtended Cost",
      "0093-1056-01\t100\t$2.41",
      "0093-1056-01\t80\t$1.93",
    ].join("\n");
    const p = parseOnHand(text);
    assert.equal(p.rows.length, 1);
    assert.equal(p.rows[0].quantityThousandths, 180_000);
    assert.equal(p.rows[0].valueCents, 434);
  });

  test("columns it cannot place are named rather than dropped in silence", () => {
    const text = "Inventory On Hand\nNDC\tQuantity On Hand\tBin Location\tLot\n0093-1056-01\t10\tA4\tX1";
    const p = parseOnHand(text);
    assert.deepEqual(p.unmappedColumns, ["Bin Location", "Lot"]);
  });

  test("a file with no quantity column is refused with a reason, not read as empty", () => {
    const p = parseOnHand("Inventory On Hand\nNDC\tDescription\n0093-1056-01\tLisinopril");
    assert.equal(p.rows.length, 0);
    assert.match(p.problems[0], /quantity-on-hand/);
  });

  test("page furniture and repeated headers are not rows", () => {
    const text = [
      "Inventory On Hand",
      "NDC\tQuantity On Hand",
      "0093-1056-01\t10",
      "Page 2 of 3",
      "NDC\tQuantity On Hand",
      "00378-1805-05\t20",
      "Grand Total\t30",
    ].join("\n");
    const p = parseOnHand(text);
    assert.equal(p.rows.length, 2);
  });

  test("recognising the file, and not recognising a claims file", () => {
    assert.equal(looksLikeOnHand(tabbed), true);
    assert.equal(looksLikeOnHand("Rx Transaction Details\nRx\tStatus\tDate\n305766\tP\t09/01/2026"), false);
  });
});

describe("header mapping", () => {
  test("the many spellings of quantity on hand all land on it", () => {
    for (const h of ["Quantity On Hand", "QTY ON HAND", "On-Hand Qty", "QOH", "Current Quantity", "Stock on Hand"]) {
      const { mapping } = mapHeader(["NDC", h]);
      assert.equal(mapping.quantityThousandths, 1, h);
    }
  });

  test("a repeated meaning keeps the first column, not the last", () => {
    const { mapping } = mapHeader(["NDC", "Quantity On Hand", "Quantity"]);
    assert.equal(mapping.quantityThousandths, 1);
  });
});

describe("totals", () => {
  test("adds the units and the value", () => {
    const t = onHandTotals(parseOnHand(tabbed).rows);
    assert.equal(t.items, 2);
    assert.equal(t.unitsThousandths, 240_500);
    assert.equal(t.valueCents, 525);
  });

  test("no value anywhere reports null rather than zero", () => {
    const t = onHandTotals(parseOnHand("Inventory On Hand\nNDC\tQuantity On Hand\n0093-1056-01\t10").rows);
    assert.equal(t.valueCents, null);
  });
});

describe("routing an emailed count", () => {
  test("an on-hand export is recognised as a count, never as a price list", async () => {
    const { classify } = await import("../src/lib/autoroute");
    const c = classify("OnHandInventory_9_6_2026.txt", Buffer.from(tabbed, "utf8"));
    // It carries NDCs and unit costs, so a looser rule would file it as a supplier catalogue and
    // overwrite what the pharmacy pays with what it happens to hold.
    assert.equal(c.kind, "on_hand");
  });

  test("a supplier catalogue is not mistaken for a count", async () => {
    const { classify } = await import("../src/lib/autoroute");
    const catalog = [
      "Supplier Catalog Item Search Results",
      "Printed On: 9/5/2026",
      "McKesson",
      "Supplier Item Number\tName\tNDC\tOrder By Constant\tCost Per Unit",
      "123456\tLisinopril 10mg\t0093-1056-01\t(1) 100.00 EA\t0.02410",
    ].join("\n");
    assert.notEqual(classify("MCKCatalog_9_5_2026.txt", Buffer.from(catalog, "utf8")).kind, "on_hand");
  });
});
