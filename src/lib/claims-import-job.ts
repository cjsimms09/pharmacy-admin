import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { getSettings, setSetting } from "./settings";
import { audit } from "./audit";
import { readCopyLines } from "./claude-copy-job";
import { importRxTransactions, describeTransactionImport, type TransactionImportReport } from "./claims";

/**
 * A large claims file is imported in a process of its own, and the site says how it is going.
 *
 * The daily Rx Transaction Details file is about twenty kilobytes and imports before the page has
 * finished redirecting. The history the owner is exporting — twelve months, because the archive
 * held three weeks and every rate on the site was being judged on them — is a few megabytes, and
 * an import of that size inside the web server is minutes during which no page is served: every
 * libsql call blocks the thread that makes it, and the per-row updates in the reversal, sale and
 * refresh passes are thousands of them. The button would be pressed and the page would never
 * change, which is the exact fault the copy-for-Claude job was built to end.
 *
 * So a file over the threshold is written to disk, a job record is claimed, the response goes out,
 * and `scripts/import-claims.ts` does the work in a child process. The child prints one JSON line
 * per step; this reads them and writes each into the job, which the claims page shows. A file
 * under the threshold imports inline exactly as before, because a process is worth starting only
 * for work that would otherwise be noticed.
 */

/** Above this a file imports apart. The daily file is ~20 KB; the history is megabytes. */
export const APART_ABOVE_BYTES = 256 * 1024;

export type ClaimsImportJob = {
  state: "running" | "done" | "failed";
  runId: string;
  fileName: string;
  startedAt: string;
  finishedAt?: string;
  by: string;
  step: string;
  /** The import report's sentence, once there is one. */
  result?: string;
  error?: string;
  updatedAt?: string;
};

const STALE_MS = 10 * 60_000;

export function parseClaimsImportJob(raw: string | undefined): ClaimsImportJob | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as ClaimsImportJob;
    return j && typeof j === "object" && typeof j.runId === "string" ? j : null;
  } catch {
    return null;
  }
}

export async function claimsImportJob(): Promise<ClaimsImportJob | null> {
  const s = await getSettings();
  return parseClaimsImportJob(s.claims_import_job);
}

/** Running, and heard from inside the stale window — a child that died with the launcher is not running. */
export function claimsImportRunning(job: ClaimsImportJob | null, now = Date.now()): boolean {
  if (!job || job.state !== "running") return false;
  const heard = Date.parse(job.updatedAt ?? job.startedAt);
  return Number.isFinite(heard) && now - heard < STALE_MS;
}

async function write(job: ClaimsImportJob): Promise<void> {
  await setSetting("claims_import_job", JSON.stringify({ ...job, updatedAt: new Date().toISOString() }));
}

/** Where a file waits for its child process: under the data folder, never in the repository. */
function importsDir(): string {
  const dataDir = path.dirname(path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
  const dir = path.join(dataDir, "imports");
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

export type ImportOutcome =
  | { apart: false; report: TransactionImportReport }
  | { apart: true; started: boolean; message: string };

/**
 * Imports the file inline where it is small, and apart where it is not.
 *
 * `after` runs on the inline path once the report is in and on the apart path once the child has
 * finished — it is where a caller attaches remittances that arrived before the claims.
 */
export async function importClaimsFile(a: {
  buf: Buffer;
  fileName: string;
  user: { id: string; name: string };
  after?: () => Promise<void>;
}): Promise<ImportOutcome> {
  if (a.buf.length <= APART_ABOVE_BYTES) {
    const report = await importRxTransactions(a.buf, a.fileName, a.user.id);
    if (a.after) await a.after();
    return { apart: false, report };
  }

  const existing = await claimsImportJob();
  if (claimsImportRunning(existing)) {
    return { apart: true, started: false, message: `Already importing ${existing!.fileName} — ${existing!.step}. The Claims page shows it as it goes.` };
  }
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const file = path.join(importsDir(), `${runId}.txt`);
  await fs.promises.writeFile(file, a.buf);
  await write({ state: "running", runId, fileName: a.fileName, startedAt: new Date().toISOString(), by: a.user.name, step: "Starting" });
  const settled = await claimsImportJob();
  if (settled?.runId !== runId) return { apart: true, started: false, message: "Another import claimed the job first. The Claims page shows it as it goes." };

  // Not awaited: the response goes out and the work carries on behind it.
  void runClaimsImport(a.user, runId, file, a.fileName, a.after);
  return {
    apart: true,
    started: true,
    message: `${a.fileName} is ${(a.buf.length / 1_048_576).toFixed(1)} MB, so it is importing in the background. Leave the page or refresh it; the Claims page says here when it is done.`,
  };
}

type ImportProcess = { command: string; args: string[] } | null;

export function importProcessPlan(root: string, file: string, fileName: string, userId: string, exists: (f: string) => boolean = (f) => fsSync.existsSync(f)): ImportProcess {
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(root, "scripts", "import-claims.ts");
  const tsconfig = path.join(root, "tsconfig.script.json");
  if (!exists(tsx) || !exists(script) || !exists(tsconfig)) return null;
  return { command: process.execPath, args: [tsx, "--tsconfig", tsconfig, script, file, fileName, userId] };
}

type ChildMessage = { step?: string; result?: { text: string; claimsAdded: number; problems: string[] }; error?: string };

/** Does the work after the response has gone out, and is the only thing that clears "running". */
export async function runClaimsImport(user: { id: string; name: string }, runId: string, file: string, fileName: string, after?: () => Promise<void>): Promise<void> {
  const ours = async () => (await claimsImportJob())?.runId === runId;
  const step = async (text: string) => {
    const j = await claimsImportJob();
    if (j?.runId === runId) await write({ ...j, step: text });
  };
  const finish = async (patch: Partial<ClaimsImportJob>) => {
    const j = await claimsImportJob();
    if (j?.runId === runId) await write({ ...j, ...patch, finishedAt: new Date().toISOString() });
  };

  try {
    const plan = importProcessPlan(process.cwd(), file, fileName, user.id);
    let result: ChildMessage["result"] | undefined;
    let error: string | undefined;
    if (plan) {
      await new Promise<void>((resolve) => {
        const child = spawn(plan.command, plan.args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env });
        let carried = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          const r = readCopyLines(carried, chunk);
          carried = r.carried;
          for (const m of r.messages as ChildMessage[]) {
            if (m.step) void step(m.step);
            if (m.result) result = m.result;
            if (m.error) error = m.error;
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c: string) => (stderr += c));
        child.on("error", (e) => {
          error = error ?? e.message;
          resolve();
        });
        child.on("exit", (code) => {
          if (!result && !error) error = `The import process stopped (exit ${code}). ${stderr.trim().split("\n").slice(-3).join(" ")}`.trim();
          resolve();
        });
      });
    } else {
      // No tsx or no script on this machine: the work runs here, slowly, rather than not at all.
      await step("Importing in the web server (the import process could not be started)");
      const report = await importRxTransactions(await fs.promises.readFile(file), fileName, user.id);
      result = { text: describeTransactionImport(report), claimsAdded: report.claimsAdded, problems: report.problems };
    }
    if (!(await ours())) return;
    if (error || !result) {
      await finish({ state: "failed", step: error ?? "The import ended without a report.", error: error ?? "no report" });
      await audit({ action: "claims.import_failed", userId: user.id, userName: user.name, details: `${fileName}: ${(error ?? "no report").slice(0, 300)}` });
      return;
    }
    if (after) await after();
    await finish({ state: "done", step: result.text, result: result.text });
    await audit({ action: "claims.import", userId: user.id, userName: user.name, details: `${fileName} (apart): ${result.text.slice(0, 200)}` });
  } catch (e) {
    await finish({ state: "failed", step: e instanceof Error ? e.message : String(e), error: e instanceof Error ? e.message : String(e) });
  } finally {
    await fs.promises.rm(file, { force: true }).catch(() => undefined);
  }
}
