import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceLines } from "../src/lib/invoice-lines";

/**
 * ParMed, which prints every column with nothing between them.
 *
 * The owner: "1 invoice worth $14.24 with no item lines read... nothing on this invoice reaches the
 * cost of any drug". The screen guessed a scan. It was not a scan — the text is all there, and the
 * reader had no pattern for a row that carries eighteen columns and two spaces:
 *
 *   21598389572888014938GENSN3011ea 6.57 6.57
 *
 * Read from its two fixed ends. The NDC is the last eleven digits of the leading run, and the money
 * is the two amounts at the end. Everything between is unlabelled and is not guessed at.
 */
const HEAD = "LINEITEM#NDC/UPCTYPEFORMCLASSSIZEMSGSOMITNOTEDESCRIPTION/LOT/EXPIRATIONORDER QTYUOMUNIT $EXTENDED $";
const page = (...rows: string[]) => [HEAD, ...rows].join("\n");

describe("ParMed's item lines", () => {
  test("both lines read, and they add up to the printed total", () => {
    const r = parseInvoiceLines(
      page("A60501NA1       08/31/2028", "21598389572888014938GENSN3011ea 6.57 6.57", "20260262        04/30/2028", "61525786068462073329GENTB8411CT 7.67 7.67"),
      1424,
    );
    assert.equal(r.format, "parmed");
    assert.equal(r.lines.length, 2);
    assert.equal(r.unreadable.length, 0);
    assert.equal(
      r.lines.reduce((n, l) => n + l.extendedCents, 0),
      1424,
      "the reading is only stored if it reconciles, so this is the whole test",
    );
  });

  /*
   * The item number's length is not fixed and the NDC's is, so the NDC is the last eleven digits of
   * the run. Taking the first eleven gives 21598389572, which belongs to nobody — and a wrong NDC is
   * a price filed against another company's drug.
   */
  test("the NDC is the last eleven digits of the run, not the first", () => {
    const r = parseInvoiceLines(page("21598389572888014938GENSN3011ea 6.57 6.57"), 657);
    assert.equal(r.lines[0].ndc11, "72888014938");
  });

  test("the second line's NDC too, so it is not one lucky row", () => {
    const r = parseInvoiceLines(page("61525786068462073329GENTB8411CT 7.67 7.67"), 767);
    assert.equal(r.lines[0].ndc11, "68462073329");
  });

  /*
   * SIZE, ORDER and QTY run together into one digit run with nothing marking where each ends, so the
   * quantity comes from the arithmetic instead. "3011" is a pack of 30, one ordered, one shipped —
   * and no split of those digits can be justified from the page.
   */
  test("the quantity comes from the money, because the page cannot say it", () => {
    const r = parseInvoiceLines(page("21598389572888014938GENSN3011ea 6.57 6.57"), 657);
    assert.equal(r.lines[0].quantity, 1);
    assert.equal(r.lines[0].unitCostCents, 657);
    assert.equal(r.lines[0].extendedCents, 657);
  });

  test("a quantity of more than one is read from the money just the same", () => {
    const r = parseInvoiceLines(page("21598389572888014938GENSN3013ea 6.57 19.71"), 1971);
    assert.equal(r.lines[0].quantity, 3, "$19.71 at $6.57 each is three of them");
  });

  /*
   * Where the money does not divide there is nothing to fall back on, and a guessed quantity is a
   * wrong cost per unit on a drug — which is the one figure this reader exists to produce.
   */
  test("a line whose money does not divide is left unread rather than guessed", () => {
    const r = parseInvoiceLines(page("21598389572888014938GENSN3011ea 6.57 10.00"), 1000);
    assert.equal(r.lines.length, 0);
    assert.equal(r.unreadable.length, 1);
  });

  test("nothing is claimed about AWP, rebate or schedule, because the page prints none of them", () => {
    const r = parseInvoiceLines(page("21598389572888014938GENSN3011ea 6.57 6.57"), 657);
    assert.equal(r.lines[0].awpCents, null);
    assert.equal(r.lines[0].rebated, null, "saying 'not rebated' would strip a discount off every later comparison");
    assert.equal(r.lines[0].controlled, null);
  });

  /*
   * The row opens with the line number and the item number run together with nothing marking the
   * join. A number here would be read as ParMed's catalogue reference and used to order from them.
   */
  test("no item number is invented out of the leading digits", () => {
    const r = parseInvoiceLines(page("21598389572888014938GENSN3011ea 6.57 6.57"), 657);
    assert.equal(r.lines[0].itemNumber, null);
  });

  test("the unit of measure is kept as printed, in upper case", () => {
    const r = parseInvoiceLines(page("21598389572888014938GENSN3011ea 6.57 6.57", "61525786068462073329GENTB8411CT 7.67 7.67"), 1424);
    assert.deepEqual(r.lines.map((l) => l.unitOfMeasure), ["EA", "CT"]);
  });

  /*
   * The lot and expiry line above each item, and the subtotal below, are not item lines. A reader
   * that took them would reconcile to the wrong figure and store nothing at all.
   */
  test("the lot line and the subtotal are not mistaken for items", () => {
    const r = parseInvoiceLines(page("A60501NA1       08/31/2028", "21598389572888014938GENSN3011ea 6.57 6.57", "        SUB TOTAL", "14.24"), 657);
    assert.equal(r.lines.length, 1);
  });
});
