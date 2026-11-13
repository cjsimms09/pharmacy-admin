import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalPayer, fold, UNNAMED } from "../src/lib/engine/payers";

describe("one name per payer", () => {
  test("the three spellings of Prime meet, and so do Capital Rx's and Express Scripts'", () => {
    assert.equal(canonicalPayer("Prime Therapeutics LLC"), "Prime Therapeutics");
    assert.equal(canonicalPayer("Prime Therapeutics"), "Prime Therapeutics");
    assert.equal(canonicalPayer("Prime"), "Prime Therapeutics");
    assert.equal(canonicalPayer("Capital Rx, Inc. and CapitalRx IPA, LLC"), "Capital Rx");
    assert.equal(canonicalPayer("CapitalRx"), "Capital Rx");
    assert.equal(canonicalPayer("EXPRESS SCRIPTS INC."), "Express Scripts");
    assert.equal(canonicalPayer("Express Scripts"), "Express Scripts");
    assert.equal(canonicalPayer("MedOne, L.C. (Administrator)"), "MedOne");
    assert.equal(canonicalPayer("Liviniti (Southern Scripts)"), "Liviniti");
  });
  test("a processor is not folded into a programme that carries its name", () => {
    assert.equal(canonicalPayer("SS&C HEALTH"), "SS&C HEALTH");
    assert.equal(canonicalPayer("DST Pharmacy Solutions (SS&C Health)"), "DST Pharmacy Solutions (SS&C Health)");
    assert.equal(canonicalPayer("DST/Argus GLP-1 bridge"), "DST/Argus GLP-1 bridge");
  });
  test("a name that is nothing, or only a BIN and a group, is unnamed so it can be seen and named", () => {
    assert.equal(canonicalPayer(""), UNNAMED);
    assert.equal(canonicalPayer(null), UNNAMED);
    assert.equal(canonicalPayer("026696 (779993333)"), UNNAMED);
    assert.equal(canonicalPayer("005377 (10000019)- City of Wichita"), UNNAMED);
  });
  test("the owner's own merge comes first and wins", () => {
    const aliases = new Map([[fold("RxCrossroads by McKesson"), "RxCrossroads"], [fold("Prime"), "Prime (the Kansas plan)"]]);
    assert.equal(canonicalPayer("RxCrossroads by McKesson", aliases), "RxCrossroads");
    assert.equal(canonicalPayer("Prime", aliases), "Prime (the Kansas plan)");
    assert.equal(canonicalPayer("Prime Therapeutics LLC", aliases), "Prime Therapeutics");
    const onFamily = new Map([[fold("Express Scripts"), "ESI"]]);
    assert.equal(canonicalPayer("EXPRESS SCRIPTS INC.", onFamily), "ESI", "an alias written on the shown name reaches every spelling under it");
  });
  test("folding keeps the ampersand and drops every other mark", () => {
    assert.equal(fold("  SS&C   Health, Inc. "), "SS&C HEALTH INC");
    assert.equal(fold("Capital Rx, Inc. and CapitalRx IPA, LLC"), "CAPITAL RX INC AND CAPITALRX IPA LLC");
  });
});
