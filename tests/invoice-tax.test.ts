import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { salesTaxOnInvoice } from "../src/lib/invoice-tax";

/**
 * The shape of the ParMed tail. It carries no invoice number, account number or NDC — only the four
 * figures the arithmetic turns on, which are what is being tested.
 *
 * The scrambling is not incidental and is not tidied up here: the tax amount really does sit inside
 * the legend block, between two unrelated code descriptions, because the PDF's columns interleave
 * when the page is flattened to text. A fixture that put TAX on a tidy line of its own would test a
 * document this pharmacy does not receive.
 */
const parmedTail = `
        SUB TOTAL
291.03
ParMed Pharmaceuticals
REMITTANCE          :
0.00
LIST OF CHEMICAL DESIGNATIONS
NOTE CODEOMIT CODE:
1 RESTRICTED ITEM
6 TEMPORARILY OUT
TAX1.15
OV OVERRIDE
NR NON RETURNABLE
GRAND TOTAL
292.18
`;

describe("salesTaxOnInvoice", () => {
  test("reads the tax that closes the gap, when the subtotal proves the lines are all of them", () => {
    const r = salesTaxOnInvoice(parmedTail, 29103, 29218);
    assert.equal(r?.amountCents, 115);
    assert.match(r!.says, /291\.03/);
    assert.match(r!.says, /292\.18/);
  });

  test("an invoice that already balances has no tax to find", () => {
    assert.equal(salesTaxOnInvoice(parmedTail, 29218, 29218), null);
  });

  test("freight already read is taken off before the gap is measured", () => {
    /* Same document, but $7.50 of carriage was read as a charge: the tax is still 1.15. */
    assert.equal(salesTaxOnInvoice(parmedTail, 29103, 29218 + 750, 750)?.amountCents, 115);
  });
});

describe("what it refuses, which is the whole of its value", () => {
  test("no printed subtotal: a gap and a number are not a proof", () => {
    const noSubtotal = parmedTail.replace(/SUB TOTAL\n291\.03/, "");
    assert.equal(salesTaxOnInvoice(noSubtotal, 29103, 29218), null);
  });

  test("a subtotal that disagrees with what was read means a line was missed, not tax", () => {
    /* Eight of the nine lines read. The gap is now 1.15 plus a drug, and nothing may be claimed. */
    assert.equal(salesTaxOnInvoice(parmedTail, 27324, 29218), null);
  });

  test("a tax label whose amount does not account for the gap is not used", () => {
    const wrongTax = parmedTail.replace("TAX1.15", "TAX2.40");
    assert.equal(salesTaxOnInvoice(wrongTax, 29103, 29218), null);
  });

  test("two tax figures matching the gap is refused as readily as none", () => {
    const twice = parmedTail.replace("OV OVERRIDE", "TAX 1.15");
    assert.equal(salesTaxOnInvoice(twice, 29103, 29218), null);
  });

  test("no tax label at all: the gap stays unexplained rather than being named", () => {
    const noLabel = parmedTail.replace("TAX1.15", "1.15");
    assert.equal(salesTaxOnInvoice(noLabel, 29103, 29218), null);
  });

  test("a total read as less than the lines is never turned into a negative tax", () => {
    assert.equal(salesTaxOnInvoice(parmedTail, 29103, 29000), null);
  });

  test("nothing read off the invoice at all claims nothing", () => {
    assert.equal(salesTaxOnInvoice(parmedTail, 0, 29218), null);
    assert.equal(salesTaxOnInvoice(parmedTail, 29103, null), null);
  });
});
