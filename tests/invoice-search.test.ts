import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchesText } from "../src/lib/invoices";

/**
 * Finding an invoice again.
 *
 * Filing them correctly is what the regulation asks for; finding them is what makes anybody use
 * the system between inspections. The questions people actually have are "when did we last buy
 * oxycodone", "what did McKesson send in March", and "where is 7656147109" — and an archive that
 * only knows the number on the front of each document can answer one of those three.
 */
const invoice = {
  supplier: "MCKESSON",
  invoiceNumber: "7656147111",
  invoiceDate: "2026-09-04",
  receivedFrom: "invoices@mckesson.com",
  controlledItems: "70010-0029-01 AMPHET MIX SLT ERCP5MGGRAN100@ 720.00 X",
  itemsText:
    "70010-0029-01 AMPHET MIX SLT ERCP5MGGRAN100@ 720.00 X\n00406-0522-01 OXYCOD+ACE TB 7.5/325 SGX 100@ 271.54 X",
};

describe("searching the invoices", () => {
  test("by invoice number, in full", () => {
    assert.equal(matchesText(invoice, "7656147111"), true);
  });

  test("by the last few digits, which is what people actually remember", () => {
    assert.equal(matchesText(invoice, "7111"), true);
  });

  test("by a drug on it, which no invoice number would ever find", () => {
    assert.equal(matchesText(invoice, "oxycod"), true);
  });

  test("by NDC", () => {
    assert.equal(matchesText(invoice, "00406-0522-01"), true);
  });

  test("by supplier, whatever case it is typed in", () => {
    assert.equal(matchesText(invoice, "mckesson"), true);
  });

  test("by the address it arrived from", () => {
    assert.equal(matchesText(invoice, "mckesson.com"), true);
  });

  test("every word has to appear, so two terms narrow rather than widen", () => {
    assert.equal(matchesText(invoice, "oxycod mckesson"), true);
    assert.equal(matchesText(invoice, "oxycod cardinal"), false);
  });

  test("an empty search is not a filter", () => {
    assert.equal(matchesText(invoice, ""), true);
    assert.equal(matchesText(invoice, undefined), true);
    assert.equal(matchesText(invoice, "   "), true);
  });

  test("something that is not on it does not match", () => {
    assert.equal(matchesText(invoice, "hydrocodone"), false);
  });

  test("a missing field never throws the search", () => {
    assert.equal(
      matchesText(
        { supplier: null, invoiceNumber: null, invoiceDate: null, itemsText: "", controlledItems: "", receivedFrom: null },
        "anything",
      ),
      false,
    );
  });
});
