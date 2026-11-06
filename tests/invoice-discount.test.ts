import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { discountOnInvoice, pricesExplainedByDiscount } from "../src/lib/invoice-tax";
import { chargeBasis } from "../src/lib/invoice-price-check";

/*
 * The shape of ParMed's tail when a discount is taken: SUB TOTAL, then DISCOUNT joined to a signed figure, then GRAND TOTAL.
 * Invented amounts; the layout is the thing under test, including the legend block's lone "T TAX" that has no figure.
 */
const withDiscount = `
SUB TOTAL
121.71
ParMed Pharmaceuticals
0.00
DISCOUNT-1.22
LIST OF CHEMICAL DESIGNATIONS
T TAX
GRAND TOTAL
120.49
`;

const withTax = `
SUB TOTAL
291.03
TAX1.15
T TAX
GRAND TOTAL
292.18
`;

describe("discountOnInvoice", () => {
  test("reads the discount that closes a gap below the total, when the subtotal proves the lines are all of them", () => {
    const r = discountOnInvoice(withDiscount, 12171, 12049);
    assert.equal(r?.discountCents, 122);
    assert.equal(r?.taxCents, 0);
  });

  test("a gap above the total is not a discount", () => {
    assert.equal(discountOnInvoice(withTax, 29103, 29218), null);
  });

  test("refuses when the printed subtotal is not what the lines came to", () => {
    assert.equal(discountOnInvoice(withDiscount, 12000, 11878), null);
  });

  test("refuses when the discount does not account for the whole gap", () => {
    assert.equal(discountOnInvoice(withDiscount, 12171, 12000), null);
  });

  test("reads a discount and a tax together when, and only when, both are printed and net to the gap", () => {
    const both = `SUB TOTAL\n100.00\nDISCOUNT-1.00\nTAX2.50\nGRAND TOTAL\n101.50\n`;
    const r = discountOnInvoice(both, 10000, 10150);
    assert.equal(r?.discountCents, 100);
    assert.equal(r?.taxCents, 250);
    assert.equal(discountOnInvoice(both, 10000, 10160), null);
  });

  test("a discount printed twice is refused, not guessed between", () => {
    const twice = `SUB TOTAL\n121.71\nDISCOUNT-1.22\nDISCOUNT-1.22\nGRAND TOTAL\n120.49\n`;
    assert.equal(discountOnInvoice(twice, 12171, 12049), null);
  });
});

describe("pricesExplainedByDiscount", () => {
  test("a line above the delivery by the printed discount is explained", () => {
    assert.equal(pricesExplainedByDiscount([123], 122), true);
    assert.equal(pricesExplainedByDiscount([41], 41), true);
  });

  test("a difference larger than the discount is not", () => {
    assert.equal(pricesExplainedByDiscount([500], 122), false);
  });

  test("a line below the delivery is never explained by a discount", () => {
    assert.equal(pricesExplainedByDiscount([123, -5], 118), false);
  });

  test("no discount, nothing explained", () => {
    assert.equal(pricesExplainedByDiscount([123], 0), false);
  });
});

describe("chargeBasis", () => {
  test("a difference the invoice prints as sales tax is sales tax", () => {
    assert.equal(chargeBasis(withTax, 29103, 29218), "sales-tax");
  });

  test("a difference with nothing printed against it is unexplained, never freight", () => {
    assert.equal(chargeBasis("SUB TOTAL\n291.03\nGRAND TOTAL\n292.18\n", 29103, 29218), "unexplained");
  });

  test("an unreadable document is said to be unreadable", () => {
    assert.equal(chargeBasis(null, 29103, 29218), "unreadable");
  });
});

import { uncheckedState } from "../src/lib/invoice-price-check";

describe("uncheckedState", () => {
  test("an invoice as new as the newest delivery is expected, not missing", () => {
    assert.equal(uncheckedState({ invoiceDate: "2026-10-16", totalCents: 5000 }, "2026-10-15"), "not-yet");
    assert.equal(uncheckedState({ invoiceDate: "2026-10-15", totalCents: 5000 }, "2026-10-15"), "not-yet");
  });

  test("a credit is no delivery", () => {
    assert.equal(uncheckedState({ invoiceDate: "2026-09-09", totalCents: -19900 }, "2026-10-15"), "credit-memo");
  });

  test("an older invoice with no delivery is the one to look at", () => {
    assert.equal(uncheckedState({ invoiceDate: "2026-10-01", totalCents: 5000 }, "2026-10-15"), "no-delivery");
  });

  test("with no delivery on file at all, nothing can be called too new", () => {
    assert.equal(uncheckedState({ invoiceDate: "2026-10-16", totalCents: 5000 }, null), "no-delivery");
  });
});
