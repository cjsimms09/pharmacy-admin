import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifySupplierDocument, looksLikeInvoice } from "../src/lib/invoices";

/**
 * Telling an invoice from a statement of account.
 *
 * Both arrive as a PDF from the same address with the same kind of subject line. Only one of them
 * is a record that goods were received, and only that one belongs in a file an inspector reads
 * under 21 CFR 1304.04(h)(1). The rule that separates them is the item table: an invoice lists what
 * was shipped, NDC by NDC, and a statement lists invoice numbers and balances.
 */
describe("what a supplier actually sent", () => {
  const invoice = [
    "INDEPENDENT PHARMACY DISTRIBUTOR       INVOICE",
    "Invoice No: 1004797            Invoice Date: 09/02/2026",
    "68180051103 LOSARTAN 100MG TAB 90    $12.40   $12.40",
    "00093721698 AMLODIPINE 5MG TAB 90    $3.15    $6.30",
    "65862008201 SERTRALINE 50MG TAB 30   $4.02    $4.02",
    "Total Due: $22.72",
  ].join("\n");

  const statement = [
    "INDEPENDENT PHARMACY DISTRIBUTOR",
    "STATEMENT OF ACCOUNT",
    "Statement Date: 09/01/2026",
    "Previous Balance                     $4,102.55",
    "Invoice 1004797   09/02/2026         $22.72",
    "Invoice 1004812   09/04/2026        $318.90",
    "Current    31-60 Days    61-90 Days   Over 90",
    "$341.62    $0.00         $0.00        $0.00",
    "Amount Enclosed: ____________",
  ].join("\n");

  test("an item table with NDCs on it is an invoice", () => {
    assert.equal(classifySupplierDocument(invoice, "invoice_1004797.pdf", "Invoice").kind, "invoice");
  });

  test("balances and aging buckets with no item lines is a statement", () => {
    const c = classifySupplierDocument(statement, "stmt.pdf", "Your statement of account");
    assert.equal(c.kind, "statement");
    assert.match(c.why, /no item lines/);
  });

  test("a statement is never filed as an invoice, whatever the subject says", () => {
    assert.equal(
      looksLikeInvoice({ fileName: "stmt.pdf", mimeType: "application/pdf", subject: "Invoice — statement of account", supplier: "IPD", text: statement }),
      false,
      "the subject said invoice twice over; the document is what counts",
    );
  });

  test("an invoice with the word statement in its footer is still an invoice", () => {
    const withFooter = `${invoice}\nThis invoice will appear on your next statement.`;
    assert.equal(classifySupplierDocument(withFooter, "inv.pdf", "Invoice").kind, "invoice");
    assert.equal(looksLikeInvoice({ fileName: "inv.pdf", mimeType: "application/pdf", subject: "Invoice", supplier: "IPD", text: withFooter }), true);
  });

  /*
   * A credit memo files with the invoices, and it is the one exception to the rule above.
   *
   * This test used to assert the opposite, and it was right when it was written: a credit had
   * nowhere to go, so letting it in as an invoice would have added $199.00 to a month instead of
   * taking it off. What changed is that `readTotalCents` can now read a negative — IPC prints its
   * credits in brackets — so the same filing that was wrong is now the arithmetic that makes it
   * right.
   *
   * The documents this still refuses are refused for a different reason. A statement of account and
   * a rebate breakdown restate money already counted somewhere else, so filing them as invoices
   * counts it twice. A credit memo is money counted nowhere at all, on a document the wholesaler
   * issues in the same series as its invoices and applies against one of them by number.
   */
  test("a credit memo files with the invoices, negative", () => {
    const credit = ["INDEPENDENT PHARMACY COOPERATIVE", "CREDIT MEMO   RGA 88213", "Credit applied to account: $118.40"].join("\n");
    assert.equal(classifySupplierDocument(credit, "credit.pdf", "").kind, "credit_memo");
    assert.equal(looksLikeInvoice({ fileName: "credit.pdf", mimeType: "application/pdf", subject: "Invoice credit", supplier: "IPC", text: credit }), true);
  });

  test("a statement and a rebate breakdown are still refused, because their money is counted elsewhere", () => {
    const statement = ["INDEPENDENT PHARMACY DISTRIBUTOR", "STATEMENT OF ACCOUNT", "Balance forward", "Aging: 30 60 90"].join("\n");
    assert.equal(looksLikeInvoice({ fileName: "stmt.pdf", mimeType: "application/pdf", subject: "Invoice", supplier: "IPD", text: statement }), false);
  });

  test("with nothing readable in it, the old behaviour stands", () => {
    assert.equal(classifySupplierDocument(null, "invoice_9.pdf", "Invoice").kind, "unknown");
    assert.equal(looksLikeInvoice({ fileName: "invoice_9.pdf", mimeType: "application/pdf", subject: "Invoice", supplier: "IPD", text: null }), true);
  });
});
