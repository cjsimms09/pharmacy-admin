import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

// SQLite via libsql: ships prebuilt binaries for Windows/macOS/Linux, so nothing compiles on install.
// Migrations are applied by `npm run db:migrate` (run automatically by `npm start` and `npm run dev`).
const dbPath = process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db";

declare global {
  // eslint-disable-next-line no-var
  var __pharmacyDb: ReturnType<typeof createDb> | undefined;
}

function createDb() {
  /*
   * A test must never open the live database.
   *
   * On 6 November 2026 a test file run directly (`tsx --test tests/on-hand.test.ts`, with no DATABASE_PATH) filed two invented counts into the
   * real database, and the retention rule that runs on every filing deleted five real daily shelf counts. They were restored from the stored
   * files the same hour. `npm test` has always run against a copy (scripts/test.mjs); the way round it was just to run a file by hand. The
   * node test runner marks every test process, so a test process that resolves to the live file stops here instead of writing to it.
   */
  if (process.env.NODE_TEST_CONTEXT && !process.env.PHARMACY_ALLOW_LIVE_TEST && path.resolve(dbPath) === path.resolve("./data/pharmacy-admin.db")) {
    throw new Error(
      "A test tried to open the live database (./data/pharmacy-admin.db) and was stopped. Run tests with `npm test -- <file>`, which migrates a copy of its own, or point DATABASE_PATH at a scratch file.",
    );
  }
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  // One connection, queries serialized: this is a single-pharmacy app and a single connection
  // means the PRAGMAs below apply to every query and SQLITE_BUSY cannot occur within the process.
  const client = createClient({ url: `file:${path.resolve(dbPath)}`, concurrency: 1 });
  const ready = (async () => {
    await client.execute("PRAGMA busy_timeout = 15000");
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA foreign_keys = ON");
    // Safe in WAL: a crash can lose the last commits but cannot corrupt the database, and this
    // is the difference between a bulk load taking seconds and taking minutes. The backup is
    // what protects against loss, not fsync on every write.
    await client.execute("PRAGMA synchronous = NORMAL");
    await client.execute("PRAGMA temp_store = MEMORY");
    // ~64 MB of page cache. Trivial on any machine this runs on, and it keeps the working set
    // in memory instead of going back to disk for every compliance query.
    await client.execute("PRAGMA cache_size = -64000");
  })();
  return { db: drizzle(client, { schema }), ready };
}

const instance = globalThis.__pharmacyDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalThis.__pharmacyDb = instance;

export const db = instance.db;
/** Resolves once connection PRAGMAs are applied. Awaited by auth on every request. */
export const dbReady = instance.ready;

export { schema };
