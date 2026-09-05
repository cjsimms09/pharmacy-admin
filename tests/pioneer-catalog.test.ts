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
    assert.ok((r.reasons["NDC not in 5-4-2 hyphenated form"] ?? 0) >= 1);
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

  test("a filename that is not a catalogue claims nothing", () => {
    assert.equal(supplierFromFileName("invoice_1004797.pdf"), null);
    assert.equal(dateFromFileName("invoice_1004797.pdf"), null);
  });
});
