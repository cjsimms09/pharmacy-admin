import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * A month does not close without its wholesaler rebate statement. September 2026 read "closed" with $12,354.06 of rebate booked
 * nowhere. Every value here is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let rebateCheck: typeof import("../src/lib/month-close-store").rebateCheck;
let monthClose: typeof import("../src/lib/month-close-store").monthClose;
let cleanup: () => void;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ rebateCheck, monthClose } = await import("../src/lib/month-close-store"));
  /* The suite's template database is shared with tests that do not copy it, so other files' rows can already be in this one. */
  await db.delete(schema.inboxItems);
  await db.delete(schema.cashReceipts);
  await db.delete(schema.expenses);
});
after(() => cleanup());

const receipt = (id: string, key: string, on: string, out = false) =>
  db.insert(schema.cashReceipts).values({ id, month: on.slice(0, 7), kind: "rebate", amountCents: 100_000, payer: "A Wholesaler", receivedOn: on, sourceKey: key, outOfBooks: out, createdBy: "the test" } as never);

describe("the wholesaler's rebate statement as a gate on closing a month", () => {
  test("a pharmacy whose books have never held a rebate statement is not asked for one", async () => {
    assert.equal(await rebateCheck("2026-09"), null);
  });

  test("once one has been booked, a month without its own is waiting on it, and says what to expect", async () => {
    await receipt("r-aug", "REBATE|sup-1|2026-08-01|2026-08-31", "2026-09-17");
    const c = await rebateCheck("2026-09");
    assert.ok(c);
    assert.equal(c!.done, false);
    assert.equal(c!.gate, "document");
    assert.match(c!.says, /has not arrived\. It usually comes around the 20th of the next month and books itself/);
    assert.match(c!.says, /ladder's estimate/);
  });

  test("a statement that arrived and was refused is named as that, not as one that has not come", async () => {
    await db.insert(schema.inboxItems).values({
      id: "i-1", messageId: "m-1", receivedAt: "2026-10-19T23:34:00Z", fromAddress: "x@example.test", subject: "s", fileName: "r.pdf", documentId: null,
      status: "stored", routedAs: "rebate_report", routeResult: "refused", imported: false,
    });
    const c = await rebateCheck("2026-09");
    assert.match(c!.says, /has arrived and was refused, so it is not booked: see the Inbox/);
  });

  test("the month is not closed while it is waiting, and a booked statement for that period clears it", async () => {
    const waiting = await monthClose("2026-09", "2026-10-23");
    assert.ok(waiting.checks.some((k) => k.key === "wholesaler_rebate" && !k.done));
    assert.equal(waiting.state, "waiting_on_documents");
    await receipt("r-sep", "REBATE|sup-1|2026-09-01|2026-09-30", "2026-10-20");
    const c = await rebateCheck("2026-09");
    assert.equal(c!.done, true);
    assert.match(c!.says, /is booked from its own statement/);
  });

  test("a rebate marked out of the books does not count, and an earlier month's does not stand in for this one", async () => {
    assert.equal((await rebateCheck("2026-10"))!.done, false, "October has no statement of its own");
    await db.delete(schema.cashReceipts);
    await receipt("r-old", "REBATE|sup-1|2026-09-01|2026-09-30", "2026-10-20", true);
    assert.equal(await rebateCheck("2026-09"), null, "the only rebate on file is out of books, so none has ever been booked");
  });
});
