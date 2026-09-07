import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePayerPayments, looksLikePayerPayments, moneyCents, rangeFromFileName } from "../src/lib/payer-payments";

const FILE = readFileSync(new URL("../fixtures/payer-payments.csv", import.meta.url), "utf8");

describe("recognising the payer payment report", () => {
  test("it is known by its columns, not by its name", () => {
    assert.equal(looksLikePayerPayments(FILE), true);
    // The file name carries the pharmacy and a date range and nothing about the shape.
    assert.equal(looksLikePayerPayments('"Rx Number","NDC","Date Filled"\n1,2,3'), false);
    assert.equal(looksLikePayerPayments(""), false);
  });

  test("a file missing any one of the four is not this report", () => {
    assert.equal(looksLikePayerPayments('"Payment number","Payer name","Deposit date"'), false);
    assert.equal(looksLikePayerPayments('"Payer name","Deposit date","Payment amt"'), false);
  });
});

describe("money read as digits rather than as a float", () => {
  test("the amounts that a multiplication would round wrong", () => {
    // 63298.82 * 100 is 6329881.9999999991 in binary. Read as text the digits are exact.
    assert.equal(moneyCents("63298.82"), 6_329_882);
    assert.equal(moneyCents("8829.73"), 882_973);
    assert.equal(moneyCents("1808"), 180_800);
    assert.equal(moneyCents("1.18"), 118);
    assert.equal(moneyCents("$21,175.45"), 2_117_545);
    assert.equal(moneyCents("-40.10"), -4_010);
  });

  test("anything that is not an amount gives nothing rather than a zero", () => {
    for (const s of [undefined, "", "  ", "n/a", "1.234", "abc"]) assert.equal(moneyCents(s), null);
  });
});

describe("reading the report", () => {
  const read = parsePayerPayments(FILE);

  test("every payment is read, and the total is the sum of the file", () => {
    assert.equal(read.payments.length, 7);
    assert.equal(read.skipped.length, 0);
    // 63298.82 + 6098.36 + 1808 + 8829.73 + 377.41 + 21175.45 + 25006.44
    assert.equal(read.totalCents, 12_659_421);
    assert.equal(read.from, "2026-09-01");
    assert.equal(read.to, "2026-09-03");
  });

  test("the deposit date is what counts, and the payment date is kept where it differs", () => {
    // Atlas paid on the 31st of August and it landed on the 1st of September: September's money.
    const atlas = read.payments.find((p) => p.paymentNumber === "EFT-31415975")!;
    assert.equal(atlas.depositedOn, "2026-09-01");
    assert.equal(atlas.paidOn, "2026-08-31");
    assert.equal(atlas.method, "COPY");
  });

  test("the reconciliation columns are recorded, and are not the money", () => {
    // Express Scripts deposited 8,829.73 while the claims matched 8,845.15 — a real difference the
    // 835 work will have to explain. The cash account banks what arrived, which is the deposit.
    const es = read.payments.find((p) => p.payerName === "EXAMPLE SCRIPTS")!;
    assert.equal(es.amountCents, 882_973);
    assert.equal(es.claimMatchCents, 884_515);
    assert.equal(es.noClaimMatchCents, 118);
    assert.equal(es.remitMatched, true);
    // A payer with no remittance advice is recorded as such rather than as matched.
    const rx = read.payments.find((p) => p.payerName === "EXAMPLERX")!;
    assert.equal(rx.remitMatched, false);
    assert.equal(rx.claimMatchCents, null);
  });

  test("a payment printed twice is one payment", () => {
    const doubled = FILE.trimEnd() + "\n" + FILE.split(/\r?\n/)[1];
    const r = parsePayerPayments(doubled);
    assert.equal(r.payments.length, 7);
    assert.match(r.skipped[0].why, /listed twice/);
  });

  test("a row that cannot be banked says why rather than being banked as nothing", () => {
    const bad =
      '"Location","Payment number","Payer name","Deposit date","Payment amt"\n' +
      ',"","A PAYER","09/01/2026",100\n' +
      ',"P2","A PAYER","not a date",100\n' +
      ',"P3","A PAYER","09/01/2026","oops"\n' +
      ',"P4","A PAYER","09/01/2026",0\n';
    const r = parsePayerPayments(bad);
    assert.equal(r.payments.length, 0);
    assert.match(r.skipped[0].why, /no payment number/);
    assert.match(r.skipped[1].why, /deposit date/);
    assert.match(r.skipped[2].why, /amount/);
    assert.match(r.skipped[3].why, /zero/);
  });
});

describe("the range the file name states", () => {
  test("a report that came back empty can still say what was checked", () => {
    assert.deepEqual(rangeFromFileName("West_Wichita_Family_Pharmacy_1722734_20260901_20260907.csv"), {
      from: "2026-09-01",
      to: "2026-09-07",
    });
    assert.equal(rangeFromFileName("something_else.csv"), null);
  });
});
