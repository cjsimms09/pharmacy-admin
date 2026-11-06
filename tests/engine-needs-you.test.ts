import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * The three rules of the list, on a scratch database: a stable id is one row across passes; a line a person
 * answered never returns; a line the data settles resolves itself and reopens if its source produces it again.
 */
let writeNeedsYou: typeof import("../src/lib/engine/needs-you").writeNeedsYou;
let resolveByAnswer: typeof import("../src/lib/engine/needs-you").resolveByAnswer;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanup: () => void;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ writeNeedsYou, resolveByAnswer } = await import("../src/lib/engine/needs-you"));
  ({ db, schema } = await import("../src/db"));
});
after(() => cleanup());

const line = (id: string, amount: number) => ({ id, kind: "bank_line", rank: 4 as const, title: id, amountCents: amount, answers: [{ label: "x", action: "noted" }] });

describe("the list keeps its three rules", () => {
  test("one row per id across passes; a line that stops being produced resolves itself; it reopens when produced again", async () => {
    let r = await writeNeedsYou([line("bank_line|1", -100), line("bank_line|2", -200)], "2026-10-01T06:00:00.000Z");
    assert.deepEqual([r.opened, r.kept, r.resolved], [2, 0, 0]);
    r = await writeNeedsYou([line("bank_line|1", -100)], "2026-10-01T07:00:00.000Z");
    assert.deepEqual([r.opened, r.kept, r.resolved], [0, 1, 1]);
    const two = await db.query.needsYou.findFirst({ where: (t, { eq }) => eq(t.id, "bank_line|2") });
    assert.equal(two?.resolvedBy, "data");
    r = await writeNeedsYou([line("bank_line|1", -100), line("bank_line|2", -200)], "2026-10-01T08:00:00.000Z");
    assert.deepEqual([r.opened, r.kept, r.resolved], [1, 1, 0]);
    const again = await db.query.needsYou.findFirst({ where: (t, { eq }) => eq(t.id, "bank_line|2") });
    assert.equal(again?.resolvedAt, null);
    assert.equal(again?.firstSeen, "2026-10-01T06:00:00.000Z");
  });

  test("a line a person answered never returns, even while its source still produces it", async () => {
    await resolveByAnswer("bank_line|1", "2026-10-01T09:00:00.000Z");
    const r = await writeNeedsYou([line("bank_line|1", -100), line("bank_line|2", -200)], "2026-10-01T10:00:00.000Z");
    assert.equal(r.suppressed, 1);
    const open = await db.query.needsYou.findMany({ where: (t, { isNull }) => isNull(t.resolvedAt) });
    assert.deepEqual(open.map((o) => o.id), ["bank_line|2"]);
    assert.equal(schema.needsYou !== undefined, true);
  });
});
