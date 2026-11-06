import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

describe("a morning-list check that throws says so instead of leaving no row", () => {
  let cleanup: () => void;
  let alerts: typeof import("../src/lib/alerts").alerts;
  let setSetting: typeof import("../src/lib/settings").setSetting;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ alerts } = await import("../src/lib/alerts"));
    ({ setSetting } = await import("../src/lib/settings"));
  });
  after(() => cleanup?.());

  test("on a database with nothing in it no check reports that it could not run", async () => {
    const keys = (await alerts()).map((a) => a.key).filter((k) => k.startsWith("check-failed-"));
    assert.deepEqual(keys, []);
  });

  test("a register reading the site cannot parse shows as a check that could not run, with a link to look at it", async () => {
    await setSetting("pioneer_register_check", "{this is not json");
    const row = (await alerts()).find((a) => a.key === "check-failed-card-batches");
    assert.ok(row, "the failed check has a row");
    assert.equal(row.level, "soon");
    assert.match(row.title, /could not be checked/);
    assert.match(row.why, /does not mean it is clear/);
    assert.equal(row.href, "/money");
  });

  test("no check in the file swallows its error silently any more", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/alerts.ts", "utf8");
    assert.equal(/catch(\s*\(e\))?\s*\{\s*(\/\*[^]*?\*\/|\/\/[^\n]*\n)?\s*(void e;)?\s*\}/.test(src), false);
  });
});
