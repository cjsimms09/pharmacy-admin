import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { looksLikeIpdStatement, readIpdStatement } from "../src/lib/ipd-statement";

/*
 * The owner's real statement, with every identifier changed and every amount as printed: the arithmetic is the point.
 * Two settlements, each an Aytu credit memo offset against a set of invoices, and one invoice paid across both of them.
 */
const text = fs.readFileSync("fixtures/ipd-statement.txt", "utf8");

describe("reading IPD's statement of account", () => {
  const read = readIpdStatement(text);
  assert.ok(read.ok, read.ok ? "" : read.why);
  const s = read.statement;

  test("it is recognised by its own headings, and nothing else is", () => {
    assert.equal(looksLikeIpdStatement(text), true);
    assert.equal(looksLikeIpdStatement("Statement of account\nTotal due 100.00"), false);
  });

  test("both settlements are read, each netting to nought against its credit memo", () => {
    assert.equal(s.settlements.length, 2);
    for (const settlement of s.settlements) {
      assert.equal(settlement.paidCents + (settlement.creditMemo?.cents ?? 0), 0, `${settlement.checkDate} does not net`);
    }
    assert.deepEqual(s.settlements.map((x) => x.checkDate).sort(), ["2026-08-19", "2026-09-03"]);
  });

  test("what each settlement put against each invoice is kept, including a part payment", () => {
    const september = s.settlements.find((x) => x.checkDate === "2026-09-03")!;
    assert.equal(september.invoices.length, 6);
    assert.equal(september.paidCents, 1_070_620);
    /* Two of its six are part payments: $107.00 against a $5,828.13 invoice, and $2,152.03 against a $3,277.39 one. */
    const parts = september.invoices.filter((v) => v.paidCents !== v.invoiceCents);
    assert.deepEqual(
      parts.map((v) => [v.invoiceCents, v.paidCents]).sort((a, b) => a[0] - b[0]),
      [
        [327_739, 215_203],
        [582_813, 10_700],
      ],
    );
  });

  test("one invoice settled across both blocks is one invoice, and the two parts are its whole amount", () => {
    const parts = s.settlements.flatMap((x) => x.invoices).filter((v) => v.invoiceDate === "2026-08-13");
    assert.equal(parts.length, 2);
    assert.equal(new Set(parts.map((v) => v.invoiceNumber)).size, 1);
    assert.deepEqual(parts.map((v) => v.paidCents).sort((a, b) => a - b), [112_536, 215_203]);
    assert.equal(parts[0].invoiceCents, 327_739);
    assert.equal(parts.reduce((n, v) => n + v.paidCents, 0), 327_739);
  });

  test("the credit memo's own date comes from its id, not from the day IPD applied it", () => {
    const august = s.settlements.find((x) => x.checkDate === "2026-08-19")!;
    assert.equal(august.creditMemo?.issuedOn, "2026-08-18");
    assert.equal(august.creditMemo?.cents, -1_432_639);
    const september = s.settlements.find((x) => x.checkDate === "2026-09-03")!;
    assert.equal(september.creditMemo?.issuedOn, "2026-09-03");
  });

  test("the open invoices carry the day the statement says each is due", () => {
    assert.equal(s.openInvoices.length, 5);
    assert.deepEqual([...new Set(s.openInvoices.map((v) => v.dueOn))].sort(), ["2026-09-25", "2026-10-10"]);
    const part = s.openInvoices.find((v) => v.originalCents !== v.remainingCents)!;
    assert.equal(part.originalCents - part.remainingCents, 10_700, "what the September settlement put against it");
  });

  test("it says what it holds, in figures a person can check against the page", () => {
    assert.match(s.says, /2 settlements/);
    assert.match(s.says, /5 invoices still open, \$12,481\.03/);
  });
});

describe("a settlement that does not hold together is refused whole", () => {
  const brokenNet = text.replace("500020260903CM-10,706.20", "500020260903CM-10,706.21");
  test("a credit memo that is not the credit above it", () => {
    const r = readIpdStatement(brokenNet);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /credit memo prints/);
  });

  test("a settlement whose invoices do not come to its credit", () => {
    const short = text.replace("7000002 4,446.27", "7000002 4,446.26");
    const r = readIpdStatement(short);
    assert.match(r.ok ? "" : r.why, /which is not nought/);
  });

  test("more put against an invoice than the invoice is for", () => {
    const over = text.replace("08/18/2026I 202.88\n7000003 202.88", "08/18/2026I 202.88\n7000003 302.88");
    const r = readIpdStatement(over);
    assert.match(r.ok ? "" : r.why, /which is more than it is for/);
  });

  test("a page with no settlement on it at all", () => {
    const r = readIpdStatement("Statement\nCredits used Since 08/15/2026\nPayment RefInv/Cr NbrInvPay\n");
    assert.match(r.ok ? "" : r.why, /no settlement could be read/);
  });
});
