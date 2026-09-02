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
  const client = createClient({ url: `file:${path.resolve(dbPath)}` });
  void client.execute("PRAGMA journal_mode = WAL");
  void client.execute("PRAGMA foreign_keys = ON");
  void client.execute("PRAGMA busy_timeout = 5000");
  return drizzle(client, { schema });
}

export const db = globalThis.__pharmacyDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalThis.__pharmacyDb = db;

export { schema };
