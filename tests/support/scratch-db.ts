import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

/**
 * A database of its own for a test that needs one.
 *
 * A handful of these tests exercise the store rather than a pure function, because that is where
 * the bug they pin actually lived — the shape was right and the key was wrong, which no pure test
 * would have caught. They were reading whatever database happened to be on the machine, so they
 * passed for whoever had run the migrator and failed for everyone else, continuous integration
 * included. Seven tests red on every run teaches people to ignore the red, which costs more than
 * the tests are worth.
 *
 * So each takes a scratch file, migrated from the same folder the real database is, and removes it
 * afterwards. `DATABASE_PATH` is read when `src/db` is first imported, so this has to run before
 * that import — every caller uses a dynamic import inside the hook for exactly that reason.
 */
export async function useScratchDb(): Promise<() => void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmacy-admin-test-"));
  const file = path.join(dir, "test.db");
  process.env.DATABASE_PATH = file;

  const client = createClient({ url: `file:${file}` });
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  client.close();

  return () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A scratch file that will not delete is not worth failing a test over.
    }
  };
}
