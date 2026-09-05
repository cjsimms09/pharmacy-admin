import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceLines, sumLines } from "../src/lib/invoice-lines";

/**
 * The item lines as numbers. The McKesson rows below are in the shape the pharmacy's own
 * invoices print (the same fixture the schedule reader is tested on); the drug names and figures
 * are invented, the layout is not.
 */
const mck = (ndc: string, qty: string, um: string, desc: string, awp: string, cls: string, price: string, ext: string, flag = "") =>
  `${ndc}257-9894973485930            ${qty} ${um} ${desc}      ${awp} ${cls}      ${price}        ${ext} ${flag}`;

describe("a McKesson invoice", () => {
  const text = [
    "Billing No.:7656147106",
    "NDC/UPC/UDI#ITEM#DEL DOC#QTYUM    ITEM DESCRIPTIONRETAIL XPRICEDAMOUNT   M",
    mck("00002-1436-11", "1", "EA", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R", "739.11", "739.11"),
    mck("00228-2031-96", "2", "EA", "ALPRAZOL TAB 1MG    ACTA 1000@", "1,079.00", "D", "31.20", "62.40", "H"),
    mck("00406-0522-01", "-1", "EA", "OXYCOD+ACE TB 7.5/325 SGX 100@", "271.54", "X", "18.90", "-18.90"),
    "TOTAL RX PURCHASES: $782.61",
  ].join("\n");

  test("every column is read, and the NDC is the eleven-digit form", () => {
    const r = parseInvoiceLines(text);
    assert.equal(r.layout, "mckesson");
    assert.equal(r.unread, 0);
    assert.equal(r.lines.length, 3);
    const first = r.lines[0];
    assert.equal(first.ndc11, "00002143611");
    assert.equal(first.rawNdc, "00002-1436-11");
    assert.equal(first.quantity, 1);
    assert.equal(first.unit, "EA");
    assert.equal(first.description, "EMGALITY INJ PEN 120MG/ML 1");
    assert.equal(first.awpCents, 91673);
    assert.equal(first.itemClass, "R");
    assert.equal(first.unitPriceCents, 73911);
    assert.equal(first.extendedCents, 73911);
    assert.equal(first.confidence, "full");
  });

  test("a thousands separator in the AWP and a trailing flag letter do not break the row", () => {
    const r = parseInvoiceLines(text);
    const alp = r.lines[1];
    assert.equal(alp.awpCents, 107900);
    assert.equal(alp.quantity, 2);
    assert.equal(alp.extendedCents, 6240);
    assert.equal(alp.itemClass, "D");
  });

  test("a negative quantity is a credit line", () => {
    const r = parseInvoiceLines(text);
    const credit = r.lines[2];
    assert.equal(credit.kind, "credit");
    assert.equal(credit.quantity, -1);
    assert.equal(credit.extendedCents, -1890);
  });

  test("the total line carries no NDC and is not a line", () => {
    assert.ok(parseInvoiceLines(text).lines.every((l) => !/TOTAL/.test(l.description ?? "")));
  });

  test("lines are numbered in the order printed", () => {
    assert.deepEqual(parseInvoiceLines(text).lines.map((l) => l.lineNumber), [1, 2, 3]);
  });
});

describe("a layout this does not know column by column", () => {
  const text = ["INVOICE 1004797", "59651038401 METFORMIN HCL 500MG TAB 100 12.50 25.00", "0093-7212-56 SIMVASTATIN 20MG TAB $8.10", "Sub Total $33.10"].join("\n");

  test("reads the NDC and the last amount, and says the read is partial", () => {
    const r = parseInvoiceLines(text);
    assert.equal(r.layout, "ndc-and-amount");
    assert.equal(r.lines.length, 2);
    assert.equal(r.lines[0].ndc11, "59651038401");
    assert.equal(r.lines[0].extendedCents, 2500);
    assert.equal(r.lines[0].quantity, null, "a quantity is never assumed");
    assert.equal(r.lines[0].unitPriceCents, null);
    assert.equal(r.lines[0].confidence, "partial");
    assert.equal(r.lines[1].ndc11, "00093721256");
    assert.equal(r.lines[1].extendedCents, 810);
    assert.match(r.lines[1].description ?? "", /SIMVASTATIN/);
  });

  test("the subtotal is not a line", () => {
    assert.ok(parseInvoiceLines(text).lines.every((l) => !/Sub Total/.test(l.description ?? "")));
  });
});

describe("what is refused", () => {
  test("a page with no NDCs reads nothing, and says the layout is none", () => {
    const r = parseInvoiceLines("a scanned page\nwith nothing that parses\n$12.00");
    assert.equal(r.lines.length, 0);
    assert.equal(r.layout, "none");
  });

  test("an NDC with no amount beside it is not a line", () => {
    const r = parseInvoiceLines("00002-1436-11 EMGALITY backordered");
    assert.equal(r.lines.length, 0);
  });
});

describe("summing lines", () => {
  test("adds what it has and counts what it could not", () => {
    assert.deepEqual(sumLines([{ extendedCents: 100 }, { extendedCents: null }, { extendedCents: -20 }]), { totalCents: 80, missing: 1 });
  });
});
