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

describe("the two shapes that read nothing at all", () => {
  test("McKesson's front-end lines: a UPC in the NDC column and no item class", () => {
    // A real over-the-counter invoice read $0 of $91.97 because its code is hyphenated 6-5 rather
    // than 5-4-2 and its lines carry no class letter. The digits are the same eleven either way.
    const otc = "305361-32710231-6966974132450            1EA ACETAM TAB 325MG RUG 1000@       18.19        21.80 K       21.80";
    const p = parseInvoiceLines(otc, null);
    assert.equal(p.format, "mckesson");
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0].ndc11, "30536132710");
    assert.equal(p.lines[0].itemClass, null, "a front-end line states no class rather than a wrong one");
    assert.equal(p.lines[0].rebated, true);
    assert.equal(p.lines[0].extendedCents, 2180);
  });

  test("a line the wholesaler rounded is read, and one that is genuinely wrong is not", () => {
    // Five pods at $304.18 is $1,520.90; IPC printed $1,520.89. A penny of rounding, not an error.
    const rounded = "5328661Omnipod 5 Dexcom G6-G7 Pods (Gen 5)  508508300021$307.25$384.0655$304.18$1,520.89";
    const p = parseInvoiceLines(rounded, null);
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0].quantity, 5);
    assert.equal(p.lines[0].extendedCents, 152089, "the invoice's own figure is kept, not the multiplication");

    // The same line with the extension out by a dollar is a misread, and is refused.
    const wrong = rounded.replace("$1,520.89", "$1,620.89");
    assert.equal(parseInvoiceLines(wrong, null).lines.length, 0);
  });
});
