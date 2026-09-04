import "server-only";
import { getSettings, setSetting } from "./settings";
import { putRight, type PutRightResult } from "./manual-audit";
import { hasApiKey } from "./ai";
import { audit } from "./audit";

/**
 * The "Put it right" press, as a job rather than as a request.
 *
 * This is the fix for a real and repeated failure. The work took a minute or more and it happened
 * inside the button's own request, which does two bad things at once. The browser's router waits
 * on a pending action, so every other link on the site stops responding until it returns — the
 * site had not frozen, but there is no way for the person looking at it to know that. And a press
 * whose only sign of life is a spinner that eventually disappears is one nobody can tell is
 * working, so it gets pressed again, and then reported as broken.
 *
 * So the press now does one thing: it starts this, and comes straight back. The work runs behind
 * the response, writing where it has got to as it goes, and the page shows that. Nothing is lost
 * if the browser is closed — each piece of work is saved as it finishes — and pressing again
 * while it runs is refused rather than doubled.
 *
 * The state lives in settings rather than in memory on purpose: the page that has to display it
 * is rendered on the server, possibly by a different worker, and memory does not survive a
 * restart of a computer that gets switched off every night.
 */

export type ManualJob = {
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  by: string;
  /** What it is doing right now, in words meant for the person waiting. */
  step: string;
  done: number;
  total: number;
  result?: PutRightResult;
  error?: string;
};

/**
 * How long a job may go quiet before it is presumed dead.
 *
 * A pharmacy computer gets switched off with work in flight, and a "running" that never clears
 * would lock the button out for good. Twenty minutes is far longer than the longest real pass and
 * short enough that nobody is stuck for an afternoon.
 */
const STALE_MS = 20 * 60 * 1000;

/** How long one press is allowed to work for. Nothing is waiting on it, so it can finish. */
const BUDGET_MS = 8 * 60 * 1000;

export async function manualJob(): Promise<ManualJob | null> {
  const s = await getSettings();
  return parseJob(s.manual_job);
}

export function parseJob(raw: string | undefined): ManualJob | null {
  if (!raw?.trim()) return null;
  try {
    const j = JSON.parse(raw) as ManualJob;
    if (j && typeof j === "object" && typeof j.state === "string") return j;
  } catch {
    // A corrupt job record is not worth an error page. It means "no job".
  }
  return null;
}

/** Whether a job claiming to be running has simply stopped saying so. */
export function isStale(job: ManualJob | null, now = Date.now()): boolean {
  if (!job || job.state !== "running") return false;
  const at = Date.parse(job.finishedAt ?? job.startedAt);
  return !Number.isFinite(at) || now - at > STALE_MS;
}

/** Whether a job is genuinely in flight right now. */
export function isRunning(job: ManualJob | null, now = Date.now()): boolean {
  return job?.state === "running" && !isStale(job, now);
}

/** How long ago, in words, without pretending to more precision than anybody needs. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "a minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs === 1) return "an hour ago";
  if (hrs < 24) return `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

async function write(job: ManualJob): Promise<void> {
  await setSetting("manual_job", JSON.stringify(job));
}

/**
 * Starts a pass, or says why it did not.
 *
 * Returns rather than throws, because every reason it might not start is something the person who
 * pressed the button needs told in a sentence: it is already going, or Claude is not connected.
 */
export async function startPutRight(user: { id: string; name: string }): Promise<{ started: boolean; message: string }> {
  const existing = await manualJob();
  if (isRunning(existing)) {
    return {
      started: false,
      message: `It is already running — ${existing!.step.charAt(0).toLowerCase()}${existing!.step.slice(1)}. This page shows it as it goes.`,
    };
  }

  if (!(await hasApiKey())) {
    return {
      started: false,
      message:
        "Claude is not connected, so nothing can be drafted or read against the rules. Add your Anthropic API key under Settings → Claude and press this again.",
    };
  }

  const job: ManualJob = {
    state: "running",
    startedAt: new Date().toISOString(),
    by: user.name,
    step: "Starting",
    done: 0,
    total: 0,
  };
  await write(job);
  return { started: true, message: "Started. It works through the manual in the background — this page shows where it has got to, and you can leave it or carry on using the site." };
}

/**
 * Does the work, and is the only thing that clears the "running" state.
 *
 * Called after the response has gone out, so nothing is waiting on it. Every failure is caught and
 * recorded: a job that dies silently leaves a button that can never be pressed again.
 */
export async function runPutRight(user: { id: string; name: string }): Promise<void> {
  const started = new Date().toISOString();
  const beat = async (p: { step: string; done: number; total: number }) => {
    await write({ state: "running", startedAt: started, by: user.name, step: p.step, done: p.done, total: p.total, finishedAt: new Date().toISOString() });
  };
  try {
    const result = await putRight(user, { auditLimit: 40, draftLimit: 40, budgetMs: BUDGET_MS, onProgress: beat });
    await write({
      state: "done",
      startedAt: started,
      finishedAt: new Date().toISOString(),
      by: user.name,
      step: "Finished",
      done: 0,
      total: 0,
      result,
    });
    await audit({
      action: "manual.put_right",
      userId: user.id,
      userName: user.name,
      details: `${result.pointed} pointed, ${result.drafted} drafted, ${result.audited} read, ${result.raised} raised`,
    });
  } catch (e) {
    const { describeError } = await import("./ai");
    await write({
      state: "failed",
      startedAt: started,
      finishedAt: new Date().toISOString(),
      by: user.name,
      step: "Stopped",
      done: 0,
      total: 0,
      error: describeError(e),
    });
    await audit({ action: "manual.put_right.failed", userId: user.id, userName: user.name, details: describeError(e) });
  }
}

/**
 * What a finished pass actually did, in one sentence.
 *
 * "Nothing needed doing" is a real and good outcome, and has to read like one rather than like a
 * failure — it is what the button should say most of the time once the manual is in order.
 */
export function summarise(r: PutRightResult): string {
  const said = [
    r.regenerated ? `${r.regenerated} generated section${r.regenerated === 1 ? "" : "s"} brought level with the site` : "",
    r.pointed ? `${r.pointed} heading${r.pointed === 1 ? "" : "s"} pointed at the form this site produces` : "",
    r.drafted ? `${r.drafted} ${r.drafted === 1 ? "policy" : "policies"} drafted` : "",
    r.markersRemoved ? `${r.markersRemoved} footnote marker${r.markersRemoved === 1 ? "" : "s"} removed` : "",
    r.audited ? `${r.audited} section${r.audited === 1 ? "" : "s"} read against the rules` : "",
    r.raised ? `${r.raised} finding${r.raised === 1 ? "" : "s"} raised` : "",
  ].filter(Boolean);
  const left = [
    r.stillEmpty ? `${r.stillEmpty} heading${r.stillEmpty === 1 ? "" : "s"} still to write` : "",
    r.remaining ? `${r.remaining} section${r.remaining === 1 ? "" : "s"} still to read` : "",
  ].filter(Boolean);
  return [said.length ? said.join(", ") : "Nothing needed doing", left.length ? `Left: ${left.join(", ")}` : ""]
    .filter(Boolean)
    .join(". ");
}

/**
 * Clears a job whose process is no longer there.
 *
 * A pharmacy computer gets switched off at the end of the day, sometimes with a pass in flight.
 * Nothing would ever finish that job or mark it failed, and a "running" that never clears means a
 * button that can never be pressed again — the failure looks exactly like the one this whole file
 * exists to fix. So the background beat sweeps it up.
 */
export async function reapStale(): Promise<boolean> {
  const job = await manualJob();
  if (!isStale(job) || !job) return false;
  await write({
    ...job,
    state: "failed",
    finishedAt: new Date().toISOString(),
    step: "Stopped",
    error: "It stopped before finishing — normally the computer being switched off or restarted. Everything done up to that point was saved.",
  });
  return true;
}
