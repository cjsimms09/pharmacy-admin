/* Applies pending migrations from ./drizzle to the SQLite database. */
import "dotenv/config";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const client = createClient({ url: `file:${dbPath}` });

async function main() {
  await client.execute("PRAGMA journal_mode = WAL");
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log(`Database ready at ${dbPath}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
