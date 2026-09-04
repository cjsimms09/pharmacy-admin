import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readTotalCents, sumOf, money } from "../src/lib/invoices";

/**
 * What an invoice was billed at, read only where the invoice says so.
 *
 * Every one of these documents carries a dozen dollar amounts: line extensions, subtotals by
 * category, AWP, a statement balance carried forward. Picking the largest, or the last, would put
 * a number the site invented onto a financial record that later gets reconciled against a payment
 * — and a wrong amount is far worse than a missing one, because a blank is a question and a wrong
 * figure is an answer nobody checks.
 *
 * The three wholesalers this pharmacy actually buys from print totals three different ways, and
 * one of them does not print an invoice total at all. That last case has to come back null rather
 * than adding the subtotals up.
 */
describe("reading the amount off an invoice", () => {
  test("McKesson prints a net payable, and that is what is owed", () => {
    // Two totals on the page; the payable is the one the pharmacy is billed.
    const text = "TOTAL RX PURCHASES: $9,102.11\nNET PAYABLE BY STATEMENT DATE 09/08/2026:$8,241.65";
    assert.equal(readTotalCents(text), 824165);
  });

  test("IPC prints a total due", () => {
    assert.equal(readTotalCents("Sub Total$281.44\nTotal Due$290.23"), 29023);
  });

  test("IPD prints subtotals by schedule and no invoice total, so nothing is read", () => {
    // The real failure this guards: 1317.40 and 192.32 are per-schedule subtotals. Adding them,
    // or taking the larger, would be the site making a figure up.
    const text = "SCHEDULE 3-5 SUBTOTAL $1,317.40\nSCHEDULE 2 SUBTOTAL $192.32\nPAGE 1 OF 2";
    assert.equal(readTotalCents(text), null);
  });

  test("a bare dollar amount with no label is never taken as the total", () => {
    assert.equal(readTotalCents("00406-0522-01 OXYCOD+ACE TB 100@ $271.54 X"), null);
  });

  test("commas, and cents, survive the trip", () => {
    assert.equal(readTotalCents("Amount Due $12,345.06"), 1234506);
  });

  test("a zero total is a total, not a missing one", () => {
    assert.equal(readTotalCents("Invoice Total $0.00"), 0);
  });

  test("the label is matched however it is cased", () => {
    assert.equal(readTotalCents("balance due:  $45.00"), 4500);
  });
});

describe("what a filtered list comes to", () => {
  const rows = (cents: (number | null)[]) =>
    cents.map((c, i) => ({ id: String(i), totalCents: c })) as Parameters<typeof sumOf>[0];

  test("adds up what it has", () => {
    assert.deepEqual(sumOf(rows([1000, 2550, 45])), { total: 3595, missing: 0 });
  });

  test("counts what it could not add rather than quietly dropping it", () => {
    // A total that silently excludes three invoices is worse than no total: it reads as complete.
    assert.deepEqual(sumOf(rows([1000, null, null, 500])), { total: 1500, missing: 2 });
  });

  test("an empty list comes to nothing, not to a crash", () => {
    assert.deepEqual(sumOf(rows([])), { total: 0, missing: 0 });
  });
});

describe("showing money", () => {
  test("two decimal places and thousands separators, always", () => {
    assert.equal(money(824165), "$8,241.65");
    assert.equal(money(500), "$5.00");
    assert.equal(money(0), "$0.00");
  });

  test("no amount is a dash, never a zero", () => {
    // $0.00 and "we do not know" are different facts about an invoice.
    assert.equal(money(null), "—");
  });
});
