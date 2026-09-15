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

/**
 * Splits what was configured into a program and the arguments that must come before ours.
 *
 * The MTF tool ships as a Node application with its own copy of Node beside it, so on some builds
 * there is no single executable to point at — the way to run it is one program with a script as its
 * first argument. Accepting only a bare path would make that layout unusable, and the person
 * looking at a bin folder containing node.exe would reasonably conclude node.exe was the answer.
 * It is not: node.exe with no script runs nothing.
 *
 * So the setting is a command line. A plain path is the ordinary case and behaves as before;
 * quotes hold a path containing spaces together, which every path under "Program Files" does.
 */
export function splitCommand(configured: string): { bin: string; prefix: string[] } {
  const parts = configured.trim().match(/"[^"]*"|\S+/g) ?? [];
  const clean = parts.map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));
  return { bin: clean[0] ?? "mtf-cli", prefix: clean.slice(1) };
}

/**
 * What to actually spawn, which on Windows is not always what was configured.
 *
 * Node refuses to launch a .cmd or .bat file directly. It has done since April 2024, when the fix
 * for CVE-2024-27980 stopped `spawn` running batch files without a shell, because the way Windows
 * parses a batch file's arguments allowed command injection. The refusal surfaces as `spawn
 * EINVAL` — five characters that say nothing about batch files, nothing about which file, and read
 * exactly like the path being wrong.
 *
 * And this tool's Windows package is a batch launcher: bin holds node.exe, run.js and mtf-cli.cmd,
 * and the .cmd is the only one of the three Windows knows how to start. So a batch file is routed
 * through the command interpreter, which is what a shell would have done, with the arguments still
 * passed as an array so each is quoted by Node rather than pasted into a command line.
 */
export function spawnPlan(bin: string, args: string[]): { command: string; args: string[] } {
  if (/\.(cmd|bat)$/i.test(bin)) {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/c", bin, ...args] };
  }
  return { command: bin, args };
}

/**
 * The download folder as the CLI will understand it, which is not the same as where it is.
 *
 * Version 2.2.0 joins whatever it is given onto its own working directory instead of resolving it,
 * so an absolute path comes back doubled:
 *
 *   ENOENT: no such file or directory, mkdir
 *   'C:\Users\wwfprx\pharmacy-admin\C:\Users\wwfprx\pharmacy-admin\data\remits\mtf'
 *
 * A path relative to the working directory joins correctly, and joining handles the ".." in one
 * that points outside. This site always runs the tool from its own folder, so the relative form is
 * computed from there — which also means a scheduled task started in that folder behaves the same
 * way, and the stored configuration is right for both.
 *
 * If their CLI is fixed to resolve absolute paths, this keeps working: a relative path was always
 * valid. It is the absolute one that was not.
 */
export function cliDownloadArg(absolute: string, from = process.cwd()): string {
  const rel = path.relative(from, absolute);
  // A path on another drive has no relative form on Windows; there is nothing to do but pass it.
  return rel && !path.isAbsolute(rel) ? rel : absolute;
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
  const { bin, prefix } = splitCommand(await cliPath());
  const plan = spawnPlan(bin, [...prefix, ...args]);
  try {
    const { stdout, stderr } = await run(plan.command, plan.args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: stdout ?? "", err: stderr ?? "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (err.code === "ENOENT") {
      return {
        ok: false,
        out: "",
        err:
          `Nothing is at "${bin}". There is no installer to run — the download is the program, so all that is ` +
          `needed is the path to it. On Windows, extracting into your user folder puts it at ` +
          `C:\\Users\\<your user>\\mtf-cli\\bin\\mtf-cli.exe: open that folder, check the file is there, and paste the ` +
          `whole path including the file name into "Where the tool is" on the Medicare MFP refunds page.`,
      };
    }
    /*
     * Windows blocks a program that came out of a downloaded zip.
     *
     * The file is there, the path is right, and it refuses to run — which is the most confusing
     * possible failure, because everything looks correct. It is Mark of the Web: the zip carried a
     * "downloaded from the internet" flag and every file extracted from it inherited it. The fix is
     * a checkbox, and nobody finds it by guessing.
     */
    if (/ENOENT[^]*mkdir/i.test(err.stderr ?? err.message ?? "")) {
      return {
        ok: false,
        out: err.stdout ?? "",
        err:
          "The MTF tool could not create its download folder. It builds that path by joining what it was given onto " +
          "its own working folder, so an absolute path comes back doubled — press “Save and check it runs” again and " +
          "the folder is configured in the form it accepts.",
      };
    }
    if (err.code === "EINVAL") {
      return {
        ok: false,
        out: "",
        err:
          `Windows would not start "${bin}" the way it was asked to. This is a known refusal in the version of Node ` +
          `this site runs on — it will not launch a .cmd or .bat file directly — and it has been worked around, so ` +
          `try again. If it persists, point at the launcher script (mtf-cli.cmd) rather than node.exe.`,
      };
    }
    if (err.code === "EACCES" || err.code === "EPERM" || err.code === "UNKNOWN") {
      return {
        ok: false,
        out: "",
        err:
          `Windows would not run "${bin}". This is usually because the file came out of a downloaded zip and is still ` +
          `marked as blocked: right-click the original zip, choose Properties, tick Unblock at the bottom, press OK, ` +
          `then extract it again. Right-clicking the .exe itself and doing the same works too. If that is not it, ` +
          `check the file is the Windows 64-bit build rather than another platform's.`,
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
  const r = await cli(["config", "set", `--apiKey=${key}`, `--downloadDir=${cliDownloadArg(dir)}`], 30_000);
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

/**
 * How long the stored key has left.
 *
 * CMS expires MTF API keys 90 days after generation and gives no notice. A scheduled pull would
 * simply start failing. Counted from when the key was pasted in, which is the closest date we
 * have — if it was generated some days earlier, the real deadline is earlier still, so this
 * errs toward warning too early rather than too late.
 */
export function keyDaysLeft(setOn: string | null, today = new Date().toISOString().slice(0, 10)): number | null {
  if (!setOn) return null;
  const ms = Date.parse(`${setOn}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(ms) || Number.isNaN(now)) return null;
  return 90 - Math.floor((now - ms) / 86_400_000);
}

/** What the MTF page shows about the last run. */
export async function mtfStatus() {
  const s = await getSettings();
  const dir = await downloadDir().catch(() => mtfDir());
  return {
    hasKey: Boolean(s.mtf_api_key_enc),
    keySetOn: s.mtf_key_set_on || null,
    keyDaysLeft: keyDaysLeft(s.mtf_key_set_on || null),
    payeeId: s.mtf_payee_id || null,
    dir,
    files: await listFiles(dir),
    lastPull: s.mtf_last_pull || null,
    lastResult: s.mtf_last_result || null,
  };
}

/**
 * Where the tool is, and whether it is really there.
 *
 * The path was a setting with no way to enter it, so the only route in was putting the tool on the
 * system PATH — an environment variable edit, a reboot of the terminal, and a class of failure
 * ("mtf-cli is not recognised") that looks like the software is broken. A full path typed into a
 * box is the same thing without any of that.
 *
 * It is checked rather than accepted: a path that is wrong should say so here, while somebody is
 * looking at it, not three screens later as a download that mysteriously does nothing.
 */
export async function checkCli(candidate?: string): Promise<{ ok: boolean; message: string; version?: string }> {
  const bin = (candidate ?? "").trim() || (await cliPath());
  const r = await cli(["--version"], 20_000);
  if (r.ok) {
    const version = (r.out || r.err).trim().split("\n")[0] || undefined;
    return { ok: true, message: `Found it${version ? `: ${version}` : ""}.`, version };
  }
  // Some builds answer only to help. A tool that responds at all is a tool that is there.
  const h = await cli(["help"], 20_000);
  if (h.ok) return { ok: true, message: "Found it." };
  return {
    ok: false,
    message:
      r.err ||
      `Nothing runs at "${bin}". On Windows the tool is usually at ` +
        `C:\\Users\\<your user>\\mtf-cli\\bin\\mtf-cli.exe — open that folder and check the file is there, then paste ` +
        `the whole path including the file name.`,
  };
}

/** Saves where the tool is and where its downloads should go, checking the tool before it agrees. */
export async function saveCliLocation(
  cliPathIn: string,
  downloadDirIn: string,
): Promise<{ ok: boolean; message: string }> {
  const { setSetting } = await import("./settings");
  const p = cliPathIn.trim();
  const d = downloadDirIn.trim();
  if (p) await setSetting("mtf_cli_path", p);
  if (d) await setSetting("mtf_download_dir", d);

  const check = await checkCli(p);
  if (!check.ok) return { ok: false, message: check.message };

  /*
   * Push the settings into the tool's own configuration as well.
   *
   * A scheduled task runs the tool directly, not through this site, so the tool has to hold its own
   * key and download directory. Setting them here means the scheduled download and the site put
   * their files in the same place — otherwise the site watches an empty folder for ever while the
   * money piles up in another one.
   */
  const applied = await applyKey();
  const where = await downloadDir();
  return {
    ok: true,
    message:
      `${check.message} Downloads go to ${where}, and that is the folder this site reads.` +
      (applied ? ` ${applied.message}` : " The stored API key has been written into the tool as well, so a scheduled download uses it too."),
  };
}

/**
 * Finds the tool on this computer, so nobody has to know where a zip put it.
 *
 * Telling somebody the path "is usually" somewhere is a guess dressed as instruction, and when the
 * guess is wrong — a zip that made its own folder, an extract into Downloads, a build that puts the
 * program beside the folder rather than in a bin inside it — the answer is an error message
 * repeating the same wrong path back at them. The computer knows where the file is. It can look.
 *
 * Bounded on purpose: the likely roots, a few levels deep, skipping the directories that make a
 * whole-disk search take minutes. A search that has to be waited on gets cancelled, and a
 * cancelled search teaches nothing.
 */
export async function findCli(): Promise<{ found: string[]; searched: string[] }> {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const roots = [
    home,
    home && path.join(home, "Downloads"),
    home && path.join(home, "Desktop"),
    home && path.join(home, "Documents"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    process.env.ProgramFiles,
    "/usr/local/bin",
    "/opt",
  ].filter((x): x is string => Boolean(x));

  const found: string[] = [];
  const searched: string[] = [];
  const skip = /^(node_modules|\.git|AppData|Windows|\$Recycle|OneDrive.*Temp|Library|Pictures|Music|Videos)$/i;
  /*
   * What counts as "the tool", which is not always one file.
   *
   * Some builds are a single executable. Others are a Node application shipped with its own copy of
   * Node, where the thing to run is a launcher script — and the bin folder contains node.exe, which
   * is the engine and not the program. Both shapes are looked for, and node.exe on its own never
   * counts: it would run nothing and the failure would be silent.
   */
  const wanted = /^mtf-cli(\.exe|\.bat|\.cmd|\.ps1|\.js)?$/i;
  /*
   * A Node application's entry point is rarely named after the product.
   *
   * It is index.js, cli.js, main.js or bundle.js in a lib or app folder, and only the folder it
   * sits under says which product it belongs to. So a generic name counts only when the path
   * itself mentions MTF — otherwise every Node project on the computer would be a candidate.
   */
  const entryName = /^(index|cli|main|bundle|mtf.*)\.js$/i;
  const nodeScripts: { node: string; script: string }[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length >= 8) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    searched.push(dir);
    for (const e of entries) {
      if (found.length >= 8) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.test(e.name)) continue;
        await walk(full, depth + 1);
      } else if (wanted.test(e.name)) {
        // A .js entry needs the Node beside it; it is paired below rather than offered bare.
        if (/\.js$/i.test(e.name)) nodeScripts.push({ node: "", script: full });
        else found.push(full);
      } else if (entryName.test(e.name) && /mtf/i.test(full)) {
        nodeScripts.push({ node: "", script: full });
      } else if (/\.(cmd|bat)$/i.test(e.name) && /mtf/i.test(full)) {
        /*
         * A launcher script under an MTF folder, whatever it is called.
         *
         * The Windows package ships one in bin beside its bundled node.exe, and it is not always
         * named after the product. It is offered as a candidate rather than assumed to be right —
         * pressing Save runs it, which is what settles the question.
         */
        found.push(full);
      } else if (/^node(\.exe)?$/i.test(e.name) && /mtf/i.test(full)) {
        nodeScripts.push({ node: full, script: "" });
      }
    }
  };

  for (const r of roots) await walk(r, 0);

  /*
   * Pair a bundled Node with the script it is there to run.
   *
   * Offered separately they are two useless answers: node.exe runs nothing without a script, and a
   * .js file is not a program Windows knows how to start. Together they are the command line.
   */
  const nodes = nodeScripts.filter((x) => x.node).map((x) => x.node);
  const scripts = nodeScripts.filter((x) => x.script).map((x) => x.script);
  for (const script of scripts) {
    // The Node that belongs to this script is the one under the same product folder — matched by
    // the longest shared path rather than by an assumed depth, because layouts differ.
    const near = nodes
      .map((n) => ({ n, shared: sharedPrefixLength(n, script) }))
      .sort((a, b) => b.shared - a.shared)[0];
    if (near && near.shared > 0) found.push(`"${near.n}" "${script}"`);
  }

  return { found: [...new Set(found)], searched };
}

/** How many path segments two paths have in common, for pairing a runtime with its script. */
function sharedPrefixLength(a: string, b: string): number {
  const x = a.split(/[\\/]/);
  const y = b.split(/[\\/]/);
  let n = 0;
  while (n < x.length && n < y.length && x[n].toLowerCase() === y[n].toLowerCase()) n++;
  return n;
}

/**
 * The whole MTF cycle, unattended: fetch what is new, read it, put it on the claims.
 *
 * Downloading and reading were two buttons on a page, which means the money only arrives when
 * somebody remembers to go and get it. That is not automation, it is a chore with a nicer
 * interface — and the whole reason the payments were invisible in the first place is that nobody
 * was going to check a portal every day.
 *
 * A rolling window rather than yesterday alone. CMS publishes a remittance days after the fill and
 * not on a schedule anybody here controls, so asking only for today would miss anything that
 * appeared late, for ever. Asking for the last few weeks every time costs nothing — the tool is
 * told to fetch only files not already taken, and a payment already recorded is recognised by its
 * trace number and skipped.
 */
export async function mtfCycle(user: { name: string }, days = 21): Promise<{
  ran: boolean;
  why?: string;
  downloaded: number;
  payments: number;
  amountCents: number;
  matched: number;
  unmatched: number;
  message: string;
}> {
  const idle = { ran: false, downloaded: 0, payments: 0, amountCents: 0, matched: 0, unmatched: 0 };
  const key = await readSecret("mtf");
  if (!key) return { ...idle, why: "no API key stored", message: "No MTF API key is stored, so nothing was fetched." };

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const pulled = await downloadMtf(iso(from), iso(to), true);
  const { sweepRemittances } = await import("./claim-payments");
  // Read whatever is in the folder even when the fetch failed: a file from an earlier run that
  // has never been read is money sitting on the disk, and a network failure should not hide it.
  const read = await sweepRemittances(user);

  const { setSetting } = await import("./settings");
  const message =
    (pulled.ok ? pulled.message : `Could not fetch: ${pulled.message}`) +
    (read.payments
      ? ` ${read.payments} payment${read.payments === 1 ? "" : "s"} worth $${(read.amountCents / 100).toFixed(2)} posted, ${read.matched} onto claims we hold.`
      : " Nothing new to post.");
  await setSetting("mtf_last_pull", new Date().toISOString());
  await setSetting("mtf_last_result", message.slice(0, 500));

  return {
    ran: true,
    downloaded: countFiles(pulled.output ?? ""),
    payments: read.payments,
    amountCents: read.amountCents,
    matched: read.matched,
    unmatched: read.unmatched,
    message,
  };
}
