import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceLines } from "../src/lib/invoice-lines";

/**
 * A McKesson drop ship: goods sent straight from the manufacturer, on a different layout.
 *
 * A drop ship invoice of 17 September 2026 arrived as $46.20 with nothing under it — no format
 * claimed a single line, not even as unreadable. Two differences from a warehouse invoice did it:
 * a drop ship prints no nine-digit document number, and its quantity carries decimals.
 *
 * The fourth time a McKesson line of an unexpected shape has cost a whole invoice, after the missing
 * AWP column, the two-letter rebate flag and the GTIN-14. Figures below are invented; the layout is
 * theirs, including the freight line that has no NDC because it is not a product.
 */
const dropShip = [
  "NDC/UPC/UDI#ITEM#QTYUM    ITEM DESCRIPTIONRETAIL XPRICEDAMOUNT   M",
  "38779-0227-01207-8236        1.000EA DILTIAZEM HCI MED 10G DSR       38.70 K       38.70 6.1",
  "POWDER DSCSA-NO",
  "294-8743294-8743        1.000EA DROP SHIP FREIGHT        7.50         7.50 ",
  "DSCSA-NO",
  "NET PAYABLE BY STATEMENT DATE 09/22/2026:$46.20 ",
].join("\n");

/* A warehouse line, which prints the document number and an integer quantity. */
const warehouse = ["64850-0513-01267-2681975342631            2*EA AMPHET MIXSLT ER CP20MGELI100       35.00 K       70.00"].join("\n");

describe("a drop ship invoice", () => {
  test("its item line is read even though no document number is printed", () => {
    const p = parseInvoiceLines(dropShip, 4620);
    assert.equal(p.format, "mckesson");
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0]?.ndc11, "38779022701");
    assert.equal(p.lines[0]?.quantity, 1, "a quantity printed 1.000 is one");
    assert.equal(p.lines[0]?.extendedCents, 3870);
  });

  test("the freight is counted towards the total and against no drug", () => {
    /*
     * Both halves matter. Uncounted, $38.70 against a $46.20 total fails the all-or-nothing rule and
     * throws the drug line away with it. Counted as a product, $7.50 of carriage becomes part of what
     * that powder cost — a fifth dearer than it was, and differently on every invoice.
     */
    const p = parseInvoiceLines(dropShip, 4620);
    assert.equal(p.chargesCents, 750);
    assert.equal(p.charges[0]?.description, "DROP SHIP FREIGHT");
    assert.equal(p.totalCents, 3870, "the products alone");
    assert.equal(p.reconciles, true, "products plus charges are the invoice's own total");
    assert.ok(!p.lines.some((l) => /freight/i.test(l.description ?? "")), "freight is never a line with an NDC");
  });

  test("a warehouse invoice reads exactly as it always did", () => {
    /* The change must not touch the forty that were already working. */
    const p = parseInvoiceLines(warehouse, 7000);
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0]?.ndc11, "64850051301");
    assert.equal(p.lines[0]?.quantity, 2);
    assert.equal(p.lines[0]?.extendedCents, 7000);
    assert.equal(p.chargesCents, 0);
    assert.equal(p.reconciles, true);
  });

  test("a product line is never mistaken for a charge", () => {
    /*
     * The charge pattern needs the item number printed twice, which a product line never does. If it
     * could claim one, that drug would lose its NDC and its cost would vanish silently.
     */
    const p = parseInvoiceLines(warehouse, 7000);
    assert.equal(p.charges.length, 0);
  });
});
