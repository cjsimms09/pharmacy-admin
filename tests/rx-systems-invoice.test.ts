import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readRxSystemsInvoice, looksLikeRxSystemsInvoice, rxSystemsBillNote } from "../src/lib/rx-systems-invoice";

/**
 * An Rx Systems supplies invoice, on the shape their PDF actually arrives in.
 *
 * The text layer interleaves the columns, which is why the reader works from labelled amounts rather
 * than positions. Figures below are invented; the layout is theirs.
 *
 * The owner, 16 September 2026: "Rx system is for pharmacy supplies. Not for drugs", and of the
 * freight line, "406 is freight that gets refunded.. so just use the 1715". Their invoice says the
 * same thing in its own words, which is why this reads it rather than being told.
 */
const page = [
  "Invoice",
  "Invoice Number:Customer:Date:9/15/26",
  "900123499999",
  "Quantity",
  "Item/Description",
  "Price/Per",
  "20,000M$1,715.00",
  "$85.75",
  "EACHBAG 6# 3C",
  "$406.00",
  "Extra charges",
  "$0.00",
  "EACHFREIGHT",
  "Freight has been added to your invoice. If the invoice is paid ",
  "within 30 days, you may deduct the freight amount from the ",
  "invoice total.",
  "ACH",
  "$2,121.00",
].join("\n");

describe("reading one of their invoices", () => {
  test("the goods, the freight and the total, with the arithmetic holding", () => {
    const r = readRxSystemsInvoice(page);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.invoice.goodsCents, 171_500, "the figure that becomes spending");
    assert.equal(r.invoice.freightCents, 40_600);
    assert.equal(r.invoice.totalCents, 212_100);
    assert.equal(r.invoice.goodsCents + r.invoice.freightCents + r.invoice.extrasCents, r.invoice.totalCents);
    assert.equal(r.invoice.freightDeductibleDays, 30, "read from their own sentence, not assumed");
  });

  test("the invoice number is theirs alone, not theirs run together with the customer number", () => {
    const r = readRxSystemsInvoice(page);
    assert.equal(r.ok && r.invoice.invoiceNumber, "9001234");
  });

  test("the date is read as a date", () => {
    const r = readRxSystemsInvoice(page);
    assert.equal(r.ok && r.invoice.invoiceDate, "2026-09-15");
  });

  test("the note ties the bill to the paper without opening it", () => {
    const r = readRxSystemsInvoice(page);
    assert.ok(r.ok);
    if (!r.ok) return;
    const note = rxSystemsBillNote(r.invoice);
    assert.match(note, /\$1,715\.00 of pharmacy supplies/);
    assert.match(note, /\$406\.00 of freight/);
    assert.match(note, /within 30 days/);
    assert.match(note, /not counted as spending here/);
  });
});

describe("what it refuses rather than guesses", () => {
  test("a page whose figures do not add up books nothing", () => {
    /*
     * The one number that must never be wrong here is the one that becomes spending. Where the
     * subtraction produces a figure no line on the page prints, the reader stops and says so.
     */
    const wrong = page.replace("$2,121.00", "$2,500.00");
    const r = readRxSystemsInvoice(wrong);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.why, /no line on the invoice prints that figure/);
  });

  test("a page with no freight line is refused, because goods cannot be told from carriage", () => {
    const r = readRxSystemsInvoice(page.replace("EACHFREIGHT", "EACH"));
    assert.equal(r.ok, false);
  });

  test("freight larger than the total is refused rather than booked as a negative", () => {
    const r = readRxSystemsInvoice(page.replace("$2,121.00", "$300.00"));
    assert.equal(r.ok, false);
  });

  test("it knows one of theirs from anybody else's", () => {
    assert.equal(looksLikeRxSystemsInvoice(page, "billing@rxsystems.com"), true);
    assert.equal(looksLikeRxSystemsInvoice("McKesson invoice, item lines and NDCs", "invoices@mckesson.com"), false);
    assert.equal(looksLikeRxSystemsInvoice("Rx Systems, Inc. invoice", ""), true, "recognised by the page where the sender is unknown");
  });
});
