import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { purchasesMade, bareNumber } from "../src/lib/purchases-made";

/*
 * September 2026 read $148,076.26 more dispensed than bought because invoices alone were counted and 118 deliveries had none on file.
 * PioneerRx has a receipt for every delivery. Every figure here is invented.
 */
const rec = (n: string, d: string, c: number | null) => ({ invoiceNumber: n, invoiceDate: d, totalCents: c });
const base = { month: "2026-09", invoiceLinesCents: 100_000, haveInvoiceLines: true, invoiceNumbers: ["7000001"] as (string | null)[] };

describe("what a month bought", () => {
  test("a delivery with no invoice is counted from PioneerRx's receipt", () => {
    const r = purchasesMade({ ...base, receipts: [rec("7000002", "2026-09-02", 25_000)] });
    assert.equal(r.cents, 125_000);
    assert.equal(r.receiptsUsed, 1);
  });

  test("a delivery that has its invoice is not counted twice, however the number is written", () => {
    const r = purchasesMade({ ...base, receipts: [rec("7000001", "2026-09-02", 100_000), rec("007000001", "2026-09-03", 100_000), rec("INV-7000001", "2026-09-03", 100_000)] });
    assert.equal(r.cents, 100_000);
    assert.equal(r.receiptsUsed, 0);
  });

  test("a receipt whose invoice is dated in another month still matches it", () => {
    const r = purchasesMade({ ...base, invoiceNumbers: ["7000009"], receipts: [rec("7000009", "2026-09-30", 40_000)] });
    assert.equal(r.receiptsUsed, 0, "the invoice is on file wherever it is dated, so the receipt is not a second purchase");
  });

  test("only the month's receipts, and only ones with a total", () => {
    const r = purchasesMade({ ...base, receipts: [rec("A1", "2026-08-31", 10_000), rec("A2", "2026-10-01", 10_000), rec("A3", "2026-09-10", null), rec("A4", "2026-09-10", 7_000)] });
    assert.equal(r.cents, 107_000);
  });

  test("no invoice lines and no receipts says nothing, and receipts alone still count", () => {
    assert.equal(purchasesMade({ ...base, haveInvoiceLines: false, invoiceLinesCents: 0, receipts: [] }).cents, null);
    assert.equal(purchasesMade({ ...base, haveInvoiceLines: false, invoiceLinesCents: 0, receipts: [rec("B1", "2026-09-05", 30_000)] }).cents, 30_000);
  });

  test("numbers compare by their digits", () => {
    assert.equal(bareNumber("00123"), "123");
    assert.equal(bareNumber(null), "");
  });
});
