import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { duplicatesToRemove, type DocumentRow } from "../src/lib/duplicate-documents";

const doc = (over: Partial<DocumentRow> & { id: string }): DocumentRow => ({
  category: "invoice",
  sha256: "aaa",
  storageKey: `2026/${over.id}`,
  ...over,
});

/**
 * The sweep filed the same attachment 599 times behind 64 actual files, one of them twenty-eight
 * times over. The archive was never wrong — every invoice has its document — but the Schedule II
 * drawer held twenty times as many records as invoices, and an inspector counting them asks why.
 *
 * This deletes from the archive a DEA inspection reads, so every test here is about what it refuses.
 */
describe("what may be removed", () => {
  test("a copy nothing points at, whose bytes are kept against an invoice", () => {
    const plan = duplicatesToRemove(
      [doc({ id: "kept" }), doc({ id: "copy" })],
      new Set(["kept"]),
      new Set(["kept"]),
    );
    assert.deepEqual(plan.remove.map((r) => r.id), ["copy"]);
    assert.equal(plan.remove[0]?.keptId, "kept", "it names the copy that survives");
  });

  test("twenty-seven copies go and the twenty-eighth stays", () => {
    const rows = [doc({ id: "kept" }), ...Array.from({ length: 27 }, (_, i) => doc({ id: `copy${i}` }))];
    const plan = duplicatesToRemove(rows, new Set(["kept"]), new Set(["kept"]));
    assert.equal(plan.remove.length, 27);
    assert.ok(!plan.remove.some((r) => r.id === "kept"));
  });
});

describe("what it refuses, which is the whole of its value", () => {
  test("the only copy of a document is never removed", () => {
    /* No invoice points at these bytes, so this may be the only record of that delivery. */
    const plan = duplicatesToRemove([doc({ id: "lonely" })], new Set(), new Set());
    assert.deepEqual(plan.remove, []);
    assert.ok(plan.keptBecause.some((k) => /only one/.test(k.reason)));
  });

  test("a copy something points at is kept, even with its bytes held elsewhere", () => {
    const plan = duplicatesToRemove(
      [doc({ id: "kept" }), doc({ id: "cited" })],
      new Set(["kept", "cited"]),
      new Set(["kept"]),
    );
    assert.deepEqual(plan.remove, []);
  });

  test("a row sharing its file with another row is kept, or the kept row loses its document", () => {
    const plan = duplicatesToRemove(
      [doc({ id: "kept", storageKey: "2026/shared" }), doc({ id: "copy", storageKey: "2026/shared" })],
      new Set(["kept"]),
      new Set(["kept"]),
    );
    assert.deepEqual(plan.remove, []);
    assert.ok(plan.keptBecause.some((k) => /shares its file/.test(k.reason)));
  });

  test("a row with no content hash is kept, because nothing can prove another copy is identical", () => {
    const plan = duplicatesToRemove([doc({ id: "kept" }), doc({ id: "unhashed", sha256: null })], new Set(["kept"]), new Set(["kept"]));
    assert.deepEqual(plan.remove, []);
  });

  test("nothing outside the invoice drawers is touched at all", () => {
    /* A rule that ranges wider than its evidence is how a clean-up becomes an incident. */
    const plan = duplicatesToRemove(
      [doc({ id: "kept" }), doc({ id: "report", category: "report" }), doc({ id: "licence", category: "license" })],
      new Set(["kept"]),
      new Set(["kept"]),
    );
    assert.deepEqual(plan.remove, []);
  });

  test("Schedule II copies are removable on the same terms and no looser ones", () => {
    const rows = [doc({ id: "kept", category: "invoice_schedule_2" }), doc({ id: "copy", category: "invoice_schedule_2" })];
    const plan = duplicatesToRemove(rows, new Set(["kept"]), new Set(["kept"]));
    assert.deepEqual(plan.remove.map((r) => r.id), ["copy"]);
    /* And the only copy of a Schedule II document is refused exactly as any other only copy is. */
    assert.deepEqual(duplicatesToRemove([doc({ id: "solo", category: "invoice_schedule_2" })], new Set(), new Set()).remove, []);
  });
});
