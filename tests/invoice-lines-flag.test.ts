import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceLines } from "../src/lib/invoice-lines";

/**
 * A McKesson line whose flag column holds a letter this reader had not met.
 *
 * On 6 October 2026 one McKesson invoice came out short of its printed total by exactly one line's
 * amount, and the morning check said so. The line was a V where every other line prints a K or
 * nothing; the pattern accepted only a K, so a line whose own arithmetic was right was dropped.
 *
 * The fifth time one column has cost a McKesson invoice lines. Every figure and code below is
 * invented; the layout is theirs.
 */
const flagged = "99999-0101-01201-1111975300001            1*EA TESTAZOLE CREAM 30GM TUBE      24.65     18.40 V       18.40";
const flaggedWithClass = "99999-0101-01201-1111975300001            1*EA TESTAZOLE CREAM 30GM TUBE      24.65 R     18.40 V       18.40";
const contract = "99999-0202-01202-2222975300002            2*EA TESTAMIDE TAB 100CT       30.00 R      12.50 K       25.00";
const contractTwoLetter = "99999-0303-01203-3333975300003            1*EA TESTOLOL INJ 10ML VIAL       9.00     7.25 KI       7.25";
const unflagged = "99999-0404-01204-4444975300004            3*EA TESTAPRIL CAP 30CT       15.00     5.00       15.00";
const nothingShipped = "99999-0505-01205-5555975300005            0*EA TESTAMINE SUSP 120ML       21.00";
const bent = "99999-0606-01206-6666975300006            2*EA TESTAZINE TAB 60CT       20.00     9.10 V       20.00";

const invoice = [contract, flagged, contractTwoLetter, unflagged, nothingShipped].join("\n");

describe("a McKesson line with an unfamiliar flag letter", () => {
  test("is read, because its own arithmetic holds", () => {
    const p = parseInvoiceLines(flagged, 1840);
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0]?.ndc11, "99999010101");
    assert.equal(p.lines[0]?.quantity, 1);
    assert.equal(p.lines[0]?.unitCostCents, 1840);
    assert.equal(p.lines[0]?.extendedCents, 1840);
    assert.equal(p.unreadable.length, 0);
    assert.equal(p.unrecognised.length, 0);
  });

  test("is read when an item class is printed in front of the price as well", () => {
    const p = parseInvoiceLines(flaggedWithClass, 1840);
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0]?.itemClass, "R");
    assert.equal(p.lines[0]?.awpCents, 2465);
    assert.equal(p.lines[0]?.extendedCents, 1840);
  });

  test("says nothing about a rebate either way", () => {
    /*
     * Reading the line is not the same as knowing what the letter means. Nobody has read the
     * invoice's legend, so the line is neither contract nor non-contract: null, which the schema
     * keeps apart from "not rebated". Guessing false would strip a discount off its price in every
     * comparison; guessing true would invent one.
     */
    assert.equal(parseInvoiceLines(flagged).lines[0]?.rebated, null);
  });

  test("lets the invoice reconcile with its printed total", () => {
    /* 25.00 + 18.40 + 7.25 + 15.00 = 65.65. The line that shipped nothing carries no money. */
    const p = parseInvoiceLines(invoice, 6565);
    assert.equal(p.lines.length, 4);
    assert.equal(p.totalCents, 6565);
    assert.equal(p.reconciles, true);
  });

  test("is still refused when its arithmetic does not hold", () => {
    /* The letter is accepted; the line is only kept when quantity times price is the amount. */
    const p = parseInvoiceLines(bent, 2000);
    assert.equal(p.lines.length, 0);
    assert.equal(p.unreadable.length, 1);
  });
});

describe("the flags that were already read", () => {
  test("K and KI still mark a contract line", () => {
    assert.equal(parseInvoiceLines(contract).lines[0]?.rebated, true);
    assert.equal(parseInvoiceLines(contractTwoLetter).lines[0]?.rebated, true);
  });

  test("a line printed with no flag is still not a contract line", () => {
    const p = parseInvoiceLines(unflagged);
    assert.equal(p.lines[0]?.rebated, false);
    assert.equal(p.lines[0]?.quantity, 3);
    assert.equal(p.lines[0]?.extendedCents, 1500);
  });

  test("a line that shipped nothing is still not a line", () => {
    const p = parseInvoiceLines(nothingShipped);
    assert.equal(p.lines.length, 0);
  });
});
