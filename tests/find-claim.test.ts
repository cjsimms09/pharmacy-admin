import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * What recording a payment does about the claim, pinned through the database: the lookup that loads every claim for the
 * prescription and the choosing that reads them were one function, and are now two (claims-on-file.ts, match-remittance.ts),
 * so that the screen which says why a payment is attached to nothing reads the claims exactly as the matcher did.
 * Every answer below was the answer before the split.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let recordClaimPayment: typeof import("../src/lib/claim-payments").recordClaimPayment;
let matchOrphanPayments: typeof import("../src/lib/claim-payments").matchOrphanPayments;
let newId: typeof import("../src/lib/crypto").newId;
let importId: string;
let cleanup: () => void;

const user = { name: "the test" };
const NDC = "00093000011";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ recordClaimPayment, matchOrphanPayments } = await import("../src/lib/claim-payments"));
  ({ newId } = await import("../src/lib/crypto"));
  importId = newId();
  await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test" });
});
after(() => cleanup());

const claim = (rx: string, fill: number, date: string, o: Partial<typeof import("../src/db").schema.claims.$inferInsert> = {}) => ({
  id: newId(), importId, rxNumber: rx, fillNumber: fill, dateFilled: date, ndc11: NDC, bin: "610097", pbmName: "OptumRx", status: "paid" as const, remitCents: 5_000, copayCents: 1_000, source: "transaction_report", ...o,
});
const pay = (rx: string, fill: number, date: string, o: Partial<Parameters<typeof recordClaimPayment>[0]> = {}) =>
  recordClaimPayment({ rxNumber: rx, fillNumber: fill, dateFilled: date, ndc11: NDC, source: "plan", payer: "A Plan", amountCents: 3_999, receivedOn: "2026-09-20", ...o }, user);

describe("what recording a payment makes of the claims on the prescription", () => {
  test("a paid claim for the fill takes it", async () => {
    await db.insert(schema.claims).values(claim("900700", 1, "2026-09-05"));
    const r = await pay("900700", 1, "2026-09-05");
    assert.deepEqual([r.matched, r.settledReversed, r.ambiguous], [true, false, null]);
  });

  test("a prescription the site holds nothing for is attached to nothing, and not called reversed", async () => {
    const r = await pay("900701", 1, "2026-09-05");
    assert.deepEqual([r.matched, r.settledReversed, r.ambiguous], [false, false, null]);
  });

  test("a prescription whose claims are all reversed is attached to nothing, and says so on the payment", async () => {
    await db.insert(schema.claims).values(claim("900702", 1, "2026-09-05", { status: "reversed" }));
    const r = await pay("900702", 1, "2026-09-05");
    assert.deepEqual([r.matched, r.settledReversed, r.ambiguous], [false, true, null]);
    const row = await db.query.claimPayments.findFirst({ where: (t, { eq }) => eq(t.id, r.id) });
    assert.match(row?.notes ?? "", /was reversed/);
  });

  test("the reversal is the prescription's, not the fill's: a reversed fill beside a paid refill is not called reversed", async () => {
    await db.insert(schema.claims).values([claim("900703", 1, "2026-09-05", { status: "reversed" }), claim("900703", 2, "2026-10-05")]);
    const r = await pay("900703", 1, "2026-09-05");
    assert.deepEqual([r.matched, r.settledReversed, r.ambiguous], [false, false, null]);
  });

  test("paid claims for other fills only take nothing, and call nothing ambiguous", async () => {
    await db.insert(schema.claims).values(claim("900704", 2, "2026-10-05"));
    const r = await pay("900704", 1, "2026-09-05");
    assert.deepEqual([r.matched, r.settledReversed, r.ambiguous], [false, false, null]);
  });

  test("a fill billed to two payers: a payment naming neither and matching neither amount is refused and says so; one matching an amount is tied", async () => {
    await db.insert(schema.claims).values([claim("900705", 1, "2026-09-05", { bin: "610097", remitCents: 5_000 }), claim("900705", 1, "2026-09-05", { bin: "004336", remitCents: 2_500 })]);
    const refused = await pay("900705", 1, "2026-09-05");
    assert.equal(refused.matched, false);
    assert.equal(refused.ambiguous?.count, 2);
    const tied = await pay("900705", 1, "2026-09-05", { amountCents: 2_500, receivedOn: "2026-09-21" });
    assert.equal(tied.matched, true);
  });

  test("a reversed twin of a paid claim is not offered, so it does not make the paid one ambiguous", async () => {
    await db.insert(schema.claims).values([claim("900706", 1, "2026-09-05"), claim("900706", 1, "2026-09-05", { status: "reversed" })]);
    const r = await pay("900706", 1, "2026-09-05");
    assert.deepEqual([r.matched, r.settledReversed, r.ambiguous], [true, false, null]);
  });

  test("a payment that beat its claim is attached when the claim arrives, by the sweep", async () => {
    const early = await pay("900707", 1, "2026-09-05");
    assert.equal(early.matched, false);
    await db.insert(schema.claims).values(claim("900707", 1, "2026-09-05"));
    const swept = await matchOrphanPayments();
    assert.ok(swept.matched >= 1);
    const row = await db.query.claimPayments.findFirst({ where: (t, { eq }) => eq(t.id, early.id) });
    assert.notEqual(row?.claimId, null);
  });
});

describe("a take-back is attached to the claim that was paid what it takes back", () => {
  /*
   * A fill billed to two payers is two claims, and a take-back of $41.50 cannot equal either one's remit. What tells them apart is which was
   * paid $41.50. Every figure here is invented.
   */
  const twoClaims = async (rx: string, remits: [number, number] = [4_150, 1_900]) => {
    const a = claim(rx, 1, "2026-09-05", { bin: "610097", remitCents: remits[0] });
    const b = claim(rx, 1, "2026-09-05", { bin: "004336", remitCents: remits[1], pbmName: "Other Plan" });
    await db.insert(schema.claims).values([a, b]);
    return { a, b };
  };
  const tiedTo = async (claimId: string) => (await db.query.claimPayments.findMany({ where: (t, { eq }) => eq(t.claimId, claimId) })).map((p) => p.amountCents).sort((x, y) => x - y);
  const take = (rx: string, receivedOn: string, amountCents = -4_150) => pay(rx, 1, "2026-09-05", { amountCents, receivedOn });

  test("it is tied to the claim that was paid that amount, and the other claim is left alone", async () => {
    const { a, b } = await twoClaims("900710");
    const paid = await pay("900710", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-20" });
    const again = await pay("900710", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-27" });
    const back = await take("900710", "2026-10-02");
    assert.deepEqual([paid.matched, again.matched, back.matched, back.ambiguous], [true, true, true, null]);
    assert.deepEqual(await tiedTo(a.id), [-4_150, 4_150, 4_150]);
    assert.deepEqual(await tiedTo(b.id), []);
  });

  test("one claim can be taken back until nothing is left to take back, and then it is refused", async () => {
    const { a } = await twoClaims("900711");
    await pay("900711", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-20" });
    await pay("900711", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-27" });
    assert.equal((await take("900711", "2026-10-02")).matched, true);
    assert.equal((await take("900711", "2026-10-03")).matched, true);
    const third = await take("900711", "2026-10-04");
    assert.equal(third.matched, false);
    assert.equal(third.ambiguous?.count, 2);
    assert.match(third.ambiguous?.why ?? "", /takes money back/);
    assert.deepEqual(await tiedTo(a.id), [-4_150, -4_150, 4_150, 4_150]);
  });

  test("a take-back for a fill nothing was paid on is refused, and says it takes money back", async () => {
    const { a, b } = await twoClaims("900712");
    const r = await take("900712", "2026-10-02");
    assert.deepEqual([r.matched, r.ambiguous?.count], [false, 2]);
    assert.match(r.ambiguous?.why ?? "", /takes money back/);
    assert.deepEqual([await tiedTo(a.id), await tiedTo(b.id)], [[], []]);
  });

  test("a take-back of an amount no claim was paid is refused, whatever else was paid", async () => {
    const { a } = await twoClaims("900713");
    await pay("900713", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-20" });
    assert.equal((await take("900713", "2026-10-02", -3_300)).matched, false);
    assert.deepEqual(await tiedTo(a.id), [4_150]);
  });

  test("a take-back from another source than the payment is not that payment's", async () => {
    const { a } = await twoClaims("900714");
    await pay("900714", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-20" });
    const r = await pay("900714", 1, "2026-09-05", { amountCents: -4_150, receivedOn: "2026-10-02", source: "secondary" });
    assert.equal(r.matched, false);
    assert.deepEqual(await tiedTo(a.id), [4_150]);
  });

  test("a take-back that arrived before the payments it takes back is tied by the same sweep that ties them", async () => {
    const early = await take("900715", "2026-10-02");
    const one = await pay("900715", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-20" });
    const two = await pay("900715", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-27" });
    assert.deepEqual([early.matched, one.matched, two.matched], [false, false, false]);
    const { a } = await twoClaims("900715");
    await matchOrphanPayments();
    assert.deepEqual(await tiedTo(a.id), [-4_150, 4_150, 4_150]);
  });

  test("a take-back whose own payment is waiting beside it stays beside that payment, not given to the claim that holds an equal one", async () => {
    const { a, b } = await twoClaims("900716", [4_150, 4_150]);
    const bin = await pay("900716", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-20", bin: "610097" });
    const waiting = await pay("900716", 1, "2026-09-05", { amountCents: 4_150, receivedOn: "2026-09-27" });
    const back = await take("900716", "2026-10-02");
    assert.deepEqual([bin.matched, waiting.matched, back.matched], [true, false, false]);
    await matchOrphanPayments();
    assert.deepEqual([await tiedTo(a.id), await tiedTo(b.id)], [[4_150], []]);
  });
});
