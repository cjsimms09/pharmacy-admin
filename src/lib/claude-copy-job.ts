import "server-only";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { getSettings, setSetting } from "./settings";
import { audit } from "./audit";

/**
 * Making the copy, as a job rather than as a form the browser has to sit and wait on.
 *
 * "button still isnt working" — and it was not. The whole thing ran inside the press: a copy of
 * the database, ten thousand prescription replacements, a scan of every value in the result, and
 * the compression. On the pharmacy's data that is minutes, and a browser waiting on a form action
 * does not last minutes. It never came back, so the page never changed, so the button looked dead.
 *
 * This is the third time this shape of fault has appeared in this site — the NADAC fetch and the
 * FDA directory both did the same thing — and the answer is the same both previous times: the
 * press claims the job and returns at once, the work runs behind the response writing where it has
 * got to, and the page shows that.
 */
export type CopyJob = {
  state: "running" | "done" | "failed";
  runId: string;
  startedAt: string;
  /** When the job last wrote a step. Staleness is judged on this, not on when it began. */
  updatedAt?: string;
  finishedAt?: string;
  by: string;
  step: string;
  /** Where the finished file went, so the page can offer it. */
  path?: string;
  bytes?: number;
  error?: string;
};

/**
 * A job that has written nothing for this long is presumed dead.
 *
 * Judged on the last step rather than on the start, because the copy legitimately runs for minutes
 * and reports as it goes. Five minutes of complete silence is a process that has gone.
 */
const STALE_MS = 5 * 60 * 1000;

export async function copyJob(): Promise<CopyJob | null> {
  const s = await getSettings();
  return parseCopyJob(s.claude_copy_job);
}

export function parseCopyJob(raw: string | undefined): CopyJob | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as CopyJob;
    return j && typeof j.state === "string" ? j : null;
  } catch {
    return null;
  }
}

export function copyJobRunning(job: CopyJob | null, now = Date.now()): boolean {
  if (!job || job.state !== "running") return false;
  const last = Date.parse(job.updatedAt ?? job.startedAt);
  return Number.isFinite(last) && now - last < STALE_MS;
}

async function write(job: CopyJob): Promise<void> {
  await setSetting("claude_copy_job", JSON.stringify({ ...job, updatedAt: new Date().toISOString() }));
}

/** A job cannot survive a restart, so one still marked running was killed mid-way. */
export async function failOrphanedCopyJob(): Promise<void> {
  const j = await copyJob();
  if (!j || j.state !== "running") return;
  await write({
    ...j,
    state: "failed",
    finishedAt: new Date().toISOString(),
    step: "The site restarted while this was running, so it did not finish. Press it again.",
    error: "interrupted by a restart",
  });
}

/** Claims the job, or says why not. */
export async function startCopy(user: { id: string; name: string }): Promise<{ started: boolean; message: string; runId?: string }> {
  const existing = await copyJob();
  if (copyJobRunning(existing)) {
    return { started: false, message: `Already making one — ${existing!.step}. This page shows it as it goes.` };
  }
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await write({ state: "running", runId, startedAt: new Date().toISOString(), by: user.name, step: "Starting" });
  const settled = await copyJob();
  if (settled?.runId !== runId) return { started: false, message: "Already making one. This page shows it as it goes." };
  return { started: true, runId, message: "Making the copy. It takes a few minutes — leave the page or refresh it, and it will say here when it is done." };
}

/**
 * Where the copy actually runs, and why it is not here.
 *
 * SQLite is a library rather than a server: every read happens on the thread that asks for it. On
 * this pharmacy's database, reading two hundred thousand rows takes 1.7 seconds and — measured with
 * a heartbeat every twenty milliseconds — lets through none of the eighty-four beats that should
 * have fired. Nothing else on that thread runs. The copy is minutes of that, so for those minutes
 * the web server can answer nothing, which is exactly the fault reported: the button pressed, and
 * the page never changed, because the page could not be served.
 *
 * Returning from the press at once was necessary but not sufficient. The work has to leave the
 * process as well.
 */
type CopyProcess = { command: string; args: string[] } | null;

export function copyProcessPlan(root: string, destination: string, exists: (file: string) => boolean = (f) => fsSync.existsSync(f)): CopyProcess {
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(root, "scripts", "make-claude-copy.ts");
  const tsconfig = path.join(root, "tsconfig.script.json");
  if (!exists(tsx) || !exists(script) || !exists(tsconfig)) return null;
  return { command: process.execPath, args: [tsx, "--tsconfig", tsconfig, script, destination] };
}

/** Does the work after the response has gone out, and is the only thing that clears "running". */
export async function runCopy(user: { id: string; name: string }, runId: string, destination: string): Promise<void> {
  const ours = async () => (await copyJob())?.runId === runId;
  const step = async (text: string) => {
    const j = await copyJob();
    if (j?.runId === runId) await write({ ...j, step: text });
  };
  const fail = async (why: string, found?: { table: string; column: string; example: string }[]) => {
    if (!(await ours())) return;
    const j = await copyJob();
    const where = found?.length ? ` Still holding something: ${found.map((f) => `${f.table}.${f.column} (${f.example})`).join("; ")}.` : "";
    await write({ ...j!, state: "failed", finishedAt: new Date().toISOString(), step: why + where, error: why });
  };

  try {
    const result = await runCopyProcess(destination, step);
    if (!(await ours())) return;
    if (!result.ok) {
      await fail(result.why, result.found);
      await audit({ action: "backup.copy_for_claude_refused", userId: user.id, userName: user.name, details: result.why.slice(0, 400) });
      return;
    }
    const j = await copyJob();
    await write({
      ...j!,
      state: "done",
      finishedAt: new Date().toISOString(),
      path: result.path,
      bytes: result.bytes,
      step:
        `Done: ${(result.bytes / 1_048_576).toFixed(1)} MB. ` +
        `${result.prescriptions.toLocaleString()} prescription numbers replaced, ` +
        `${result.checked.toLocaleString()} values checked and none held an identifier.`,
    });
    await audit({
      action: "backup.copy_for_claude",
      userId: user.id,
      userName: user.name,
      details: `${result.path}, ${(result.bytes / 1_048_576).toFixed(1)} MB, ${result.checked.toLocaleString()} values checked`,
    });
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Reads the child's output a chunk at a time, which is not the same as a line at a time.
 *
 * A pipe hands over whatever has arrived, so one read can carry three messages and half of a
 * fourth. Keeping the remainder and prefixing it to the next chunk is the whole of it, and getting
 * it wrong shows up as a step that never appears or a result silently lost — which reads, from the
 * page, exactly like the button not working.
 */
export function readCopyLines(carried: string, chunk: string): { carried: string; messages: { step?: string; result?: CopyResult }[] } {
  const lines = (carried + chunk).split("\n");
  const rest = lines.pop() ?? "";
  const messages: { step?: string; result?: CopyResult }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Anything the child writes that is not one of its own messages is not ours to interpret.
    }
  }
  return { carried: rest, messages };
}

type CopyResult =
  | { ok: true; path: string; bytes: number; checked: number; prescriptions: number }
  | { ok: false; why: string; found?: { table: string; column: string; example: string }[] };

/**
 * Runs the copy in its own process, reporting each step as it is announced.
 *
 * If the separate process cannot be started — a deployment without the development tools beside it,
 * say — the work is done here instead. That is the slow path and it does freeze the site while it
 * runs, but a copy made slowly is better than a button that cannot work at all, and the job record
 * still says where it got to for anyone who reloads once it is over.
 */
async function runCopyProcess(destination: string, step: (s: string) => Promise<void>): Promise<CopyResult> {
  const plan = copyProcessPlan(process.cwd(), destination);
  if (!plan) {
    const { writeClaudeCopy } = await import("./backup-scrub");
    const r = await writeClaudeCopy(destination, step);
    return r.ok ? { ok: true, path: r.path, bytes: r.bytes, checked: r.checked, prescriptions: r.report.prescriptions } : r;
  }

  return await new Promise<CopyResult>((resolve) => {
    const child = spawn(plan.command, plan.args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let result: CopyResult | null = null;
    let pending = Promise.resolve();
    let out = "";
    let errors = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const read = readCopyLines(out, chunk.toString());
      out = read.carried;
      for (const message of read.messages) {
        // Steps are written one after another rather than all at once, so the page never goes backwards.
        if (message.step) pending = pending.then(() => step(message.step!)).catch(() => {});
        if (message.result) result = message.result;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-2000);
    });

    const finish = (fallback: string) => {
      pending.then(() => resolve(result ?? { ok: false, why: fallback }));
    };
    child.on("error", (e) => finish(`The copy could not be started: ${e.message}`));
    child.on("close", (code) =>
      finish(
        `The copy stopped without saying why (exit ${code ?? "unknown"}).` + (errors.trim() ? ` It reported: ${errors.trim().split("\n").slice(-3).join(" ")}` : ""),
      ),
    );
  });
}
