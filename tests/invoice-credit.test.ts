import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readTotalCents, looksLikeCredit } from "../src/lib/invoices";

/**
 * The owner: "we got an invoice credit from IPC did we read it right and apply credit?"
 *
 * It could not have. Every pattern captured only the digits, so a minus sign or a pair of brackets
 * had nowhere to go, and the guard meant to catch it — `n >= 0` — could never fire because the
 * capture group was incapable of holding a sign.
 *
 * A credit filed as an invoice is wrong twice: the money that should come off purchases is added
 * instead, so the account moves by twice the credit and in the wrong direction.
 */

describe("a bill reads as a bill", () => {
  test("the ordinary case is untouched", () => {
    assert.equal(readTotalCents("TOTAL DUE  $1,234.56"), 123_456);
    assert.equal(readTotalCents("NET PAYABLE  $2,000.00"), 200_000);
    assert.equal(readTotalCents("Invoice Total: $87.10"), 8_710);
  });

  test("a bill is not a credit", () => {
    assert.equal(looksLikeCredit("TOTAL DUE $1,234.56", 123_456), false);
  });

  test("nothing readable is null, never nought", () => {
    assert.equal(readTotalCents("no total anywhere on this page"), null);
  });
});

describe("a credit reads as a credit", () => {
  /* The three ways a wholesaler prints a negative, all of which returned a positive before. */
  test("a minus before the dollar sign", () => assert.equal(readTotalCents("TOTAL DUE -$123.45"), -12_345));
  test("a minus after the dollar sign", () => assert.equal(readTotalCents("AMOUNT DUE $-78.50"), -7_850));
  test("brackets, which is the same statement in accounting notation", () =>
    assert.equal(readTotalCents("TOTAL DUE  ($123.45)"), -12_345));

  test("each of them is recognised as a credit", () => {
    for (const t of ["TOTAL DUE -$123.45", "AMOUNT DUE $-78.50", "TOTAL DUE  ($123.45)"]) {
      assert.equal(looksLikeCredit(t, readTotalCents(t)), true, t);
    }
  });

  /*
   * A credit memo whose own total is printed positive — the document says what it is in words and
   * the figure is the size of the credit. Recognised by the words, so it is not filed as a bill.
   */
  test("a document that calls itself a credit memo is one, whatever the sign", () => {
    assert.equal(looksLikeCredit("Credit Memo\nTOTAL DUE $45.00", 4_500), true);
    assert.equal(looksLikeCredit("CREDIT NOTE for returned goods\nTOTAL DUE $45.00", 4_500), true);
    assert.equal(looksLikeCredit("Return Credit\nTOTAL DUE $45.00", 4_500), true);
  });

  test("the word invoice on a credit memo does not make it a bill", () => {
    assert.equal(looksLikeCredit("CREDIT INVOICE 11495631\nTOTAL DUE $45.00", 4_500), true);
  });

  test("an ordinary invoice that happens to mention credit terms is not a credit", () => {
    assert.equal(looksLikeCredit("Net 30. Credit limit $50,000.\nTOTAL DUE $1,234.56", 123_456), false);
  });
});
