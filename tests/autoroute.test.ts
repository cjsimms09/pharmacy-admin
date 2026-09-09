import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, headersOf, parseSupplierRules, supplierFor, acceptableAttachment } from "../src/lib/autoroute";

/**
 * This runs unattended, overnight, with nobody watching. A file loaded as the wrong kind of
 * thing writes wrong data into the tables everything else reads. So every rule needs positive
 * evidence, and anything ambiguous must come back unrecognised — which costs a manual load and
 * nothing else.
 */
const csv = (header: string, row = "") => Buffer.from(`${header}\n${row}\n`, "utf8");

describe("recognising a claims export", () => {
  test("the real PioneerRx header row", () => {
    const c = classify("report.csv", csv("Rx Number,Date Filled,Dispensed Item NDC,Primary Third Party Bin,Primary Third Party PCN,Primary Remit Amount"));
    assert.equal(c.kind, "claims");
  });

  test("a renamed export still reads as claims", () => {
    assert.equal(classify("x.csv", csv("Rx,Fill Date,NDC,BIN,PCN,Amount Paid")).kind, "claims");
  });

  test("a prescription list with no payer routing is not treated as a claims file", () => {
    // Nothing could be matched to a contract from this, so loading it would only add noise.
    assert.equal(classify("x.csv", csv("Rx Number,Date Filled,Dispensed Item Name")).kind, "unrecognised");
  });
});

describe("recognising a supplier catalogue", () => {
  test("NDC and a price, with no prescription number", () => {
    assert.equal(classify("cat.csv", csv("NDC,Item Description,Manufacturer,Units Per Pack,Net Cost")).kind, "supplier_catalog");
  });

  test("a claims file is never taken for a catalogue, though it also has NDC and cost", () => {
    const c = classify("x.csv", csv("Rx Number,Date Filled,Primary Third Party Bin,Dispensed Item NDC,Acquisition Cost"));
    assert.equal(c.kind, "claims", "the prescription number must win");
  });

  test("a price list with no NDC cannot be matched to anything we dispense", () => {
    assert.equal(classify("x.csv", csv("Item Description,Net Cost")).kind, "unrecognised");
  });
});

describe("recognising a NADAC file", () => {
  test("the CMS layout", () => {
    const c = classify("nadac.csv", csv("NDC Description,NDC,NADAC Per Unit,Effective Date,Pricing Unit,As of Date"));
    assert.equal(c.kind, "nadac");
  });

  test("NADAC wins over the catalogue rule, which it would also match", () => {
    assert.equal(classify("x.csv", csv("NDC,NADAC Per Unit,Effective Date,Unit Cost")).kind, "nadac");
  });
});

describe("files that must not be routed anywhere", () => {
  test("an unreadable file is unrecognised, not guessed at", () => {
    assert.equal(classify("scan.pdf", Buffer.from("%PDF-1.4 not a spreadsheet")).kind, "unrecognised");
  });

  test("an empty file", () => {
    assert.equal(classify("empty.csv", Buffer.from("")).kind, "unrecognised");
    assert.deepEqual(headersOf("empty.csv", Buffer.from("")), []);
  });

  test("an unrelated spreadsheet", () => {
    const c = classify("staff.csv", csv("Employee,Hours,Wage,Department"));
    assert.equal(c.kind, "unrecognised");
    assert.ok(c.why.includes("Employee"), "the reason should name what it actually saw");
  });

  test("every classification explains itself, so a wrong guess can be diagnosed", () => {
    for (const h of ["Rx Number,Date Filled,BIN", "NDC,Net Cost", "NDC,NADAC Per Unit,Effective Date", "A,B,C"]) {
      assert.ok(classify("x.csv", csv(h)).why.length > 15);
    }
  });
});

describe("supplier rules", () => {
  const rules = parseSupplierRules(`
    # comments and blanks are skipped

    mckesson.com = McKesson
    orders@topsecondary = Top Rx
    weekly price file = Value Drug
  `);

  test("parses the rules a person would write", () => {
    assert.equal(rules.length, 3);
    assert.deepEqual(rules[0], { pattern: "mckesson.com", supplier: "McKesson" });
  });

  test("matches on the sender", () => {
    assert.equal(supplierFor(rules, "reports@mckesson.com", "Order guide"), "McKesson");
  });

  test("matches on the subject when the sender does not give it away", () => {
    assert.equal(supplierFor(rules, "noreply@mailer.example", "Your weekly price file"), "Value Drug");
  });

  test("no matching rule means no supplier — prices are never filed under a guess", () => {
    assert.equal(supplierFor(rules, "someone@elsewhere.com", "Prices"), null);
  });

  test("a line with no separator is ignored rather than half-read", () => {
    assert.equal(parseSupplierRules("just some text\n").length, 0);
  });
});

describe("the scheduled PioneerRx catalogue, however it is named", () => {
  const catalogue = Buffer.from("\ufeffSupplier Catalog Item Search Results\r\nMcKesson\r\nSupplier: McKessonStatus: Available\r\nSupplier Item Number\tName\tNDC\tPackage Size\tCost Per Unit\r\n", "utf8");

  test("recognised by its title line whatever the extension, including none", () => {
    assert.equal(classify("Mck9_6_2026.txt", catalogue).kind, "pioneer_catalog");
    assert.equal(classify("Mck9_6_2026", catalogue).kind, "pioneer_catalog", "no extension");
    assert.equal(classify("Mck9_6_2026.dat", catalogue).kind, "pioneer_catalog", "an odd extension");
  });

  test("an attachment with no extension is accepted when it is text, or when it is the catalogue", () => {
    assert.ok(acceptableAttachment({ filename: "Mck9_6_2026", contentType: "text/plain" }).ok);
    assert.ok(acceptableAttachment({ filename: "Mck9_6_2026", contentType: "application/octet-stream", content: catalogue }).ok);
    const zip = acceptableAttachment({ filename: "Mck9_6_2026", contentType: "application/octet-stream", content: Buffer.from("PK\u0003\u0004") });
    assert.equal(zip.ok, false);
  });

  test("what was declined is named, so the inbox can say how the file came", () => {
    const v = acceptableAttachment({ filename: "catalogues.zip", contentType: "application/zip" });
    assert.equal(v.ok, false);
    assert.match((v as { why: string }).why, /catalogues\.zip/);
    const t = acceptableAttachment({ filename: "Mck9_6_2026.txt", contentType: "application/zip" });
    assert.equal(t.ok, false);
    assert.match((t as { why: string }).why, /sent as application\/zip/);
  });

  test("the ordinary cases are unchanged", () => {
    assert.ok(acceptableAttachment({ filename: "Mck9_6_2026.txt", contentType: "text/plain" }).ok);
    assert.ok(acceptableAttachment({ filename: "claims.csv", contentType: "application/octet-stream" }).ok, "Gmail's octet-stream with a known extension");
    assert.equal(acceptableAttachment({ filename: "", contentType: "text/plain" }).ok, false);
  });
});

describe("the daily transaction report", () => {
  test("is known by its title line, whatever it is named", () => {
    const buf = Buffer.from("Rx Transaction Details By Submission Type (BETA)\r\nWest Wichita Family Pharmacy\r\n", "utf8");
    assert.equal(classify("Daily (9_5_2026).txt", buf).kind, "rx_transactions");
    assert.equal(classify("Daily (9_5_2026)", buf).kind, "rx_transactions");
  });
});

/**
 * A remittance advice arriving by email, named whatever the payer felt like naming it.
 *
 * BACKLOG item 27. The money in an 835 is money the pharmacy has already been paid, so a file
 * refused at the door is a deposit that never reaches the books. The envelope decides, because the
 * name is written by whoever sent it.
 */
describe("an 835 emailed in, under any name", () => {
  const era = Buffer.from(
    "ISA*00*          *00*          *ZZ*PAYER          *ZZ*PHARMACY       *260908*1200*^*00501*000000001*0*P*:~" +
      "GS*HP*PAYER*PHARM*20260908*1200*1*X*005010X221A1~ST*835*0001~" +
      "BPR*I*102.50*C*ACH*CCP*01*999*DA*111*1234567890**01*999*DA*222*20260908~" +
      "TRN*1*TRACE001*1999999999~N1*PR*BIG PBM*XV*PBM123~" +
      "CLP*332359-1*1*100.00*60.00*10.00*07*CTRL9*~SE*8*0001~GE*1*1~IEA*1*000000001~",
    "latin1",
  );

  test("whatever it is called, and called nothing at all", () => {
    for (const [filename, contentType] of [
      ["REMIT_20260908.835", "application/octet-stream"],
      ["remit.edi", "application/octet-stream"],
      ["835output.dat", "application/edi-x12"],
      ["remittance", "application/octet-stream"],
      ["", "application/octet-stream"],
    ] as const) {
      const v = acceptableAttachment({ filename, contentType, content: era });
      assert.ok(v.ok, `${filename || "(no name)"} as ${contentType} should be accepted: ${v.ok ? "" : v.why}`);
    }
  });

  /*
   * The envelope's own contribution, now that the name rules have caught up with it.
   *
   * `45dba2b` added `.835`, `.edi`, `.x12`, `.dat` and `.xml` to `REPORT_EXT`, so those names are
   * admitted at the door on their name, the way a `.csv` is — and the door only decides what the
   * site will look at, never what a document is. What the envelope still adds, and what these two
   * cases hold, is the file whose name is no help at all.
   */
  test("the envelope carries a name no rule would admit", () => {
    const v = acceptableAttachment({ filename: "PAYER_REMIT_0908.rmt", contentType: "application/octet-stream", content: era });
    assert.ok(v.ok, `an 835 named .rmt should be accepted: ${v.ok ? "" : v.why}`);
  });

  test("and a name no rule would admit is not opened by looking like a remittance", () => {
    // The words say a covering note. The name says remittance. Neither the envelope nor the
    // extension list is satisfied, so it is refused — the name on its own never opens the door.
    const v = acceptableAttachment({ filename: "remittance.rmt", contentType: "application/octet-stream", content: Buffer.from("Dear pharmacy, your remittance is attached.\n") });
    assert.equal(v.ok, false);
  });
});
