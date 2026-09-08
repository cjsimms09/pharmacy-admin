import "server-only";
import { getSettings, setSetting } from "./settings";
import { audit } from "./audit";

/**
 * The FDA drug directory fetch, as a job rather than as a request.
 *
 * Two zips from the FDA — the NDC Directory and the Orange Book — running to tens of megabytes
 * between them, then a join that replaces every row. Done inside the button's own request it
 * freezes the whole site, exactly as the NADAC fetch used to: the browser's router waits on a
 * pending action, so no other link answers until the download finishes. So the press claims the
 * job and returns at once, and the work runs behind the response writing where it has got to.
 *
 * The same shape as `nadac-job`, deliberately: one settings key holding the job, a claim written
 * and read back so two presses cannot both start, and a restart marking an orphan failed rather
 * than hiding the button for half an hour behind a job that no longer exists.
 */
export type DirectoryJob = {
  state: "running" | "done" | "failed";
  runId: string;
  startedAt: string;
  updatedAt?: string;
  finishedAt?: string;
  by: string;
  step: string;
  error?: string;
};

const STALE_MS = 5 * 60 * 1000;

export async function directoryJob(): Promise<DirectoryJob | null> {
  const s = await getSettings();
  return parseDirectoryJob(s.drug_directory_job);
}

export function parseDirectoryJob(raw: string | undefined): DirectoryJob | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as DirectoryJob;
    return j && typeof j.state === "string" ? j : null;
  } catch {
    return null;
  }
}

export function directoryJobRunning(job: DirectoryJob | null, now = Date.now()): boolean {
  if (!job || job.state !== "running") return false;
  const last = Date.parse(job.updatedAt ?? job.startedAt);
  return Number.isFinite(last) && now - last < STALE_MS;
}

async function write(job: DirectoryJob): Promise<void> {
  await setSetting("drug_directory_job", JSON.stringify({ ...job, updatedAt: new Date().toISOString() }));
}

/** A job cannot survive a restart, so one still marked running was killed mid-way. */
export async function failOrphanedDirectoryJob(): Promise<void> {
  const j = await directoryJob();
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
export async function startDirectoryFetch(user: { id: string; name: string }): Promise<{ started: boolean; message: string; runId?: string }> {
  const existing = await directoryJob();
  if (directoryJobRunning(existing)) {
    return { started: false, message: `Already fetching — ${existing!.step}. This page shows it as it goes.` };
  }
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await write({ state: "running", runId, startedAt: new Date().toISOString(), by: user.name, step: "Starting" });
  const settled = await directoryJob();
  if (settled?.runId !== runId) return { started: false, message: "Already fetching. This page shows it as it goes." };
  return {
    started: true,
    runId,
    message: "Fetching the FDA's directory and the Orange Book in the background. You can leave this page — it will say here when it is done.",
  };
}

/** Does the work after the response has gone out, and is the only thing that clears "running". */
export async function runDirectoryFetch(user: { id: string; name: string }, runId: string): Promise<void> {
  const ours = async () => (await directoryJob())?.runId === runId;
  const step = async (text: string) => {
    const j = await directoryJob();
    if (j?.runId === runId) await write({ ...j, step: text });
  };
  try {
    await step("Downloading ndctext.zip and the Orange Book from fda.gov");
    const { fetchDrugDirectory } = await import("./drug-directory-store");
    const r = await fetchDrugDirectory({ userId: user.id }, { onStep: step });
    if (!(await ours())) return;
    const j = await directoryJob();
    const says = r.ok
      ? `Loaded ${r.rows.toLocaleString()} packages, ${r.rated.toLocaleString()} of them with an Orange Book rating.`
      : r.why;
    await write({ ...j!, state: r.ok ? "done" : "failed", finishedAt: new Date().toISOString(), step: says, error: r.ok ? undefined : says });
    // The drug file groups on this, so it has to be rebuilt before anyone reads equivalents again.
    if (r.ok) (await import("./drug-catalog")).forgetDrugFile();
    await audit({ action: "drug_directory.fetch", userId: user.id, userName: user.name, details: says.slice(0, 200) });
  } catch (e) {
    if (!(await ours())) return;
    const j = await directoryJob();
    const msg = e instanceof Error ? e.message : String(e);
    await write({ ...j!, state: "failed", finishedAt: new Date().toISOString(), step: msg, error: msg });
  }
}
