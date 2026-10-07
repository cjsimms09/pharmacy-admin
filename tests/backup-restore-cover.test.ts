import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

/*
 * Which quarters a restore rehearsal covers, read through openItems() itself. The register used to read the one setting every success
 * overwrites, so pressing the test in October turned September — covered by the test done in September — into a period that "went by
 * without being covered", on a card nothing could close. The failure was in the store, not in any pure function. Every date and message is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let openItems: typeof import("../src/lib/compliance-status").openItems;
let restoreRehearsalDates: typeof import("../src/lib/backup").restoreRehearsalDates;
let setSetting: typeof import("../src/lib/settings").setSetting;
let newId: typeof import("../src/lib/crypto").newId;
let cleanup: () => void;

const PROVED = "Restore rehearsed from pharmacy-admin-backup-test.zip: 10 tables, 100 rows and 2 uploaded files came back intact.";
const FAILED = "The newest backup (pharmacy-admin-backup-test.zip) could NOT be restored: the file is damaged. Treat the pharmacy as having no working backup until this is fixed.";
const NO_FOLDER = "The backup folder D:\Backups could not be read. There may be no backups at all.";
const NO_ARCHIVE = "No backup archive was found in D:\Backups.";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ openItems } = await import("../src/lib/compliance-status"));
  ({ restoreRehearsalDates } = await import("../src/lib/backup"));
  ({ setSetting } = await import("../src/lib/settings"));
  ({ newId } = await import("../src/lib/crypto"));
  const { ensureObligations } = await import("../src/lib/obligations");
  await ensureObligations();
  // The register counts from the earliest obligation, so the scratch one has to begin before the quarter under test.
  await db.update(schema.obligations).set({ createdAt: "2026-09-03T12:00:00.000Z" });
  await db.update(schema.obligations).set({ needsConfirmation: false, confirmedOn: null }).where(eq(schema.obligations.seedKey, "backup_restore_test"));
});
after(() => cleanup());

beforeEach(async () => {
  await db.delete(schema.auditEvents).where(eq(schema.auditEvents.action, "backup.rehearse"));
  await db.delete(schema.settings).where(eq(schema.settings.key, "backup_restore_last"));
});

const rehearsal = (at: string, details: string, userName = "the test") =>
  db.insert(schema.auditEvents).values({ id: newId(), at, action: "backup.rehearse", userName, details });
const backupItems = async () => (await openItems()).filter((i) => i.seedKey === "backup_restore_test");
const periods = async () => (await backupItems()).map((i) => `${i.periodKey} ${i.state}`);

describe("the quarters a restore rehearsal covers", () => {
  test("a test done in October does not take September's cover away", async () => {
    await rehearsal("2026-09-04T21:30:00.000Z", PROVED);
    await setSetting("backup_restore_last", "2026-10-06T22:22:38.000Z");
    assert.deepEqual((await periods()).filter((p) => p.startsWith("2026-Q3") || p.startsWith("2026-Q4")), []);
  });

  test("an October test alone leaves September a gap, which is what makes the case above mean something", async () => {
    await setSetting("backup_restore_last", "2026-10-06T22:22:38.000Z");
    const found = await periods();
    assert.ok(found.includes("2026-Q3 missed"), `September should read as a gap; got ${JSON.stringify(found)}`);
    assert.ok(!found.some((p) => p.startsWith("2026-Q4")), "October's own test covers October");
  });

  test("a rehearsal that failed, or found nothing to rehearse, covers nothing", async () => {
    await rehearsal("2026-09-04T21:30:00.000Z", FAILED);
    await rehearsal("2026-09-05T21:30:00.000Z", NO_FOLDER);
    await rehearsal("2026-09-06T21:30:00.000Z", NO_ARCHIVE);
    assert.deepEqual(await restoreRehearsalDates(), []);
    assert.ok((await periods()).includes("2026-Q3 missed"));
  });

  test("an automatic rehearsal counts the same, and the dates come back oldest first", async () => {
    await rehearsal("2026-10-05T10:00:00.000Z", PROVED, "Automatic check");
    await rehearsal("2026-09-04T21:30:00.000Z", PROVED);
    await setSetting("backup_restore_last", "2026-10-05T10:00:00.000Z");
    assert.deepEqual(await restoreRehearsalDates(), ["2026-09-04T21:30:00.000Z", "2026-10-05T10:00:00.000Z"]);
    assert.deepEqual((await periods()).filter((p) => p.startsWith("2026-Q3") || p.startsWith("2026-Q4")), []);
  });

  test("one press is one date: its slot and its audit row, written a moment apart, are not two tests", async () => {
    await rehearsal("2026-10-06T22:22:39.412Z", PROVED);
    await setSetting("backup_restore_last", "2026-10-06T22:22:38.038Z");
    assert.deepEqual(await restoreRehearsalDates(), ["2026-10-06T22:22:39.412Z"]);
  });

  test("a slot with no audit row near it still counts, and one far from the trail is its own date", async () => {
    await setSetting("backup_restore_last", "2026-08-20T15:00:00.000Z");
    assert.deepEqual(await restoreRehearsalDates(), ["2026-08-20T15:00:00.000Z"]);
    await rehearsal("2026-08-20T15:10:00.000Z", PROVED);
    assert.deepEqual(await restoreRehearsalDates(), ["2026-08-20T15:00:00.000Z", "2026-08-20T15:10:00.000Z"]);
  });
});
