import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getSettings, setSetting } from "./settings";
import { readSecret } from "./connections";

const run = promisify(execFile);

/**
 * The Medicare Transaction Facilitator, driven from inside the app.
 *
 * MTF is CMS's channel for Maximum Fair Price refunds under the Inflation Reduction Act. It has
 * no web API of its own — CMS ships a command-line tool, mtf-cli, and everything goes through
 * that. Rather than leave the PIC at a command prompt, this wraps it.
 *
 * Two things shape the design.
 *
 * The API key is single-valued: generating a new one in the portal cancels the old, and the
 * portal never shows it again. So it is stored encrypted here and pushed into the CLI's own
 * config immediately before each call, rather than being kept in two places that can drift.
 *
 * And search is separated from download. `search835` reports what exists without writing
 * anything, which makes it the honest way to test a key — it proves the credential works and
 * proves nothing else changed.
 */

export const mtfDir = () => {
  const base = path.dirname(path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
  return path.join(base, "remits", "mtf");
};

export type MtfResult = {
  ok: boolean;
  /** What to tell the person, in words they can act on. */
  message: string;
  /** Raw CLI output, for when the message is not enough. */
  output?: string;
  filesFound?: number;
};

/** Where the CLI lives. A configured path wins; otherwise assume it is on the PATH. */
async function cliPath(): Promise<string> {
  const s = await getSettings();
  return s.mtf_cli_path?.trim() || "mtf-cli";
}

async function downloadDir(): Promise<string> {
  const s = await getSettings();
  const configured = s.mtf_download_dir?.trim();
  const dir = configured ? path.resolve(configured) : mtfDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Runs the CLI, turning the ways it can fail into sentences rather than stack traces.
 *
 * A missing binary and a rejected key look nothing alike to a person and identical to a naive
 * error handler, so they are separated here.
 */
async function cli(args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; out: string; err: string }> {
  const bin = await cliPath();
  try {
    const { stdout, stderr } = await run(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: stdout ?? "", err: stderr ?? "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (err.code === "ENOENT") {
      return {
        ok: false,
        out: "",
        err:
          `Could not find the MTF command-line tool at "${bin}". Download it from the MTF portal ` +
          `(Developer Tools → Download files), install it, then either put it on the system PATH or ` +
          `enter its full path in Settings → Connections.`,
      };
    }
    if (err.killed) return { ok: false, out: err.stdout ?? "", err: "The MTF tool did not finish in time." };
    return { ok: false, out: err.stdout ?? "", err: (err.stderr || err.message || "").trim() };
  }
}

/** Pushes the stored key into the CLI's own config. Called before anything that needs it. */
async function applyKey(): Promise<MtfResult | null> {
  const key = await readSecret("mtf");
  if (!key) {
    return {
      ok: false,
      message: "No MTF API key is stored. Add it in Settings → Connections, then try again.",
    };
  }
  const dir = await downloadDir();
  const r = await cli(["config", "set", `--apiKey=${key}`, `--downloadDir=${dir}`], 30_000);
  if (!r.ok) return { ok: false, message: r.err || "Could not configure the MTF tool.", output: r.out };
  return null;
}

/**
 * Proves the key works, without downloading anything.
 *
 * Searches a recent window: if CMS has published nothing in it, that is a legitimate result and
 * says so, rather than being reported as a failure. An empty search and a rejected key are very
 * different answers and must not read the same.
 */
export async function testMtf(): Promise<MtfResult> {
  const bad = await applyKey();
  if (bad) return bad;

  const check = await cli(["config", "get"], 30_000);
  if (!check.ok) return { ok: false, message: check.err || "The MTF tool would not report its configuration.", output: check.out };

  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  // Verbose on the test specifically. It is the one command run to diagnose rather than to get
  // work done, so the extra detail is the entire point of running it.
  const s = await cli(["search835", `--date=${iso(from)}`, `--toDate=${iso(to)}`, "--verbose"], 120_000);

  const diagnostic = [check.out, check.err, s.out, s.err].filter(Boolean).join("\n").trim();

  if (!s.ok) {
    const err = `${s.err}\n${s.out}`.toLowerCase();

    if (err.includes("unauthor") || err.includes("401")) {
      return {
        ok: false,
        message:
          "The tool reached MTF, but the key was rejected. Generate a new key in the portal " +
          "(Developer Tools → API key → Generate) and paste it in again. Generating a new key cancels the old one.",
        output: diagnostic,
      };
    }

    if (err.includes("forbidden") || err.includes("403") || err.includes("access denied")) {
      return {
        ok: false,
        message:
          "The key was accepted but this account is not permitted to use the developer tools. In MTF that is a " +
          "role question rather than a key question — the account needs dispensing entity access. Ask your MTF " +
          "Access Manager to grant it.",
        output: diagnostic,
      };
    }

    if (err.includes("404") || err.includes("not found")) {
      return {
        ok: false,
        message:
          "MTF answered 404. That means the tool reached CMS and CMS had nothing to return at that address, so " +
          "the key itself is probably fine. Two things cause it, and the raw output below usually says which: " +
          "either this pharmacy has no payee profile set up in MTF yet — check Developer Tools shows a Payee ID " +
          "and a remit profile, because without one there is no mailbox to search — or the installed tool is an " +
          "older version calling an endpoint CMS has retired, which a re-download from Developer Tools fixes. " +
          "If the raw output names a URL, that tells us which of the two it is.",
        output: diagnostic,
      };
    }

    return { ok: false, message: s.err || s.out || "The search failed.", output: diagnostic };
  }

  const found = countFiles(s.out);
  return {
    ok: true,
    filesFound: found,
    message:
      found > 0
        ? `Connected. ${found} 835 file${found === 1 ? "" : "s"} available in the last 90 days.`
        : "Connected, and the key works. CMS has published no 835 files for us in the last 90 days, which is a normal result if no MFP refunds have been issued yet.",
    output: diagnostic,
  };
}

/** Pulls 835 files for a date range into the download folder. */
export async function downloadMtf(fromIso: string, toIso: string, onlyNew = true): Promise<MtfResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso) || !/^\d{4}-\d{2}-\d{2}$/.test(toIso)) {
    return { ok: false, message: "Give both dates as YYYY-MM-DD." };
  }
  if (fromIso > toIso) return { ok: false, message: "The start date is after the end date." };

  const bad = await applyKey();
  if (bad) return bad;

  const dir = await downloadDir();
  const before = await listFiles(dir);
  const args = ["download835", `--date=${fromIso}`, `--toDate=${toIso}`];
  if (onlyNew) args.push("--newFiles");
  const r = await cli(args, 10 * 60_000);

  const after = await listFiles(dir);
  const added = after.filter((f) => !before.includes(f));

  await setSetting("mtf_last_pull", new Date().toISOString());
  await setSetting("mtf_last_result", r.ok ? `${added.length} new file(s)` : (r.err || "failed").slice(0, 300));

  if (!r.ok) return { ok: false, message: r.err || "The download failed.", output: r.out };
  return {
    ok: true,
    filesFound: added.length,
    message:
      added.length > 0
        ? `Downloaded ${added.length} new file${added.length === 1 ? "" : "s"} into ${dir}.`
        : "Ran successfully. Nothing new to download for that range.",
    output: r.out,
  };
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * Counts the files a search reported.
 *
 * The CLI's output format is not contractual, so this looks for a stated count first and falls
 * back to counting things that look like filenames. It returns 0 rather than guessing high — an
 * overstated count would make an empty mailbox look like a working pipeline.
 */
export function countFiles(out: string): number {
  const stated = /(\d+)\s+files?\s+found/i.exec(out);
  if (stated) return Number(stated[1]);
  if (/no files? found/i.test(out)) return 0;
  const names = out.match(/[\w.-]+\.(835|edi|txt|zip)\b/gi);
  return names ? new Set(names.map((n) => n.toLowerCase())).size : 0;
}

/** What the MTF page shows about the last run. */
export async function mtfStatus() {
  const s = await getSettings();
  const dir = await downloadDir().catch(() => mtfDir());
  return {
    hasKey: Boolean(s.mtf_api_key_enc),
    payeeId: s.mtf_payee_id || null,
    dir,
    files: await listFiles(dir),
    lastPull: s.mtf_last_pull || null,
    lastResult: s.mtf_last_result || null,
  };
}
