import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * What the Medicare Transaction Facilitator has paid and which of it is tied to a claim, through facilitatorMoney() and the money list's row for it.
 * The split used to be by fill date alone, so a payment that fits two claims of a fill the site holds was said to name a prescription the site has
 * not loaded, with the instruction to load the days it belongs to, and a payment for a fill from before the feed that the site holds a claim for was
 * said to be matchable never. It is now the matcher's answer on each prescription, the answer the Claims page gives. Every value is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let facilitatorMoney: typeof import("../src/lib/claim-payments").facilitatorMoney;
let computeMoneyFound: typeof import("../src/lib/money-found").computeMoneyFound;
let newId: typeof import("../src/lib/crypto").newId;
let importId: string;
let cleanup: () => void;

const NDC = "00093000022";
const TODAY = new Date("2026-10-04T12:00:00Z");

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ facilitatorMoney } = await import("../src/lib/claim-payments"));
  ({ computeMoneyFound } = await import("../src/lib/money-found"));
  ({ newId } = await import("../src/lib/crypto"));
  importId = newId();
  await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test", periodFrom: "2026-09-01" });
});
after(() => cleanup());

const claim = (rx: string, fill: number, date: string, o: Partial<typeof import("../src/db").schema.claims.$inferInsert> = {}) => ({
  id: newId(), importId, rxNumber: rx, fillNumber: fill, dateFilled: date, ndc11: NDC, bin: "610097", pbmName: "OptumRx", status: "paid" as const, remitCents: 5_000, copayCents: 1_000, source: "transaction_report", ...o,
});
const payment = (rx: string, o: Partial<typeof import("../src/db").schema.claimPayments.$inferInsert> = {}) => ({
  id: newId(), rxNumber: rx, fillNumber: 1, dateFilled: "2026-09-05", ndc11: NDC, source: "mtf", payer: "Facilitator", amountCents: 1_000, receivedOn: "2026-09-20", outOfBooks: false, recordedBy: "the test", ...o,
});
const mtfRow = async () => (await computeMoneyFound()).blocked.find((b) => /Medicare Transaction Facilitator/.test(b.says));

describe("the Medicare Transaction Facilitator's payments, and which are tied to a claim", () => {
  test("a source that has paid nothing is nothing to say", async () => {
    const m = await facilitatorMoney("mtf", TODAY);
    assert.deepEqual([m.allTimePayments, m.tiedPayments, m.tiedToNone, m.unmatched, m.beforeTheFeed], [0, 0, [], 0, 0]);
    assert.deepEqual([m.booksFrom, m.feedFrom], ["2026-09-01", "2026-09-01"]);
    assert.equal(await mtfRow(), undefined);
  });

  test("where the only payment tied to no claim is for a fill from before the feed, nothing is to be done and the row goes to the MTF page", async () => {
    const tied = claim("940001", 1, "2026-09-05");
    await db.insert(schema.claims).values(tied);
    await db.insert(schema.claimPayments).values([payment("940001", { claimId: tied.id }), payment("940003", { dateFilled: "2026-08-14", amountCents: 3_000 })]);
    const m = await facilitatorMoney("mtf", TODAY);
    assert.deepEqual([m.tiedPayments, m.tiedCents, m.unmatched, m.unmatchedCents, m.beforeTheFeed, m.beforeTheFeedCents], [1, 1_000, 0, 0, 1, 3_000]);
    assert.deepEqual(m.tiedToNone, [{ cause: "before_feed", count: 1, cents: 3_000 }]);
    const row = await mtfRow();
    assert.ok(row, "the row");
    assert.match(row.says, /^\$0\.00 has come in from the Medicare Transaction Facilitator this month, \$40\.00 received since Sep 1, 2026\. 1 of its 2 payments is tied to the claim it paid\.$/);
    assert.equal(row.todo, "Nothing to do. 1 payment ($30.00) for a fill from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.");
    assert.equal(row.href, "/remits/mtf");
  });

  test("each payment is in exactly one of tied and tied to none, and the groups are the matcher's, not the fill date's", async () => {
    const early = claim("940004", 1, "2026-08-20");
    const twin1 = claim("940005", 1, "2026-09-06", { payerLabel: "Plan C" });
    const twin2 = claim("940005", 1, "2026-09-06", { payerLabel: "Plan D", remitCents: 6_000 });
    await db.insert(schema.claims).values([early, twin1, twin2]);
    await db.insert(schema.claimPayments).values([
      payment("940002", { dateFilled: "2026-09-08", amountCents: 2_000 }),
      payment("940004", { dateFilled: "2026-08-20", amountCents: 4_000 }),
      payment("940005", { dateFilled: "2026-09-06", amountCents: 5_500 }),
    ]);
    const m = await facilitatorMoney("mtf", TODAY);
    assert.deepEqual(
      m.tiedToNone,
      [
        { cause: "fits_several", count: 1, cents: 5_500 },
        { cause: "no_claim_yet", count: 1, cents: 2_000 },
        { cause: "will_attach", count: 1, cents: 4_000 },
        { cause: "before_feed", count: 1, cents: 3_000 },
      ],
      "a fill from before the feed that the site holds a claim for is read by that claim, and a payment that fits two claims is not one whose claim has not arrived",
    );
    assert.deepEqual([m.unmatched, m.unmatchedCents], [1, 2_000], "only a prescription with no claim on file, for a fill inside the feed, is a claim still to come");
    assert.deepEqual([m.beforeTheFeed, m.beforeTheFeedCents], [1, 3_000]);
    assert.equal(m.tiedPayments + m.tiedToNone.reduce((n, t) => n + t.count, 0), m.allTimePayments);
    assert.equal(m.tiedCents + m.tiedToNone.reduce((n, t) => n + t.cents, 0), m.allTimeCents);
    assert.deepEqual([m.allTimePayments, m.allTimeCents, m.monthToDateCents, m.lastMonthCents], [5, 15_500, 0, 15_500]);
  });

  test("the money list's row says the basis, how many are tied, and each group as the page words it, and no longer asks for days to be loaded", async () => {
    const row = await mtfRow();
    assert.ok(row, "the row");
    assert.match(row.says, /, \$155\.00 received since Sep 1, 2026\. 1 of its 5 payments is tied to the claim it paid\.$/);
    assert.doesNotMatch(row.says, /since it started|already counted/);
    assert.ok(row.todo.includes("1 payment ($55.00) that fits two or more claims equally. Pick the claim each one paid, on the Payments with no claim page. The site will not guess."), row.todo);
    assert.ok(row.todo.includes("1 payment ($20.00) for a prescription with no claim on file. Find out why no claim is on file."), row.todo);
    assert.ok(row.todo.includes("1 payment ($40.00) whose claim is on file now."), row.todo);
    assert.ok(row.todo.endsWith("1 payment ($30.00) for a fill from before the claims feed begins on Sep 1, 2026, which the site holds no claim for. Needs nothing."), row.todo);
    assert.doesNotMatch(row.todo, /Load the days|not loaded/);
    assert.equal(row.href, "/claims/no-claim", "to the page that has each payment, where a group has something to decide or look at");
  });

  test("another source's payments and money received before the books begin are not counted", async () => {
    await db.insert(schema.claimPayments).values([
      payment("940006", { source: "plan", amountCents: 9_000 }),
      payment("940007", { receivedOn: "2026-08-25", outOfBooks: true, amountCents: 8_000 }),
    ]);
    const m = await facilitatorMoney("mtf", TODAY);
    assert.deepEqual([m.allTimePayments, m.allTimeCents], [5, 15_500]);
    assert.equal(m.tiedPayments + m.tiedToNone.reduce((n, t) => n + t.count, 0), 5);
  });
});
