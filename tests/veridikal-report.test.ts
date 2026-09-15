import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkRowAgainstClaim, looksLikeVeridikalReport, readVeridikalReport } from "../src/lib/veridikal-report";

/*
 * The shape of Veridikal's two client summaries as `readSheets` returns them: a title and four lines above the header,
 * an unnamed transaction-number column, Excel date numbers, a totals row, and a month tab beside an identical "Total"
 * tab. Every value is invented: NABP, BIN, PCN, group, prescription, NDC and transaction numbers alike. The figures are
 * chosen so each row obeys the formula the real reports obey on every row.
 */
const NABP = "7000017";
const SERIAL_2026_07_28 = "46231";
const SERIAL_2026_06_01 = "46174";

function evoucherRows(rows: string[][], extra: { totals?: string[] } = {}): string[][] {
  const head = ["", "NABP", "", "BIN", "PCN", "Group ID", "Fill Date", "Rx Number", "Drug Name", "NDC", "Deposit Date", "Total Due From Third Party", "Original 3rd Party Copay", "Patient Out Of Pocket", "Voucher Amount", "eVoucher Fee", "Total Due to Pharmacy"];
  const sum = (i: number) => (rows.reduce((n, r) => n + Math.round(Number(r[i]) * 100), 0) / 100).toFixed(2);
  const totals = extra.totals ?? ["Total", "", "", "", "", "", "", "", "", "", "", sum(11), sum(12), sum(13), sum(14), sum(15), sum(16)];
  return [["eVoucher Program - Client Summary"], ["Client Name: Test"], ["Report Month: 2026 Jul"], ["Program Year 2026: Test"], ["Customer: Test Pharmacy"], head, ...rows, totals];
}

const ev = (txn: string, rx: string, voucher: number, fee: number, copay: number, oop: number, due = voucher + fee): string[] =>
  [txn, NABP, "Test Pharmacy", "999001", "TESTPCN", "GRP1", SERIAL_2026_06_01, rx, "TEST DRUG 10MG", "99999999901", SERIAL_2026_07_28, "120.00", copay.toFixed(2), oop.toFixed(2), voucher.toFixed(2), fee.toFixed(2), due.toFixed(2)];

const EV_ROWS = [
  ev("900101", "000000990101", 100, 2.5, 110, 10),
  ev("900102", "990102", 25, 2.5, 25, 0),
  ev("900103", "990101", -100, -2.5, -110, -10),
  ev("900104", "990104", 75, 2.5, 100, 25),
];

function denialRows(rows: string[][]): string[][] {
  const head = ["Customer", "NABP", "BIN", "PCN", "Group ID", "Fill Date", "Rx #", "Drug Name", "NDC", "Deposit Date", "", "Patient Out of Pocket", "Ing Cost Pd by Manufacturer", "Denial Conversion Fee", "Fax Admin Fee", "Total Due to Pharmacy"];
  const sum = (i: number) => (rows.reduce((n, r) => n + Math.round(Number(r[i]) * 100), 0) / 100).toFixed(2);
  return [["Denial Conversion Activity - Client Summary"], ["Client Name: Test"], ["Report Month: 2026 Jul"], ["Program Year 2026: Test"], head, ...rows, ["Total", "", "", "", "", "", "", "", "", "", "", sum(11), sum(12), sum(13), sum(14), sum(15)]];
}
const dn = (txn: string, rx: string, ing: number, fee: number, fax = 0, due = ing + fee): string[] =>
  ["Test Pharmacy", NABP, "999002", "TESTPCN2", "GRP2", SERIAL_2026_06_01, rx, "TEST DRUG 20MG", "99999-9999-02", SERIAL_2026_07_28, txn, "35.00", ing.toFixed(2), fee.toFixed(2), fax.toFixed(2), due.toFixed(2)];

const monthAndTotal = (rows: string[][]) => [{ name: "2026 Jul, None", rows }, { name: "Total, Total", rows: rows.map((r) => r.slice()) }];

describe("Veridikal's eVoucher client summary", () => {
  test("is recognised by its title and header, and nothing else is", () => {
    assert.equal(looksLikeVeridikalReport(monthAndTotal(evoucherRows(EV_ROWS))), true);
    assert.equal(looksLikeVeridikalReport([{ name: "Sheet1", rows: [["Rx Number", "Deposit Date"]] }]), false);
  });

  test("reads every row once from a month tab beside its identical Total tab, with the fee paid to the pharmacy", () => {
    const r = readVeridikalReport(monthAndTotal(evoucherRows(EV_ROWS)), NABP);
    assert.ok(r.ok, r.ok ? "" : r.why);
    const p = r.report;
    assert.equal(p.program, "evoucher");
    assert.equal(p.rows.length, 4);
    assert.equal(p.paymentCents, 10000);
    assert.equal(p.feeCents, 500);
    assert.equal(p.totalDueCents, 10500);
    assert.deepEqual(p.byDeposit, [{ on: "2026-07-28", cents: 10500 }]);
    assert.deepEqual(p.rows[0], {
      transaction: "900101", nabp: NABP, bin: "999001", pcn: "TESTPCN", groupId: "GRP1", fillDate: "2026-06-01", rxNumber: "990101",
      ndc11: "99999999901", depositOn: "2026-07-28", paymentCents: 10000, feeCents: 250, totalDueCents: 10250, patientOutOfPocketCents: 1000,
      thirdPartyDueCents: 12000, originalCopayCents: 11000,
    });
    assert.equal(p.rows[2].paymentCents, -10000, "a reversal row is kept, negative");
  });

  test("a row whose Total Due is not the voucher plus the fee refuses the report", () => {
    const rows = EV_ROWS.map((r) => r.slice());
    rows[1] = ev("900102", "990102", 25, 2.5, 25, 0, 28);
    const r = readVeridikalReport([{ name: "2026 Jul", rows: evoucherRows(rows) }], NABP);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /Total Due to Pharmacy \$28\.00 is not the payment \$25\.00 plus the fee \$2\.50/);
  });

  test("a voucher that is not the copay less what the patient paid refuses the report", () => {
    const rows = EV_ROWS.map((r) => r.slice());
    rows[3] = ev("900104", "990104", 75, 2.5, 90, 25);
    const r = readVeridikalReport([{ name: "2026 Jul", rows: evoucherRows(rows) }], NABP);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /the voucher \$75\.00 is not the copay \$90\.00 less what the patient paid \$25\.00/);
  });

  test("columns that do not add to the totals row refuse the report", () => {
    const sheet = evoucherRows(EV_ROWS);
    sheet[sheet.length - 1][16] = "105.01";
    const r = readVeridikalReport([{ name: "2026 Jul", rows: sheet }], NABP);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /"Total Due to Pharmacy" rows come to \$105\.00 against a total of \$105\.01/);
  });

  test("a report for another pharmacy is refused", () => {
    const r = readVeridikalReport(monthAndTotal(evoucherRows(EV_ROWS)), "7000025");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /NABP 7000017, not this pharmacy's 7000025/);
  });

  test("a Total tab that does not carry the month tab's rows is refused rather than one of them believed", () => {
    const tabs = [{ name: "2026 Jul", rows: evoucherRows(EV_ROWS) }, { name: "Total", rows: evoucherRows(EV_ROWS.slice(0, 3)) }];
    const r = readVeridikalReport(tabs, NABP);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /month tabs and the "Total" tab do not carry the same rows/);
  });

  test("two month tabs and their Total are read as the Total, every row once", () => {
    const jul = EV_ROWS.slice(0, 2), aug = EV_ROWS.slice(2);
    const tabs = [{ name: "2026 Jul", rows: evoucherRows(jul) }, { name: "2026 Aug", rows: evoucherRows(aug) }, { name: "Total", rows: evoucherRows(EV_ROWS) }];
    const r = readVeridikalReport(tabs, NABP);
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.report.rows.length, 4);
  });

  test("a repeated transaction number is refused, since a row could not be told from its copy", () => {
    const rows = [...EV_ROWS, ev("900104", "990105", 10, 0, 10, 0)];
    const r = readVeridikalReport([{ name: "2026 Jul", rows: evoucherRows(rows) }], NABP);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /transaction number is repeated/);
  });
});

describe("Veridikal's Denial Conversion client summary", () => {
  const ROWS = [dn("800201", "990201", 150, 5), dn("800202", "990202", 60.25, 5), dn("800203", "990201", -150, -5)];

  test("reads the manufacturer's payment and the fee paid to the pharmacy, with the transaction number from the unnamed column", () => {
    const r = readVeridikalReport(monthAndTotal(denialRows(ROWS)), NABP);
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.report.program, "denial_conversion");
    assert.equal(r.report.paymentCents, 6025);
    assert.equal(r.report.feeCents, 500);
    assert.equal(r.report.totalDueCents, 6525);
    assert.equal(r.report.rows[1].transaction, "800202");
    assert.equal(r.report.rows[1].ndc11, "99999999902");
  });

  test("a Fax Admin Fee is held for a person: no report has shown whether it is added or taken away", () => {
    const rows = [dn("800201", "990201", 150, 5, 3, 158), ...ROWS.slice(1)];
    const r = readVeridikalReport([{ name: "2026 Jul", rows: denialRows(rows) }], NABP);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /Fax Admin Fee/);
  });
});

describe("a Veridikal row against the claim it settles", () => {
  const read = readVeridikalReport(monthAndTotal(evoucherRows(EV_ROWS)), NABP);
  assert.ok(read.ok);
  const row = read.report.rows[0]; // voucher $100.00, plan $120.00 expected, copay $110.00, patient $10.00

  test("an eVoucher row agrees where the plan's share is the remit less the voucher, and copay, patient and voucher match", () => {
    const c = checkRowAgainstClaim("evoucher", row, { remitCents: 22000, evoucherCents: 10000, copayCents: 11000, patientTotalCents: 1000 });
    assert.deepEqual(c, { compared: true, agrees: true, differences: [] });
  });

  test("each field that differs is named with both figures, and the row is still not refused", () => {
    const c = checkRowAgainstClaim("evoucher", row, { remitCents: 20000, evoucherCents: 9000, copayCents: 11000, patientTotalCents: 2000 });
    assert.equal(c.agrees, false);
    assert.deepEqual(c.differences, [
      { what: "the plan's expected payment", reportCents: 12000, claimCents: 11000 },
      { what: "what the patient paid", reportCents: 1000, claimCents: 2000 },
      { what: "the voucher", reportCents: 10000, claimCents: 9000 },
    ]);
  });

  test("a reversal row is not compared", () => {
    assert.equal(checkRowAgainstClaim("evoucher", read.report.rows[2], { remitCents: 0, evoucherCents: 0, copayCents: 0, patientTotalCents: 0 }).compared, false);
  });

  test("a denial conversion agrees where the remit is the manufacturer's payment and the patient's share matches", () => {
    const d = readVeridikalReport(monthAndTotal(denialRows([dn("800201", "990201", 150, 5)])), NABP);
    assert.ok(d.ok);
    assert.equal(checkRowAgainstClaim("denial_conversion", d.report.rows[0], { remitCents: 15000, evoucherCents: 0, copayCents: 0, patientTotalCents: 3500 }).agrees, true);
    assert.deepEqual(checkRowAgainstClaim("denial_conversion", d.report.rows[0], { remitCents: 0, evoucherCents: 0, copayCents: 0, patientTotalCents: 3500 }).differences, [
      { what: "the manufacturer's payment against the remit", reportCents: 15000, claimCents: 0 },
    ]);
  });
});
