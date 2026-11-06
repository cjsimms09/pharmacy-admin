import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * The two morning alerts about payments tied to no claim, through alerts() itself. Their block in alerts.ts sits inside a try/catch, so a
 * reader that breaks silences them without any test failing; these assert the rows positively on a scratch database. They are read from
 * the payments-with-no-claim page's own reading, so the count in the alert is the count in its group on the page. Every value is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let alerts: typeof import("../src/lib/alerts").alerts;
let untiedPayments: typeof import("../src/lib/untied-payments-store").untiedPayments;
let newId: typeof import("../src/lib/crypto").newId;
let importId: string;
let cleanup: () => void;

const NDC = "00093000022";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ alerts } = await import("../src/lib/alerts"));
  ({ untiedPayments } = await import("../src/lib/untied-payments-store"));
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
const find = async (key: string) => (await alerts()).find((a) => a.key === key);

describe("the alerts about payments tied to no claim", () => {
  test("none is said where each payment is for a fill from before the feed, on a reversed claim, or fits several claims", async () => {
    const reversed = claim("930001", 1, "2026-09-05", { status: "reversed" });
    const twin1 = claim("930002", 1, "2026-09-06", { payerLabel: "Plan C" });
    const twin2 = claim("930002", 1, "2026-09-06", { payerLabel: "Plan D", remitCents: 6_000 });
    await db.insert(schema.claims).values([reversed, twin1, twin2]);
    await db.insert(schema.claimPayments).values([
      payment("930001"),
      payment("930002", { dateFilled: "2026-09-06", amountCents: 5_500 }),
      payment("930003", { dateFilled: "2026-08-14" }),
    ]);
    assert.equal(await find("payments-stranded"), undefined);
    assert.equal(await find("payments-not-a-fill"), undefined);
  });

  test("a payment for a prescription with no claim on file, for a fill inside the feed, is said now, and leads to its group", async () => {
    await db.insert(schema.claimPayments).values([payment("930010"), payment("930011", { payer: "B Plan", amountCents: 2_500, dateFilled: "2026-09-08" })]);
    const a = await find("payments-stranded");
    assert.ok(a, "payments-stranded");
    assert.equal(a.level, "now");
    assert.equal(a.title, "2 payments for a prescription with no claim on file, $65.00");
    assert.match(a.why, /^From A Plan, B Plan\. /);
    assert.doesNotMatch(a.why, /disagrees between/, "there is no claim for the payment to disagree with");
    assert.equal(a.href, "/claims/no-claim#no_claim_yet");
    const page = (await untiedPayments()).lines.filter((l) => l.cause === "no_claim_yet");
    assert.equal(page.length, 2, "the alert counts what its group on the page counts");
  });

  test("payments that name no drug and no fill are the other alert, and a fill date in the future is said", async () => {
    await db.insert(schema.claimPayments).values([
      payment("930020001", { fillNumber: null, ndc11: null, dateFilled: "2099-12-31", amountCents: 500 }),
      payment("930020002", { fillNumber: null, ndc11: null, dateFilled: "2099-12-31", amountCents: 1_000 }),
    ]);
    const a = await find("payments-not-a-fill");
    assert.ok(a, "payments-not-a-fill");
    assert.equal(a.level, "soon");
    assert.equal(a.title, "2 payments on a remittance that belong to no fill, $15.00");
    assert.match(a.why, /every one dated in the future/);
    assert.equal(a.href, "/claims/no-claim#not_a_fill");
    assert.equal((await find("payments-stranded"))?.title, "2 payments for a prescription with no claim on file, $65.00", "and they are not counted as the first");
  });

  test("a payment received before the books begin is said by neither", async () => {
    await db.insert(schema.claimPayments).values(payment("930030", { receivedOn: "2026-08-25", outOfBooks: true }));
    assert.equal((await find("payments-stranded"))?.title, "2 payments for a prescription with no claim on file, $65.00");
  });

  test("names the payers with the most payments first whatever order they arrived in, and counts the rest", async () => {
    await db.insert(schema.claimPayments).values([
      ...["930041", "930042", "930043"].map((rx) => payment(rx, { payer: "Z Plan", receivedOn: "2026-09-01", dateFilled: "2026-09-02" })),
      payment("930044", { payer: "C Plan", receivedOn: "2026-09-27", dateFilled: "2026-09-12" }),
    ]);
    const a = await find("payments-stranded");
    assert.ok(a, "payments-stranded");
    assert.match(a.why, /^From Z Plan, A Plan, B Plan and 1 more\. /);
  });
});
