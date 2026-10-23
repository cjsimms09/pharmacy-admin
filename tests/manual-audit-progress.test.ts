import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

describe("what the manual page is told is still to read, and how much of it a press will skip", () => {
  let cleanup: () => void;
  let audit: typeof import("../src/lib/manual-audit");

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    const { db, schema } = await import("../src/db");
    const { todayIso, addDays } = await import("../src/lib/dates");
    const today = todayIso();
    const section = (id: string, over: Partial<typeof schema.manualSections.$inferInsert>) =>
      db.insert(schema.manualSections).values({ id, title: `Section ${id}`, position: Number(id.slice(1)) * 100, level: 2, ...over });

    await section("s1", {});
    await section("s2", { auditFailCount: 3, auditFailedOn: today, auditError: "The reading did not come back." });
    await section("s3", { auditedOn: addDays(today, -10) });
    await section("s4", { auditedOn: addDays(today, -400), auditFailCount: 4, auditFailedOn: today, auditError: "The reading did not come back." });
    await section("s5", { auditedOn: addDays(today, -1), auditFailCount: 3 });
    await section("s6", { auditFailCount: 1, auditFailedOn: today, auditError: "The reading did not come back." });
    await section("s7", { managedBy: "the practice", auditFailCount: 3 });
    await section("s8", { source: "site", auditFailCount: 3 });
    await section("s9", { retiredOn: today, auditFailCount: 3 });
    audit = await import("../src/lib/manual-audit");
  });
  after(() => cleanup?.());

  test("a section is skipped from its third failure on, and a missing count is no failures", () => {
    assert.equal(audit.MAX_AUDIT_ATTEMPTS, 3);
    for (const n of [null, undefined, 0, 1, 2]) assert.equal(audit.isParked(n), false, `${n} failures`);
    for (const n of [3, 4, 9]) assert.equal(audit.isParked(n), true, `${n} failures`);
  });

  test("parked counts only the pharmacy's own sections that are due and have failed three times", async () => {
    const p = await audit.auditProgress();
    assert.deepEqual({ total: p.total, current: p.current, due: p.due, parked: p.parked }, { total: 6, current: 2, due: 4, parked: 2 });
  });

  test("a press tries the due sections that have not failed three times, and never a current one", async () => {
    const ids = async (opts?: { includeParked?: boolean }) => (await audit.due(9999, opts)).map((r) => r.id).sort();
    assert.deepEqual(await ids(), ["s1", "s6"], "never tried, and failed once");
    assert.deepEqual(await ids({ includeParked: true }), ["s1", "s2", "s4", "s6"], "s5 was read yesterday, so it is not due however often it failed before");
  });

  test("the list of failures marks the same two as parked", async () => {
    const f = await audit.auditFailures();
    assert.deepEqual(
      f.map((x) => `${x.title}: ${x.attempts} ${x.parked ? "parked" : "not parked"}`).sort(),
      ["Section s2: 3 parked", "Section s4: 4 parked", "Section s6: 1 not parked"],
    );
  });
});
