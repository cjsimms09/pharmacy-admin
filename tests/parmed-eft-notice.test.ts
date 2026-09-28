import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeParmedEftNotice, readParmedEftNotice } from "../src/lib/parmed-eft-notice";

/**
 * The shape Parmed's EFT debit notice prints, with an invented customer number and invented invoice numbers.
 *
 * The real one runs the date, the customer number and the invoice number together with no separator, and prints its own
 * total at the foot. Two of the twelve rows on the real page carry no ship-to party above them, so one row here has none
 * either — a reader that needs that line would have dropped two invoices and still balanced, because it would have
 * compared the rows it found against a total it never checked.
 */
const NOTICE = [
  "EFT DEBIT NOTICE",
  "PARMED PHARMACEUTICALS",
  "MEMPHIS, TN 38141-7602",
  "Notice Date  Customer No",
  "09/26/2026  1000000001",
  "Subject: ACH DEBIT VERIFICATION",
  "Details of the Invoices to be paid",
  "DATESHIP TO PARTYINVOICE NUMBERPURCHASE ORDERAMOUNT",
  "   4357",
  "08/24/202610000000019000000001         191.19 ",
  "   4362",
  "08/26/202610000000019000000002          11.07 ",
  "08/25/202610000000019000000003         308.64 ",
  "Total (in USD)$         510.90 ",
].join("\n");

describe("Parmed's EFT debit notice", () => {
  test("it is recognised by its heading and its subject together", () => {
    assert.equal(looksLikeParmedEftNotice(NOTICE), true);
    assert.equal(looksLikeParmedEftNotice("EFT DEBIT NOTICE\nsome other company"), false);
  });

  test("every invoice is read, including the row with no ship-to party above it", () => {
    const n = readParmedEftNotice(NOTICE);
    assert.ok(n);
    assert.equal(n.invoices.length, 3);
    assert.equal(n.noticeOn, "2026-09-26");
    assert.equal(n.customerNumber, "1000000001");
    assert.deepEqual(
      n.invoices.map((v) => [v.invoiceNumber, v.invoiceDate, v.cents]),
      [
        ["9000000001", "2026-08-24", 19_119],
        ["9000000002", "2026-08-26", 1_107],
        ["9000000003", "2026-08-25", 30_864],
      ],
    );
  });

  test("the total is the sum of the rows, and it agrees with the printed one", () => {
    const n = readParmedEftNotice(NOTICE);
    assert.ok(n);
    assert.equal(n.totalCents, 51_090);
    assert.equal(
      n.totalCents,
      n.invoices.reduce((a, v) => a + v.cents, 0),
    );
  });

  /*
   * The gate. This figure is a bank debit, and a reader that takes a printed total on trust believes the one number on
   * the page it could have checked. A page whose rows do not reach its total yields nothing at all, so the document
   * stays where a person will look at it rather than quietly becoming a payment for the wrong amount.
   */
  test("a total the rows do not reach yields nothing", () => {
    assert.equal(readParmedEftNotice(NOTICE.replace("510.90", "610.90")), null);
  });

  test("a row that does not carry this page's customer number is not one of its invoices", () => {
    const n = readParmedEftNotice(NOTICE.replace("08/25/202610000000019000000003", "08/25/202620000000029000000003"));
    assert.equal(n, null, "the rows no longer reach the printed total, so nothing is read");
  });

  test("a notice with no rows at all yields nothing", () => {
    assert.equal(readParmedEftNotice("EFT DEBIT NOTICE\nPARMED\nACH DEBIT VERIFICATION\n09/26/2026  1000000001"), null);
  });
});
