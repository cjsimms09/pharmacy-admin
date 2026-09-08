import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOnHand, looksLikeOnHand, countDate, mapHeader, onHandTotals, looksLikePioneerOnHand, readOnHand, packFrom, whyNotAnOnHandFile } from "../src/lib/on-hand";

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
    // The reason now names the column and lists the headings it did read, so a report one
    // heading away from working can be told from a file that was never a count at all.
    assert.match(p.problems[0], /missing a column named "Quantity On Hand"/);
    assert.match(p.problems[0], /NDC, Description/);
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

// ── PioneerRx's Inventory Search Results, which is the file this pharmacy actually sends ────────
//
// Copied from a real export, with the real page furniture and both inventory groups. The test
// cares most about the thing that is invisible when it is wrong: the Retail group counts packages
// where the Rx group counts dispensing units, so the same test strip is 100 on one shelf and
// "2 of a 100 EA package" on the other.

const pioneer = [
  "﻿Inventory Search Results with Lot Information",
  "West Wichita Family Pharmacy",
  '"8200 W Central Ave, Ste 5"',
  '"Wichita, KS 67212-3661"',
  "Inventory Group:,Rx",
  "Acamprosate Calc Dr 333 Mg Tab",
  "NDC/UPC:,68462-0435-18,On Hand:,180.00,Inventory Group Status:,Active",
  "Package Info:,180 EA,On Order:,0.00",
  "Item Status:,Active,Cost:,$0.62",
  "ACETAMINOPHEN 500 MG CAPLET",
  "NDC/UPC:,00904-6720-51,On Hand:,8.00,Inventory Group Status:,Active",
  "Package Info:,50 EA,On Order:,50.00",
  "Item Status:,Active,Cost:,$0.08",
  "Printed On: 9/6/2026,Page 1 of 225",
  "Inventory Search Results with Lot Information",
  "West Wichita Family Pharmacy",
  '"8200 W Central Ave, Ste 5"',
  '"Wichita, KS 67212-3661"',
  "ACCU-CHEK GUIDE TEST STRIP",
  "NDC/UPC:,65702-0712-10,On Hand:,100.00,Inventory Group Status:,Active",
  "Package Info:,100 EA,On Order:,0.00",
  "Item Status:,Active,Cost:,$0.41",
  "Inventory Group:,Retail",
  "ACCU-CHEK GUIDE TEST STRIP",
  "NDC/UPC:,365702712102,On Hand:,2.00,Inventory Group Status:,Active",
  "Package Info:,Package (100 EA),On Order:,0.00",
  "Item Status:,Active,Cost:,$0.41",
  "ABREVA 10% CREAM",
  "NDC/UPC:,307660801559,On Hand:,2.00,Inventory Group Status:,Active",
  "Package Info:,Package (2 GM),On Order:,0.00",
  "Item Status:,Active,Cost:,$8.85",
  "Item With No Code At All",
  "NDC/UPC:,,On Hand:,6.00,Inventory Group Status:,Active",
  "Package Info:,Package (1 EA),On Order:,0.00",
  "Item Status:,Active,Cost:,$1.00",
  "Printed On: 9/6/2026,Page 225 of 225",
].join("\n");

describe("reading PioneerRx's Inventory Search Results", () => {
  test("recognises it, and the generic reader does not have to", () => {
    assert.equal(looksLikePioneerOnHand(pioneer), true);
    assert.equal(looksLikeOnHand(pioneer), true, "autoroute files it as a count");
    assert.equal(looksLikePioneerOnHand(tabbed), false);
  });

  test("reads name, code, quantity, pack, cost and on order", () => {
    const p = readOnHand(pioneer);
    assert.equal(p.countedOn, "2026-09-06");
    const acam = p.rows.find((r) => r.code === "68462043518");
    assert.ok(acam);
    assert.equal(acam.description, "Acamprosate Calc Dr 333 Mg Tab");
    assert.equal(acam.inventoryGroup, "Rx");
    assert.equal(acam.quantityThousandths, 180_000);
    assert.equal(acam.packQty, 180);
    assert.equal(acam.unit, "EA");
    assert.equal(acam.unitCostMicros, 620_000);
    assert.equal(acam.valueCents, 11_160);
  });

  test("carries On Order, which is the whole reason a shelf can be short without being bought again", () => {
    const p = readOnHand(pioneer);
    const apap = p.rows.find((r) => r.code === "00904672051");
    assert.equal(apap?.quantityThousandths, 8_000);
    assert.equal(apap?.onOrderThousandths, 50_000);
  });

  test("the Retail group counts packages, and is multiplied out to dispensing units", () => {
    const p = readOnHand(pioneer);
    const retailStrip = p.rows.find((r) => r.code === "365702712102");
    assert.ok(retailStrip);
    assert.equal(retailStrip.countedInPackages, true);
    assert.equal(retailStrip.quantityThousandths, 200_000, "two boxes of a hundred, not two strips");
    assert.equal(retailStrip.valueCents, 8_200, "2 × 100 × $0.41");

    const abreva = p.rows.find((r) => r.code === "307660801559");
    assert.equal(abreva?.quantityThousandths, 4_000, "two 2 g tubes");
    assert.equal(abreva?.valueCents, 3_540, "$17.70 a tube, not 35 cents for both");
  });

  test("the Rx line for the same product is left in units, and the two do not collide", () => {
    const p = readOnHand(pioneer);
    const rxStrip = p.rows.find((r) => r.code === "65702071210");
    assert.equal(rxStrip?.quantityThousandths, 100_000);
    assert.equal(rxStrip?.countedInPackages, false);
    assert.equal(rxStrip?.inventoryGroup, "Rx");
  });

  test("a barcode is kept as a barcode and never presented as an NDC", () => {
    const p = readOnHand(pioneer);
    const retail = p.rows.filter((r) => r.inventoryGroup === "Retail");
    assert.ok(retail.length >= 2);
    for (const r of retail.filter((x) => x.codeKind === "upc")) {
      assert.equal(r.ndc11, null, "nothing may join a shampoo's barcode to a drug");
    }
    const rx = p.rows.find((r) => r.code === "68462043518");
    assert.equal(rx?.codeKind, "ndc11");
    assert.equal(rx?.ndc11, "68462043518");
  });

  test("an item with no code at all is refused and named, not counted as nothing", () => {
    const p = readOnHand(pioneer);
    assert.equal(p.rows.some((r) => r.description === "Item With No Code At All"), false);
    assert.equal(p.skipped["no NDC or barcode on the item"], 1);
    assert.equal(p.rowsRead, 6);
  });

  test("page furniture is not read as an item name", () => {
    const p = readOnHand(pioneer);
    for (const r of p.rows) {
      assert.doesNotMatch(r.description ?? "", /Printed On|Inventory Search|West Wichita|Wichita, KS|Central Ave/i);
    }
  });

  test("packFrom tells the two package forms apart", () => {
    assert.deepEqual(packFrom("180 EA"), { packQty: 180, unit: "EA", countsPackages: false });
    assert.deepEqual(packFrom("Package (100 EA)"), { packQty: 100, unit: "EA", countsPackages: true });
    assert.deepEqual(packFrom("Package (473 ML)"), { packQty: 473, unit: "ML", countsPackages: true });
    assert.deepEqual(packFrom(""), { packQty: null, unit: null, countsPackages: false });
  });

  test("a package count with no readable pack size is refused, because 2 of an unknown is not a number", () => {
    const broken = pioneer.replace("Package Info:,Package (2 GM),On Order:,0.00", "Package Info:,Package (),On Order:,0.00");
    const p = readOnHand(broken);
    assert.equal(p.rows.some((r) => r.code === "307660801559"), false);
    assert.equal(p.skipped["counted in packages with no readable pack size"], 1);
  });
});

/**
 * The first real count, made to land on the first try.
 *
 * Data health says no on-hand count has ever arrived, and nobody has seen a real file — so this
 * fixture is built from what PioneerRx's report designer offers rather than cut from something the
 * pharmacy sent. The point is that the day the owner exports one, it works, rather than being
 * debugged while he waits.
 */
describe("a PioneerRx inventory export", () => {
  const text = readFileSync(new URL("../fixtures/on-hand.txt", import.meta.url), "utf8");

  test("it is recognised as a count, so the inbox files it as one", () => {
    // "No on-hand count has ever arrived" may partly be "arrived and was filed as other".
    assert.equal(looksLikeOnHand(text), true);
  });

  test("the count date comes off the report, not off the clock", () => {
    assert.equal(readOnHand(text).countedOn, "2026-09-30");
  });

  test("every column the report prints is understood", () => {
    // An unmapped column is a column whose meaning was thrown away. Inventory Group was one until
    // now: the reader dropped it, so fileOnHand's split of the dispensing shelf from the front shop
    // fell back to guessing from the NDC alone.
    assert.deepEqual(readOnHand(text).unmappedColumns, []);
    assert.equal(readOnHand(text).rows.find((r) => r.code === "00093505698")?.inventoryGroup, "Rx");
    assert.equal(readOnHand(text).rows.find((r) => r.codeKind === "upc")?.inventoryGroup, "Front Shop");
  });

  test("a front-shop barcode is kept, as the other report shape keeps it", () => {
    // parsePioneerOnHand reads the same stock out of the four-line report and keeps a UPC. This
    // path asked for an NDC and dropped it, so one shelf valued differently depending on which
    // export was sent — two readers of one thing disagreeing, which is the fault that keeps
    // recurring here.
    const upc = readOnHand(text).rows.find((r) => r.codeKind === "upc");
    assert.ok(upc, "a twelve-digit barcode is a real front-shop item, not an unreadable NDC");
    assert.equal(upc!.ndc11, null, "and it still carries no NDC, so nothing prices it against NADAC");
  });

  test("a partial bottle keeps its decimals", () => {
    // 3.5 mL of a suspension is three and a half millilitres, not three and not four.
    assert.equal(readOnHand(text).rows.find((r) => r.code === "00093416073")?.quantityThousandths, 3_500);
  });

  test("A ROW WITH NO QUANTITY IS SKIPPED, NEVER FILED AS ZERO", () => {
    // The whole point. A zero says the shelf is empty and the buy list acts on it; a skip says
    // nobody knows, which is the truth.
    const parsed = readOnHand(text);
    assert.equal(parsed.rowsRead, 7);
    assert.equal(parsed.rows.length, 6);
    assert.equal(parsed.skipped["quantity unreadable"], 1);
    assert.ok(!parsed.rows.some((r) => r.quantityThousandths === 0));
    assert.ok(!parsed.rows.some((r) => r.code === "00093145306"), "the row with no quantity must not be stored at all");
  });
});

describe("a file that is not a count says which column it wanted", () => {
  const lines = (s: string) => s.split(/\r?\n/);

  test("the missing column is named, and so are the headings it did read", () => {
    // "No header row carrying both an NDC column and a quantity-on-hand column" is true and
    // useless: a report one heading away from working fails identically to a photograph of a shelf,
    // and the pharmacist cannot tell which it is.
    const why = whyNotAnOnHandFile(lines("Inventory Search Results\nItem Number\tDescription\tNDC\tUnit\n1\tX\t00093505698\tEA"));
    assert.match(why, /missing a column named "Quantity On Hand"/);
    assert.match(why, /Item Number, Description, NDC, Unit/);
  });

  test("a missing NDC column is named just as plainly", () => {
    const why = whyNotAnOnHandFile(lines("Stock\nItem Number\tDescription\tQuantity On Hand\n1\tX\t5"));
    assert.match(why, /missing a column named "NDC"/);
  });

  test("both missing is said as both", () => {
    const why = whyNotAnOnHandFile(lines("Report\nItem Number\tDescription\tUnit\n1\tX\tEA"));
    assert.match(why, /"NDC".*and.*"Quantity On Hand"/s);
  });

  test("a file with no table at all is told that, not given a column list", () => {
    const why = whyNotAnOnHandFile(lines("Inventory as of today\nnothing here is a table"));
    assert.match(why, /exported as text or CSV rather than a PDF or a picture/);
  });

  test("the refusal reaches the caller rather than an empty count", () => {
    // fileOnHand returns { ok: false, why } from problems[0], so this sentence is what the
    // pharmacist sees on the page.
    const parsed = readOnHand("Inventory Search Results\nItem Number\tDescription\tNDC\tUnit\n1\tX\t00093505698\tEA");
    assert.equal(parsed.rows.length, 0);
    assert.match(parsed.problems[0], /missing a column named "Quantity On Hand"/);
  });
});

/*
 * The wrapped line that arrives at full width, and the real loss it must not be confused with.
 *
 * The 8 September count read 1,774 lines against the 1,772 records the report says it holds, with
 * exactly two rows skipped for "no NDC". The narrow-line test could not have caught those two: a
 * manufacturer that wraps can still fill the row's whole width, and such a line was counted as a
 * record and then dropped as a product whose NDC had gone missing.
 *
 * That is the reader's own warning coming true in the direction nobody looked for. Not products
 * lost — products invented and then mourned. The shelf was never short by two; the count of what
 * was read was long by two, and the skip list named two losses that never happened, which is the
 * worse half because somebody would go looking for them.
 *
 * The distinction these hold is the only one that matters: a record carries a code or a quantity.
 * A line with neither is a tail wherever its text landed. A line with one of them is a record, and
 * a record missing its NDC is a genuine loss that must still be counted and named.
 */
describe("a wrapped manufacturer that fills the whole row", () => {
  const header = "Item Number\tDescription\tNDC\tInventory Group\tQuantity On Hand\tUnit\tUnit Cost\tExtended Cost";
  const good = "100234\tATORVASTATIN 20MG TAB 90\t00093505698\tRx\t270.000\tEA\t$0.0241\t$6.51";
  const read = (...rows: string[]) => parseOnHand(["Inventory Search Results", "Count Date:\t9/30/2026", header, ...rows].join("\n"));

  test("a tail whose text lands in the description column is not a record", () => {
    const p = read(good, "\tAMNEAL PHARMACEUTICALS, LLC\t\t\t\t\t\t");
    assert.equal(p.rowsRead, 1, "one record was read, not two");
    assert.equal(p.continuations, 1);
    assert.equal(p.rows.length, 1);
    assert.equal(p.skipped["no NDC"], undefined, "a loss that never happened must not be reported as one");
  });

  test("a tail whose text lands in the NDC column is not a record either", () => {
    // The first guard asked whether the NDC cell was empty, and this is the line that defeated it:
    // same tail, different column, counted and then dropped as an unreadable code.
    const p = read(good, "\t\tAMNEAL PHARMACEUTICALS, LLC\t\t\t\t\t");
    assert.equal(p.rowsRead, 1);
    assert.equal(p.continuations, 1);
    assert.equal(p.skipped["code is neither an NDC nor a barcode"], undefined);
  });

  test("a real product whose NDC cell is empty is still a record, and still a reported loss", () => {
    // It carries a quantity, which is what says a shelf item is behind it. This one is genuinely
    // missing and the count must go on saying so.
    const p = read(good, "100241\tCEFDINIR 300MG CAP 20\t\tRx\t40.000\tEA\t$0.1900\t$7.60");
    assert.equal(p.rowsRead, 2);
    assert.equal(p.continuations, 0);
    assert.equal(p.skipped["no NDC"], 1);
    assert.equal(p.rows.length, 1);
  });

  test("a real product with an unreadable code is still a record, because it has a quantity", () => {
    const p = read(good, "100242\tSHELF TALKER\tNOT-A-CODE\tRx\t3.000\tEA\t$1.0000\t$3.00");
    assert.equal(p.rowsRead, 2);
    assert.equal(p.skipped["code is neither an NDC nor a barcode"], 1);
  });

  test("the report's own record count and the lines read now agree, which is the whole point", () => {
    /*
     * Two tails among four records: the arithmetic that was 1,774 against 1,772 in miniature.
     * Before this, rowsRead was 6 and the report said 4.
     */
    const p = read(
      "Total Record Count: 4",
      good,
      "100235\tMETFORMIN HCL ER 500MG TAB 100\t00093105301\tRx\t1400.000\tEA\t$0.0189\t$26.46",
      "\tAMNEAL PHARMACEUTICALS, LLC\t\t\t\t\t\t",
      "100236\tGABAPENTIN 300MG CAP 100\t00093571401\tRx\t820.000\tEA\t$0.0402\t$32.96",
      "\t\tINC/GNP\t\t\t\t\t",
      "100237\tMOUNJARO 12.5MG/0.5ML PEN\t00002150680\tRx\t4.000\tEA\t$212.4400\t$849.76",
    );
    assert.equal(p.reportedCount, 4);
    assert.equal(p.rowsRead, 4, "the lines read now equal the records the report claims");
    assert.equal(p.continuations, 2);
    assert.equal(p.rows.length, 4);
  });
});
