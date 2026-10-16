import { redirect } from "next/navigation";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { checkForUpdates, currentVersion, lastUpdateLog, launcherActive, refreshUpdateCheck, requestUpdateAndRestart } from "@/lib/updates";
import { PageHeader, BackLink, Notice } from "@/components/ui";

export const metadata = { title: "Updates" };

export default async function UpdatesPage({ searchParams }: { searchParams: Promise<{ check?: string; error?: string }> }) {
  const user = await requireManager();
  const { check, error } = await searchParams;
  const version = await currentVersion();
  const launcher = launcherActive();
  /*
   * Checked on arrival, not on a button.
   *
   * This page opened saying nothing at all until "Check for updates" was pressed, so somebody who
   * came here because a fix had been promised was shown a blank page and left believing the fix
   * had not shipped. Coming to this page IS the request. The button stays, as "Check again", for
   * the minute after a push.
   */
  void check;
  const result = await checkForUpdates();
  // The once-a-day banner agrees with what this page just saw, rather than lagging it by a day.
  await refreshUpdateCheck().catch(() => {});
  const log = lastUpdateLog();

  async function doCheck() {
    "use server";
    redirect("/settings/updates?check=1");
  }

  async function doInstall() {
    "use server";
    const u = await requireManager();
    if (u.role !== "owner") redirect("/settings/updates?error=" + encodeURIComponent("Only the owner can install updates."));
    if (!launcherActive()) redirect("/settings/updates?error=" + encodeURIComponent("Start the app with “Start Pharmacy Admin” to install updates from here."));
    await audit({ action: "app.update.install", userId: u.id, userName: u.name });
    requestUpdateAndRestart();
    redirect("/settings/updates/installing");
  }

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader title="Updates" subtitle="New versions are published to the pharmacy's private GitHub repository. Check here and install with one click." />
      {version && <p className="mb-4 text-xs text-ink-3">This copy follows the <code>{version.branch}</code> branch and updates from it.</p>}
      {error && <Notice kind="crit">{error}</Notice>}
      {!launcher && <Notice kind="warn">The app was started by hand, so it can't restart itself. Close it and start it with <b>Start Pharmacy Admin</b> (the file in the app folder) to enable one-click updates.</Notice>}

      <section className="card mb-6 max-w-2xl">
        <h2 className="mb-2 font-semibold">Installed version</h2>
        {version ? (
          <p className="text-sm">
            <code>{version.commit}</code> · {version.date} · {version.subject}
            <span className="badge badge-muted ml-2">{version.branch}</span>
          </p>
        ) : (
          <p className="text-sm text-ink-3">Version information isn't available (Git not found).</p>
        )}
        <form action={doCheck} className="mt-3"><button className="btn">Check again</button></form>
      </section>

      {log && (
        <details className="card mb-6 max-w-2xl">
          <summary className="cursor-pointer text-sm font-medium text-accent">What happened during the last update</summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-ground p-3 text-[11px] text-ink-2">{log}</pre>
        </details>
      )}

      {result?.ok && result.behind > 0 && (
        <Notice kind="warn">
          <b>{result.behind} update{result.behind === 1 ? "" : "s"} waiting.</b> Press <b>Install and restart</b> below. Until you
          do, this computer is running the version it was running before them, so anything fixed in
          them is still broken here.
        </Notice>
      )}

      {result && (
        <section className="card max-w-2xl">
          {!result.ok ? (
            <Notice kind="crit">{result.error}</Notice>
          ) : result.behind === 0 ? (
            <p className="text-sm">You're up to date.</p>
          ) : (
            <>
              <h2 className="mb-2 font-semibold">{result.behind} update{result.behind === 1 ? "" : "s"} available on {result.branch}</h2>
              <ul className="mb-4 space-y-1 text-sm">
                {result.changes.map((c) => (
                  <li key={c.commit}><code className="text-xs">{c.commit}</code> <span className="text-ink-3">{c.date}</span> {c.subject}</li>
                ))}
              </ul>
              <p className="mb-3 text-xs text-ink-3">Installing takes one to three minutes. The app restarts itself; everyone using it will be signed out briefly. Your data is not touched.</p>
              <form action={doInstall}><button className="btn btn-primary" disabled={!launcher || user.role !== "owner"}>Install and restart</button></form>
            </>
          )}
        </section>
      )}
    </>
  );
}
