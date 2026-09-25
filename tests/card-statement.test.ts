import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";
import { cardStatementBillNumber, looksLikeCardStatement, readCardStatement } from "../src/lib/card-statement";
import { placeLine, type MatchContext } from "../src/lib/bank-statement";
import { ascii85 } from "../src/lib/pdf-text";

/*
 * The shape of a Global Payments merchant statement as `pdfText` returns it: every glyph placed on its
 * own, so every line runs together. The line order and spellings are the August 2026 statement's; every
 * figure and identifier is invented, and chosen so the statement's own totals agree.
 */
const STATEMENT = [
  "DBAName:TESTPHARMACY",
  "StatementPeriod:09/01/2026-09/30/2026",
  "MerchantNumber:11112222333",
  "OneHeartlandWay",
  "MerchantStatement",
  "TotalDeposits.............................................$150.00",
  "TotalFees.................................................$25.00",
  "VisaPass-thruInterchange&Fees",
  "Subtotal$10.00",
  "MasterCardPass-thruInterchange&Fees",
  "GlobalPaymentsCustomerService1-888-000-0000Page2of7",
  "myaccount.globalpayments.com",
  "Subtotal$5.00",
  "AmericanExpressPass-thruFees",
  "Subtotal$1.00",
  "DiscoverPass-thruInterchange&Fees",
  "Subtotal$2.00",
  "GPProcessingFees",
  "Subtotal$7.00",
  "$25.00",
  "Totals",
  "ProcessingSummary-SettledbyGP",
  "3$151.001($1.00)$150.00$50.00",
  "Totals",
  "000201T$100.00-$100.00-",
  "09/02/2026",
  "ACH09/03/2026---$100.00",
  "000202T$50.00-$50.00-",
  "09/03/2026",
  "ACH09/04/2026---$50.00",
  "FeesT09/30/2026---($25.00)",
  "$150.00$0.00",
  "Totals",
].join("\n");

describe("the monthly card processing statement", () => {
  test("is recognised by its own words, and a rebate report is not", () => {
    assert.equal(looksLikeCardStatement(STATEMENT), true);
    assert.equal(looksLikeCardStatement("Rebate Summary\nTier Compliance Rate 92%\nMcKesson"), false);
  });

  test("reads the fees by section, the deposits by batch, and the auto-debit", () => {
    const r = readCardStatement(STATEMENT);
    assert.ok(r.ok, r.ok ? "" : r.why);
    const s = r.statement;
    assert.equal(s.periodFrom, "2026-09-01");
    assert.equal(s.periodTo, "2026-09-30");
    assert.equal(s.totalFeesCents, 2500);
    assert.equal(s.totalDepositsCents, 15000);
    assert.deepEqual(s.feeSections.map((f) => f.name), ["Visa", "MasterCard", "AmericanExpress", "Discover", "Global Payments processing"]);
    assert.equal(s.passThroughCents, 1800);
    assert.equal(s.processorCents, 700);
    assert.equal(s.transactions, 3);
    assert.equal(s.salesCents, 15100);
    assert.equal(s.refundsCents, -100);
    assert.deepEqual(s.deposits, [
      { sequence: "000201", batchDate: "2026-09-02", amountCents: 10000, achDate: "2026-09-03" },
      { sequence: "000202", batchDate: "2026-09-03", amountCents: 5000, achDate: "2026-09-04" },
    ]);
    assert.deepEqual(s.feeDebit, { on: "2026-09-30", cents: 2500 });
    assert.equal(cardStatementBillNumber(s), "GP-11112222333-2026-09-30");
  });

  test("a fee section that does not add up refuses the whole statement", () => {
    const r = readCardStatement(STATEMENT.replace("Subtotal$7.00", "Subtotal$8.00"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /fee sections come to \$26\.00/);
  });

  test("a deposit row that does not add up refuses it", () => {
    const r = readCardStatement(STATEMENT.replace("000202T$50.00-$50.00-", "000202T$40.00-$40.00-"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /deposit rows come to \$140\.00/);
  });

  test("an auto-debit that is not the fees refuses it", () => {
    const r = readCardStatement(STATEMENT.replace("($25.00)", "($24.00)"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /auto-debit is \$24\.00/);
  });

  test("fees netted from a deposit are refused, not absorbed — it changes how every batch meets the bank", () => {
    const r = readCardStatement(STATEMENT.replace("000201T$100.00-$100.00-", "000201T$100.00($3.00)$100.00-"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /netted from deposits/);
  });
});

describe("the bank's card fee debit", () => {
  const ctx: MatchContext = { payers: [], suppliers: [], vendors: [], unpaidBills: [], unpaidInvoices: [] };
  const debit = { on: "2026-10-02", description: "HRTLAND PMT SYS/TXNS/FEES", amountCents: -2500, key: "k" };

  test("confirms the bill the statement booked, though that bill is already marked paid", () => {
    const p = placeLine(debit, { ...ctx, cardFeeBills: [{ id: "e1", vendorName: "Global Payments (Heartland)", amountCents: 2500, invoiceDate: "2026-09-30" }] });
    assert.equal(p.kind, "pays_bill");
    assert.equal(p.kind === "pays_bill" ? p.expenseId : null, "e1");
  });

  test("with no statement on file it is left for a person, and says to forward the statement rather than book it by hand", () => {
    const p = placeLine(debit, { ...ctx, cardFeeBills: [{ id: "e1", vendorName: null, amountCents: 2400, invoiceDate: "2026-09-30" }] });
    assert.equal(p.kind, "unplaced");
    assert.match(p.why, /Forward that month's statement/);
  });
});

describe("ASCII85, which the statement wraps every page in before Flate", () => {
  /* The standard encoding, written out here so the decoder is tested against something other than itself. */
  function encode(buf: Buffer): string {
    let out = "";
    for (let i = 0; i < buf.length; i += 4) {
      const chunk = buf.subarray(i, i + 4);
      const n = chunk.length;
      const padded = Buffer.concat([chunk, Buffer.alloc(4 - n)]);
      const v = padded.readUInt32BE(0);
      if (n === 4 && v === 0) {
        out += "z";
        continue;
      }
      const digits: string[] = [];
      let x = v;
      for (let k = 0; k < 5; k++) {
        digits.unshift(String.fromCharCode((x % 85) + 33));
        x = Math.floor(x / 85);
      }
      out += digits.slice(0, n + 1).join("");
    }
    return `${out}~>`;
  }

  test("decodes the textbook example", () => {
    assert.equal(ascii85(Buffer.from("9jqo^~>"))?.toString("latin1"), "Man ");
  });

  test("round-trips a Flate stream of every length, including runs of zeros and a short last group", () => {
    for (const text of ["BT /F1 9 Tf (Total Fees) Tj ET", "a", "ab", "abc", "\0\0\0\0\0\0\0\0x"]) {
      const flated = deflateSync(Buffer.from(text, "latin1"));
      const back = ascii85(Buffer.from(`<~${encode(flated)}`));
      assert.ok(back);
      assert.equal(inflateSync(back).toString("latin1"), text);
    }
  });

  test("refuses bytes that are not ASCII85, so a Flate stream is not mangled by it", () => {
    assert.equal(ascii85(deflateSync(Buffer.from("hello"))), null);
    assert.equal(ascii85(Buffer.from("9jqo^")), null);
  });
});
