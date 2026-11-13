import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * Which remittances the bank matcher is offered. A remittance is offered when nothing stands for it, except one whose own receipt key is
 * already held: banking it would write a second receipt under that key, the gate refuses that as the same money, and the bank line would
 * be placed as banking the remittance with nothing behind it. Every name and number is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let matchContext: typeof import("../src/lib/bank-match-context").matchContext;
let remitReceiptKey: typeof import("../src/lib/engine/remit-standing").remitReceiptKey;
let cleanup: () => void;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ matchContext } = await import("../src/lib/bank-match-context"));
  ({ remitReceiptKey } = await import("../src/lib/engine/remit-standing"));
});
after(() => cleanup());

const ROW = { payer: "Invented Payer A", paymentNumber: "999000000000051", remitNumber: "R-100001", remitOn: "2026-09-15" };

async function offered() {
  const { remits } = await matchContext();
  assert.ok(remits, "the matcher is always given a list, even an empty one");
  return remits;
}

describe("the remittances the matcher is offered", () => {
  test("one nothing stands for is offered", async () => {
    await db.insert(schema.remittanceRegister).values({ id: "reg-1", remitNumber: ROW.remitNumber, payerName: ROW.payer, remitOn: ROW.remitOn, amountCents: 200_800, paymentNumber: ROW.paymentNumber, source: "test" });
    assert.deepEqual((await offered()).map((r) => r.remitNumber), ["R-100001"]);
  });

  test("one whose own receipt key is already held is not, though nothing stands for it", async () => {
    await db.insert(schema.cashReceipts).values({
      id: "cash-1",
      month: "2026-09",
      kind: "third_party",
      amountCents: 100,
      payer: "Invented Payer A",
      sourceKey: remitReceiptKey(ROW),
      receivedOn: "2026-09-24",
      reference: null,
      outOfBooks: false,
      createdBy: "test",
    });
    assert.deepEqual(await offered(), []);
  });
});
