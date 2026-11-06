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

/**
 * The two columns the pattern had no room for.
 *
 * The owner, on the morning two ParMed invoices came in with a total and no lines: "fix so these
 * issues dont keep happening with parmed".
 *
 * The reader matched the run of class letters and then expected digits. That reads the rows above
 * and nothing with anything in the columns between, and ParMed's header names two that break it:
 * DESCRIPTION, which it prints on front-end and device lines and omits on drugs, and NOTE, which
 * carries codes like "NR". Real rows from 11 September 2026:
 *
 *   102399715075537009710HHCLC100TACCU-CHEK SOFTCLIX LC 10011CT 11.87 11.87
 *   101327892600169750111RXMD1NR33ea 74.51 223.53
 *
 * Three of six lines matched on the first invoice and none on the second. Because what matched came
 * to $657.98 against a printed $722.34, the reading did not reconcile and every line was thrown
 * away — which on the screen is an invoice with a total and no items, indistinguishable from an
 * unreadable scan. Neither was a scan. Both were completely legible.
 *
 * So the fix is to read the row from its two fixed ends and not interpret the middle at all, which
 * is what this file's own docstring said the reader did.
 */
describe("ParMed rows that carry a description or a note code", () => {
  /* Invoice 7491384103, every line, as the text extractor produced it. */
  const REAL = page(
    "102399715075537009710HHCLC100TACCU-CHEK SOFTCLIX LC 10011CT 11.87 11.87",
    "117700          01/31/2028",
    "21531511449502010102RXSY122ea 291.00 582.00",
    "VT6348          04/30/2029",
    "31402035060505082901GENSN1611ea 4.37 4.37",
    "405523204365702731103HHCKT1TACCU-CHEK GUIDE ME KIT11ea 10.49 10.49",
    "SAB10523A       01/31/2029",
    "71571845700781324664GENSY1033CT 23.87 71.61",
    "1305439112365702712102HHCSI1TACCU-CHEK GUIDE SI 10011ea 42.00 42.00",
  );

  test("REGRESSION: a line with a product name on it is read", () => {
    const r = parseInvoiceLines(page("102399715075537009710HHCLC100TACCU-CHEK SOFTCLIX LC 10011CT 11.87 11.87"), 1_187);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].extendedCents, 1_187);
    assert.equal(r.lines[0].unitCostCents, 1_187);
    assert.equal(r.lines[0].quantity, 1);
    assert.equal(r.lines[0].unitOfMeasure, "CT");
  });

  test("REGRESSION: a line with a note code between the size and the unit is read", () => {
    // Invoice 7491383165, its only line — a Schedule II item, and the whole invoice was lost.
    const r = parseInvoiceLines(page("101327892600169750111RXMD1NR33ea 74.51 223.53"), 22_353);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].extendedCents, 22_353);
    assert.equal(r.lines[0].quantity, 3);
    assert.equal(r.lines[0].ndc11, "00169750111");
  });

  test("the whole invoice reads, and reconciles against its printed goods subtotal", () => {
    const r = parseInvoiceLines(REAL, 72_234);
    assert.equal(r.lines.length, 6);
    assert.equal(r.totalCents, 72_234);
    assert.equal(r.reconciles, true);
    assert.deepEqual(r.unreadable, []);
  });

  test("the NDC still comes from the front of the row, not from the description", () => {
    const r = parseInvoiceLines(REAL, 72_234);
    /*
     * The last eleven digits of the leading run, exactly as before the description was allowed for.
     * The description sits after that run and contributes no digits to it — which is the property
     * worth pinning, because a pattern that walked the middle could have taken "100" off
     * "ACCU-CHEK SOFTCLIX LC 100" and shifted the NDC by three places.
     */
    assert.deepEqual(r.lines.map((l) => l.ndc11), [
      "75537009710",
      "49502010102",
      "60505082901",
      "65702731103",
      "00781324664",
      "65702712102",
    ]);
  });

  test("the description is not claimed, because it cannot be separated from the size", () => {
    /*
     * "ACCU-CHEK SOFTCLIX LC 10011CT" splits as "LC 100" and 11, or "LC 1001" and 1, and the row
     * cannot say which — the same ambiguity that stops the quantity being read off the page. A
     * description ending in half a pack size would match nothing in the catalogue.
     */
    for (const l of parseInvoiceLines(REAL, 72_234).lines) assert.equal(l.description, null);
  });

  test("the lot and expiry rows between the items are still not items", () => {
    const r = parseInvoiceLines(REAL, 72_234);
    assert.equal(r.lines.length, 6);
    // Six items on a page holding nine candidate rows: three are lot numbers with dates.
    assert.deepEqual(r.unreadable, []);
  });

  test("and it does not reach across an IPC row, which prints its money differently", () => {
    // PARMED is tried before the IPC patterns, so a loosened middle must not steal their lines.
    const ipc = "5269337Betamethasone Dip Oint 0.05% Vio 1572578009301$49.10$61.37-1-1$2.51($2.51)";
    const r = parseInvoiceLines(page(ipc), -251);
    for (const l of r.lines) assert.ok(l.extendedCents < 0, "an IPC credit line must stay negative");
    assert.notEqual(r.format, "parmed");
  });
});
