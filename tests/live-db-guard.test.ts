import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

/*
 * A test process that resolves to the live database is stopped before it can write to it. Pinned by running a child that looks like a
 * test process (the node test runner's marker) with no DATABASE_PATH, which is exactly how a file run by hand reaches the live file.
 */
describe("the live database cannot be opened by a test", () => {
  const tsx = path.join("node_modules", "tsx", "dist", "cli.mjs");
  const run = (env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [tsx, "--tsconfig", "tsconfig.test.json", path.join("tests", "support", "open-db.ts")], {
      env: { ...process.env, DATABASE_PATH: undefined, ...env } as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });

  test("with no DATABASE_PATH and the test marker, it throws and names the way to run tests", () => {
    const r = run({ NODE_TEST_CONTEXT: "child-v8" });
    assert.match(r.stdout, /STOPPED: A test tried to open the live database/);
    assert.doesNotMatch(r.stdout, /OPENED/);
  });

  test("with a scratch DATABASE_PATH it opens as before", () => {
    const r = run({ NODE_TEST_CONTEXT: "child-v8", DATABASE_PATH: path.join(process.env.TEMP ?? ".", "guard-scratch-" + process.pid + ".db") });
    assert.match(r.stdout, /OPENED/);
  });

  test("outside a test process it opens as before (the site itself)", () => {
    const r = run({ NODE_TEST_CONTEXT: undefined, DATABASE_PATH: path.join(process.env.TEMP ?? ".", "guard-scratch2-" + process.pid + ".db") });
    assert.match(r.stdout, /OPENED/);
  });
});
