import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

describe("the rebate put against a month until the wholesaler's statement is entered", () => {
  let cleanup: () => void;
  let rebateFromLastPayments: typeof import("../src/lib/profit-and-loss").rebateFromLastPayments;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ rebateFromLastPayments } = await import("../src/lib/profit-and-loss"));
  });
  after(() => cleanup?.());

  test("with nothing ever paid there is no estimate from payments, so the ladder stands", async () => {
    assert.equal(await rebateFromLastPayments("2026-09", "2026-10-09"), null);
  });

  test("it is the average of the last two months the wholesaler paid, and says so", async () => {
    const { db, schema } = await import("../src/db");
    const { newId } = await import("../src/lib/crypto");
    const put = (month: string, kind: "rebate" | "patient", amountCents: number) =>
      db.insert(schema.cashReceipts).values({ id: newId(), month, kind, amountCents, createdBy: "test" });
    await put("2026-07", "rebate", 500_000);
    await put("2026-08", "rebate", 970_652);
    await put("2026-09", "rebate", 1_069_724);
    await put("2026-09", "patient", 99_999_999);
    const r = await rebateFromLastPayments("2026-09", "2026-10-09");
    assert.ok(r);
    assert.equal(r.cents, Math.round((970_652 + 1_069_724) / 2));
    assert.match(r.note, /last paid/);
    assert.match(r.note, /\$9,706\.52 in 2026-08/);
    assert.match(r.note, /\$10,697\.24 in 2026-09/);
    assert.doesNotMatch(r.note, /spread by the day/);
  });

  test("the month still open gets only the days gone, not the whole month's rebate", async () => {
    const r = await rebateFromLastPayments("2026-10", "2026-10-09");
    assert.ok(r);
    assert.equal(r.cents, Math.round((((970_652 + 1_069_724) / 2) * 9) / 31));
    assert.match(r.note, /spread by the day \(9 of 31\)/);
  });

  test("a month before the later payment does not use it", async () => {
    const r = await rebateFromLastPayments("2026-08", "2026-10-09");
    assert.ok(r);
    assert.equal(r.cents, Math.round((500_000 + 970_652) / 2));
  });
});
