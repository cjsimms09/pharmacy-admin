import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

/*
 * The one thing the payments-with-no-claim page lets a person change: a payment that fits two or more claims equally is attached to the claim the
 * owner says it paid, with his name on the choice, and he can take it back. It is refused for every other payment, and the sweeps that move or
 * merge payments leave a payment he tied where he put it. Every value is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let tieByHand: typeof import("../src/lib/tie-by-hand").tieByHand;
let untieByHand: typeof import("../src/lib/tie-by-hand").untieByHand;
let untiedPayments: typeof import("../src/lib/untied-payments-store").untiedPayments;
let handTied: typeof import("../src/lib/untied-payments-store").handTied;
let recordClaimPayment: typeof import("../src/lib/claim-payments").recordClaimPayment;
let rematchMisattachedPayments: typeof import("../src/lib/claim-payments").rematchMisattachedPayments;
let newId: typeof import("../src/lib/crypto").newId;
let importId: string;
let cleanup: () => void;

const NDC = "00093000022";
const owner = { id: "owner-1", name: "Test Owner" };

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ tieByHand, untieByHand } = await import("../src/lib/tie-by-hand"));
  ({ untiedPayments, handTied } = await import("../src/lib/untied-payments-store"));
  ({ recordClaimPayment, rematchMisattachedPayments } = await import("../src/lib/claim-payments"));
  ({ newId } = await import("../src/lib/crypto"));
  importId = newId();
  await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test", periodFrom: "2026-09-01" });
});
after(() => cleanup());

const claim = (rx: string, o: Partial<typeof import("../src/db").schema.claims.$inferInsert> = {}) => ({
  id: newId(), importId, rxNumber: rx, fillNumber: 1, dateFilled: "2026-09-05", ndc11: NDC, bin: "610097", pbmName: "OptumRx", status: "paid" as const, remitCents: 5_000, copayCents: 1_000, source: "transaction_report", ...o,
});
const payment = (rx: string, o: Partial<typeof import("../src/db").schema.claimPayments.$inferInsert> = {}) => ({
  id: newId(), rxNumber: rx, fillNumber: 1, dateFilled: "2026-09-05", ndc11: NDC, source: "plan", payer: "A Plan", amountCents: 5_500, receivedOn: "2026-09-20", outOfBooks: false, recordedBy: "the test", ...o,
});
/** Two paid claims for one fill, $50.00 and $60.00, and a payment of $55.00, which is the amount of neither: it fits both equally. */
async function fitsTwo(rx: string) {
  const a = claim(rx, { payerLabel: "Plan C", itemName: "Drug One" });
  const b = claim(rx, { payerLabel: "Plan D", itemName: "Drug One", remitCents: 6_000 });
  const p = payment(rx);
  await db.insert(schema.claims).values([a, b]);
  await db.insert(schema.claimPayments).values(p);
  return { a, b, p };
}
const row = (id: string) => db.query.claimPayments.findFirst({ where: (t, { eq }) => eq(t.id, id) });
const where = async (id: string) => {
  const r = await row(id);
  return [r?.claimId ?? null, r?.tiedBy ?? null];
};
const refused = (go: Promise<unknown>, pattern: RegExp) => assert.rejects(go, (e: Error) => pattern.test(e.message));
const eventsOf = async (id: string) => (await db.query.auditEvents.findMany({ where: (t, { eq }) => eq(t.entityId, id) })).map((e) => [e.action, e.userId, e.userName]).sort();

describe("a payment that fits several claims, tied by hand", () => {
  test("it goes on the claim he chooses with his name on it, and leaves the list of payments tied to none", async () => {
    const { a, b, p } = await fitsTwo("930001");
    const line = (await untiedPayments()).lines.find((l) => l.id === p.id)!;
    assert.equal(line.cause, "fits_several");
    assert.deepEqual(line.claims.map((c) => c.id).sort(), [a.id, b.id].sort());

    const said = await tieByHand(p.id, b.id, owner);
    assert.equal(said, 'Attached the $55.00 received Sep 20, 2026 to the claim you chose. It is listed under "Attached by hand" below, where it can be taken back.');
    assert.deepEqual(await where(p.id), [b.id, owner.name]);
    assert.equal((await untiedPayments()).lines.some((l) => l.id === p.id), false);
    assert.deepEqual((await handTied()).filter((h) => h.id === p.id).map((h) => [h.tiedBy, h.claim?.id, h.claim?.payerLabel, h.amountCents]), [[owner.name, b.id, "Plan D", 5_500]]);
    assert.deepEqual(await eventsOf(p.id), [["claim_payment.tie_by_hand", owner.id, owner.name]]);
    const e = await db.query.auditEvents.findFirst({ where: (t, { eq }) => eq(t.entityId, p.id) });
    assert.match(e?.details ?? "", /^Tied the \$55\.00 received Sep 20, 2026 to claim \S+, one of 2 it fit equally\.$/);
  });

  test("a payment already tied is refused, whoever tied it, and is not moved", async () => {
    const { a, b, p } = await fitsTwo("930002");
    await tieByHand(p.id, a.id, owner);
    await refused(tieByHand(p.id, b.id, owner), /not waiting for a claim any more/);
    assert.deepEqual(await where(p.id), [a.id, owner.name]);
    assert.deepEqual(await eventsOf(p.id), [["claim_payment.tie_by_hand", owner.id, owner.name]], "the refused press wrote nothing");
  });

  test("a claim that is not one of the ones it fits is refused: another prescription's, or one the plan reversed", async () => {
    const { a, p } = await fitsTwo("930003");
    const reversed = claim("930003", { status: "reversed", payerLabel: "Plan E" });
    const other = claim("930004");
    await db.insert(schema.claims).values([reversed, other]);
    assert.equal((await untiedPayments()).lines.find((l) => l.id === p.id)?.cause, "fits_several", "a reversed claim of the same fill does not change what it fits");
    for (const wrong of [reversed.id, other.id, "no-such-claim"]) {
      await refused(tieByHand(p.id, wrong, owner), /not one of the claims this payment fits/);
      assert.deepEqual(await where(p.id), [null, null]);
    }
    await tieByHand(p.id, a.id, owner);
    assert.deepEqual(await where(p.id), [a.id, owner.name]);
  });

  test("a payment the site reads as anything else is refused, and the sentence names what it is read as", async () => {
    const { causeInfo } = await import("../src/lib/untied-payments");
    const claimless = payment("930005");
    const a = claim("930006", { remitCents: 5_500 });
    const exact = payment("930006");
    await db.insert(schema.claimPayments).values([claimless, exact]);
    await db.insert(schema.claims).values(a);
    const label = causeInfo("no_claim_yet", null).label;
    await refused(tieByHand(claimless.id, a.id, owner), new RegExp(`reads that payment as "${label}", not as fitting several claims`));
    assert.deepEqual(await where(claimless.id), [null, null]);
    /* A payment that has one claim of its own is read as a payment that will attach to it, and is not chosen for either */
    await refused(tieByHand(exact.id, a.id, owner), /not as fitting several claims/);
    assert.deepEqual(await where(exact.id), [null, null]);
  });

  test("a payment that is not in the books, or that is not there, is refused", async () => {
    const { a } = await fitsTwo("930007");
    const early = payment("930007", { receivedOn: "2026-08-20", outOfBooks: true });
    await db.insert(schema.claimPayments).values(early);
    await refused(tieByHand(early.id, a.id, owner), /received before the books begin/);
    await refused(tieByHand("no-such-payment", a.id, owner), /not waiting for a claim any more/);
    assert.deepEqual(await where(early.id), [null, null]);
  });
});

describe("taking a choice back", () => {
  test("the payment is tied to none again, read as it was, and both presses are written down", async () => {
    const { a, p } = await fitsTwo("930010");
    await tieByHand(p.id, a.id, owner);
    const said = await untieByHand(p.id, { id: "pic-1", name: "Test Pharmacist" });
    assert.equal(said, "Took the $55.00 received Sep 20, 2026 off the claim. It is read again with the others that are tied to none.");
    assert.deepEqual(await where(p.id), [null, null]);
    assert.equal((await untiedPayments()).lines.find((l) => l.id === p.id)?.cause, "fits_several");
    assert.equal((await handTied()).some((h) => h.id === p.id), false);
    assert.deepEqual(await eventsOf(p.id), [["claim_payment.tie_by_hand", owner.id, owner.name], ["claim_payment.untie_by_hand", "pic-1", "Test Pharmacist"]]);
    await tieByHand(p.id, a.id, owner);
    assert.deepEqual(await where(p.id), [a.id, owner.name], "and it can be chosen again");
  });

  test("a payment the matcher tied is not his to take back, and an unknown payment is not either", async () => {
    const a = claim("930011");
    const matched = payment("930011", { claimId: a.id });
    await db.insert(schema.claims).values(a);
    await db.insert(schema.claimPayments).values(matched);
    await refused(untieByHand(matched.id, owner), /was not tied by hand/);
    await refused(untieByHand("no-such-payment", owner), /was not tied by hand/);
    assert.deepEqual(await where(matched.id), [a.id, null]);
    assert.deepEqual(await eventsOf(matched.id), []);
    assert.equal((await handTied()).some((h) => h.id === matched.id), false, "what the matcher tied is not listed as his choice");
  });
});

describe("a payment tied by hand stays where he put it", () => {
  test("the sweep that revisits payments tied far from their own fill moves the matcher's and leaves his", async () => {
    const a = claim("930020");
    const byMatcher = payment("930020", { claimId: a.id, dateFilled: "2026-09-20", amountCents: 4_100 });
    const byHand = payment("930020", { claimId: a.id, dateFilled: "2026-09-20", amountCents: 4_200, tiedBy: owner.name });
    await db.insert(schema.claims).values(a);
    await db.insert(schema.claimPayments).values([byMatcher, byHand]);
    const swept = await rematchMisattachedPayments();
    assert.deepEqual([swept.looked, swept.detached, swept.moved], [1, 1, 0]);
    assert.deepEqual(await where(byMatcher.id), [null, null], "the matcher's tie to a claim 15 days away from the fill is undone");
    assert.deepEqual(await where(byHand.id), [a.id, owner.name], "his is not");
  });

  test("the same money arriving again by another kind of document is that payment and not a second one", async () => {
    const { a, p } = await fitsTwo("930030");
    await db.update(schema.claimPayments).set({ origin: "accesshealth:EFT-1", reference: null }).where(eq(schema.claimPayments.id, p.id));
    await tieByHand(p.id, a.id, owner);
    const again = await recordClaimPayment(
      { rxNumber: "930030", fillNumber: 1, dateFilled: "2026-09-05", ndc11: NDC, source: "plan", payer: "A Plan", amountCents: 5_500, receivedOn: "2026-09-20", reference: "TRACE-9", documentId: "doc-9", origin: "835:TRACE-9" },
      { name: "the test" },
    );
    assert.deepEqual([again.duplicateOf, again.id, again.matched, again.ambiguous], [p.id, p.id, true, null]);
    const rows = await db.query.claimPayments.findMany({ where: (t, { eq }) => eq(t.rxNumber, "930030") });
    assert.equal(rows.length, 1, "no second payment was written");
    assert.deepEqual([rows[0].claimId, rows[0].tiedBy, rows[0].origin, rows[0].reference], [a.id, owner.name, "835:TRACE-9", "TRACE-9"], "his choice kept, the 835's trace taken over");
  });

  test("money the site read as fitting several and left tied to none is still counted once by the same rule", async () => {
    const { p } = await fitsTwo("930031");
    await db.update(schema.claimPayments).set({ origin: "accesshealth:EFT-2" }).where(eq(schema.claimPayments.id, p.id));
    const again = await recordClaimPayment(
      { rxNumber: "930031", fillNumber: 1, dateFilled: "2026-09-05", ndc11: NDC, source: "plan", payer: "A Plan", amountCents: 5_500, receivedOn: "2026-09-20", origin: "835:TRACE-10" },
      { name: "the test" },
    );
    assert.deepEqual([again.duplicateOf, again.matched, again.ambiguous], [p.id, false, null]);
  });
});
