import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceLines } from "../src/lib/invoice-lines";

/*
 * IPD's printed invoice, in the shape its PDF text comes out in.
 *
 * The identifiers and figures are invented; the layout is the real one, including the three things
 * that made the real invoice unreadable: the item number and NDC run together with no separator,
 * a long product name printed beside the figures instead of below them with its extension dropped
 * off the end, and the section subtotals that close each half.
 */
const invoice = [
  "NDC",
  "ProductProduct NameQuantityB/OUOMPriceDiscountExtension",
  "CII",
  "1111122222000101 2 0EACH 100.00  0  200.00",
  "TEST C2 PRODUCT 10MG",
  "Internal Lot External Lot Expiry DateQuantity ",
  "NumberNumberAllocated",
  "AAA1AAA1 2 ",
  "09/30/2029",
  "%",
  "2222233333000202 1 0EACH 50.00  0 % 50.00",
  "OTHER C2 PRODUCT",
  "C-2 (B)",
  "CII Subtotal:$250.00 ",
  "Continued on next page..",
  "Non-CII",
  "3333344444000303 4 0EACH 5.00  0 % 20.00",
  "PLAIN PRODUCT",
  "%",
  "4444455555000404LONG NAMED PRODUCT HCL/OTHER  3 0EACH 10.00  0 ",
  "SUSPENSION 0.3 %-0.1% 7.5ML",
  "Non-CII Subtotal:$50.00 ",
  " 300.00 ",
  "Subtotal",
].join("\n");

describe("IPD's own invoice", () => {
  test("every line reads, and each half adds up to the subtotal IPD printed for it", () => {
    const p = parseInvoiceLines(invoice, 30000);
    assert.equal(p.format, "ipd");
    assert.equal(p.unreadable.length, 0, "no line is left unread");
    assert.equal(p.lines.length, 4);
    assert.equal(p.totalCents, 30000);
    assert.equal(p.reconciles, true);

    const [c2, rest] = p.sections;
    assert.deepEqual(
      { controlled: c2.controlled, printed: c2.printedCents, read: c2.readCents, lines: c2.lines },
      { controlled: true, printed: 25000, read: 25000, lines: 2 },
    );
    assert.deepEqual(
      { controlled: rest.controlled, printed: rest.printedCents, read: rest.readCents, lines: rest.lines },
      { controlled: false, printed: 5000, read: 5000, lines: 2 },
    );
  });

  test("the item number and the NDC are told apart, and the name is taken from the next line", () => {
    const l = parseInvoiceLines(invoice, null).lines[0];
    assert.equal(l.ndc11, "22222000101", "the NDC is the last eleven digits of the run");
    assert.equal(l.itemNumber, "11111");
    assert.equal(l.quantity, 2);
    assert.equal(l.unitOfMeasure, "EACH");
    assert.equal(l.unitCostCents, 10_000);
    assert.equal(l.extendedCents, 20_000);
    assert.equal(l.description, "TEST C2 PRODUCT 10MG");
    assert.equal(l.controlled, true);
  });

  test("a long name printed beside the figures is read, and its missing extension is worked out", () => {
    // The line that cost $114.00 on the real invoice: the name runs onto the NDC and the extension
    // never printed. It is read from the quantity and the price, and the section subtotal proves it.
    const l = parseInvoiceLines(invoice, null).lines[3];
    assert.equal(l.ndc11, "55555000404");
    assert.equal(l.description, "LONG NAMED PRODUCT HCL/OTHER");
    assert.equal(l.quantity, 3);
    assert.equal(l.extendedCents, 3000, "three at ten dollars, worked out rather than read");
    assert.equal(l.controlled, false);
  });

  test("a half whose subtotal never printed leaves its lines unmarked rather than guessed", () => {
    const noClose = invoice.slice(0, invoice.indexOf("Non-CII Subtotal"));
    const p = parseInvoiceLines(noClose, null);
    assert.equal(p.sections.length, 1, "only the half that closed is counted");
    assert.equal(p.lines.filter((l) => l.controlled === null).length, 2, "the open half says nothing about itself");
  });
});
