/**
 * Proves the NADAC table against the CMS files it was loaded from.
 *
 * The owner, 8 September: "we need to do the same with drug info (pricing, nadac, awp,
 * equivalents, etc).. this is the most important thing." NADAC is the benchmark every
 * over- and under-payment figure on this site is measured against and the Kansas floor is
 * calculated from, so a price the table holds that the file never contained — or one the file
 * contained that the table lost — is wrong money on a screen, silently.
 *
 * Every CMS file in data/reference/nadac/ is read again, a line at a time by the same reader the
 * loader uses, and each row is set against the table by its key: the NDC and the effective date.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/prove-nadac.ts
 *
 * ── Three answers, not two, because pruning is deliberate ──
 *
 * `pruneNadac` deletes rows older than `nadac_keep_months` where a newer price exists for the same
 * NDC, on purpose: a weekly file is thirty thousand rows and the table grew by a million and a half
 * a year. So the table does not hold everything the files contained, and a proof asking only "is
 * every file row in the table" would report tens of thousands of correct deletions as missing, on
 * the first run and every run after it. A red row that appears every night is a red row nobody
 * reads.
 *
 *   proved       the table holds this NDC and effective date
 *   prunedAway   older than the cutoff, and the table holds a newer price for that NDC — correct,
 *                counted, and never reported as a fault
 *   missing      neither of those, which is the only one that is wrong
 *
 * The cutoff is computed from `nadac_keep_months` in settings, read here rather than assumed, so
 * the proof and the pruner cannot disagree about which rows are supposed to be gone.
 *
 * ── A file that changed after it was loaded ──
 *
 * `.loaded.json` records a sha256 for every file the loader took. This hashes each file on disk and
 * compares. A corrected copy dropped over an old one is the one failure where the table is
 * faithfully correct about a file that no longer exists, and nothing else in this site notices it.
 *
 * The proof only says so. It never re-loads a changed file: loading is the loader's job, it decides
 * what is new against what is held, and a proof that quietly imported would be a second writer for
 * one table and would make the next night's proof pass by having caused it to.
 *
 * ── Memory ──
 *
 * Flat regardless of file size. The reader is called a row at a time and the row is discarded; the
 * only sets held are the table's own keys — tens of thousands, not millions — and the accounting
 * for the other direction is done by deleting from a copy of them as they are seen, so nothing
 * grows with the archive. A year archive is a hundred megabytes of text and must never become a
 * hundred megabytes of strings on a machine that has run out of memory twice.
 *
 * ── What it writes, in the `nadac_proof` setting, for the Data health row to read ──
 *
 *   { provedOn, cutoff, keepMonths,
 *     files: [{ file, bytes, sha256, manifestSha256, changedSinceLoad, loadedAt,
 *               rowsRead, rowsUnreadable, unreadableReasons, effectiveFrom, effectiveTo,
 *               proved, prunedAway, missing, problems: [] }],
 *     rowsInFiles, proved, prunedAway, missing,
 *     tableRowsNoFileAccountsFor, lines: [the first 40 faults in words] }
 *
 * The file list is whatever is in the folder, so a new source of NADAC — PioneerRx's own, when the
 * SQL connection lands — becomes another entry with its own name rather than a second shape.
 */
import "dotenv/config";
import { createClient } from "@libsql/client";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";

const db = createClient({ url: "file:" + (process.env.DATABASE_PATH || "./data/pharmacy-admin.db") });

const MANIFEST = ".loaded.json";
type ManifestEntry = { size: number; mtimeMs: number; sha256: string | null; loadedAt: string; added: number; rows: number };

async function hashFile(full: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(full)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Whole months before today, as an ISO date. The same arithmetic `pruneNadac` uses. */
function cutoffFrom(keepMonths: number, today = new Date()): string {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - keepMonths, today.getUTCDate())).toISOString().slice(0, 10);
}

async function main() {
  const { nadacDir } = await import("../src/lib/nadac");
  const { readNadacRow, newCtx } = await import("../src/lib/nadac");
  const { splitRow } = await import("../src/lib/pioneer-catalog");

  // The pruner's own number, not a guess at it. Its floor of six months is honoured here too.
  const keepRaw = (await db.execute(`select value from settings where key='nadac_keep_months'`)).rows[0]?.value as string | undefined;
  const keepMonths = Math.max(6, Number(keepRaw ?? "") || 18);
  const cutoff = cutoffFrom(keepMonths);

  /*
   * The table's keys, and the newest price per NDC.
   *
   * Both are bounded by the table rather than by the archive. `unseen` starts as every key and has
   * keys deleted from it as the files account for them, so what remains at the end is the other
   * direction of the proof — rows the table holds that no file explains — without ever holding the
   * files' keys in memory.
   */
  const held = (await db.execute(`select ndc11, effective_on from nadac_prices`)).rows as unknown as { ndc11: string; effective_on: string }[];
  const keys = new Set<string>();
  const newestByNdc = new Map<string, string>();
  for (const r of held) {
    keys.add(`${r.ndc11}|${r.effective_on}`);
    const seen = newestByNdc.get(r.ndc11);
    if (!seen || r.effective_on > seen) newestByNdc.set(r.ndc11, r.effective_on);
  }
  const unseen = new Set(keys);

  const dir = nadacDir();
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((f) => /\.(csv|txt)$/i.test(f)).sort();
  } catch {
    names = [];
  }
  let manifest: Record<string, ManifestEntry> = {};
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), "utf8")) as Record<string, ManifestEntry>;
  } catch {
    manifest = {};
  }

  const files: unknown[] = [];
  const lines: string[] = [];
  let rowsInFiles = 0;
  let provedAll = 0;
  let prunedAll = 0;
  let missingAll = 0;

  for (const name of names) {
    const full = path.join(dir, name);
    const problems: string[] = [];
    let bytes = 0;
    let sha256: string | null = null;
    try {
      bytes = (await fs.stat(full)).size;
      sha256 = await hashFile(full);
    } catch (e) {
      problems.push(`could not be read: ${e instanceof Error ? e.message : String(e)}`);
      lines.push(`${name}: the stored file could not be read.`);
      files.push({ file: name, bytes, sha256, manifestSha256: manifest[name]?.sha256 ?? null, changedSinceLoad: false, loadedAt: manifest[name]?.loadedAt ?? null, rowsRead: 0, rowsUnreadable: 0, unreadableReasons: {}, effectiveFrom: null, effectiveTo: null, proved: 0, prunedAway: 0, missing: 0, problems });
      continue;
    }

    const manifestSha = manifest[name]?.sha256 ?? null;
    const changedSinceLoad = Boolean(manifestSha && sha256 && manifestSha !== sha256);
    if (changedSinceLoad) {
      lines.push(`${name}: the file on disk is not the file that was loaded — it has been replaced or edited since. The table holds what the old file said. Re-load it from the feeds page; this proof does not load anything.`);
    }
    if (!manifest[name]) {
      problems.push("no manifest entry, so this file has never been loaded");
      lines.push(`${name}: present in the NADAC folder and never loaded, so none of its prices are in the table.`);
    }

    const ctx = newCtx();
    let headers: string[] | null = null;
    let rowsRead = 0;
    let proved = 0;
    let pruned = 0;
    let missing = 0;
    let effectiveFrom: string | null = null;
    let effectiveTo: string | null = null;

    const rl = readline.createInterface({ input: createReadStream(full, { encoding: "utf8", highWaterMark: 1 << 16 }), crlfDelay: Infinity });
    for await (const rawLine of rl) {
      const line = rawLine.replace(/^﻿/, "");
      if (!line.trim()) continue;
      const cells = splitRow(line, ",");
      if (!headers) {
        headers = cells.map((c) => c.trim());
        continue;
      }
      rowsRead++;
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = cells[i] ?? "";
      });
      const row = readNadacRow(obj, ctx);
      // A row the reader declines is counted by the reader, in ctx.skipped with its reason. It is
      // not a missing price: it was never a price.
      if (!row) continue;

      if (!effectiveFrom || row.effectiveOn < effectiveFrom) effectiveFrom = row.effectiveOn;
      if (!effectiveTo || row.effectiveOn > effectiveTo) effectiveTo = row.effectiveOn;

      const key = `${row.ndc11}|${row.effectiveOn}`;
      if (keys.has(key)) {
        proved++;
        unseen.delete(key);
        continue;
      }
      const newest = newestByNdc.get(row.ndc11);
      if (row.effectiveOn < cutoff && newest && newest > row.effectiveOn) {
        pruned++;
        continue;
      }
      missing++;
      if (lines.length < 200) {
        lines.push(
          `${name}: NDC ${row.ndc11} effective ${row.effectiveOn} at $${(row.unitMicros / 1_000_000).toFixed(5)}/${row.pricingUnit} is in the file and not in the table${newest ? `; the newest price held for that NDC is ${newest}` : "; no price at all is held for that NDC"}.`,
        );
      }
    }

    rowsInFiles += rowsRead;
    provedAll += proved;
    prunedAll += pruned;
    missingAll += missing;
    files.push({
      file: name,
      bytes,
      sha256,
      manifestSha256: manifestSha,
      changedSinceLoad,
      loadedAt: manifest[name]?.loadedAt ?? null,
      rowsRead,
      rowsUnreadable: ctx.skipped,
      unreadableReasons: ctx.reasons,
      effectiveFrom,
      effectiveTo,
      proved,
      prunedAway: pruned,
      missing,
      problems,
    });
  }

  /*
   * The other direction: prices the table holds that no file on disk accounts for.
   *
   * Not always a fault. A file loaded and later deleted from the folder leaves its prices behind
   * legitimately, and the pharmacy is not obliged to keep every archive for ever. But it is the
   * only way a price nobody can point at a source for would ever be noticed, so it is counted and
   * the oldest of them are named.
   */
  const orphans = [...unseen];
  const orphanNdcs = new Set(orphans.map((k) => k.split("|")[0]));
  if (orphans.length > 0) {
    lines.push(
      `${orphans.length.toLocaleString("en-US")} price${orphans.length === 1 ? "" : "s"} in the table, across ${orphanNdcs.size.toLocaleString("en-US")} NDC${orphanNdcs.size === 1 ? "" : "s"}, are accounted for by no file now in the NADAC folder. That is expected where a loaded file has since been deleted; it is the only sign there would be of a price with no source.`,
    );
  }

  const summary = {
    provedOn: new Date().toISOString().slice(0, 10),
    cutoff,
    keepMonths,
    files,
    rowsInFiles,
    proved: provedAll,
    prunedAway: prunedAll,
    missing: missingAll,
    tableRowsNoFileAccountsFor: orphans.length,
  };
  await db.execute({
    sql: `insert into settings (key, value) values ('nadac_proof', ?) on conflict(key) do update set value = excluded.value`,
    args: [JSON.stringify({ ...summary, lines: lines.slice(0, 40) })],
  });
  console.log(JSON.stringify(summary));
  for (const line of lines.slice(0, 40)) console.log("NADAC " + line);
  await db.close();
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
