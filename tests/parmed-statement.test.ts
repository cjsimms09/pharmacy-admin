import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeParmedStatement, readParmedStatement, describeParmedStatement, statementReadOf } from "../src/lib/parmed-statement";

/*
 * Parmed's "Statement & Remittance", as the PDF text reader prints it: every row is two lines, the first running the
 * invoice number, the customer number, the transaction type, the billed date, the purchase order and the due date
 * together with the invoice number printed again at the end; the second the five money columns. Then the ageing
 * bands and the Total Balance. Every identifier here is invented.
 */
const CUSTOMER = "9990000011";
const row = (inv: string, billed: string, po: string, due: string, amount: string) => [`${inv}${CUSTOMER}INV${billed}${po}${due}( )${inv}`, `${amount} 0.00           0.00 ${amount} ${amount} `];
const page = (rows: string[][]) =>
  [
    "Statement & Remittance",
    "Remit to:",
    "ParMed Pharmaceuticals",
    "Payer:",
    "Statement Date Stmt Ref  Payer",
    `09/30/2026  70001  ${CUSTOMER}`,
    "Invoice/Bill-ToTransaction   InvoicePurchase order/Due     InvoicePaymentDiscountBalance Due    ( )InvoiceBalance Due",
    "ReferenceAcct #TypeDateReferenceDate       Amount        MadeNumber",
    "The following items are due by date shown",
    ...rows.flat(),
  ].join("\n");
const totals = (total: string) => ["CurrentFuture1-15 days16-30 days31-45 daysOver 45 daysTotal Balance", `${total} 0.00 0.00 0.00 0.00 0.00 ${total} `, "Past Due:           0.00 "].join("\n");

const rows = [row("7000000001", "09/01/2026", "4374", "10/10/2026", "9.17"), row("7000000002", "09/02/2026", "4378", "10/10/2026", "441.76"), row("7000000003", "09/16/2026", "4415", "10/25/2026", "1,292.18")];

describe("reading Parmed's statement of account", () => {
  test("it is known by its own heading, not its sender", () => {
    assert.equal(looksLikeParmedStatement(page(rows) + "\n" + totals("1,743.11")), true);
    assert.equal(looksLikeParmedStatement("Customer Statement\nsome other supplier\nTotal Balance"), false);
  });
  test("every row is read off the customer number, and the rows must add up to the total the page prints", () => {
    const s = readParmedStatement(page(rows) + "\n" + totals("1,743.11"));
    assert.ok(s);
    assert.equal(s.statementOn, "2026-09-30");
    assert.equal(s.reference, "70001");
    assert.equal(s.customerNumber, CUSTOMER);
    assert.equal(s.rows.length, 3);
    assert.deepEqual(s.rows.map((r) => [r.invoiceNumber, r.billedOn, r.dueOn, r.kind, r.netCents]), [
      ["7000000001", "2026-09-01", "2026-10-10", "INV", 917],
      ["7000000002", "2026-09-02", "2026-10-10", "INV", 44_176],
      ["7000000003", "2026-09-16", "2026-10-25", "INV", 129_218],
    ]);
    assert.equal(s.totalCents, 174_311);
    assert.deepEqual(s.ageing, { current: 174_311, future: 0, days1to15: 0, days16to30: 0, days31to45: 0, over45: 0 });
  });
  test("a statement whose rows miss its own total yields nothing", () => {
    assert.equal(readParmedStatement(page(rows) + "\n" + totals("1,743.12")), null);
  });
  test("a row whose two printed copies of the invoice number disagree is not read", () => {
    const bad = [`7000000009${CUSTOMER}INV09/03/2026438810/10/2026( )7000000008`, "365.52 0.00           0.00 365.52 365.52 "];
    const s = readParmedStatement(page([...rows, bad]) + "\n" + totals("1,743.11"));
    assert.ok(s);
    assert.equal(s.rows.length, 3);
  });
  test("rows across two pages are one statement", () => {
    const two = page(rows.slice(0, 2)) + "\n" + "  Page    1  of    2 " + "\n" + page(rows.slice(2)) + "\n" + totals("1,743.11");
    const s = readParmedStatement(two);
    assert.ok(s);
    assert.equal(s.rows.length, 3);
  });
  test("what it says, and what the store keeps", () => {
    const s = readParmedStatement(page(rows) + "\n" + totals("1,743.11"))!;
    assert.match(describeParmedStatement(s, ["7000000003"]), /\$1,743\.11 is open across 3 invoices, due 2026-10-10 to 2026-10-25/);
    assert.match(describeParmedStatement(s, ["7000000003"]), /1 of the invoices it bills for is not on file here: 7000000003/);
    const read = statementReadOf(s);
    assert.equal(read.supplier, "Parmed");
    assert.equal(read.statementDate, "2026-09-30");
    assert.equal(read.lines.length, 3);
    assert.equal(read.netCents, 174_311);
    assert.deepEqual(read.lines[2], { invoiceNumber: "7000000003", billedOn: "2026-09-16", dueOn: "2026-10-25", grossCents: 129_218, discountCents: 0, netCents: 129_218, kind: "INV" });
  });
});
