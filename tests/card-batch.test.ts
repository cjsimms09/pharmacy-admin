import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { section } from "./support/fixtures";
import { readFile } from "node:fs/promises";
import { readCardBatch, looksLikeCardBatch, cellsOf } from "../src/lib/card-batch";

/**
 * The credit card batch report: counter takings, one batch a day.
 *
 * The layout is the processor's "POS Gateway Batch Summary Report" as forwarded on 15 September, with
 * every figure and identifier changed. The owner: "credit card info doesnt show fees but will give how
 * much we took in in credit cards daily and should match bank statement deposits".
 */
type Row = [string, number, string, number, string, number, string, number, string, number, string];

const summary = (id: string, rows: Row[], totals: Row) => {
  const td = (v: string | number) => `<td>${v}</td>`;
  const tr = (r: (string | number)[]) => `<tr>${r.map(td).join("")}</tr>`;
  return `<html><head><style>td{font:10px}</style></head><body>
<h2>Batch Detail Report: Batch #${id}</h2><h3>POS Gateway Batch Summary Report</h3>
<table>
${tr(["Site ID", "100001"])}${tr(["Open Date/Time", "9/3/2026 9:15:00 AM"])}
${tr(["Merchant Name", "WEST WICHITA FAMILY PHARM"])}${tr(["Close Date/Time", "9/3/2026 9:04:00 PM"])}
${tr(["Batch ID", id])}${tr(["Batch Status", "C"])}
</table>
<table>
${tr(["Totals"])}${tr(["Credit / Debit Breakdown"])}${tr(["Sales / Return Breakdown"])}
${tr(["Card Type", "Count", "Amount", "Credit Count", "Credit Amount", "Debit Count", "Debit Amount", "Sale Count", "Sale Amount", "Return Count", "Return Amount"])}
${rows.map(tr).join("\n")}
${tr(totals)}
</table></body></html>`;
};

const plain = summary(
  "900000001",
  [
    ["Amex", 1, "5.00", 1, "5.00", 0, "0.00", 1, "5.00", 0, "0.00"],
    ["MC", 2, "95.00", 2, "95.00", 0, "0.00", 2, "95.00", 0, "0.00"],
    ["Visa", 7, "1,900.50", 7, "1,900.50", 0, "0.00", 7, "1,900.50", 0, "0.00"],
  ],
  ["Totals", 10, "2,000.50", 10, "2,000.50", 0, "0.00", 10, "2,000.50", 0, "0.00"],
);
const plainSubject = "Fw: Credit Card Batch (900000001, 9/3/2026) Report: $2000.50, 10 Transactions";

describe("reading a batch", () => {
  test("the net takings, the close date and the card types", () => {
    const r = readCardBatch(plainSubject, plain);
    assert.ok(r.ok, r.ok ? "" : r.why);
    if (!r.ok) return;
    assert.equal(r.batch.batchId, "900000001");
    assert.equal(r.batch.closedOn, "2026-09-03");
    assert.equal(r.batch.totalCents, 200_050);
    assert.equal(r.batch.count, 10);
    assert.deepEqual(r.batch.byCard.map((c) => [c.card, c.count, c.amountCents]), [["Amex", 1, 500], ["MC", 2, 9_500], ["Visa", 7, 190_050]]);
    assert.equal(r.batch.merchant, "WEST WICHITA FAMILY PHARM");
  });

  test("REGRESSION: returns print negative and the total already includes them", () => {
    /*
     * The real case, batch 780961413 of 8 September with its figures changed: sales across 121, returns
     * of −$32.81 across 2, total across 123. The total is sales plus returns — the net the processor
     * settles — and subtracting a negative return again would overstate the deposit.
     */
    const withReturns = summary(
      "900000002",
      [
        ["MC", 50, "1,000.00", 50, "1,000.00", 0, "0.00", 51, "1,020.00", 1, "-20.00"],
        ["Visa", 73, "3,229.27", 73, "3,229.27", 0, "0.00", 74, "3,242.08", 1, "-12.81"],
      ],
      ["Totals", 123, "4,229.27", 123, "4,229.27", 0, "0.00", 125, "4,262.08", 2, "-32.81"],
    );
    const r = readCardBatch("Credit Card Batch (900000002, 9/8/2026) Report: $4229.27, 123 Transactions", withReturns);
    assert.ok(r.ok, r.ok ? "" : r.why);
    if (!r.ok) return;
    assert.equal(r.batch.totalCents, 422_927);
    assert.equal(r.batch.salesCents, 426_208);
    assert.equal(r.batch.returnsCents, -3_281);
    assert.match(r.batch.says, /less \$32\.81 of returns/);
  });

  test("it is recognised forwarded or direct, and nothing else is", () => {
    assert.equal(looksLikeCardBatch(plainSubject), true);
    assert.equal(looksLikeCardBatch("Credit Card Batch (900000001, 9/3/2026) Report: $2000.50, 10 Transactions"), true);
    assert.equal(looksLikeCardBatch("Health Mart Atlas EFT completed"), false);
    assert.equal(looksLikeCardBatch("Re: question about the batch"), false);
  });

  test("the first 'Totals' is a heading, and the totals row is the last one", () => {
    const c = cellsOf(plain);
    assert.ok(c.indexOf("Totals") < c.lastIndexOf("Totals"));
  });
});

describe("what it refuses", () => {
  test("card types that do not add to the total", () => {
    const bad = plain.replace("<td>1,900.50</td><td>7</td><td>1,900.50</td>", "<td>1,800.50</td><td>7</td><td>1,900.50</td>");
    const r = readCardBatch(plainSubject, bad);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /card types come to/);
  });

  test("a subject that disagrees with the summary", () => {
    const r = readCardBatch("Credit Card Batch (900000001, 9/3/2026) Report: $2100.50, 10 Transactions", plain);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /the subject says \$2,100\.50/);
  });

  test("a summary for a different batch than the subject names", () => {
    const r = readCardBatch("Credit Card Batch (900000009, 9/3/2026) Report: $2000.50, 10 Transactions", plain);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /names batch 900000009 and the summary names 900000001/);
  });

  test("a summary with no totals row", () => {
    const r = readCardBatch(plainSubject, "<table><tr><td>Batch ID</td><td>900000001</td></tr></table>");
    assert.equal(r.ok, false);
  });
});

describe("where the money goes", () => {
  test("banked as cash only, keyed on the batch, through the deposit gate", async () => {
    const store = await readFile("src/lib/card-batch-store.ts", "utf8");
    assert.match(store, /kind: "patient"/);
    assert.match(store, /sourceKey: `card-batch\|\$\{b\.batchId\}`/);
    assert.match(store, /addCashReceipt\(/, "through addCashReceipt, which runs the deposit gate");
  });

  test("the accrual account does not read cash receipts, so a batch cannot double its revenue", async () => {
    const pl = await readFile("src/lib/profit-and-loss.ts", "utf8");
    /* `section` refuses if either marker has been renamed, rather than leaving this looking at some other part of the file. */
    const accrual = section(pl, 'label: "Third-party remittance"', "const banked = i.receipts");
    assert.doesNotMatch(accrual, /i\.receipts/, "the accrual branch has started reading cash receipts — card batches would double counter revenue");
  });

  test("a refused batch shows as held, never as passed over", async () => {
    const text = await readFile("src/lib/mailbox.ts", "utf8");
    assert.match(text, /card\.refused \? `Held, nothing stored: /);
  });
});
