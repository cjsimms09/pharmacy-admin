import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sql } from "drizzle-orm";

const FILE = "drizzle/0143_wwfp_policies_2026.sql";

describe("the migration that takes WWFP's dress code and attendance point policies into the manual", () => {
  let cleanup: () => void;
  let db: typeof import("../src/db").db;

  const seed = async (id: string, title: string, managedBy: string | null, retired: string | null, pos: number) =>
    db.run(
      sql`insert into manual_sections (id, source, title, level, position, body, managed_by, retired_on, audited_on, audit_fail_count, audit_error) values (${id}, 'pharmacy', ${title}, 2, ${pos}, 'old wording', ${managedBy}, ${retired}, '2026-09-04', 2, 'it failed')`,
    );
  const row = async (id: string) => (await db.all(sql`select body, audited_on, audit_fail_count, audit_error from manual_sections where id = ${id}`))[0] as {
    body: string;
    audited_on: string | null;
    audit_fail_count: number;
    audit_error: string | null;
  };

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ db } = await import("../src/db"));
    await seed("dress", "Dress Code", "WWFP", null, 1);
    await seed("att", "Attendance Policy", "WWFP", null, 2);
    await seed("pharm-dress", "Dress Code", null, null, 3);
    await seed("old-dress", "Dress Code", "WWFP", "2026-01-01", 4);
    await seed("other", "Employee Conduct and Work Ethic", "WWFP", null, 5);
    for (const stmt of fs.readFileSync(FILE, "utf8").split("--> statement-breakpoint")) await db.run(sql.raw(stmt));
  });
  after(() => cleanup?.());

  test("both sections hold the new policy, and say when and by whom it was entered", async () => {
    assert.match((await row("dress")).body, /^WWFP Dress Code & Personal Appearance Policy, version 08\.2026/);
    assert.match((await row("att")).body, /^WWFP Attendance Point Policy, version 10\.2026/);
    const updatedBy = (await db.all(sql`select updated_by from manual_sections where id = 'att'`))[0] as { updated_by: string };
    assert.match(updatedBy.updated_by, /not yet reviewed/);
  });

  test("a section whose wording changed no longer claims to have been read against the requirements", async () => {
    for (const id of ["dress", "att"]) {
      const r = await row(id);
      assert.equal(r.audited_on, null);
      assert.equal(r.audit_fail_count, 0);
      assert.equal(r.audit_error, null);
    }
  });

  test("only the live sections the practice maintains are touched", async () => {
    for (const id of ["pharm-dress", "old-dress", "other"]) {
      const r = await row(id);
      assert.equal(r.body, "old wording");
      assert.equal(r.audited_on, "2026-09-04");
    }
  });

  test("the pharmacy's own safety requirements are still in the sections, and the rules the points replace are gone", async () => {
    const dress = (await row("dress")).body;
    const att = (await row("att")).body;
    assert.match(dress, /closed-toe shoes with a closed heel/);
    assert.match(dress, /bloodborne pathogens exposure control plan/);
    assert.match(dress, /Pharmacy staff may wear scrubs/);
    assert.match(att, /needlestick/);
    assert.match(att, /compounded preparation/);
    assert.doesNotMatch(att, /job abandonment|voluntary resignation/);
    assert.match(att, /no points are assessed/);
  });

  test("the migration is registered, after the last one, so a launcher that updates will run it", () => {
    const j = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
    const last = j.entries.at(-1)!;
    const prev = j.entries.at(-2)!;
    assert.equal(last.tag, "0143_wwfp_policies_2026");
    assert.ok(last.when > prev.when);
  });
});
