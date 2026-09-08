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
    // The facilitator's spelling: padded to twelve digits, the fill spelled out.
    assert.deepEqual(splitReference("000000318553FILL1"), { rxNumber: "318553", fillNumber: 1 });
    assert.deepEqual(splitReference("000000285719FILL10"), { rxNumber: "285719", fillNumber: 10 });
    assert.deepEqual(splitReference("000000332359"), { rxNumber: "332359", fillNumber: null });
  });
});

/*
 * Provider-level money, the adjustments, and the arithmetic that says the file was read whole.
 *
 * Helper B found the hole: `claim-payments.ts` banks BPR02, which is net of any provider-level
 * adjustment, while posting the claim payments, which are gross. Twenty claims at $4,000.00 with a
 * $57.50 DIR fee bank $3,942.50, post $4,000.00, and lose $57.50 in silence — on every remittance
 * carrying one, and DIR is one of the largest deductions an independent faces.
 */
const withPlb = [
  "ISA*00*          *00*          *ZZ*BIGPBM         *ZZ*WESTWICHITA    *260906*0230*^*00501*000000042*0*P*:~",
  "ST*835*0001~",
  // Pays $3,942.50: $4,000.00 of claims less a $57.50 DIR fee held back.
  "BPR*I*3942.50*C*ACH*CCP*01*021000021*DA*1234567890*1234567890**01*021000021*DA*9876543210*20260906~",
  "TRN*1*EFT20260906XYZ*1123456789~",
  "DTM*405*20260904~",
  "N1*PR*BIG PBM INCORPORATED*XV*610014~",
  "N1*PE*WEST WICHITA FAMILY PHARMACY*XX*1548737182~",
  "LX*1~",
  "CLP*900001-1*1*5000.00*4000.00*100.00*MC*PBM0000123*80~",
  // Six adjustments in one segment: the format repeats reason/amount/quantity after the group code.
  "CAS*CO*45*800.00*1*A2*50.00*1*59*25.00*1*131*15.00*1*137*7.00*1*45*3.00*1~",
  "SVC*N4:00074433902*5000.00*4000.00**30~",
  "DTM*472*20260901~",
  "CAS*PR*1*100.00~",
  // The segment that used to be filed against prescription 900001.
  "PLB*1548737182*20261231*CS:DIRFEE0926*57.50~",
  "SE*12*0001~",
].join("");

describe("provider-level money and the file's own arithmetic", () => {
  const r = parse835(withPlb);

  test("a PLB is money of its own, not raw text on whoever came last", () => {
    assert.equal(r.providerAdjustments.length, 1);
    assert.equal(r.providerAdjustments[0].amountCents, 5750);
    assert.equal(r.providerAdjustments[0].reasonCode, "CS");
    assert.equal(r.providerAdjustments[0].reference, "DIRFEE0926");
    // The bug this replaces: the segment landed in the last claim's raw[] and was read as its own.
    assert.equal(r.payments[0].raw.some((s) => s.startsWith("PLB")), false);
  });

  test("the remittance balances: what it pays is the claims less what was held back", () => {
    assert.deepEqual(r.balance, { paidCents: 394_250, claimsCents: 400_000, adjustmentsCents: 5_750, differenceCents: 0 });
    assert.deepEqual(r.problems, []);
  });

  test("a file that does not add up says so and says by how much", () => {
    // The same file with the DIR fee removed: it now pays $57.50 less than its claims explain.
    const noPlb = withPlb.replace("PLB*1548737182*20261231*CS:DIRFEE0926*57.50~", "");
    const p = parse835(noPlb);
    assert.equal(p.balance?.differenceCents, -5_750);
    assert.equal(p.problems.length, 1);
    assert.match(p.problems[0], /does not add up and nothing from it should be posted/);
    assert.match(p.problems[0], /\$57\.50 unaccounted for/);
    assert.match(p.problems[0], /the difference is money/);
  });

  test("one CAS segment carries six adjustments, not one", () => {
    const claimLevel = r.payments[0].adjustments.filter((a) => a.loop === "claim");
    assert.equal(claimLevel.length, 6);
    assert.equal(claimLevel.reduce((n, a) => n + a.amountCents, 0), 90_000);
    assert.deepEqual(claimLevel.map((a) => a.reasonCode), ["45", "A2", "59", "131", "137", "45"]);
    assert.equal(claimLevel.every((a) => a.groupCode === "CO"), true);
    assert.equal(claimLevel[0].quantity, 1);
  });

  test("a claim-level adjustment and a service-level one are told apart by where they sat", () => {
    const service = r.payments[0].adjustments.filter((a) => a.loop === "service");
    assert.equal(service.length, 1);
    assert.equal(service[0].groupCode, "PR");
    assert.equal(service[0].amountCents, 10_000);
    // The claim's own arithmetic: charged − paid − patient responsibility = the contractual writedown.
    const p = r.payments[0];
    assert.equal(p.chargedCents! - p.paidCents! - p.patientResponsibilityCents!, 90_000);
  });

  test("the payer's id, its claim control number and the production date are all kept", () => {
    assert.equal(r.payerId, "610014", "N1*PR's identification code, which the name is not");
    assert.equal(r.payments[0].controlNumber, "PBM0000123", "CLP07, the number the help desk asks for");
    assert.equal(r.producedOn, "2026-09-04");
    assert.equal(r.paidOn, "2026-09-06", "and it is not the day the money moves");
  });

  test("an adjustment before any claim has nowhere to belong and is refused, not attached", () => {
    const stray = withPlb.replace("LX*1~", "LX*1~CAS*CO*45*10.00~");
    const p = parse835(stray);
    assert.equal(p.problems.some((x) => x.includes("before any claim payment")), true);
  });

  test("a remittance with nothing to check does not claim to balance", () => {
    const ack = "ISA*00*          *00*          *ZZ*A              *ZZ*B              *260906*0230*^*00501*000000001*0*P*:~ST*999*0001~SE*2*0001~";
    assert.equal(parse835(ack).balance, null);
  });
});
