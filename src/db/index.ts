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
