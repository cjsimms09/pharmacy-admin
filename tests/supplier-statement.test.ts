import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readSupplierStatement, expectedDebits } from "../src/lib/supplier-statement";
import { placeLines, type MatchContext } from "../src/lib/bank-statement";

/*
 * McKesson's statement of account as of 25 September 2026, in the shape the text layer gives it, with invented
 * figures. Three things it taught the reader that day: a credit prints its minus after the figure with a flag
 * letter; the controlled-substance account's statement prints no description word; and the week's debit is the
 * invoices net of discount LESS the credits — $121,997.41 on the real one, which the ledger had not posted yet.
 */
const MAIN = [
  "STATEMENT  As of: 09/25/2026  Statement for information only  Customer: 999001  Date: 09/26/2026 MCK",
  "09/21/202609/29/20267000000041441801165Invoice  179.47  8,973.68  8,794.21  7000000041",
  "09/22/202609/29/20267000000042442501165Invoice  210.23  10,511.47  10,301.24  7000000042",
  "09/25/202609/25/20267000000043Credit 0.00 5,619.06-P 5,619.06-P7000000043",
  "09/25/202609/25/20267000000044Credit 0.00 94.46-P 94.46-P7000000044",
  "Subtotals: 19,485.15 USD Due If Paid On Time: 13,381.93 USD",
].join("\n");

const CII = ["STATEMENT  As of: 09/25/2026  Statement for information only  Cust: 999002  Date: 09/26/2026 MCK", "09/22/202609/29/20267000000045 91.33 4,566.33 4,475.00 7000000045"].join("\n");

describe("the wholesaler's statement of account", () => {
  test("invoices and credits both read, each by its own arithmetic", () => {
    const r = readSupplierStatement(MAIN);
    assert.equal(r.supplier, "Mckesson");
    assert.equal(r.statementDate, "2026-09-26");
    assert.equal(r.unreadable.length, 0, r.unreadable.join(" | "));
    assert.deepEqual(
      r.lines.map((l) => [l.kind, l.netCents]),
      [
        ["Invoice", 879_421],
        ["Invoice", 1_030_124],
        ["Credit", -561_906],
        ["Credit", -9_446],
      ],
    );
  });

  test("the controlled-substance account's statement, with no description word, still reads", () => {
    const r = readSupplierStatement(CII);
    assert.equal(r.lines.length, 1);
    assert.deepEqual([r.lines[0].kind, r.lines[0].discountCents, r.lines[0].grossCents, r.lines[0].netCents], ["Invoice", 9_133, 456_633, 447_500]);
  });

  test("grouped by due date, the way the bank will take it", () => {
    const d = expectedDebits(readSupplierStatement(MAIN));
    assert.deepEqual(
      d.map((x) => [x.dueOn, x.netCents, x.invoices.length]),
      [
        ["2026-09-25", -571_352, 2],
        ["2026-09-29", 1_909_545, 2],
      ],
    );
  });

  test("a wholesaler's ACH equal to the statement's due-date group settles those invoices, on the day or the day after", () => {
    const base: MatchContext = { payers: [], suppliers: [{ id: "mck", name: "Mckesson" }], vendors: [], unpaidBills: [], unpaidInvoices: [], booksStartOn: "2026-09-01", /* 19,095.45 of invoices due the 29th less 5,713.52 of credits dated the 25th: what the bank takes on the 29th. */ statementDebits: [{ supplier: "Mckesson", dueOn: "2026-09-29", statementDate: "2026-09-26", netCents: 1_338_193, invoices: ["7000000041", "7000000042"] }] };
    const line = (on: string, cents: number) => placeLines([{ on, description: "MCKESSON DRUG/AUTO ACH ACH00000002 WEST WICHITA FAM PHCY", amountCents: cents, key: on + cents }], base)[0].placement;
    const p = line("2026-09-29", -1_338_193);
    assert.equal(p.kind, "settles_ach");
    assert.deepEqual(p.kind === "settles_ach" ? [p.agrees, p.invoices, p.reference] : [], [true, ["7000000041", "7000000042"], "statement 2026-09-26 due 2026-09-29"]);
    assert.equal(line("2026-10-02", -1_338_193).kind === "settles_ach", false);
    assert.equal(line("2026-09-29", -1_338_194).kind === "settles_ach", false);
  });
});

describe("McKesson's Accounts Payable Transaction History (sent 1 October 2026, to be read monthly)", () => {
  const CSV = [
    ",Receivable Number,Transaction Date,Account Number,Account Name,Alternate Payer ID,Company Code,Company Name,Transaction Posting Date,Due Date,DC Number,Transaction Type,Reference,Assignment,Account Street Address,Account State,Account City,Account ZIP,Document Type,Bill Type Code,Bill Type Description,Purchase History Extended Invoice Gross Sell Price ($),Purchase History Extended Price ($),Cash Discount ($),Accounts Payable (Gross Amount) $",
    '1,7000000051,2026-10-01,999001,WEST WICHITA FAM PHCY,,8000,McKesson Drug Company,2026-10-01,2026-10-06,8165,INV - INVOICE,7000000051,7000000051      00,8200 W CENTRAL AVE STE 5,KS,WICHITA,67212,RV - Customer Invoice,ZPF2,Invoice,"$7,466.98","$7,466.98",$152.39,"$7,619.37"',
    '2,7000000052,2026-10-01,999001,WEST WICHITA FAM PHCY,,8000,McKesson Drug Company,2026-10-01,2026-10-06,8165,INV - INVOICE,7000000052,7000000052      00,8200 W CENTRAL AVE STE 5,KS,WICHITA,67212,RV - Customer Invoice,ZPF2,Invoice,$89.00,$89.00,$1.82,$90.82',
    '3,7000000053,2026-10-01,999001,WEST WICHITA FAM PHCY,,8000,McKesson Drug Company,2026-10-01,2026-10-06,8165,INV - INVOICE,7000000053,7000000053      00,8200 W CENTRAL AVE STE 5,KS,WICHITA,67212,RV - Customer Invoice,ZPF2,Invoice,$89.00,$88.00,$1.82,$90.82',
  ].join("\n");

  test("is recognised, and the Open & Closed report is not mistaken for it", async () => {
    const { looksLikeApHistory } = await import("../src/lib/ap-history");
    assert.equal(looksLikeApHistory(CSV), true);
    assert.equal(looksLikeApHistory("Receivable Number,Transaction Status,Check Number,Net Amount ($)\n"), false);
  });

  test("gross less discount is net, with the net in the column named Extended Price; a row that does not balance is not read", async () => {
    const { readApHistory } = await import("../src/lib/ap-history");
    const r = readApHistory(CSV, "2026-10-01");
    assert.equal(r.supplier, "Mckesson");
    assert.deepEqual(
      r.lines.map((l) => [l.invoiceNumber, l.billedOn, l.dueOn, l.grossCents, l.discountCents, l.netCents]),
      [
        ["7000000051", "2026-10-01", "2026-10-06", 761_937, 15_239, 746_698],
        ["7000000052", "2026-10-01", "2026-10-06", 9_082, 182, 8_900],
      ],
    );
    assert.equal(r.unreadable.length, 1);
    assert.match(r.unreadable[0], /7000000053/);
  });
});
