/**
 * The test suite, run against a database of its own.
 *
 * `npm test` used to run with whatever `DATABASE_PATH` said, and on the pharmacy computer that is the
 * live database. Measured on 15 September 2026: 72 audit events written by "the test suite" into the
 * real audit log since the 12th, 64 of them in one day. Each is harmless as a row, and each one moved
 * the fingerprint every held reading is keyed on (`src/lib/held.ts`), so every test run emptied the
 * site's caches and the owner's next page paid for all of them again — nineteen seconds for money
 * found alone. A test has no business writing where the books are kept, whatever it writes.
 *
 * All 3,402 tests passed against a freshly migrated empty database, so none depends on real data.
 * This migrates one in a temporary folder, runs the suite against it and removes it. Arguments are
 * passed through, so `npm test -- tests/held-stale.test.ts` still runs one file.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmacy-admin-suite-"));
const env = { ...process.env, DATABASE_PATH: path.join(dir, "suite.db") };
const tsx = path.join("node_modules", "tsx", "dist", "cli.mjs");

let status = 1;
try {
  const migrated = spawnSync(process.execPath, [tsx, "scripts/migrate.ts"], { env, stdio: "inherit" });
  if (migrated.status !== 0) throw new Error("the scratch database would not migrate");
  const files = process.argv.slice(2);
  const run = spawnSync(
    process.execPath,
    [tsx, "--tsconfig", "tsconfig.test.json", "--test", "--test-concurrency=4", ...(files.length ? files : ["tests/*.test.ts"])],
    { env, stdio: "inherit" },
  );
  status = run.status ?? 1;
} catch (e) {
  console.error(String(e));
} finally {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(status);
