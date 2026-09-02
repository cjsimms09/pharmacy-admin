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

export type UpdateCheck = { ok: true; behind: number; changes: { commit: string; date: string; subject: string }[] } | { ok: false; error: string };

/** Fetches the main branch from GitHub and lists commits not yet installed. */
export async function checkForUpdates(): Promise<UpdateCheck> {
  try {
    await git(["fetch", "origin", "main"], 120_000);
    const out = await git(["log", "--format=%h%x09%cs%x09%s", "HEAD..origin/main"]);
    const changes = out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [commit, date, ...rest] = l.split("\t");
        return { commit, date, subject: rest.join("\t") };
      });
    return { ok: true, behind: changes.length, changes };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/could not read|authentication|403|Permission denied/i.test(msg)) return { ok: false, error: "GitHub sign-in is needed on this computer. Open a terminal in the app folder and run: git fetch origin main" };
    return { ok: false, error: msg.split("\n")[0] };
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
