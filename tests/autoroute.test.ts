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
