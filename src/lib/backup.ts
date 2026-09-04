import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createClient } from "@libsql/client";
import { db, schema } from "@/db";
import { createZip } from "./zip";
import { unzip } from "./xlsx";
import { sha256 } from "./crypto";
import { getSettings, setSetting } from "./settings";

/**
 * Backups.
 *
 * Everything else in this application is worthless if the machine it runs on dies, so this is
 * held to a different standard than the rest. Four rules shape it.
 *
 * A backup is not a backup until it has been read back. Copying a file that is being written to
 * produces an archive that looks fine and restores to nothing, so the database is copied with
 * SQLite's own VACUUM INTO — which takes a consistent snapshot of a live database — and the
 * finished archive is then re-opened, its tables counted, and the counts compared against the
 * source. An archive that fails that check is deleted rather than kept, because a bad backup
 * sitting next to good ones is worse than no backup: it is the one you will reach for.
 *
 * A backup on the same disk dies with the disk. The destination is a folder the pharmacy
 * chooses, and the page says plainly that a folder on the same machine is not enough.
 *
 * A backup readable only by this application is a hostage. The archive is an ordinary ZIP
 * containing an ordinary SQLite file, both openable by anything.
 *
 * And the encryption key is deliberately NOT in the archive. If it were, the backup would carry
 * both the locked box and its key, and every copy of it — on a USB stick, in a cloud folder —
 * would be a complete set of credentials. It is shown once, on screen, to be written down and
 * kept somewhere else.
 */

const dataDir = () => path.dirname(path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
const dbPath = () => path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db");
const filesDir = () => path.join(dataDir(), "files");

/** One further copy of a verified archive, and how it went. */
export type ExtraCopy = { destination: string; path: string | null; error: string | null };

export type BackupResult = {
  ok: boolean;
  file: string;
  /**
   * The further copies, one per extra destination.
   *
   * Three of them rather than two now, and a list rather than a pair, because the rule worth
   * following here is the old one: three copies, on two kinds of media, one of them off the
   * premises. A USB drive in a drawer and a synced cloud folder are two different failure modes,
   * and neither of them is the pharmacy computer.
   */
  copies: ExtraCopy[];
  /** The first extra copy, kept for the screens that only ever showed one. */
  copy: string | null;
  copyError: string | null;
  sizeBytes: number;
  documents: number;
  tables: number;
  rows: number;
  verified: boolean;
  message: string;
};

/** Every file under a directory, as archive-relative paths. */
async function walk(dir: string, base = dir): Promise<{ name: string; full: string }[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; full: string }[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push({ name: path.relative(base, full).split(path.sep).join("/"), full });
  }
  return out;
}

/** Row counts per table, which is what verification compares. */
/**
 * Deleting a scratch file, on an operating system that may not let you yet.
 *
 * Windows refuses to unlink a file while any handle to it is open, and closing a SQLite
 * connection does not always release the handle in the same tick. On Linux the unlink simply
 * succeeds, which is why this never showed up here and showed up immediately on the pharmacy's
 * own computer: every backup it took reported
 *
 *   EBUSY: resource busy or locked, unlink '...\Temp\pa-verify-....db'
 *
 * A few short retries clear it. If they do not, the file is left in the temporary folder for the
 * operating system to clean up, which is a housekeeping problem and nothing more.
 */
async function removeQuietly(file: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(file, { force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

async function tableCounts(url: string): Promise<Record<string, number>> {
  const c = createClient({ url });
  try {
    const t = await c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'");
    const out: Record<string, number> = {};
    for (const row of t.rows) {
      const name = String(row.name);
      const n = await c.execute(`select count(*) as n from "${name}"`);
      out[name] = Number(n.rows[0].n);
    }
    return out;
  } finally {
    c.close();
  }
}

/**
 * Takes a backup and proves it before returning.
 *
 * The database snapshot goes through VACUUM INTO rather than a file copy: the app may be
 * mid-write, and a copied SQLite file caught mid-transaction restores to a corrupt database that
 * gives no warning until the day it is needed.
 */
export async function runBackup(destination: string, extras: (string | null | undefined)[] = []): Promise<BackupResult> {
  /*
   * A backup that never started is the one nobody hears about.
   *
   * Everything below records its own outcome once it has written something. What it could not
   * record was the failure before that point — an unplugged stick, a network share that is not
   * mounted, a folder that was renamed — because the throw went straight past the recording and
   * into a background job that swallows it. The result was a pharmacy told nothing at all, which
   * is the worst of the three possible states to be in.
   *
   * So the reason is written down before the error is re-thrown, and the date of the failure with
   * it: the dashboard compares that against the last success, and says so on the front page.
   */
  try {
    return await takeBackup(destination, extras);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await setSetting("backup_last_result", `Backup could not be taken: ${why}`);
    await setSetting("backup_last_failure", new Date().toISOString());
    throw e;
  }
}

async function takeBackup(destination: string, extras: (string | null | undefined)[]): Promise<BackupResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `pharmacy-admin-backup-${stamp}.zip`;
  const dest = path.resolve(destination);
  await fs.mkdir(dest, { recursive: true });

  const tmp = path.join(os.tmpdir(), `pa-snapshot-${stamp}.db`);
  await removeQuietly(tmp);

  const live = createClient({ url: `file:${dbPath()}` });
  try {
    // SQLite's own consistent snapshot of a database that may be being written to.
    await live.execute(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }

  const sourceCounts = await tableCounts(`file:${dbPath()}`);
  const snapshot = await fs.readFile(tmp);

  const docs = await walk(filesDir());
  const files: { name: string; data: Buffer }[] = [
    { name: "pharmacy-admin.db", data: snapshot },
  ];
  for (const d of docs) files.push({ name: `files/${d.name}`, data: await fs.readFile(d.full) });

  const manifest = {
    takenAt: new Date().toISOString(),
    application: "Pharmacy Admin Desk",
    databaseSha256: sha256(snapshot),
    documents: docs.length,
    tables: Object.keys(sourceCounts).length,
    rows: Object.values(sourceCounts).reduce((a, b) => a + b, 0),
    counts: sourceCounts,
    restore:
      "This is an ordinary ZIP file. To restore: stop the application, replace data/pharmacy-admin.db " +
      "with pharmacy-admin.db from this archive, replace the data/files folder with the files folder " +
      "from this archive, then start the application. The APP_ENCRYPTION_KEY from the .env file is NOT " +
      "in this archive and must be restored separately, or the stored API keys and mail password will " +
      "not be readable.",
  };
  files.push({ name: "MANIFEST.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  files.push({ name: "HOW-TO-RESTORE.txt", data: Buffer.from(restoreInstructions(manifest)) });

  const archive = createZip(files);
  const outPath = path.join(dest, fileName);
  await fs.writeFile(outPath, archive);

  // ── Verify ──────────────────────────────────────────────────────
  // Read the archive back off disk — not the buffer still in memory, which would prove nothing
  // about what was actually written — open the database inside it, and compare the counts.
  let verified = false;
  let message = "";
  const check = path.join(os.tmpdir(), `pa-verify-${stamp}.db`);
  try {
    const readBack = unzip(await fs.readFile(outPath));
    const inner = readBack.get("pharmacy-admin.db");
    if (!inner) throw new Error("the database is not in the archive");
    if (sha256(inner) !== manifest.databaseSha256) throw new Error("the database in the archive does not match what was snapshotted");
    await fs.writeFile(check, inner);
    const restored = await tableCounts(`file:${check}`);

    const differences = Object.entries(sourceCounts).filter(([t, n]) => restored[t] !== n);
    if (differences.length > 0) throw new Error(`row counts differ on ${differences.map(([t]) => t).join(", ")}`);

    const missingDocs = docs.filter((d) => !readBack.has(`files/${d.name}`));
    if (missingDocs.length > 0) throw new Error(`${missingDocs.length} uploaded file(s) missing from the archive`);

    verified = true;
    message = `Backed up and verified: ${manifest.tables} tables, ${manifest.rows.toLocaleString()} rows, ${docs.length} uploaded file${docs.length === 1 ? "" : "s"}.`;
  } catch (e) {
    // A backup that cannot be read back is deleted. One that sits alongside good ones is worse
    // than none, because it is the one that gets reached for.
    await fs.rm(outPath, { force: true });
    message = `Backup failed verification and was deleted: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    /*
     * Cleanup may never fail the backup.
     *
     * These two lines threw on Windows, and because they are in a finally the throw replaced a
     * completed, verified backup with an error — so the pharmacy had eighteen good archives on
     * disk, every run reporting failure, and a dashboard saying no backup had ever been taken.
     * A scratch file that will not delete is housekeeping. It is not a reason to disown work that
     * has already been done and proved.
     */
    await removeQuietly(tmp);
    await removeQuietly(check);
  }

  // ── The further copies ──────────────────────────────────────────
  /*
   * Only ever copies of an archive that has already passed verification. Copying an unverified one
   * would put the same bad file in three places, which is not three backups.
   *
   * Each is written and then read back off its own disk. A network share, a USB stick or a sync
   * folder can accept a write and keep none of it, and finding that out on the day you need it is
   * the whole failure this exists to prevent. One failing does not stop the others: a USB drive
   * that is unplugged should not cost you the copy that went to the cloud.
   */
  const copies: ExtraCopy[] = [];
  const seen = new Set([dest.toLowerCase()]);
  if (verified) {
    for (const raw of extras) {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) continue;
      const where = path.resolve(trimmed);
      const entry: ExtraCopy = { destination: where, path: null, error: null };
      try {
        if (seen.has(where.toLowerCase())) throw new Error("it is the same folder as another copy");
        seen.add(where.toLowerCase());
        await fs.mkdir(where, { recursive: true });
        const target = path.join(where, fileName);
        await fs.writeFile(target, archive);
        const back = unzip(await fs.readFile(target));
        const inner2 = back.get("pharmacy-admin.db");
        if (!inner2 || sha256(inner2) !== manifest.databaseSha256) throw new Error("the copy read back does not match");
        entry.path = target;
        message += ` Copied to ${where} and read back.`;
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
        message += ` The copy to ${where} FAILED: ${entry.error}.`;
      }
      copies.push(entry);
    }
    const good = copies.filter((c) => c.path).length + 1;
    if (copies.length > 0) {
      message += ` ${good} copy${good === 1 ? "" : " copies"} of this archive ${good === 1 ? "exists" : "exist"} in total.`;
    }
  }
  const copy = copies.find((c) => c.path)?.path ?? null;
  const copyError = copies.find((c) => c.error)?.error ?? null;

  await setSetting("backup_last_run", new Date().toISOString());
  await setSetting("backup_last_result", message);
  // Cleared only on a run that got this far, so the dashboard stops reporting a failure that has
  // since been fixed — and keeps reporting one that has not.
  if (verified) await setSetting("backup_last_failure", "");

  return {
    ok: verified,
    file: verified ? outPath : "",
    copies,
    copy,
    copyError,
    sizeBytes: archive.length,
    documents: docs.length,
    tables: manifest.tables,
    rows: manifest.rows,
    verified,
    message,
  };
}

function restoreInstructions(m: { takenAt: string; documents: number; rows: number }): string {
  return [
    "RESTORING THIS BACKUP",
    "=====================",
    "",
    `Taken: ${m.takenAt}`,
    `Contains: the full database (${m.rows.toLocaleString()} rows) and ${m.documents} uploaded file(s).`,
    "",
    "This is an ordinary ZIP file. You do not need the Pharmacy Admin application to open it,",
    "and the database inside is an ordinary SQLite file that many free tools can read.",
    "",
    "TO RESTORE",
    "----------",
    "1. Close the Pharmacy Admin application completely.",
    "2. Find the application's data folder. It contains pharmacy-admin.db and a files folder.",
    "3. Rename the existing data folder to data-old, so nothing is lost if the restore is wrong.",
    "4. Create a new empty data folder.",
    "5. From this archive, copy pharmacy-admin.db into it.",
    "6. From this archive, copy the whole files folder into it.",
    "7. Start the application.",
    "",
    "THE ENCRYPTION KEY",
    "------------------",
    "The API keys and mail password stored in the application are encrypted with a key kept in",
    "the .env file, called APP_ENCRYPTION_KEY. That key is deliberately NOT in this archive: if",
    "it were, anyone holding this file would have both the locked box and its key.",
    "",
    "If you are restoring onto the same machine, the key is already in place and nothing more is",
    "needed. If you are restoring onto a new machine, put the saved APP_ENCRYPTION_KEY into the",
    ".env file first. Without it everything still works, but the stored API keys and mail",
    "password have to be entered again.",
    "",
    "WHAT IS IN HERE",
    "---------------",
    "Patient-identifying information is not stored by this application, but the database does",
    "contain staff records, prescription numbers and business information. Treat this file as",
    "confidential.",
  ].join("\n");
}

export type BackupStatus = {
  destination: string;
  destination2: string | null;
  destination3: string | null;
  /** Every place a copy goes, primary first, blanks removed. */
  destinations: string[];
  restoreLast: string | null;
  restoreResult: string | null;
  lastRun: string | null;
  lastResult: string | null;
  enabled: boolean;
  keepCount: number;
  onSameDisk: boolean;
  existing: { name: string; sizeBytes: number; takenAt: string }[];
};

export async function backupStatus(): Promise<BackupStatus> {
  const s = await getSettings();
  const destination = s.backup_destination?.trim() || path.join(dataDir(), "backups");
  let existing: BackupStatus["existing"] = [];
  try {
    const names = (await fs.readdir(destination)).filter((n) => /^pharmacy-admin-backup-.*\.zip$/.test(n)).sort().reverse();
    existing = await Promise.all(
      names.map(async (name) => {
        const st = await fs.stat(path.join(destination, name));
        return { name, sizeBytes: st.size, takenAt: st.mtime.toISOString() };
      }),
    );
  } catch {
    existing = [];
  }
  return {
    destination,
    destination2: s.backup_destination_2?.trim() || null,
    destination3: s.backup_destination_3?.trim() || null,
    destinations: [destination, s.backup_destination_2?.trim() || "", s.backup_destination_3?.trim() || ""].filter(Boolean),
    restoreLast: s.backup_restore_last || null,
    restoreResult: s.backup_restore_result || null,
    lastRun: s.backup_last_run || null,
    lastResult: s.backup_last_result || null,
    // On unless deliberately switched off. A compliance system whose backup is opt-in is a trap:
    // the pharmacy that most needs one is the pharmacy that never found the switch.
    enabled: s.backup_enabled !== "no",
    keepCount: Number(s.backup_keep) || 14,
    // A destination inside the application's own data folder shares the disk it is protecting against.
    onSameDisk: path.resolve(destination).startsWith(path.resolve(dataDir())),
    existing,
  };
}

/** Deletes the oldest archives beyond the number to keep. Never touches anything else. */
export async function pruneBackups(destination: string, keep: number): Promise<number> {
  const names = (await fs.readdir(destination).catch(() => []))
    .filter((n) => /^pharmacy-admin-backup-.*\.zip$/.test(n))
    .sort()
    .reverse();
  const doomed = names.slice(Math.max(1, keep));
  for (const n of doomed) await fs.rm(path.join(destination, n), { force: true });
  return doomed.length;
}

/** The key that must be kept somewhere other than the backup. */
export function encryptionKey(): string | null {
  const raw = process.env.APP_ENCRYPTION_KEY;
  return raw && !raw.startsWith("EXAMPLE") ? raw : null;
}

export type RestoreRehearsal = {
  ok: boolean;
  archive: string | null;
  takenAt: string | null;
  tables: number;
  rows: number;
  documents: number;
  message: string;
};

/**
 * Proves that an archive already sitting on disk still restores.
 *
 * Verifying a backup at the moment it is written proves the write. It does not prove the file is
 * still there a month later, that the USB stick has not gone bad, that a sync client has not
 * replaced it with a zero-byte placeholder, or that the folder still exists after somebody
 * tidied up. Those are the ways backups actually fail, and every one of them is invisible until
 * the day it matters.
 *
 * So this opens the newest archive as a stranger would — off disk, with no memory of having
 * written it — restores the database inside it to a scratch file, opens that as a database, and
 * counts what is in it. Nothing is written to the live system except the result.
 */
export async function rehearseRestore(destination?: string): Promise<RestoreRehearsal> {
  const s = await backupStatus();
  const dir = destination ?? s.destination;
  const fail = async (message: string): Promise<RestoreRehearsal> => {
    await setSetting("backup_restore_last", new Date().toISOString());
    await setSetting("backup_restore_result", message);
    return { ok: false, archive: null, takenAt: null, tables: 0, rows: 0, documents: 0, message };
  };

  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => /^pharmacy-admin-backup-.*\.zip$/.test(n)).sort().reverse();
  } catch {
    return fail(`The backup folder ${dir} could not be read. There may be no backups at all.`);
  }
  if (names.length === 0) return fail(`No backup archive was found in ${dir}.`);

  const archive = path.join(dir, names[0]);
  const scratch = path.join(os.tmpdir(), `pa-rehearse-${Date.now()}.db`);
  try {
    const entries = unzip(await fs.readFile(archive));
    const inner = entries.get("pharmacy-admin.db");
    if (!inner) throw new Error("the archive does not contain a database");

    const manifestRaw = entries.get("MANIFEST.json");
    const manifest = manifestRaw ? (JSON.parse(manifestRaw.toString("utf8")) as { takenAt?: string; databaseSha256?: string; counts?: Record<string, number>; documents?: number }) : null;
    if (manifest?.databaseSha256 && sha256(inner) !== manifest.databaseSha256) {
      throw new Error("the database inside has changed since it was written — the file is damaged");
    }

    await fs.writeFile(scratch, inner);
    const counts = await tableCounts(`file:${scratch}`);
    const tables = Object.keys(counts).length;
    const rows = Object.values(counts).reduce((a, b) => a + b, 0);
    if (tables === 0) throw new Error("the restored database has no tables in it");

    // Compare against what the archive said it held, where it said so.
    if (manifest?.counts) {
      const off = Object.entries(manifest.counts).filter(([t, n]) => counts[t] !== n);
      if (off.length) throw new Error(`restored row counts differ from the manifest on ${off.map(([t]) => t).join(", ")}`);
    }

    const documents = Array.from(entries.keys()).filter((k) => k.startsWith("files/")).length;
    const message =
      `Restore rehearsed from ${names[0]}: ${tables} tables, ${rows.toLocaleString()} rows and ${documents} uploaded ` +
      `file${documents === 1 ? "" : "s"} came back intact.`;
    await setSetting("backup_restore_last", new Date().toISOString());
    await setSetting("backup_restore_result", message);
    return { ok: true, archive: names[0], takenAt: manifest?.takenAt ?? null, tables, rows, documents, message };
  } catch (e) {
    return fail(`The newest backup (${names[0]}) could NOT be restored: ${e instanceof Error ? e.message : String(e)}. Treat the pharmacy as having no working backup until this is fixed.`);
  } finally {
    // Same reason as the verification scratch file: on Windows this throws while the handle is
    // still settling, and a throw here would turn a proved restore into a reported failure.
    await removeQuietly(scratch);
  }
}
