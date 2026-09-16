import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findIdentifiers } from "../src/lib/identifier-scan";

/*
 * Every "real" value below is invented to have the right shape — the NPI and DEA carry correct check digits so the rule
 * is tested on what it actually keys on, and none of them belongs to anybody.
 */
const shapes = (text: string, path = "src/lib/thing.ts") => findIdentifiers(text, path).map((f) => f.shape);

describe("what a commit must not carry", () => {
  test("a supplier invoice number of the shape that has reached this repository twice", () => {
    assert.deepEqual(shapes("const invoiceNumber = \"7656141694\";"), ["supplier invoice number"]);
    assert.deepEqual(shapes("7480000123"), ["supplier invoice number"]);
  });

  test("a wholesaler's ACH reference", () => {
    assert.deepEqual(shapes("checkNumber: \"CKACH07227740\""), ["ACH reference"]);
    assert.deepEqual(shapes("ACH1234567"), ["ACH reference"]);
  });

  test("a prescription number padded to twelve digits, which is how a copay statement prints one", () => {
    assert.deepEqual(shapes("000000410088 08/17/2026"), ["padded prescription number"]);
  });

  test("a valid NPI, and not any ten digits", () => {
    /* 1999999992 carries the right check digit; 1999999991 does not. Both are invented. */
    assert.deepEqual(shapes("npi: 1999999992"), ["NPI"]);
    assert.deepEqual(shapes("1999999991"), [], "one digit out is not an NPI, and a check that says it is cries wolf");
  });

  test("a valid DEA number, and not any two letters and seven digits", () => {
    /* AB4711138 carries the right check digit; AB4711139 does not. Both are invented. */
    assert.deepEqual(shapes("DEA#: AB4711138"), ["DEA number"]);
    assert.deepEqual(shapes("DEA#: AB4711139"), [], "the check digit is what tells a DEA number from a part number");
    assert.deepEqual(shapes("DEA#: CS4711138"), [], "C is not a letter a registration begins with, so this is a part number");
    assert.deepEqual(shapes("DEA#: AB1234563"), [], "the documented test digits every fixture here uses");
  });

  test("a drug code beside a prescription, which together are a dispensing", () => {
    assert.deepEqual(shapes("Rx 4508821 NDC 00093721410 30 tabs"), ["NDC beside a prescription"]);
  });
});

describe("what it must not cry wolf over, or it will be turned off", () => {
  test("money, dates, counts and line numbers", () => {
    assert.deepEqual(shapes("const cents = 1070620; // $10,706.20 on 2026-09-03, 24 rows"), []);
    assert.deepEqual(shapes("assert.equal(r.totalCents, 2_211_856);"), []);
  });

  test("a BIN, a PCN and a group, which are how a plan is billed and not a person", () => {
    assert.deepEqual(shapes("bin: \"610011\", pcn: \"RXLOCAL\", group: \"ACR\""), []);
  });

  test("the invented numbers this repository's own fixtures use", () => {
    assert.deepEqual(shapes("7000000001 CKACH00000001 ACH00000003 990101 000000990201 5000202609031 1234567893"), []);
    assert.deepEqual(shapes("{ supplier: \"Mckesson\", invoiceNumber: \"7000000003\", checkNumber: \"CKACH00000001\" }"), []);
  });

  test("a fixture that says it is invented is still checked for the shapes that hid there", () => {
    /* The padding case was found IN a fixture, so fixtures are not exempt from it. */
    assert.deepEqual(shapes("000000410088", "fixtures/copay-remit-redsail.txt"), ["padded prescription number"]);
  });

  test("an NDC beside a prescription is allowed in a fixture, where both are invented by rule", () => {
    assert.deepEqual(shapes("Rx 990101 NDC 99999999901", "fixtures/copay-remit-redsail.txt"), []);
  });
});

describe("what it says", () => {
  test("the line, the shape and why it matters, so nobody has to guess what to change", () => {
    const [f] = findIdentifiers("line one\nconst n = \"7656141694\";\n", "src/lib/thing.ts");
    assert.equal(f.line, 2);
    assert.equal(f.what, "7656141694");
    assert.match(f.why, /names a real purchase/);
  });
});
