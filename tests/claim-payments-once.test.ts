import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * One payment, one row, whichever documents describe it — and the reasons the 835 gives are kept beside it.
 *
 * Measured 1 October 2026: 752 payments stood twice against their claims, once from the 835 and once from a report,
 * and every one read as an over-payment. On a scratch database: a report's row and the 835's row for the same money
 * are one row, the 835 takes it over, the same kind of document read twice is the reader's own count, and the CAS
 * and PLB lines are stored once.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let recordClaimPayment: typeof import("../src/lib/claim-payments").recordClaimPayment;
let importRemittance: typeof import("../src/lib/claim-payments").importRemittance;
let newId: typeof import("../src/lib/crypto").newId;
let cleanup: () => void;

const user = { name: "the test" };
const RX1 = "900600";
const RX2 = "900601";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ recordClaimPayment, importRemittance } = await import("../src/lib/claim-payments"));
  ({ newId } = await import("../src/lib/crypto"));
  const importId = newId();
  await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test" });
  const claim = (rx: string) => ({ id: newId(), importId, rxNumber: rx, fillNumber: 1, dateFilled: "2026-09-05", ndc11: "81968004560", bin: "610097", pbmName: "OptumRx", status: "paid" as const, remitCents: 14_618, copayCents: 17_205, source: "transaction_report" });
  await db.insert(schema.claims).values([claim(RX1), claim(RX2)]);
});
after(() => cleanup());

const remittance = (rx: string) =>
  [
    "ISA*00*          *00*          *ZZ*OPTUMRX        *ZZ*WESTWICHITA    *260920*0230*^*00501*000000001*0*P*:~",
    "GS*HP*OPTUMRX*WESTWICHITA*20260920*0230*1*X*005010X221A1~",
    "ST*835*0001~",
    "BPR*I*121.18*C*ACH*CCP*01*021000021*DA*1234567890*1234567890**01*021000021*DA*9876543210*20260920~",
    "TRN*1*9999000001*1123456789~",
    "N1*PR*OPTUMRX~",
    "N1*PE*WEST WICHITA FAMILY PHARMACY*XX*1234567893~",
    "LX*1~",
    `CLP*${rx}-1*1*328.23*146.18*0*MC*2026092000001*80~`,
    "SVC*N4:81968004560*328.23*146.18**30~",
    "DTM*472*20260905~",
    "CAS*CO*45*10.00~",
    "CAS*PR*1*172.05~",
    "PLB*1234567893*20261231*CS:RECOUP-TEST*25.00~",
    "SE*14*0001~",
    "GE*1*1~",
    "IEA*1*000000001~",
  ].join("");

describe("one payment, one row", () => {
  test("a report's row and the 835's row for the same money are one row, and the 835 takes it over", async () => {
    const claim = await db.query.claims.findFirst({ where: (t, { eq }) => eq(t.rxNumber, RX1) });
    assert.ok(claim);
    const a = await recordClaimPayment({ rxNumber: RX1, fillNumber: 1, dateFilled: "2026-09-05", source: "plan", payer: "Health Mart Atlas", amountCents: 14_618, revenueCents: 0, receivedOn: "2026-09-20", reference: "EFT-99999001/900600", origin: "accesshealth:EFT-99999001", notes: "From the AccessHealth payment report for EFT-99999001, a plan." }, user);
    assert.equal(a.matched, true);
    assert.equal(a.duplicateOf, null);
    const b = await recordClaimPayment({ rxNumber: RX1, fillNumber: 1, dateFilled: "2026-09-05", source: "plan", payer: "ProviderPay", amountCents: 14_618, revenueCents: 0, receivedOn: "2026-09-20", reference: "9999000001/900600-1", origin: "835:9999000001", notes: "From test_835.txt, trace 9999000001." }, user);
    assert.equal(b.duplicateOf, a.id, "the same money, by another road");
    const rows = await db.query.claimPayments.findMany({ where: (t, { eq }) => eq(t.claimId, claim.id) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reference, "9999000001/900600-1", "the 835's reference replaces the report's");
    assert.equal(rows[0].origin, "835:9999000001");
    assert.match(rows[0].notes ?? "", /Also in test_835\.txt/);
  });

  test("the same kind of document twice is the reader's own count, not a duplicate here", async () => {
    const claim = await db.query.claims.findFirst({ where: (t, { eq }) => eq(t.rxNumber, RX1) });
    const c = await recordClaimPayment({ rxNumber: RX1, fillNumber: 1, dateFilled: "2026-09-05", source: "plan", payer: "ProviderPay", amountCents: 14_618, revenueCents: 0, receivedOn: "2026-09-20", reference: "9999000001/900600-1", origin: "835:9999000001", notes: "From test_835.txt, trace 9999000001." }, user);
    assert.equal(c.duplicateOf, null);
    const rows = await db.query.claimPayments.findMany({ where: (t, { eq }) => eq(t.claimId, claim!.id) });
    assert.equal(rows.length, 2);
  });

  test("a payment with no origin is never judged a duplicate", async () => {
    const claim = await db.query.claims.findFirst({ where: (t, { eq }) => eq(t.rxNumber, RX1) });
    const d = await recordClaimPayment({ rxNumber: RX1, fillNumber: 1, dateFilled: "2026-09-05", source: "plan", payer: "Somebody", amountCents: 14_618, revenueCents: 0, receivedOn: "2026-09-20", reference: "typed" }, user);
    assert.equal(d.duplicateOf, null);
    const rows = await db.query.claimPayments.findMany({ where: (t, { eq }) => eq(t.claimId, claim!.id) });
    assert.equal(rows.length, 3);
  });
});

describe("what the 835 says is kept", () => {
  test("reading an 835 after the report: the report's row is taken over, the CAS reasons and the PLB are stored once", async () => {
    const claim = await db.query.claims.findFirst({ where: (t, { eq }) => eq(t.rxNumber, RX2) });
    assert.ok(claim);
    const first = await recordClaimPayment({ rxNumber: RX2, fillNumber: 1, dateFilled: "2026-09-05", source: "plan", payer: "Health Mart Atlas", amountCents: 14_618, revenueCents: 0, receivedOn: "2026-09-20", reference: "EFT-99999002/900601", origin: "accesshealth:EFT-99999002", notes: "From the AccessHealth payment report for EFT-99999002, a plan." }, user);
    await importRemittance(remittance(RX2), "test2_835.txt", user, {});
    const rows = await db.query.claimPayments.findMany({ where: (t, { eq }) => eq(t.claimId, claim.id) });
    assert.equal(rows.length, 1, "one payment, whichever documents describe it");
    assert.equal(rows[0].id, first.id);
    assert.equal(rows[0].reference, "9999000001/900601-1");
    const reasons = await db.query.paymentAdjustments.findMany({ where: (t, { eq }) => eq(t.paymentId, first.id) });
    assert.deepEqual(
      reasons.map((r) => [r.groupCode, r.reasonCode, r.amountCents, r.loop]).sort(),
      [
        ["CO", "45", 1_000, "service"],
        ["PR", "1", 17_205, "service"],
      ],
    );
    const holdbacks = await db.query.remittanceHoldbacks.findMany();
    assert.equal(holdbacks.length, 1);
    assert.equal(holdbacks[0].reasonCode, "CS");
    assert.equal(holdbacks[0].reference, "RECOUP-TEST");
    assert.equal(holdbacks[0].amountCents, 2_500);
    assert.equal(holdbacks[0].traceNumber, "9999000001");
  });

  test("the same 835 read again adds nothing", async () => {
    await importRemittance(remittance(RX2), "test2_835.txt", user, {});
    const claim = await db.query.claims.findFirst({ where: (t, { eq }) => eq(t.rxNumber, RX2) });
    const rows = await db.query.claimPayments.findMany({ where: (t, { eq }) => eq(t.claimId, claim!.id) });
    assert.equal(rows.length, 1);
    assert.equal((await db.query.paymentAdjustments.findMany()).length, 2);
    assert.equal((await db.query.remittanceHoldbacks.findMany()).length, 1);
  });
});
