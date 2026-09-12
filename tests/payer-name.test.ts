import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalisePayerName, samePayer, bestPayerName } from "../src/lib/payer-name";
import { payerKey } from "../src/lib/payer-owed";

describe("one payer, however its name was typed", () => {
  test("the real case: a trailing full stop split Express Scripts in two", () => {
    /*
     * August's remittances arrived under both spellings - $37,438.32 and $3,867.12 - and every
     * report grouping by payer showed them as two, one of which looks small enough to ignore.
     */
    assert.equal(samePayer("EXPRESS SCRIPTS INC", "EXPRESS SCRIPTS INC."), true);
    assert.equal(payerKey(null, "EXPRESS SCRIPTS INC"), payerKey(null, "EXPRESS SCRIPTS INC."));
  });

  test("case and spacing carry no meaning", () => {
    assert.equal(samePayer("Health Mart Atlas", "HEALTH  MART   ATLAS"), true);
    assert.equal(samePayer("  MyMatrixx ", "MYMATRIXX"), true);
  });

  test("an ampersand becomes a word rather than a gap", () => {
    // Stripping it would leave "SS C HEALTH", which differs from "SS AND C HEALTH" only by a space
    // this code had itself introduced - the same bug in the other direction.
    assert.equal(normalisePayerName("SS&C HEALTH"), "SS AND C HEALTH");
    assert.equal(samePayer("SS&C HEALTH", "SS and C Health"), true);
  });

  test("genuinely different payers stay different", () => {
    assert.equal(samePayer("EXPRESS SCRIPTS INC", "EXPRESS SCRIPTS HOLDING"), false);
    assert.equal(samePayer("Caremark", "Caremark Part D"), false);
  });

  test("a corporate suffix is NOT dropped, deliberately", () => {
    /*
     * The tempting next step, and the one that merges two real companies. A wrongly merged payer is
     * far harder to notice than a wrongly split one: the money still adds up, it is simply
     * attributed to the wrong counterparty, and no total ever disagrees.
     */
    assert.equal(samePayer("Acme Health", "Acme Health Inc"), false);
    assert.equal(samePayer("Smith Pharmacy", "Smith Pharmacy Services Inc"), false);
  });

  test("an empty name is not the same payer as every other empty name", () => {
    assert.equal(samePayer(null, null), false);
    assert.equal(samePayer("", "   "), false);
    assert.equal(normalisePayerName(null), "");
  });

  test("a BIN still wins over any name", () => {
    // The BIN is what a claim carries. Two spellings under one BIN are one payer regardless.
    assert.equal(payerKey("610279", "Caremark"), payerKey("610279", "CVS CAREMARK"));
    assert.notEqual(payerKey("610279", "Caremark"), payerKey("610502", "Caremark"));
  });

  test("the longest spelling is the one shown", () => {
    // The differences are punctuation and truncation, and the longest was not cut short.
    assert.equal(bestPayerName(["EXPRESS SCRIPTS INC", "EXPRESS SCRIPTS INC."]), "EXPRESS SCRIPTS INC.");
    assert.equal(bestPayerName(["RXCROSSROADS BY", "RxCrossroads by McKesson"]), "RxCrossroads by McKesson");
    assert.equal(bestPayerName([null, "", "  Atlas  "]), "Atlas");
    assert.equal(bestPayerName([null, ""]), null);
  });
});
