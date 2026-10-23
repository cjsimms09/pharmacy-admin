import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fixture, mutate as alter } from "./support/fixtures";
import { readIpdStatement } from "../src/lib/ipd-statement";

/*
 * The shape the owner's statement of 25 October 2026 had, with every identifier and amount invented. It was refused whole
 * ("$2,350.33 is put against an invoice of $267.23") because it carries two things the reader had not met: rows that pay a
 * debit memo, whose reference ends DM, and one credit memo applied in two parts, the second printed before its rows and with
 * its first part's amount cut short by the text layer ("-3,600."). The open invoices were printed without a due date.
 */
const text = fixture("fixtures/ipd-statement-split-credit.txt");
const mutate = (from: string, to: string) => alter(text, from, to);

describe("a credit memo applied in two parts, and rows that pay debit memos", () => {
  const read = readIpdStatement(text);
  assert.ok(read.ok, read.ok ? "" : read.why);
  const s = read.statement;
  const first = s.settlements.filter((x) => x.creditMemo?.id === "191120261118");

  test("both parts are read, and each is exactly what its own rows come to", () => {
    assert.equal(s.settlements.length, 3);
    assert.deepEqual(first.map((x) => [x.part, x.paidCents, x.invoices.length]), [[1, 360_000, 4], [2, 60_000, 1]]);
    for (const x of s.settlements) assert.equal(x.paidCents + (x.creditMemo?.cents ?? 0), 0);
  });

  test("the cut-off figure is worked out from the memo's total, and both parts carry the whole credit", () => {
    assert.equal(first[0].creditMemo?.cents, -360_000);
    assert.equal(first.every((x) => x.memoTotalCents === -420_000), true);
  });

  test("a debit memo is a row of the settlement that paid it, marked as one", () => {
    const dms = first[0].invoices.filter((v) => v.debitMemo);
    assert.deepEqual(dms.map((v) => [v.invoiceNumber, v.invoiceDate, v.paidCents]), [["191120261103DM", "2026-11-03", 50_000], ["191120261118DM", "2026-11-18", 50_000]]);
    assert.equal(first[1].invoices.some((v) => v.debitMemo), false);
  });

  test("a part payment of an ordinary invoice is kept as one", () => {
    const part = first[0].invoices.find((v) => v.invoiceNumber === "8000002")!;
    assert.deepEqual([part.invoiceCents, part.paidCents], [200_000, 160_000]);
  });

  test("open invoices printed without a due date are counted, never reported as none", () => {
    assert.equal(s.openInvoices.length, 0);
    assert.equal(s.openUnread, 2);
    assert.match(s.says, /2 more printed without a due date or balance/);
    assert.doesNotMatch(s.says, /0 invoices still open, \$0\.00\./);
  });
});

describe("a split that does not hold is refused, naming the block", () => {
  test("a cut-off figure that is not the memo's total less its other part", () => {
    const r = readIpdStatement(mutate("191120261118CM-3,600.\n", "191120261118CM-3,700.\n"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /prints 3,700\. where its total less its other part is -\$3,600\.00/);
  });

  test("rows that no split of the credit accounts for", () => {
    const r = readIpdStatement(mutate("9000001 600.00", "9000001 590.00"));
    assert.match(r.ok ? "" : r.why, /pays \$590\.00 against a credit of -\$600\.00, which is not nought/);
  });

  test("a row left over when the credits are used up", () => {
    const extra = mutate("9000001 600.00\n", "9000001 600.00\n11/20/2026I 100.00\n9000009 100.00\n");
    const r = readIpdStatement(extra);
    assert.match(r.ok ? "" : r.why, /1 row in the 2026-11-18 settlement is paid by no credit/);
  });

  test("a payment row with no invoice row above it", () => {
    const r = readIpdStatement(mutate("8000001 1,000.00", "8000001 1,000.00\n8000099 10.00"));
    assert.match(r.ok ? "" : r.why, /payment row has no invoice above it/);
  });
});
