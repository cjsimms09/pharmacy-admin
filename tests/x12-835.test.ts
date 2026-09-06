import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parse835, payableOnly, x12Cents, x12Date, ndcFromServiceId, splitReference } from "../src/lib/x12-835";

/**
 * Reading a remittance, which is where money the pharmacy has already banked is described.
 *
 * The one this exists for: a Medicare Transaction Facilitator payment that lands weeks after the
 * claim. Until it can be read and matched, a fill it paid $146.18 on sits on the "dispensed at a
 * loss" list for ever, and the plan that underpaid it is judged on money it never sent.
 */
const remittance = [
  "ISA*00*          *00*          *ZZ*MTFPAYER       *ZZ*WESTWICHITA    *260906*0230*^*00501*000000001*0*P*:~",
  "GS*HP*MTFPAYER*WESTWICHITA*20260906*0230*1*X*005010X221A1~",
  "ST*835*0001~",
  "BPR*I*146.18*C*ACH*CCP*01*021000021*DA*1234567890*1234567890**01*021000021*DA*9876543210*20260906~",
  "TRN*1*MTF20260906001*1123456789~",
  "N1*PR*MEDICARE TRANSACTION FACILITATOR~",
  "N1*PE*WEST WICHITA FAMILY PHARMACY*XX*1548737182~",
  "LX*1~",
  "CLP*332359-1*1*328.23*146.18*0*MC*2026090600001*80~",
  "NM1*QC*1*DOE*JANE****MI*1EG4TE5MK73~",
  "SVC*N4:81968004560*328.23*146.18**30~",
  "DTM*472*20260905~",
  "CAS*PR*1*182.05~",
  "CLP*305766-2*4*161.83*0*161.83*MC*2026090600002*80~",
  "SVC*N4:00074433902*161.83*0**30~",
  "DTM*472*20260831~",
  "SE*16*0001~",
  "GE*1*1~",
  "IEA*1*000000001~",
].join("");

describe("reading an 835", () => {
  const r = parse835(remittance);

  test("the remittance says what it came to, when, and how to find it on a bank statement", () => {
    assert.equal(r.totalPaidCents, 14_618);
    assert.equal(r.paidOn, "2026-09-06");
    assert.equal(r.traceNumber, "MTF20260906001");
    assert.equal(r.payer, "MEDICARE TRANSACTION FACILITATOR");
  });

  test("each claim payment names the prescription it belongs to", () => {
    assert.equal(r.payments.length, 2);
    const [paid] = r.payments;
    assert.equal(paid.rxNumber, "332359");
    assert.equal(paid.fillNumber, 1, "the fill is part of the reference and part of the match");
    assert.equal(paid.paidCents, 14_618);
    assert.equal(paid.chargedCents, 32_823);
    assert.equal(paid.ndc11, "81968004560");
    assert.equal(paid.serviceDate, "2026-09-05");
  });

  test("a denial is read, and then not recorded as revenue", () => {
    // Recording a zero payment would put a row against a fill saying money arrived when none did.
    const { keep, skipped } = payableOnly(r);
    assert.deepEqual(keep.map((p) => p.reference), ["332359-1"]);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].why, /denied/);
  });

  test("the delimiters come from the file, not from an assumption", () => {
    // A sender using a pipe and a caret is still an 835; split on the wrong character it reads as
    // one enormous unusable segment.
    const odd = remittance.replace(/\*/g, "|").replace(/~/g, "^").replace("00501|000000001|0|P|:", "00501|000000001|0|P|:");
    const isa = "ISA|00|          |00|          |ZZ|MTFPAYER       |ZZ|WESTWICHITA    |260906|0230|^|00501|000000001|0|P|:^";
    const rebuilt = isa + odd.slice(odd.indexOf("GS|"));
    const p = parse835(rebuilt);
    assert.equal(p.payments.length, 2);
    assert.equal(p.payments[0].paidCents, 14_618);
  });

  test("a file with no claim payments says so rather than reporting nothing", () => {
    const ack = "ISA*00*          *00*          *ZZ*A              *ZZ*B              *260906*0230*^*00501*000000001*0*P*:~ST*999*0001~SE*2*0001~";
    const p = parse835(ack);
    assert.deepEqual(p.payments, []);
    assert.match(p.problems[0], /acknowledgement/);
  });

  test("an empty file is not silently a remittance of nothing", () => {
    assert.match(parse835("").problems[0], /empty/);
  });
});

describe("the small readings underneath", () => {
  test("money and dates, or nothing", () => {
    assert.equal(x12Cents("146.18"), 14_618);
    assert.equal(x12Cents("-146.18"), -14_618, "a reversal is real and negative");
    assert.equal(x12Cents(""), null);
    assert.equal(x12Cents("n/a"), null);
    assert.equal(x12Date("20260905"), "2026-09-05");
    assert.equal(x12Date("2026-09-05"), null, "an unexpected shape is refused rather than guessed");
  });

  test("an NDC only where the qualifier says it is one", () => {
    assert.equal(ndcFromServiceId("N4:81968004560"), "81968004560");
    assert.equal(ndcFromServiceId("N4:81968-0045-60"), "81968004560");
    // A procedure code read as an NDC would attach a payment to the wrong drug.
    assert.equal(ndcFromServiceId("HC:99213"), null);
    assert.equal(ndcFromServiceId("81968004560"), null);
  });

  test("a reference with a fill on it splits; one without does not invent a fill", () => {
    assert.deepEqual(splitReference("332359-1"), { rxNumber: "332359", fillNumber: 1 });
    assert.deepEqual(splitReference("332359"), { rxNumber: "332359", fillNumber: null });
  });
});
