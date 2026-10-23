import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * "Take off this list" used to delete the row, and the row is how the mail sweep knows an email was already handled, so every
 * cleared line came back at the next sweep (23 Oct 2026: 8 of 21). Every value here is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let dismissInboxItem: typeof import("../src/lib/inbox-dismiss").dismissInboxItem;
let alreadyOnFile: typeof import("../src/lib/mailbox").alreadyOnFile;
let storyOf: typeof import("../src/lib/inbox-line").storyOf;
let cleanup: () => void;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ dismissInboxItem } = await import("../src/lib/inbox-dismiss"));
  ({ alreadyOnFile } = await import("../src/lib/mailbox"));
  ({ storyOf } = await import("../src/lib/inbox-line"));
  /* The suite's template database is shared with tests that do not copy it, so other files' rows can already be in this one. */
  await db.delete(schema.inboxItems);
});
after(() => cleanup());

const row = (id: string, messageId: string, o: Record<string, unknown> = {}) =>
  db.insert(schema.inboxItems).values({
    id, messageId, receivedAt: "2026-10-20T15:21:03.000Z", fromAddress: "news@example.test", subject: "A newsletter", fileName: "image001.png",
    documentId: null, status: "stored", routedAs: "unrecognised", routeResult: "No header row could be read.", imported: false, ...o,
  } as never);

describe("taking a line off the Inbox list", () => {
  test("the message stays on file, so the sweep does not take it again", async () => {
    await row("a1", "<m1@example.test>#image001.png");
    assert.equal(await alreadyOnFile("<m1@example.test>"), true);
    const r = await dismissInboxItem("a1", { id: "u1", name: "The owner" });
    assert.deepEqual([r.found, r.hadDocument], [true, false]);
    assert.equal(await alreadyOnFile("<m1@example.test>"), true, "the old behaviour deleted the row and this became false");
    assert.equal((await db.select().from(schema.inboxItems)).length, 1);
  });

  test("the line leaves the list of what needs him, and says why it is where it is", async () => {
    const [i] = await db.select().from(schema.inboxItems);
    assert.equal(i.status, "ignored");
    assert.equal(i.routedAs, "not_for_filing");
    assert.match(i.routeResult ?? "", /Taken off the list by The owner on \d{4}-\d{2}-\d{2}\. It stays on file so it is not taken again\./);
    const outcome = storyOf(i as never).outcome;
    assert.ok(!["not_recognised", "rejected", "held"].includes(outcome), `outcome ${outcome} would still ask for him`);
  });

  test("a stored document is untouched, and a line that is gone is said to be gone", async () => {
    await row("a2", "<m2@example.test>#PL.pdf", { documentId: "doc-1", fileName: "PL.pdf" });
    const r = await dismissInboxItem("a2", { id: "u1", name: "The owner" });
    assert.equal(r.hadDocument, true);
    assert.equal((await db.query.inboxItems.findFirst({ where: (t, { eq }) => eq(t.id, "a2") }))?.documentId, "doc-1");
    assert.equal((await dismissInboxItem("nope", { id: "u1", name: "The owner" })).found, false);
  });
});
