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

type Entry = { idx: number; when: number; tag: string };

/**
 * The check that has to happen before a migration runs, because the failure it catches is silent.
 *
 * Two sessions build this app on two branches, and each generates its own migrations. Drizzle does
 * not decide what to apply by name or by number: it records the timestamp of the last migration it
 * ran, and applies only those stamped later than it. So a migration that arrives in a merge with a
 * timestamp *earlier* than one already applied is not applied and never will be — no error, no
 * warning, just a table that does not exist and a page that returns a 500 the first time somebody
 * opens it. That is a worse failure than a crash on start-up, and it happened once already with
 * `supplier_item_fixes`.
 *
 * Both branches reaching for the number 0077 is what makes it likely. Renaming the file does not
 * fix it — the timestamp inside the journal decides — so the rule when two migrations collide is:
 * renumber the one that has NOT been applied on the pharmacy computer, and give it a `when` later
 * than everything already there.
 *
 * This refuses to run rather than let a merge quietly lose a table.
 */
function checkJournal(): void {
  const file = path.resolve("./drizzle/meta/_journal.json");
  let entries: Entry[];
  try {
    entries = (JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Entry[] }).entries;
  } catch {
    return; // No journal yet: nothing to be out of order.
  }

  const seenIdx = new Map<number, string>();
  const seenTag = new Set<string>();
  for (const e of entries) {
    const already = seenIdx.get(e.idx);
    if (already) {
      throw new Error(
        `Two migrations both numbered ${e.idx}: "${already}" and "${e.tag}". A merge brought in a migration ` +
          `number that was already used. Renumber the one that has not been applied on the pharmacy computer, ` +
          `and give it a "when" later than every other entry in drizzle/meta/_journal.json.`,
      );
    }
    seenIdx.set(e.idx, e.tag);
    if (seenTag.has(e.tag)) throw new Error(`The migration "${e.tag}" appears twice in drizzle/meta/_journal.json.`);
    seenTag.add(e.tag);
  }

  const ordered = [...entries].sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.when <= prev.when) {
      throw new Error(
        `Migration "${cur.tag}" is stamped ${new Date(cur.when).toISOString()}, which is not after ` +
          `"${prev.tag}" at ${new Date(prev.when).toISOString()}. Drizzle applies migrations by that stamp and ` +
          `nothing else, so this one would be treated as already run and its tables would never be created — ` +
          `with no error at the time, and a 500 on the page that needs them. Raise the "when" of "${cur.tag}" ` +
          `in drizzle/meta/_journal.json above ${prev.when} and run this again.`,
      );
    }
  }
}

async function main() {
  checkJournal();
  await client.execute("PRAGMA journal_mode = WAL");
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log(`Database ready at ${dbPath}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
