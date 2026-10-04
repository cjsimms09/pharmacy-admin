import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * The payments tied to no claim, as the store reads them out of the database: who is counted (received since the books begin,
 * tied to nothing), who is only counted by source (a fill from before the claims feed), who is listed and beside which claims.
 * Every value is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let untiedPayments: typeof import("../src/lib/untied-payments-store").untiedPayments;
let untiedPaymentsFrom: typeof import("../src/lib/untied-payments-store").untiedPaymentsFrom;
let newId: typeof import("../src/lib/crypto").newId;
let importId: string;
let cleanup: () => void;

const NDC = "00093000022";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ untiedPayments, untiedPaymentsFrom } = await import("../src/lib/untied-payments-store"));
  ({ newId } = await import("../src/lib/crypto"));
  importId = newId();
  await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test", periodFrom: "2026-09-01" });
});
after(() => cleanup());

const claim = (rx: string, fill: number, date: string, o: Partial<typeof import("../src/db").schema.claims.$inferInsert> = {}) => ({
  id: newId(), importId, rxNumber: rx, fillNumber: fill, dateFilled: date, ndc11: NDC, bin: "610097", pbmName: "OptumRx", status: "paid" as const, remitCents: 5_000, copayCents: 1_000, source: "transaction_report", ...o,
});
const payment = (rx: string, o: Partial<typeof import("../src/db").schema.claimPayments.$inferInsert> = {}) => ({
  id: newId(), rxNumber: rx, fillNumber: 1, dateFilled: "2026-09-05", ndc11: NDC, source: "plan", payer: "A Plan", amountCents: 4_000, receivedOn: "2026-09-20", outOfBooks: false, recordedBy: "the test", ...o,
});

describe("the payments the site holds that tie to no claim", () => {
  test("nothing is left over where there is nothing: every payment is tied", async () => {
    const r = await untiedPayments();
    assert.deepEqual([r.total, r.tally, r.beforeFeed, r.lines], [{ count: 0, cents: 0 }, [], [], []]);
    assert.match(r.headline, /^Every payment received since Sep 1, 2026 is tied to a claim\.$/);
  });

  test("each cause is read from the claims the site holds, and the claims are named beside the payment", async () => {
    const a = claim("910001", 1, "2026-09-05", { status: "reversed", payerLabel: "Plan A", itemName: "Drug One" });
    const b = claim("910002", 1, "2026-09-06", { status: "reversed", soldOn: "2026-09-06", payerLabel: "Plan B", itemName: "Drug Two" });
    const c1 = claim("910003", 1, "2026-09-07", { payerLabel: "Plan C", itemName: "Drug Three" });
    const c2 = claim("910003", 1, "2026-09-07", { payerLabel: "Plan D", itemName: "Drug Three", remitCents: 6_000 });
    const d = claim("910006", 2, "2026-09-09", { payerLabel: "Plan E", itemName: "Drug Four" });
    await db.insert(schema.claims).values([a, b, c1, c2, d]);
    await db.insert(schema.claimPayments).values([
      payment("910001"),
      payment("910002", { amountCents: 6_000 }),
      payment("910003", { amountCents: 5_500 }),
      payment("910004", { dateFilled: "2026-09-08" }),
      payment("910005", { fillNumber: null, ndc11: null, dateFilled: "2026-12-31", amountCents: 1_000 }),
      payment("910006", { fillNumber: 1, dateFilled: "2026-09-02" }),
    ]);
    const r = await untiedPayments();
    const of = (rx: string) => r.lines.find((l) => l.rxNumber === rx)!;
    assert.deepEqual(
      ["910001", "910002", "910003", "910004", "910005", "910006"].map((rx) => of(rx).cause),
      ["reversed_not_sold", "reversed_sold", "fits_several", "no_claim_yet", "not_a_fill", "other_fills_only"],
    );
    assert.deepEqual(of("910001").claims.map((x) => [x.id, x.payerLabel, x.itemName, x.status]), [[a.id, "Plan A", "Drug One", "reversed"]]);
    assert.deepEqual(of("910003").claims.map((x) => x.id).sort(), [c1.id, c2.id].sort());
    assert.deepEqual(of("910004").claims, []);
    assert.deepEqual(of("910006").claims.map((x) => x.id), [d.id]);
  });

  test("a fill from before the claims feed is counted by who paid and is not listed", async () => {
    await db.insert(schema.claimPayments).values([
      payment("910010", { dateFilled: "2026-08-14", amountCents: 3_000 }),
      payment("910011", { dateFilled: "2026-08-20", amountCents: 2_050 }),
      payment("910012", { dateFilled: "2026-07-02", amountCents: 1_234, source: "mtf", payer: null }),
    ]);
    const r = await untiedPayments();
    assert.deepEqual(r.beforeFeed, [{ source: "plan", count: 2, cents: 5_050 }, { source: "mtf", count: 1, cents: 1_234 }]);
    assert.equal(r.lines.some((l) => ["910010", "910011", "910012"].includes(l.rxNumber)), false);
    assert.equal(r.feedFrom, "2026-09-01");
  });

  test("a fill from before the feed that the site holds a claim for is read by that claim, and is not counted as before the feed", async () => {
    const early = (await untiedPayments()).beforeFeed.reduce((n, b) => n + b.count, 0);
    const rev = claim("910040", 1, "2026-08-28", { status: "reversed", soldOn: "2026-08-28", payerLabel: "Plan G", itemName: "Drug Six" });
    const p1 = claim("910041", 1, "2026-08-29", { payerLabel: "Plan H", itemName: "Drug Seven" });
    const p2 = claim("910041", 1, "2026-08-29", { payerLabel: "Plan I", itemName: "Drug Seven", remitCents: 6_000 });
    const other = claim("910042", 2, "2026-09-03", { payerLabel: "Plan J", itemName: "Drug Eight" });
    await db.insert(schema.claims).values([rev, p1, p2, other]);
    await db.insert(schema.claimPayments).values([
      payment("910040", { dateFilled: "2026-08-28", amountCents: 3_300 }),
      payment("910041", { dateFilled: "2026-08-29", amountCents: 5_500 }),
      payment("910042", { dateFilled: "2026-08-20", amountCents: 2_200 }),
    ]);
    const r = await untiedPayments();
    const of = (rx: string) => r.lines.find((l) => l.rxNumber === rx);
    assert.equal(of("910040")?.cause, "reversed_sold");
    assert.deepEqual(of("910040")?.claims.map((x) => x.id), [rev.id]);
    assert.equal(of("910041")?.cause, "fits_several");
    assert.deepEqual(of("910041")?.claims.map((x) => x.id).sort(), [p1.id, p2.id].sort());
    /* A claim for another fill of the prescription is not a claim for this one: it stays among the fills the site holds no claim for. */
    assert.equal(of("910042"), undefined);
    assert.equal(r.beforeFeed.reduce((n, b) => n + b.count, 0), early + 1);
  });

  test("a payment already tied to a claim, or received before the books begin, is not here", async () => {
    const before = (await untiedPayments()).total;
    const held = claim("910015", 1, "2026-09-12");
    await db.insert(schema.claims).values(held);
    await db.insert(schema.claimPayments).values([
      payment("910015", { claimId: held.id, dateFilled: "2026-09-12" }),
      payment("910016", { receivedOn: "2026-08-25", outOfBooks: true }),
    ]);
    assert.deepEqual((await untiedPayments()).total, before);
  });

  test("a payment whose claim is on file now is said to attach itself, beside that claim", async () => {
    const held = claim("910020", 1, "2026-09-10", { payerLabel: "Plan F", itemName: "Drug Five" });
    await db.insert(schema.claims).values(held);
    await db.insert(schema.claimPayments).values(payment("910020", { dateFilled: "2026-09-10" }));
    const line = (await untiedPayments()).lines.find((l) => l.rxNumber === "910020")!;
    assert.equal(line.cause, "will_attach");
    assert.deepEqual(line.claims.map((x) => x.id), [held.id]);
  });

  test("causes are listed from the ones that need him to the ones that need nothing, newest received first within a cause", async () => {
    await db.insert(schema.claimPayments).values([
      payment("910030", { dateFilled: "2026-09-14", receivedOn: "2026-09-25" }),
      payment("910031", { dateFilled: "2026-09-15", receivedOn: "2026-09-28" }),
    ]);
    const r = await untiedPayments();
    const { CAUSES } = await import("../src/lib/untied-payments");
    const order = r.lines.map((l) => CAUSES.indexOf(l.cause));
    assert.deepEqual(order, [...order].sort((x, y) => x - y));
    assert.deepEqual(r.lines.filter((l) => l.cause === "no_claim_yet").map((l) => l.rxNumber), ["910031", "910030", "910004"]);
  });

  test("the tally, the before-feed counts and the lines add up to the total, to the cent", async () => {
    const r = await untiedPayments();
    assert.equal(r.tally.reduce((n, t) => n + t.count, 0), r.total.count);
    assert.equal(r.tally.reduce((n, t) => n + t.cents, 0), r.total.cents);
    const beforeCount = r.beforeFeed.reduce((n, b) => n + b.count, 0);
    assert.equal(r.lines.length + beforeCount, r.total.count);
    assert.equal(r.lines.reduce((n, l) => n + l.amountCents, 0) + r.beforeFeed.reduce((n, b) => n + b.cents, 0), r.total.cents);
    assert.match(r.headline, /tied to no claim/);
    assert.match(r.headline, /received since Sep 1, 2026/);
  });
});

describe("the same reading for one source of payment", () => {
  test("counts that source alone, by the same causes, and has no sentence about every payment", async () => {
    const all = await untiedPayments();
    const mtf = await untiedPaymentsFrom("mtf");
    const mine = all.lines.filter((l) => l.source === "mtf");
    assert.deepEqual(mtf.lines.map((l) => l.id), mine.map((l) => l.id));
    assert.deepEqual(mtf.beforeFeed, all.beforeFeed.filter((b) => b.source === "mtf"));
    assert.equal(mtf.total.count, mine.length + mtf.beforeFeed.reduce((n, b) => n + b.count, 0));
    assert.equal(mtf.total.cents, mine.reduce((n, l) => n + l.amountCents, 0) + mtf.beforeFeed.reduce((n, b) => n + b.cents, 0));
    assert.equal("headline" in mtf, false);
    assert.deepEqual((await untiedPaymentsFrom("a_source_nobody_used")).total, { count: 0, cents: 0 });
  });
});

describe("the payments that reached claims and the payments tied to none", () => {
  test("every payment received since the books begin is in one count or the other, to the cent", async () => {
    const { laterPaymentSummary } = await import("../src/lib/claim-payments");
    const inBooks = (await db.query.claimPayments.findMany()).filter((r) => !r.outOfBooks);
    const tied = inBooks.filter((r) => r.claimId !== null);
    const later = await laterPaymentSummary();
    const none = await untiedPayments();
    assert.ok(tied.length > 0 && none.total.count > 0, "the test holds some of each");
    assert.equal(later.reduce((n, x) => n + x.payments, 0), tied.length);
    assert.equal(later.reduce((n, x) => n + x.amountCents, 0), tied.reduce((n, r) => n + r.amountCents, 0));
    assert.equal(later.reduce((n, x) => n + x.payments, 0) + none.total.count, inBooks.length);
    assert.equal(later.reduce((n, x) => n + x.amountCents, 0) + none.total.cents, inBooks.reduce((n, r) => n + r.amountCents, 0));
  });
});

describe("the two groups the morning list speaks of", () => {
  test("are the payments the whole reading puts under those two causes, read without the fills from before the feed", async () => {
    const { paymentsWithNoClaimOnFile } = await import("../src/lib/untied-payments-store");
    /* A payment that names no fill date is not for a fill from before the feed: the narrower reading has to take it in. */
    await db.insert(schema.claimPayments).values(payment("910050", { dateFilled: null, fillNumber: null, ndc11: null, amountCents: 700 }));
    const whole = await untiedPayments();
    const some = await paymentsWithNoClaimOnFile();
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
    assert.ok(whole.lines.some((l) => l.rxNumber === "910050" && l.cause === "not_a_fill"));
    assert.deepEqual(ids(some.stranded), ids(whole.lines.filter((l) => l.cause === "no_claim_yet")));
    assert.deepEqual(ids(some.notAFill), ids(whole.lines.filter((l) => l.cause === "not_a_fill")));
    assert.ok(some.stranded.length > 0 && some.notAFill.length > 0, "the test holds some of each");
    assert.ok(whole.beforeFeed.length > 0, "and some from before the feed, which the narrower reading leaves unread");
    assert.equal(some.feedFrom, whole.feedFrom);
  });
});
