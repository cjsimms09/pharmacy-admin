import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * Where a claim leg stands, on a scratch database: paid to the cent, short with the payer's reasons, over, inside
 * its plan group's cycle, past it, never measured, a programme's, cash, a fee, reversed after it was paid — and a
 * person's decision laid over it.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let refreshClaimStanding: typeof import("../src/lib/engine/claims").refreshClaimStanding;
let legKey: typeof import("../src/lib/engine/claims").legKey;
let newId: typeof import("../src/lib/crypto").newId;
let cleanup: () => void;

const TODAY = "2026-10-01";
let importId: string;
const ids: Record<string, string> = {};

async function claim(name: string, c: Partial<typeof schema.claims.$inferInsert> & { rxNumber: string; dateFilled: string }) {
  const id = newId();
  ids[name] = id;
  await db.insert(schema.claims).values({ id, importId, fillNumber: 1, ndc11: "81968004560", bin: "610097", pcn: "9999", pbmName: "OptumRx", status: "paid", remitCents: 10_000, copayCents: 0, source: "transaction_report", ...c });
  return id;
}
async function pay(claimId: string, amountCents: number, receivedOn: string, extra: Partial<typeof schema.claimPayments.$inferInsert> = {}) {
  const id = newId();
  await db.insert(schema.claimPayments).values({ id, claimId, rxNumber: "x", source: "plan", payer: "ProviderPay", amountCents, revenueCents: 0, receivedOn, recordedBy: "the test", ...extra });
  return id;
}

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ refreshClaimStanding, legKey } = await import("../src/lib/engine/claims"));
  ({ newId } = await import("../src/lib/crypto"));
  importId = newId();
  await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test" });

  /* Twenty-five paid legs in one plan group, each paid 13 days after the fill: the group's cycle is 13. */
  for (let i = 0; i < 25; i++) {
    const id = await claim(`m${i}`, { rxNumber: String(900100 + i), dateFilled: "2026-09-01" });
    await pay(id, 10_000, "2026-09-14");
  }
  /* The cases. */
  await pay(await claim("short", { rxNumber: "900200", dateFilled: "2026-09-02" }), 9_000, "2026-09-15");
  await pay(await claim("over", { rxNumber: "900201", dateFilled: "2026-09-02" }), 10_000, "2026-09-15");
  await pay(ids.over, 10_000, "2026-09-15");
  await claim("inside", { rxNumber: "900202", dateFilled: "2026-09-25" });
  await claim("past", { rxNumber: "900203", dateFilled: "2026-09-10" });
  await claim("unmeasured", { rxNumber: "900204", dateFilled: "2026-09-10", pbmName: "Drexi (NBFSA)", bin: "020099", pcn: "NBFSA" });
  await claim("programme", { rxNumber: "900205", dateFilled: "2026-09-01", pbmName: "DST Pharmacy Solutions (SS&C Health)", bin: "019158", pcn: "CNRX" });
  await claim("cash", { rxNumber: "900206", dateFilled: "2026-09-10", cashPlan: true });
  await claim("fee", { rxNumber: "900207", dateFilled: "2026-09-10", remitCents: -150 });
  await pay(await claim("reversedPaid", { rxNumber: "900208", dateFilled: "2026-09-03", status: "reversed", reversedOn: "2026-09-20" }), 10_000, "2026-09-16");
  await claim("reversedBare", { rxNumber: "900209", dateFilled: "2026-09-03", status: "reversed", reversedOn: "2026-09-20" });
  await claim("before", { rxNumber: "900210", dateFilled: "2026-08-20" });
  await claim("waited", { rxNumber: "900211", dateFilled: "2026-09-10" });
  await claim("mtf", { rxNumber: "900212", dateFilled: "2026-09-02", expectedFacilitatorCents: 2_500 });
  await pay(ids.mtf, 10_000, "2026-09-15");
  await pay(ids.mtf, 2_500, "2026-09-28", { source: "mtf", payer: "MEDICARE TRANSACTION FACILITATOR", revenueCents: 2_500 });
  await db.insert(schema.claimDecisions).values({ id: newId(), legKey: legKey("900211", 1, "2026-09-10", "610097"), rxNumber: "900211", fillNumber: 1, dateFilled: "2026-09-10", bin: "610097", decision: "wait", note: "they pay monthly", decidedBy: "the test", decidedAt: "2026-09-30T12:00:00.000Z", revisitOn: "2026-10-20" });
  const shortPayment = await db.query.claimPayments.findFirst({ where: (t, { eq }) => eq(t.claimId, ids.short) });
  await db.insert(schema.paymentAdjustments).values([
    { id: newId(), paymentId: shortPayment!.id, groupCode: "CO", reasonCode: "45", amountCents: 700, quantity: null, loop: "service" },
    { id: newId(), paymentId: shortPayment!.id, groupCode: "CO", reasonCode: "131", amountCents: 300, quantity: null, loop: "service" },
  ]);
});
after(() => cleanup());

describe("where a claim leg stands", () => {
  let rows: (typeof schema.claimStanding.$inferSelect)[];
  const by = (name: string) => rows.find((r) => r.claimId === ids[name])!;

  before(async () => {
    const s = await refreshClaimStanding(TODAY, "2026-10-01T06:00:00.000Z");
    rows = await db.query.claimStanding.findMany();
    assert.equal(s.rows, rows.length);
  });

  test("a fill before the books, and a reversal nothing was paid on, are not here at all", () => {
    assert.equal(rows.find((r) => r.claimId === ids.before), undefined);
    assert.equal(rows.find((r) => r.claimId === ids.reversedBare), undefined);
  });
  test("paid to the cent; short with the payer's own reasons; over", () => {
    assert.equal(by("m0").state, "paid");
    assert.equal(by("m0").cycleDays, 13);
    const s = by("short");
    assert.equal(s.state, "short");
    assert.equal(s.shortCents, 1_000);
    assert.deepEqual(JSON.parse(s.reasons!), [
      { group: "CO", reason: "45", cents: 700 },
      { group: "CO", reason: "131", cents: 300 },
    ]);
    assert.equal(by("over").state, "over");
    assert.equal(by("over").paidCents, 20_000);
  });
  test("unpaid inside its plan group's cycle, due past it, never measured where the payer has shown nothing", () => {
    assert.equal(by("inside").state, "unpaid");
    assert.equal(by("inside").dueOn, "2026-10-08");
    assert.equal(by("past").state, "due");
    assert.equal(by("past").shortCents, 10_000);
    assert.equal(by("unmeasured").state, "unmeasured");
    assert.equal(by("unmeasured").cycleDays, null);
  });
  test("a programme is a programme, cash is not a receivable, a negative remit is a fee, and a reversal that was paid is money to give back", () => {
    assert.equal(by("programme").state, "programme");
    assert.equal(by("programme").programme, true);
    assert.equal(by("cash").state, "cash");
    assert.equal(by("fee").state, "fee");
    assert.equal(by("reversedPaid").state, "reversed_paid");
    assert.equal(by("reversedPaid").shortCents, 0);
  });
  test("a person's wait holds a due leg until the day they named, and travels with the row", () => {
    const w = by("waited");
    assert.equal(w.state, "unpaid");
    assert.equal(w.decision, "wait");
    assert.match(w.decisionNote ?? "", /they pay monthly until 2026-10-20/);
  });
  test("the facilitator's money is on top of the plan's, held against its own expectation", () => {
    const m = by("mtf");
    assert.equal(m.state, "paid");
    assert.equal(m.paidCents, 10_000);
    assert.equal(m.facilitatorExpectedCents, 2_500);
    assert.equal(m.facilitatorPaidCents, 2_500);
    assert.equal(m.payments, 1);
  });
  test("the summary adds up what is open and what is due", async () => {
    const s = await refreshClaimStanding(TODAY, "2026-10-01T06:30:00.000Z");
    assert.equal(s.byState.paid, 26);
    assert.equal(s.byState.due, 1);
    assert.equal(s.dueCents, 10_000);
    assert.equal(s.owedCents, 1_000 + 10_000 + 10_000 + 10_000 + 10_000 + 10_000, "short + inside + past + unmeasured + programme + waited");
  });
});
