import "server-only";
import { getSettings, setSetting } from "./settings";
import { fetchNadacFrom, type FetchResult } from "./nadac-fetch";
import { audit } from "./audit";

/**
 * The NADAC "Fetch now" press, as a job rather than as a request.
 *
 * It froze the site. The whole download, parse and load ran inside the button's own request —
 * tens of megabytes for a weekly file, far more for a year — and the browser's router waits on a
 * pending action, so every link on the site stopped answering until it finished. The site had not
 * broken; there was no way for the person looking at it to know that. This is the same failure the
 * "Put it right" button had, and the same fix: the press starts the work and returns at once, the
 * work runs behind the response writing where it has got to, and the page shows that.
 *
 * Pressing again while it runs is refused rather than doubled. The fetch itself is idempotent —
 * prices are keyed on NDC and effective date — so a second run would not corrupt anything, but it
 * would double the wait and hold the database for twice as long.
 */
export type NadacJob = {
  state: "running" | "done" | "failed";
  runId: string;
  startedAt: string;
  /** When the job last wrote a step. Staleness is judged on this, not on when it began. */
  updatedAt?: string;
  finishedAt?: string;
  by: string;
  /** What is being fetched, in words: "the current weekly file", "the 2026 archive". */
  what: string;
  step: string;
  result?: FetchResult;
  error?: string;
};

/**
 * A fetch that has written nothing for this long is presumed dead.
 *
 * Judged on the last step written, not on when the job began: a year archive legitimately runs
 * for many minutes, but it reports progress every few seconds while it does. Thirty minutes from
 * the start was the old rule, and after a restart it hid the button for half an hour with a job
 * that no longer existed — which read as "NADAC is broken again".
 */
const STALE_MS = 5 * 60 * 1000;

export async function nadacJob(): Promise<NadacJob | null> {
  const s = await getSettings();
  return parseNadacJob(s.nadac_job);
}

export function parseNadacJob(raw: string | undefined): NadacJob | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as NadacJob;
    return j && typeof j.state === "string" ? j : null;
  } catch {
    return null;
  }
}

export function nadacJobRunning(job: NadacJob | null, now = Date.now()): boolean {
  if (!job || job.state !== "running") return false;
  const last = Date.parse(job.updatedAt ?? job.startedAt);
  return Number.isFinite(last) && now - last < STALE_MS;
}

async function write(job: NadacJob): Promise<void> {
  await setSetting("nadac_job", JSON.stringify({ ...job, updatedAt: new Date().toISOString() }));
}

/**
 * Called once when the site starts: a job cannot survive a restart, so one still marked running
 * was killed mid-way. It is marked failed with a reason, and the button is back at once.
 */
export async function failOrphanedNadacJob(): Promise<void> {
  const j = await nadacJob();
  if (!j || j.state !== "running") return;
  await write({
    ...j,
    state: "failed",
    finishedAt: new Date().toISOString(),
    step: "The site restarted while this was running, so it did not finish. Press Fetch now again.",
    error: "interrupted by a restart",
  });
}

/**
 * Claims the job, or says why not. Same claim-and-verify as the manual job: write an id, read it
 * back, proceed only if it is still ours, so two presses a moment apart cannot both start.
 */
export async function startNadacFetch(
  user: { id: string; name: string },
  what: string,
): Promise<{ started: boolean; message: string; runId?: string }> {
  const existing = await nadacJob();
  if (nadacJobRunning(existing)) {
    return { started: false, message: `Already fetching ${existing!.what} — ${existing!.step}. This page shows it as it goes.` };
  }
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await write({ state: "running", runId, startedAt: new Date().toISOString(), by: user.name, what, step: "Starting" });
  const settled = await nadacJob();
  if (settled?.runId !== runId) return { started: false, message: "Already fetching. This page shows it as it goes." };
  return {
    started: true,
    runId,
    message: `Fetching ${what} in the background. You can leave this page — it will say here when it is done.`,
  };
}

/** Does the work after the response has gone out, and is the only thing that clears "running". */
export async function runNadacFetch(
  user: { id: string; name: string },
  runId: string,
  what: string,
  sources: string[],
): Promise<void> {
  const ours = async () => (await nadacJob())?.runId === runId;
  const step = async (text: string) => {
    const j = await nadacJob();
    if (j?.runId === runId) await write({ ...j, step: text });
  };
  try {
    await step(`Fetching ${what}`);
    const r = await fetchNadacFrom(sources, step);
    if (!(await ours())) return;
    const j = await nadacJob();
    await write({ ...j!, state: r.ok ? "done" : "failed", finishedAt: new Date().toISOString(), step: r.message, result: r, error: r.ok ? undefined : r.message });
    await audit({ action: "nadac.fetch", userId: user.id, userName: user.name, details: `${what} — ${r.message.slice(0, 200)}` });
  } catch (e) {
    if (!(await ours())) return;
    const j = await nadacJob();
    const msg = e instanceof Error ? e.message : String(e);
    await write({ ...j!, state: "failed", finishedAt: new Date().toISOString(), step: msg, error: msg });
  }
}
