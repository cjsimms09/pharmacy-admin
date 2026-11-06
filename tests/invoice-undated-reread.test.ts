import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyInvoiceText } from "../src/lib/invoices";

/*
 * Two IPD invoices sat with no date from 4-5 November to 6 November 2026 and the morning list said so, though the pages print
 * "Ship Date:" and "Order Date:" and the reader knew both labels. They were filed before it did, and nothing read them again.
 * `rereadUndatedInvoices` does, nightly. It needs a PDF to read, so what is pinned here is the reading of the header and that the nightly job calls it.
 */
describe("an invoice with no date is read again", () => {
  const header = [
    "Independent Pharmacy Distributor, LLC          Web Site: www.example.test                       1000001",
    "1 Invented Road                                DEA Lic#: XX0000000",
    "Anytown, NC 00000                              State Lic#: 000                                  Ship Date: 11/04/2026",
    "USA                                            State CS Lic#: NC-INVENTED                       Order Date: 11/03/2026",
    "Page 1 of 1",
    "Expiry Date 04/30/2028   Quantity Allocated",
  ].join("\n");

  test("the date printed as Ship Date is the invoice date, and not an item's expiry date", () => {
    assert.equal(classifyInvoiceText(header).invoiceDate, "2026-11-04");
  });

  test("the nightly invoice job calls the re-read, and the re-read sets the date through setInvoiceDate", () => {
    const tick = readFileSync("src/instrumentation.ts", "utf8");
    assert.match(tick, /rereadUndatedInvoices\(\{ user: \{ name: "the nightly re-read" \} \}\)/);
    const lib = readFileSync("src/lib/invoices.ts", "utf8");
    assert.match(lib, /export async function rereadUndatedInvoices/);
    assert.match(lib, /await setInvoiceDate\(row\.id, date,/);
  });
});
