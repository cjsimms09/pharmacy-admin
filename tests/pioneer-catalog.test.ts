import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parsePioneerCatalog,
  detectSeparator,
  splitRow,
  ndc11FromHyphenated,
  supplierFromFileName,
  dateFromFileName,
  canonicalSupplier,
  looksLikePioneerCatalog,
  describeFileName,
} from "../src/lib/pioneer-catalog";

/**
 * PioneerRx's supplier catalogue export, which arrives every Monday, one file per supplier.
 *
 * It is a printed report saved as text rather than a spreadsheet, so most of what can go wrong is
 * structural: the supplier is a line above its block, page footers interleave with data, and the
 * separator changed between the first hand export and the scheduled one.
 */
const semi = (sep = ";") =>
  [
    "﻿Supplier Catalog Item Search Results",
    "McKesson",
    `${sep}Cost Per Unit`,
    ["Supplier Item Number", "Name", "NDC", "Order By Constant"].join(sep),
    ["721021", "METFORMIN HCL 850 MG TAB 500", "23155-0842-05", " (1) 500.00 EA", "0.0500"].join(sep),
    ["740097", "METFORMIN HCL 850 MG TAB (11/24EXP) 500", "23155-0842-05", " (1) 500.00 EA", "0.0040"].join(sep),
    ["603510", "DICLOFENAC SOD TOPICAL SL 2%", "13107-0269-47", " (1) 112.00 GM", "0.4654"].join(sep),
    ["999999", "SHELF LABELS 1000", "", " (1) 1000.00 EA", "3.0000"].join(sep),
    ["000001", "FREEBIE", "00000-0001-01", " (1) 1.00 EA", "0.0000"].join(sep),
    `Printed On: 9/5/2026 11:29 AM${sep}Page 1 of 2`,
    "IPD",
    ["A1", "METFORMIN HCL 850MG TAB 500CT", "23155-0842-05", " (1) 500.00 EA", "0.0480"].join(sep),
    `Printed On: 9/5/2026 11:29 AM${sep}Page 2 of 2`,
  ].join("\r\n");

/** The scheduled Monday file: a sixth "rebate package cost" column whose presence, not value, matters. */
const withRebate = () =>
  [
    "﻿Supplier Catalog Item Search Results",
    "McKesson",
    ",Cost Per Unit,Rebate Package Cost",
    "Supplier Item Number,Name,NDC,Order By Constant",
    "721021,METFORMIN HCL 850 MG TAB 500,23155-0842-05, (1) 500.00 EA,0.0500,12.34",
    "603510,DICLOFENAC SOD TOPICAL SL 2%,13107-0269-47, (1) 112.00 GM,0.4654,",
    "740097,METFORMIN HCL 850 MG TAB (11/24EXP) 500,23155-0842-05, (1) 500.00 EA,0.0040,12.34",
    "111111,ZERO FILLED NOT REBATED,00002-1436-11, (1) 1.00 EA,739.11,0.00",
    '222222,"VIALS 13DR PUSH DOWN,TURN GRN",50242-0040-62, (1) 1.00 EA,0.5000,',
    "Printed On: 9/8/2026 6:02 AM,Page 1 of 1",
  ].join("\r\n");

/**
 * The scheduled Monday file as it really arrives: tab-separated, the header's sixth column on its
 * own line, most items split across two lines with the pack and cost on a line that may come before
 * or after the item, and the rebate figure rendered wherever the report engine found room — on a
 * line of its own next to a single-line item, or in the empty pack column of a split one.
 */
const scheduled = (sep = "\t") =>
  [
    "\ufeffSupplier Catalog Item Search Results",
    "McKesson",
    "Supplier: McKessonStatus: Available",
    ["Supplier Item Number", "Name", "NDC", "Package Size", "Cost Per Unit"].join(sep),
    "Rebate Pck Cost",
    // split item, price after, not rebated
    ["3925302", ".15ML MD MINI PMP BL MED 100DS", "38779-6254-02", ""].join(sep),
    [" (1) 100.00 EA", "3.7706"].join(sep),
    // split item, price BEFORE it, not rebated
    [" (1) 1.00 EA", "8.0900"].join(sep),
    ["1768217", "A M TAPE LABEL RX  2X72YD", "", ""].join(sep),
    // single-line rebated item whose rebate figure follows on its own line
    ["3637774", "ABACAV LAM TB 600 300MG CIP30@", "69097-0362-02", " (1) 30.00 EA", "2.3330"].join(sep),
    "41.9900",
    // rebate figure BEFORE its single-line item
    "301.3300",
    ["3085883", "ABACAVIR TB 300MG SAF UD 50@", "51079-0204-06", " (1) 50.00 EA", "10.0442"].join(sep),
    // split rebated item: the figure sits in the pack column, the price arrives later
    ["1903673", "ABACAVIR TAB 300MG  UD AHP 30@", "68084-0021-21", "153.6400"].join(sep),
    [" (1) 30.00 EA", "8.5357"].join(sep),
    // split item with a zero-cost price line: must hold its place in the order
    ["1299908", "ABACAVIR TAB 300MG UD MYLN 50", "51079-0204-06", ""].join(sep),
    [" (1) 50.00 EA", "0.0000"].join(sep),
    ["3996006", "ABACAVIR TB 300MG MMP UD3X10@", "00904-6874-04", ""].join(sep),
    [" (1) 30.00 EA", "8.3870"].join(sep),
    ["Printed On: 9/5/2026 12:14 PM", "Page 1 of 1"].join(sep),
  ].join("\r\n");

describe("the scheduled Monday file", () => {
  const by = (item: string) => parsePioneerCatalog(scheduled()).sections[0].rows.find((x) => x.itemNumber === item);

  test("split items are paired with their price lines by order, whichever side the price fell on", () => {
    const r = parsePioneerCatalog(scheduled());
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.sections.map((s) => s.supplier), ["McKesson"]);
    assert.equal(by("3925302")!.unitCostMicros, 3_770_600);
    assert.equal(by("3996006")!.unitCostMicros, 8_387_000);
    assert.equal(by("1903673")!.unitCostMicros, 8_535_700, "the split item after the zero-cost one must not shift");
  });

  test("a rebate figure standing on its own line marks the single-line item beside it — before or after", () => {
    assert.equal(by("3637774")!.rebated, true, "figure after");
    assert.equal(by("3085883")!.rebated, true, "figure before");
    assert.equal(by("3925302")!.rebated, false);
  });

  test("a lone figure is never taken for a supplier's name", () => {
    const r = parsePioneerCatalog(scheduled());
    assert.ok(!r.sections.some((s) => /^[\d.]+$/.test(s.supplier)));
  });

  test("a rebate figure in the pack column marks a split item rebated", () => {
    assert.equal(by("1903673")!.rebated, true);
    assert.equal(by("3996006")!.rebated, false);
  });

  test("a zero-cost price line holds its place in the order and is counted, not loaded", () => {
    const r = parsePioneerCatalog(scheduled());
    assert.equal(by("1299908"), undefined);
    assert.equal(r.reasons["zero or negative cost"], 1);
  });

  test("a non-drug item with no NDC is counted under a reason that says so", () => {
    const r = parsePioneerCatalog(scheduled());
    assert.equal(r.reasons["no NDC (supplies and other non-drug items)"], 1);
  });

  test("a mismatch between split items and price lines refuses the block with the counts named", () => {
    const text = scheduled().replace(" (1) 30.00 EA\t8.3870\r\n", "");
    const r = parsePioneerCatalog(text);
    assert.ok(r.problems.some((p) => /McKesson: 5 items were split across lines but 4 price lines/.test(p)), r.problems.join(" | "));
    // the single-line items are still loaded
    assert.ok(r.sections[0].rows.some((x) => x.itemNumber === "3637774"));
  });

  test("the same file with commas reads identically", () => {
    const a = parsePioneerCatalog(scheduled("\t")).sections[0].rows.map((x) => [x.itemNumber, x.unitCostMicros, x.rebated]);
    const b = parsePioneerCatalog(scheduled(",")).sections[0].rows.map((x) => [x.itemNumber, x.unitCostMicros, x.rebated]);
    assert.deepEqual(a, b);
  });

  test("a rebate figure with no single-line item either side is reported, not guessed", () => {
    const text = scheduled().replace("41.9900\r\n301.3300", "41.9900\r\n99.0000\r\n301.3300");
    const r = parsePioneerCatalog(text);
    assert.ok(r.problems.some((p) => /1 rebate figure stood on a line of its own/.test(p)), r.problems.join(" | "));
  });
});

describe("the hand export's blanks", () => {
  test("a blank item number with an NDC and a price is kept — the NDC is the key", () => {
    const text = semi().replace("721021;METFORMIN", ";METFORMIN");
    const r = parsePioneerCatalog(text);
    assert.ok(r.sections[0].rows.some((x) => x.itemNumber === "" && x.ndc11 === "23155084205"));
  });

  test("an item listed without a price is counted as such, not as a split-row mismatch", () => {
    const text = semi().replace(" (1) 112.00 GM;0.4654", " (1) 112.00 GM;");
    const r = parsePioneerCatalog(text);
    assert.deepEqual(r.problems, []);
    assert.equal(r.reasons["item listed without a price"], 1);
  });
});

describe("the rebate column the pharmacy added", () => {
  test("a six-column file reads every row — the five-column version would have skipped them all", () => {
    const r = parsePioneerCatalog(withRebate());
    assert.deepEqual(r.problems, []);
    assert.equal(r.hasRebateColumn, true);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].rows.length, 5, "every priced row should read");
    assert.equal(r.printedOn, "2026-09-08");
  });

  test("a figure in the column marks the item rebated; a blank does not; the figure itself is ignored", () => {
    const rows = parsePioneerCatalog(withRebate()).sections[0].rows;
    const by = (item: string) => rows.find((x) => x.itemNumber === item)!;
    assert.equal(by("721021").rebated, true);
    assert.equal(by("603510").rebated, false);
    assert.equal(by("740097").rebated, true, "a short-dated lot of a rebated item is still rebated");
  });

  test("a bare zero is treated as blank, so a system that fills empty cells with 0.00 does not mark everything rebated", () => {
    const rows = parsePioneerCatalog(withRebate()).sections[0].rows;
    assert.equal(rows.find((x) => x.itemNumber === "111111")!.rebated, false);
  });

  test("a quoted description containing a comma survives the extra column", () => {
    const rows = parsePioneerCatalog(withRebate()).sections[0].rows;
    const v = rows.find((x) => x.itemNumber === "222222")!;
    assert.equal(v.description, "VIALS 13DR PUSH DOWN,TURN GRN");
    assert.equal(v.ndc11, "50242004062");
    assert.equal(v.unitCostMicros, 500_000);
  });

  test("the five-column file still reads, with rebated unknown rather than false", () => {
    // Without the column nothing can be said either way, and saying "not rebated" would strip the
    // discount from every McKesson generic in a comparison.
    const r = parsePioneerCatalog(semi());
    assert.equal(r.hasRebateColumn, false);
    assert.ok(r.sections.flatMap((s) => s.rows).every((x) => x.rebated === null));
  });
});

describe("recognising the file", () => {
  test("by its title, and by its header row with either separator", () => {
    assert.ok(looksLikePioneerCatalog(semi(";")));
    assert.ok(looksLikePioneerCatalog(semi(",")));
    assert.ok(!looksLikePioneerCatalog("Rx Number,Date Filled,NDC\n1,2026-01-01,00000000000"));
  });

  test("the separator is read off the header row, not assumed", () => {
    assert.equal(detectSeparator(semi(";")), ";");
    assert.equal(detectSeparator(semi(",")), ",");
    assert.equal(detectSeparator("nothing here"), null);
  });

  test("a comma-separated description containing a comma is kept whole when quoted", () => {
    assert.deepEqual(splitRow('1,"VIALS 13DR PUSH DOWN,TURN GRN",12345-6789-01, (1) 1.00 EA,0.5', ","), [
      "1",
      "VIALS 13DR PUSH DOWN,TURN GRN",
      "12345-6789-01",
      " (1) 1.00 EA",
      "0.5",
    ]);
  });
});

describe("reading it", () => {
  for (const sep of [";", ","] as const) {
    test(`suppliers, rows, footers and the printed date all come out (${sep === ";" ? "semicolon" : "comma"})`, () => {
      const r = parsePioneerCatalog(semi(sep));
      assert.deepEqual(r.problems, []);
      assert.equal(r.printedOn, "2026-09-05");
      assert.deepEqual(r.sections.map((s) => s.supplier), ["McKesson", "IPD"]);
      assert.equal(r.sections[0].rows.length, 3, "three priced McKesson rows expected");
      assert.equal(r.sections[1].rows.length, 1);
    });
  }

  test("the hyphenated NDC becomes the eleven-digit form with no ambiguity", () => {
    assert.equal(ndc11FromHyphenated("23155-0842-05"), "23155084205");
    assert.equal(ndc11FromHyphenated("0002-1436-11"), "00002143611", "a 4-4-2 NDC pads the labeler");
    assert.equal(ndc11FromHyphenated("50242-040-62"), "50242004062", "a 5-3-2 NDC pads the product");
    assert.equal(ndc11FromHyphenated("50242-0040-6"), "50242004006", "a 5-4-1 NDC pads the package");
    assert.equal(ndc11FromHyphenated("not an ndc"), null);
  });

  test("pack size, unit and cost are read from the order-by constant", () => {
    const r = parsePioneerCatalog(semi());
    const row = r.sections[0].rows[0];
    assert.equal(row.packQty, 500);
    assert.equal(row.unit, "EA");
    assert.equal(row.orderMultiple, 1);
    assert.equal(row.unitCostMicros, 50_000);
  });

  test("a short-dated lot is kept and marked, never silently the cheapest", () => {
    // $0.0040 next to $0.0500 for the same NDC is stock expiring in two months, not a bargain.
    const r = parsePioneerCatalog(semi());
    const rows = r.sections[0].rows.filter((x) => x.ndc11 === "23155084205");
    assert.equal(rows.length, 2);
    const cheap = rows.find((x) => x.unitCostMicros === 4_000)!;
    assert.equal(cheap.shortDated, "11/24");
    assert.equal(rows.find((x) => x.unitCostMicros === 50_000)!.shortDated, null);
  });

  test("a row with no NDC is skipped with the reason counted, not stored under a blank", () => {
    const r = parsePioneerCatalog(semi());
    assert.ok((r.reasons["no NDC (supplies and other non-drug items)"] ?? 0) >= 1);
    assert.ok(!r.sections.flatMap((s) => s.rows).some((x) => x.ndc11 === ""));
  });

  test("a zero price is a placeholder and is kept out of the comparison", () => {
    const r = parsePioneerCatalog(semi());
    assert.ok((r.reasons["zero or negative cost"] ?? 0) >= 1);
    assert.ok(!r.sections.flatMap((s) => s.rows).some((x) => x.unitCostMicros === 0));
  });

  test("page footers are never read as prices", () => {
    const r = parsePioneerCatalog(semi());
    assert.ok(!r.sections.flatMap((s) => s.rows).some((x) => /Printed On/i.test(x.description ?? "")));
  });

  test("a file with no header row is refused with a reason, not read as one supplier", () => {
    const r = parsePioneerCatalog("just some text\nwith lines\n");
    assert.equal(r.sections.length, 0);
    assert.ok(r.problems.some((p) => /header row/i.test(p)));
  });
});

describe("the filename the pharmacy chose", () => {
  test("MCKCatalog_9_5_2026 names McKesson and the fifth of September", () => {
    assert.equal(supplierFromFileName("MCKCatalog_9_5_2026.txt"), "McKesson");
    assert.equal(dateFromFileName("MCKCatalog_9_5_2026.txt"), "2026-09-05");
  });

  test("every abbreviation the pharmacy will use resolves to the name the file uses inside", () => {
    // If these disagreed, every Monday file would be refused for naming the wrong supplier.
    assert.equal(supplierFromFileName("IPDCatalog_9_8_2026.csv"), canonicalSupplier("IPD"));
    assert.equal(supplierFromFileName("IPCCatalog_9_8_2026.csv"), canonicalSupplier("IPC"));
    assert.equal(supplierFromFileName("ParmedCatalog_9_8_2026.csv"), canonicalSupplier("ParMed"));
    assert.equal(supplierFromFileName("MCKCatalog_9_8_2026.csv"), canonicalSupplier("McKesson"));
  });

  test("an unknown supplier name passes through rather than being guessed", () => {
    assert.equal(canonicalSupplier("Some New Wholesaler"), "Some New Wholesaler");
  });

  test("Supplier + run date, the format the scheduled export will actually use", () => {
    // "will come in this format Supplier{ReportRunDate}. Suppliers are Mck, IPD, IPC, Parmed."
    assert.equal(supplierFromFileName("Mck9_6_2026.txt"), "McKesson");
    assert.equal(supplierFromFileName("IPD9_6_2026.txt"), "IPD");
    assert.equal(supplierFromFileName("IPC_9_6_2026"), "IPC");
    assert.equal(supplierFromFileName("Parmed9-6-2026.txt"), "ParMed");
    assert.equal(dateFromFileName("Mck9_6_2026.txt"), "2026-09-06");
    assert.equal(dateFromFileName("Mck2026-09-06.txt"), "2026-09-06", "year first");
    assert.equal(dateFromFileName("Mck20260906.txt"), "2026-09-06", "eight digits, year first");
    assert.equal(dateFromFileName("Mck09062026.txt"), "2026-09-06", "eight digits, month first");
  });

  test("the report's default name claims no supplier, so the hand export is never refused for being 'named for Supplier'", () => {
    assert.equal(supplierFromFileName("Supplier_Catalog_Item_Search_Results.txt"), null);
    assert.equal(supplierFromFileName("Mck_Catalog_Item_Search_Results.txt"), "McKesson");
  });

  test("the inbox line says what the name told us", () => {
    assert.match(describeFileName("Mck9_6_2026.txt"), /Named for McKesson, run 2026-09-06/);
    assert.match(describeFileName("Supplier_Catalog_Item_Search_Results.txt"), /does not begin with a supplier code \(Mck, IPD, IPC, Parmed\)/);
  });

  test("a filename that is not a catalogue claims nothing", () => {
    assert.equal(supplierFromFileName("invoice_1004797.pdf"), null);
    assert.equal(dateFromFileName("invoice_1004797.pdf"), null);
  });
});
