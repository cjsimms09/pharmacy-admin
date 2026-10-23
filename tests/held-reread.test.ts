import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { heldToReread, REREAD_WITHIN_DAYS, type HeldRow } from "../src/lib/held-reread";

/*
 * Refused reports are read again once per update. Every value is invented.
 */
const NOW = new Date("2026-10-23T12:00:00Z");
const row = (o: Partial<HeldRow> = {}): HeldRow => ({ id: "r1", routedAs: "rebate_report", imported: false, documentId: "d1", receivedAt: "2026-10-19T23:34:00Z", ...o });

describe("which refused rows are read again", () => {
  test("a refused rebate report, IPD statement or payment-type report is", () => {
    for (const kind of ["rebate_report", "ipd_statement", "sales_by_payment"]) assert.equal(heldToReread([row({ routedAs: kind })], NOW).length, 1, kind);
  });

  test("a row that was filed (true) or never judged (null) is not", () => {
    assert.equal(heldToReread([row({ imported: true })], NOW).length, 0);
    assert.equal(heldToReread([row({ imported: null })], NOW).length, 0);
  });

  test("a kind whose filing is not safe to run twice is left to a person", () => {
    for (const kind of ["invoice", "unrecognised", "remittance_835", "rx_transactions", "postage"]) assert.equal(heldToReread([row({ routedAs: kind })], NOW).length, 0, kind);
  });

  test("a row with no document, or one older than the window, is not", () => {
    assert.equal(heldToReread([row({ documentId: null })], NOW).length, 0);
    const old = new Date(NOW.getTime() - (REREAD_WITHIN_DAYS + 1) * 86_400_000).toISOString();
    assert.equal(heldToReread([row({ receivedAt: old })], NOW).length, 0);
  });
});

describe("once per build, on a scratch database", () => {
  let db: typeof import("../src/db").db;
  let schema: typeof import("../src/db").schema;
  let rereadHeldAfterUpdate: typeof import("../src/lib/held-reread").rereadHeldAfterUpdate;
  let getSettings: typeof import("../src/lib/settings").getSettings;
  let cleanup: () => void;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ db, schema } = await import("../src/db"));
    ({ rereadHeldAfterUpdate } = await import("../src/lib/held-reread"));
    ({ getSettings } = await import("../src/lib/settings"));
    await db.delete(schema.inboxItems);
  });
  after(() => cleanup());

  test("a refused report whose file cannot be opened is counted, recorded, and not tried again for the same build", async () => {
    await db.insert(schema.inboxItems).values({
      id: "held-1",
      messageId: "m-held-1",
      receivedAt: new Date().toISOString(),
      fromAddress: "reports@example.test",
      subject: "Rebate report",
      fileName: "rebate.pdf",
      documentId: "no-such-document",
      status: "stored",
      routedAs: "rebate_report",
      routeResult: "The figures on this report do not agree with the tier table printed on it.",
      imported: false,
    });
    const first = await rereadHeldAfterUpdate();
    assert.ok(first, "it ran");
    assert.equal(first!.looked, 1);
    assert.equal(first!.errors, 1);
    assert.equal(first!.stillHeld, 1);
    assert.match((await getSettings()).held_reread_result ?? "", /1 refused report read again, 0 now filed, 1 still refused, 1 could not be opened/);
    assert.equal(await rereadHeldAfterUpdate(), null, "the same build is not tried twice");
  });
});
