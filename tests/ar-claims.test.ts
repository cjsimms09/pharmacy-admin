import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { owedByPayer, type Receivable, type Received } from "../src/lib/payer-owed";
import { ageOutstanding, arReport, arReportText, arReportCsv } from "../src/lib/ar-report";

/*
 * Receivables settled and aged claim by claim, and a negative remit listed as a fee the pharmacy owes. Invented BINs,
 * claim ids and figures.
 */
const BIN = "999011";
const AS_AT = "2026-10-31";
const bill = (claimId: string, dateFilled: string, cents: number, over: Partial<Receivable> = {}): Receivable => ({ bin: BIN, name: "Test Plan", dateFilled, cents, cashPlan: false, claimId, portion: "primary", ...over });
const paid = (claimId: string | null, cents: number, over: Partial<Received> = {}): Received => ({ bin: BIN, payer: "Test Plan", cents, receivedOn: "2026-10-10", matched: claimId !== null, claimId, portion: "primary", ...over });

describe("a payer that has part-paid, aged claim by claim", () => {
  const receivables = [bill("c1", "2026-09-01", 10000), bill("c2", "2026-09-20", 7000), bill("c3", "2026-10-15", 5000)];

  test("each unpaid claim sits in the band of its own fill, and nothing is left unaged", () => {
    const s = owedByPayer(receivables, [paid("c1", 10000)], AS_AT);
    const a = ageOutstanding(receivables, s, AS_AT);
    assert.deepEqual(a.bands, { "0-30": 5000, "31-60": 7000, "61-90": 0, "91+": 0 });
    assert.equal(a.unagedCents, 0);
    assert.equal(s.lines[0].outstandingCents, 12000);
    assert.equal(s.lines[0].state, "owes");
    assert.equal(s.lines[0].oldestOn, "2026-09-20", "the oldest claim still unsettled, now that claims are known");
  });

  test("the bands add up to the outstanding total", () => {
    const s = owedByPayer(receivables, [paid("c2", 3000)], AS_AT);
    const a = ageOutstanding(receivables, s, AS_AT);
    assert.equal(Object.values(a.bands).reduce((n, b) => n + b, 0) + a.unagedCents, s.outstandingCents);
  });

  test("an overpaid claim does not settle another: the other is still outstanding, and the excess is named", () => {
    const s = owedByPayer([bill("c1", "2026-09-01", 10000), bill("c2", "2026-09-20", 10000)], [paid("c1", 15000)], AS_AT);
    assert.equal(s.lines[0].outstandingCents, 10000);
    assert.equal(s.lines[0].overpaidCents, 5000);
    assert.equal(s.lines[0].state, "owes");
    assert.match(s.lines[0].says, /\$50\.00 of what arrived was more than its own claims asked for/);
  });

  test("a payment matched to a claim this period does not bill settles nothing here, and is counted apart", () => {
    const s = owedByPayer(receivables, [paid("c-august", 9999)], AS_AT);
    assert.equal(s.receivedCents, 0);
    assert.deepEqual(s.outside, { count: 1, cents: 9999 });
    assert.deepEqual(s.unattached, { count: 0, cents: 0 });
  });

  test("a payment matched to no claim stays unattached and is never spread over the claims", () => {
    const s = owedByPayer(receivables, [paid(null, 5000)], AS_AT);
    assert.equal(s.outstandingCents, 22000);
    assert.deepEqual(s.unattached, { count: 1, cents: 5000 });
  });
});

describe("a voucher is a secondary share on the claim", () => {
  test("the programme's payment settles only the secondary share, the plan's only the primary", () => {
    const r = [bill("c1", "2026-09-10", 81347), bill("c1", "2026-09-10", 10000, { bin: null, name: "Veridikal (eVoucher)", portion: "secondary" })];
    const s = owedByPayer(r, [paid("c1", 10000, { bin: null, payer: "Veridikal (eVoucher)", portion: "secondary" })], AS_AT);
    const plan = s.lines.find((l) => l.bin === BIN)!;
    const programme = s.lines.find((l) => l.name === "Veridikal (eVoucher)")!;
    assert.equal(plan.outstandingCents, 81347);
    assert.equal(programme.state, "settled");
    assert.equal(ageOutstanding(r, s, AS_AT).bands["31-60"], 81347);
  });
});

describe("a negative remit", () => {
  const r = [bill("c1", "2026-09-10", 10000), bill("c2", "2026-09-12", -225, { bin: "999012", name: "Discount Network" }), bill("c3", "2026-09-13", -300, { bin: "999012", name: "Discount Network" })];

  test("is a fee the pharmacy owes: listed apart, never billed, and never netted against a receivable", () => {
    const s = owedByPayer(r, [], AS_AT);
    assert.equal(s.billedCents, 10000);
    assert.equal(s.outstandingCents, 10000);
    assert.deepEqual(s.feesOwed, [{ key: "bin:999012", bin: "999012", name: "Discount Network", claims: 2, cents: 525 }]);
    assert.equal(s.lines.some((l) => l.name === "Discount Network"), false);
  });

  test("the report lists it under its own heading and as its own spreadsheet row, outside the total", () => {
    const s = owedByPayer(r, [], AS_AT);
    const report = arReport("2026-10", { from: "2026-09-01", asAt: AS_AT, complete: true }, s);
    report.ageing = ageOutstanding(r, s, AS_AT);
    assert.equal(report.feesOwedCents, 525);
    const text = arReportText(report, "Test Pharmacy");
    assert.match(text, /FEES OWED BY THE PHARMACY/);
    assert.match(text, /Discount Network \(BIN 999012\) · 2 claims · \$5\.25/);
    const csv = arReportCsv(report).split("\r\n");
    const total = csv.findIndex((l) => l.startsWith("Total,"));
    assert.ok(total > 0 && csv[total + 1].startsWith("Discount Network — fee owed by the pharmacy,999012,2,,,-5.25"), csv.join(" | "));
  });
});

describe("shares with no claim id keep the old arithmetic", () => {
  test("a part-paid payer with no claim ids is still unaged, and a payer that has paid nothing is still aged", () => {
    const loose = (dateFilled: string, cents: number, bin: string): Receivable => ({ bin, name: bin, dateFilled, cents, cashPlan: false });
    const r = [loose("2026-09-01", 10000, "999021"), loose("2026-10-20", 4000, "999022")];
    const s = owedByPayer(r, [{ bin: "999021", payer: "999021", cents: 2500, receivedOn: "2026-10-01", matched: true }], AS_AT);
    const a = ageOutstanding(r, s, AS_AT);
    assert.equal(a.unagedCents, 7500);
    assert.equal(a.unagedPayers, 1);
    assert.equal(a.bands["0-30"], 4000);
  });
});
