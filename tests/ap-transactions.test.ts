import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readApTransactions, apPayments, apUpcoming, agreesWithInvoices, readReturnsDetail, looksLikeApTransactions, looksLikeReturnsDetail } from "../src/lib/ap-transactions";

/**
 * Rows copied from the real Accounts Payable Open & Closed Transactions report of 11 September.
 *
 * The report is the one thing that says which invoices left the bank together. Every invoice
 * cleared under CKACH07227740 was taken as a single ACH of $106,322.62 — no bank line will ever
 * equal one invoice, which is why matching a payment to invoices has been impossible until now.
 */
const HEAD =
  ",Receivable Number,Transaction Date,Account Number,Account Name,Alternate Payer ID,Transaction Type,Assignment,DC,Company Code," +
  "Payment Authorizer,Payment Authorization Date,Last Approver,Check Number,Due Date,Clearing Document,Clearing Date,Transaction Status," +
  "Posting Date,Reason Code,Payment Method,Reason Code Description,Document Type,Bill Type Code,Bill Type Description," +
  "Gross Amount ($),Cash Discount ($),Net Amount ($),Order Submitted By ID,Order Submitted Date,Order Received By ID,Order Received Date,Order Status,Mobile ID Received,Department Name";

const OPEN =
  '1,7657345034,2026-09-11,326136,WEST WICHITA FAM PHCY,,INV - INVOICE,0910261502      01,8165,8000,,,,,2026-09-15,,,Open - Pending Approval,2026-09-11,,,,RV - Customer Invoice,ZPF2,Invoice,"$22,569.96",$451.40,"$22,118.56",q2b5r7y5,2026-09-10,,,INVOICED,,';
const CLEARED =
  '37,7656141694,2026-09-04,326136,WEST WICHITA FAM PHCY,,INV - INVOICE,4387            00,8165,8000,,,,CKACH07227740,2026-09-08,1413871466,2026-09-07,Closed - Cleared,2026-09-04,,,,RV - Customer Invoice,ZPF2,Invoice,$65.18,$1.30,$63.88,q2b5r7y5,2026-09-03,,,INVOICED,,';
const CSV = [HEAD, OPEN, CLEARED].join("\n");

describe("the accounts payable report", () => {
  test("it is recognised by its columns, not its name", () => {
    assert.equal(looksLikeApTransactions(HEAD), true);
    assert.equal(looksLikeApTransactions("Rx Number,Status,Amount"), false);
  });

  test("gross less the cash discount is the net, and the net is what the invoice prints", () => {
    const r = readApTransactions(CSV);
    assert.equal(r.unreadable.length, 0);
    const open = r.rows.find((x) => x.invoiceNumber === "7657345034")!;
    assert.equal(open.grossCents, 2_256_996);
    assert.equal(open.discountCents, 45_140);
    /* The site has held $12,998.31 for 7657345037 since it arrived: the books were already on net. */
    assert.equal(open.netCents, 2_211_856);
  });

  test("a row whose arithmetic does not hold is not read as a number", () => {
    const broken = CLEARED.replace("$63.88", "$62.88");
    const r = readApTransactions([HEAD, broken].join("\n"));
    assert.equal(r.rows.length, 0);
    assert.equal(r.unreadable.length, 1);
  });

  test("cleared and open are told apart, because one is money gone and the other is money to go", () => {
    const r = readApTransactions(CSV);
    assert.equal(r.rows.filter((x) => x.cleared).length, 1);
    assert.equal(r.openCents, 2_211_856);
    assert.equal(r.clearedCents, 6_388);
  });

  test("cleared invoices group into the one ACH the bank will show", () => {
    const p = apPayments(readApTransactions(CSV));
    assert.equal(p.length, 1);
    assert.equal(p[0].checkNumber, "CKACH07227740");
    assert.equal(p[0].clearingDate, "2026-09-07");
    assert.deepEqual(p[0].invoices, ["7656141694"]);
  });

  test("what has not been paid is grouped by the day it will be taken", () => {
    const u = apUpcoming(readApTransactions(CSV));
    assert.deepEqual(u, [{ dueOn: "2026-09-15", invoices: ["7657345034"], netCents: 2_211_856 }]);
  });

  test("it agrees with an invoice on file, and names one that never arrived", () => {
    const a = agreesWithInvoices(readApTransactions(CSV), [{ invoiceNumber: "7657345034", totalCents: 2_211_856 }]);
    assert.equal(a.agree, 1);
    assert.equal(a.differ.length, 0);
    assert.deepEqual(a.notOnFile.map((x) => x.invoiceNumber), ["7656141694"]);
  });

  test("a disagreement names both figures rather than picking one", () => {
    const a = agreesWithInvoices(readApTransactions(CSV), [{ invoiceNumber: "7657345034", totalCents: 2_211_800 }]);
    assert.equal(a.differ.length, 1);
    assert.equal(a.differ[0].onFileCents, 2_211_800);
    assert.equal(a.differ[0].reportCents, 2_211_856);
  });
});

/** A row from the real Returns Details report of the same day. */
const RET_HEAD =
  "Account Name (History),Account Number (History),McKesson Item Number,Item Description,NDC/UPC (History),Invoice/Credit Date," +
  "Reference Number,Invoice/Credit Number,Gross Returns ($),Net Handling Charge Amount ($),Net Returned Price ($),Returned Quantity," +
  "Return Reason Description,Date Returned,Date Credited Back to Customer,Original Invoice Number,Street Address (History),City (History),State (History),ZIP (History)";
const RET_ROW =
  "WEST WICHITA FAM PHCY,326136,2880557,QUVIVIQ TB 25MG 30,80491782503,2026-08-20,7653443963,7653443963,-$491.74,$0.00,-$491.74,-1,Saleable Return,2026-08-20,2026-08-20,7646508683,8200 W CENTRAL AVE STE 5,WICHITA,KS,67212";

describe("the returns report", () => {
  test("it is recognised by its columns", () => {
    assert.equal(looksLikeReturnsDetail(RET_HEAD), true);
    assert.equal(looksLikeReturnsDetail(HEAD), false);
  });

  test("a credit is money coming back, so it reads negative", () => {
    const r = readReturnsDetail([RET_HEAD, RET_ROW].join("\n"));
    assert.equal(r.credits.length, 1);
    const c = r.credits[0];
    assert.equal(c.netCents, -49_174);
    assert.equal(c.creditNumber, "7653443963");
    assert.equal(c.creditedOn, "2026-08-20");
    assert.equal(c.ndc11, "80491782503");
    assert.equal(c.reason, "Saleable Return");
    /* The invoice it was bought on, which is what lets a credit be set against its purchase. */
    assert.equal(c.originalInvoice, "7646508683");
    assert.equal(r.totalCents, -49_174);
  });
});
