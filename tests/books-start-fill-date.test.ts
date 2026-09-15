import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isOutOfBooks, monthIsOutOfBooks, SITE_STARTS_ON } from "../src/lib/books-start";

/**
 * Money received in September is September money, whatever fill it paid for.
 *
 * On the morning of 15 September this rule was changed to judge a claim payment on its fill date,
 * because fourteen Medicare Transaction Facilitator refunds for August fills could never match a
 * claim in these books. It was withdrawn the same afternoon. The cash account reads the same flag:
 * `profit-and-loss.ts` counts MTF refunds received in a month as that month's facilitator cash where
 * nobody has typed a facilitator receipt. The change took $2,789.08 of September cash out of the
 * September cash account — growing daily as August refunds kept arriving — and was reported as moving
 * nothing, without being measured.
 *
 * The owner had already answered the matching question: *"the mtf payments are probably for claims
 * before when we started this site.. that is okay.. they should match going forward."*
 */
describe("the day the money arrived decides", () => {
  test("REGRESSION: an August fill's refund received in September is in the books", () => {
    // rx 313103, filled 2026-08-24, $96.89 received 2026-09-14 — real September cash.
    assert.equal(isOutOfBooks("2026-09-14"), false);
    assert.equal(isOutOfBooks("2026-09-01"), false);
  });

  test("money received before the books began is out", () => {
    assert.equal(isOutOfBooks("2026-08-28"), true);
    assert.equal(isOutOfBooks("2026-08-31"), true);
  });

  test("the day the books open is in them", () => {
    assert.equal(isOutOfBooks(SITE_STARTS_ON), false);
  });

  test("no date stays in the books", () => {
    assert.equal(isOutOfBooks(null), false);
    assert.equal(isOutOfBooks(undefined), false);
  });

  test("the month rule for the cash side is untouched", () => {
    assert.equal(monthIsOutOfBooks("2026-08"), true);
    assert.equal(monthIsOutOfBooks("2026-09"), false);
    assert.equal(monthIsOutOfBooks(null), false);
  });
});

describe("the withdrawn exception stays withdrawn", () => {
  test("isOutOfBooks takes no fill date", async () => {
    /*
     * The shape that did the damage was a second, optional parameter that changed the meaning of a
     * flag three other readers depend on. If this fails, find every reader of claim_payments.out_of_books
     * — the cash account first — before deciding the change is safe.
     */
    const text = await readFile("src/lib/books-start.ts", "utf8");
    assert.match(text, /export function isOutOfBooks\(receivedOn: string \| null \| undefined\): boolean/);
    assert.equal(isOutOfBooks.length, 1);
  });

  test("a claim payment is recorded on the day it was received, not on its fill", async () => {
    const text = await readFile("src/lib/claim-payments.ts", "utf8");
    assert.doesNotMatch(text, /isOutOfBooks\(p\.receivedOn,\s*p\.dateFilled\)/);
    assert.match(text, /outOfBooks: isOutOfBooks\(p\.receivedOn\)/);
  });
});
