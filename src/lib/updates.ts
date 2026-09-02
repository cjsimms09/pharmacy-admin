import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const exec = promisify(execFile);
const root = process.cwd();

async function git(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: root, timeout: timeoutMs, windowsHide: true });
  return stdout.trim();
}

export type VersionInfo = { commit: string; date: string; branch: string; subject: string };

export async function currentVersion(): Promise<VersionInfo | null> {
  try {
    const [commit, date, branch, subject] = await Promise.all([
      git(["rev-parse", "--short", "HEAD"]),
      git(["log", "-1", "--format=%cs"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["log", "-1", "--format=%s"]),
    ]);
    return { commit, date, branch, subject };
  } catch {
    return null;
  }
}

/**
 * The branch this copy follows. Updates are pulled from the same branch the computer is on,
 * so the pharmacy keeps receiving work whether it lives on main or on a working branch.
 */
export async function trackedBranch(): Promise<string> {
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch && branch !== "HEAD") return branch;
  } catch {
    /* fall through */
  }
  return "main";
}

export type UpdateCheck =
  | { ok: true; branch: string; behind: number; changes: { commit: string; date: string; subject: string }[] }
  | { ok: false; error: string };

/** Fetches this copy's branch from GitHub and lists commits not yet installed. */
export async function checkForUpdates(): Promise<UpdateCheck> {
  const branch = await trackedBranch();
  try {
    await git(["fetch", "origin", branch], 120_000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/couldn't find remote ref|not found/i.test(msg)) {
      return { ok: false, error: `This copy is on a branch (“${branch}”) that no longer exists on GitHub. Ask for it to be restored, or reinstall from the main branch.` };
    }
    if (/could not read|authentication|403|Permission denied|Could not resolve host/i.test(msg)) {
      return { ok: false, error: "Could not reach GitHub. Check the computer's internet connection; if it keeps failing, GitHub sign-in may need to be renewed on this computer." };
    }
    return { ok: false, error: msg.split("\n")[0] };
  }
  try {
    const out = await git(["log", "--format=%h%x09%cs%x09%s", `HEAD..origin/${branch}`]);
    const changes = out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [commit, date, ...rest] = l.split("\t");
        return { commit, date, subject: rest.join("\t") };
      });
    return { ok: true, branch, behind: changes.length, changes };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

export function launcherActive(): boolean {
  return process.env.PHARMACY_LAUNCHER === "1";
}

/** Ask the launcher to pull, rebuild and restart. Returns immediately; the process exits shortly after. */
export function requestUpdateAndRestart() {
  const dataDir = path.dirname(path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, ".update-requested"), new Date().toISOString());
  setTimeout(() => process.exit(75), 800);
}

/** The launcher's log from the last update, so a failed rebuild is visible without leaving the app. */
export function lastUpdateLog(): string | null {
  try {
    const dataDir = path.dirname(path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
    const txt = fs.readFileSync(path.join(dataDir, "update.log"), "utf8").trim();
    return txt ? txt.split("\n").slice(-60).join("\n") : null;
  } catch {
    return null;
  }
}
