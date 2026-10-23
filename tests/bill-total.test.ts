import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readPrintedBillTotal } from "../src/lib/bill-total";

/** The shape RedSail's PioneerRx invoice prints, with invented figures. */
const BILL = [
  "DescriptionQtyRateAmount",
  "PioneerRx Software Maintenance and Support1100.0000100.00T",
  "Switching Charges - August 20261200.0000200.00",
  "Sub Total$300.00",
  "Tax$20.00",
  "Total$320.00",
].join("\n");

describe("a bill that proves its own total", () => {
  test("the three figures are read and they add up", () => {
    const r = readPrintedBillTotal(BILL);
    assert.ok(r);
    assert.equal(r.subtotalCents, 30_000);
    assert.equal(r.taxCents, 2_000);
    assert.equal(r.totalCents, 32_000);
  });

  test("a page with no tax line is read as no tax, not as unknown", () => {
    const r = readPrintedBillTotal("Sub Total $50.00\nTotal $50.00");
    assert.ok(r);
    assert.equal(r.taxCents, 0);
    assert.equal(r.totalCents, 5_000);
  });

  test("figures that do not add up are refused, so the draft still happens", () => {
    // A penny out is the case this exists to catch: a misread column looks exactly like this.
    assert.equal(readPrintedBillTotal("Sub Total $300.00\nTax $20.00\nTotal $320.01"), null);
  });

  test("a total with no subtotal to check it is refused", () => {
    assert.equal(readPrintedBillTotal("Amount due\nTotal $1,234.56"), null);
  });

  test("'Sub Total' is not mistaken for the total", () => {
    // The total pattern must not match inside "Sub Total", or a page would check itself against itself.
    const r = readPrintedBillTotal("Sub Total$300.00\nTax$20.00\nTotal$320.00");
    assert.ok(r);
    assert.equal(r.totalCents, 32_000);
  });

  test("the last total on a multi-page bill is the one that closes it", () => {
    const r = readPrintedBillTotal("Sub Total $10.00\nTotal $10.00\nSub Total $300.00\nTax $20.00\nTotal $320.00");
    assert.ok(r);
    assert.equal(r.totalCents, 32_000);
  });

  test("nought proves nothing", () => {
    assert.equal(readPrintedBillTotal("Sub Total $0.00\nTotal $0.00"), null);
  });
});
