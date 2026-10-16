import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SITE_STARTS_ON, monthIsOutOfBooks } from "../src/lib/books-start";
import { beforeBooksAccount } from "../src/lib/profit-and-loss";
import { cashCostOfGoods } from "../src/lib/cash-cogs";

/*
 * A month before the books is not an account, and a month inside them still counts what it paid for goods bought
 * before them. Every date is taken from SITE_STARTS_ON, so this holds on either side of the 1 October cutover.
 */
const startMonth = SITE_STARTS_ON.slice(0, 7);
const [y, m] = startMonth.split("-").map(Number);
const monthBefore = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;

describe("a month before the books begin", () => {
  test("is labelled on both bases, with no figure on either side and the reason in one sentence", () => {
    assert.equal(monthIsOutOfBooks(monthBefore), true);
    for (const basis of ["accrual", "cash"] as const) {
      const pl = beforeBooksAccount(monthBefore, basis);
      assert.equal(pl.beforeBooks, true);
      assert.equal(pl.usable, false);
      assert.equal(pl.revenueCents, 0);
      assert.equal(pl.costOfGoodsCents, 0);
      assert.equal(pl.operatingCents, 0);
      assert.equal(pl.netProfitCents, 0);
      assert.deepEqual(pl.caveats, []);
      assert.equal(pl.missing.length, 1);
      assert.match(pl.missing[0], new RegExp(`before these books begin on ${SITE_STARTS_ON}`));
    }
  });
});

describe("the first month of the books still counts what it paid for goods bought before them", () => {
  test("a wholesaler invoice dated before the books and cleared in the first month is that month's cash cost of goods", () => {
    const settled = [{ supplier: "McKesson", invoiceNumber: "9990001", netCents: 123_456, clearingDate: `${startMonth}-05`, checkNumber: "CKACH9990001" }];
    const invoices = [{ supplier: "McKesson", invoiceNumber: "9990001", invoiceDate: `${monthBefore}-28`, totalCents: 125_000 }];
    const inFirst = cashCostOfGoods({ month: startMonth, settled, invoices, receiving: [] });
    assert.equal(inFirst.settledCents, 123_456);
    assert.equal(inFirst.cents, 123_456);
    assert.equal(monthIsOutOfBooks(startMonth), false, "the month it cleared in is inside the books, so it is drawn, not labelled");
  });
});
