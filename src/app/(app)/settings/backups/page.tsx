import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { setSetting } from "@/lib/settings";
import { runBackup, backupStatus, pruneBackups, encryptionKey, rehearseRestore } from "@/lib/backup";
import { detectCloudFolders, backupFolderIn, isInside } from "@/lib/cloud-folders";
import { PageHeader, Notice, BackLink, Empty, Field, Figure } from "@/components/ui";
import { fmtLong } from "@/lib/dates";

export const metadata = { title: "Backups" };
export const dynamic = "force-dynamic";

const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;

export default async function BackupsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; showKey?: string }> }) {
  await requireManager();
  const { ok, error, showKey } = await searchParams;
  const [s, clouds] = await Promise.all([backupStatus(), detectCloudFolders()]);
  const key = showKey === "1" ? encryptionKey() : null;

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    await setSetting("backup_destination", String(fd.get("destination") ?? "").trim());
    await setSetting("backup_destination_2", String(fd.get("destination2") ?? "").trim());
    await setSetting("backup_destination_3", String(fd.get("destination3") ?? "").trim());
    await setSetting("backup_enabled", fd.get("enabled") ? "yes" : "no");
    await setSetting("backup_keep", String(Number(fd.get("keep")) || 14));
    await audit({ action: "backup.settings", userId: u.id, userName: u.name });
    revalidatePath("/settings/backups");
    redirect("/settings/backups?ok=" + encodeURIComponent("Saved."));
  }

  async function now() {
    "use server";
    const u = await requireManager();
    const st = await backupStatus();
    try {
      const r = await runBackup(st.destination, [st.destination2, st.destination3]);
      if (r.ok) for (const where of st.destinations) await pruneBackups(where, st.keepCount);
      await audit({ action: "backup.run", userId: u.id, userName: u.name, details: r.message });
      revalidatePath("/settings/backups");
      redirect(`/settings/backups?${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/settings/backups?error=" + encodeURIComponent(e instanceof Error ? e.message : "The backup failed."));
    }
  }

  /**
   * Points the second copy at a synced folder, in one press.
   *
   * The alternative is finding the OneDrive path in Explorer and typing it correctly, which is
   * where this stops happening. Set as the *second* destination rather than the first on purpose:
   * the working copy of a backup should be somewhere a file appears immediately, and a sync client
   * that is paused, signed out or out of space would otherwise be the only place anything went.
   */
  async function useCloud(fd: FormData) {
    "use server";
    const u = await requireManager();
    const root = String(fd.get("root") ?? "").trim();
    if (!root) redirect("/settings/backups?error=" + encodeURIComponent("No folder was chosen."));
    const dest = backupFolderIn(root);
    // Into whichever further slot is free, so a second cloud folder does not overwrite the first.
    const st = await backupStatus();
    const slot = !st.destination2 ? "backup_destination_2" : "backup_destination_3";
    await setSetting(slot, dest);
    await audit({ action: "backup.settings", userId: u.id, userName: u.name, details: `${slot} \u2192 ${dest}` });
    revalidatePath("/settings/backups");
    redirect(
      "/settings/backups?ok=" +
        encodeURIComponent(
          `Every verified archive will now also be written to ${dest}, and read back to prove it arrived. Press \u201cBack up now\u201d to put one there straight away and confirm it syncs.`,
        ),
    );
  }

  async function rehearse() {
    "use server";
    const u = await requireManager();
    const st = await backupStatus();
    const r = await rehearseRestore(st.destination);
    await audit({ action: "backup.rehearse", userId: u.id, userName: u.name, details: r.message });
    revalidatePath("/settings/backups");
    redirect(`/settings/backups?${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
  }

  const hoursSince = s.lastRun ? (Date.now() - Date.parse(s.lastRun)) / 3_600_000 : null;
  const rehearsalDays = s.restoreLast ? Math.floor((Date.now() - Date.parse(s.restoreLast)) / 86_400_000) : null;
  const copies = s.destinations.length;

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader
        title="Backups"
        subtitle="Everything else here is worthless if this machine dies. A backup is not a backup until it has been read back, so every one is verified before it is kept."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {s.existing.length === 0 && <Notice kind="crit">No backup has ever been taken.</Notice>}

      <div className="my-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          value={!s.enabled ? "off" : hoursSince === null ? "never" : hoursSince < 36 ? "yes" : "late"}
          label="Backed up daily"
          sub={
            !s.enabled
              ? "Switched off — nothing here survives this computer"
              : s.lastRun
                ? `Last ${new Date(s.lastRun).toLocaleString()}`
                : "Runs within a day of the computer being switched on"
          }
          tone={!s.enabled || hoursSince === null ? "crit" : hoursSince < 36 ? "ok" : "warn"}
        />
        <Figure
          value={copies}
          label={copies === 1 ? "Copy of each backup" : "Copies of each backup"}
          sub={copies === 1 ? "One disk failing loses all of it" : "Written and read back in both places"}
          tone={copies > 1 ? "ok" : "crit"}
        />
        <Figure
          value={rehearsalDays === null ? "never" : rehearsalDays === 0 ? "today" : `${rehearsalDays}d`}
          label="Since a restore was proved"
          sub={rehearsalDays === null ? "Nobody has opened a backup and checked it comes back" : "Rehearsed automatically once a month"}
          tone={rehearsalDays === null ? "warn" : rehearsalDays > 45 ? "warn" : "ok"}
        />
        <Figure value={s.existing.length} label="Archives held" sub={`Oldest kept: ${s.keepCount}`} tone={s.existing.length > 0 ? "ok" : "crit"} />
      </div>

      {!s.enabled && (
        <Notice kind="crit">
          Automatic backups are switched off. Everything in this system — the CQI record, the training file, the
          inventories, every uploaded document — exists on one disk and nowhere else. Turn it back on below.
        </Notice>
      )}

      {s.enabled && s.destinations.length < 2 && (
        <Notice kind="warn">
          There is one copy of each backup. That covers this computer dying; it does not cover the backup drive dying,
          the folder being deleted, or a fire. Set a second place below — a USB drive kept somewhere else, a network
          folder, or a synced cloud folder — and each verified archive is written and read back in both.
        </Notice>
      )}

      {s.restoreResult && (s.restoreResult.includes("could NOT") || (rehearsalDays ?? 0) > 45) && (
        <Notice kind={s.restoreResult.includes("could NOT") ? "crit" : "warn"}>
          <b>Last restore rehearsal{s.restoreLast ? ` (${fmtLong(s.restoreLast.slice(0, 10))})` : ""}:</b> {s.restoreResult}
        </Notice>
      )}

      {s.onSameDisk && s.destinations.length < 2 && (
        <Notice kind="warn">
          Backups are going into the application&rsquo;s own data folder, which is on the same disk as the thing they
          are protecting. A failed drive or a stolen laptop takes both. Point this at a USB drive, a network folder, or
          a synced cloud folder such as OneDrive or Dropbox.
        </Notice>
      )}

      {/*
        The off-site copy, made easy enough that it actually happens.

        Windows records where OneDrive syncs to, so the folder is offered as a button rather than
        as a path to find in Explorer and type without a typo. The account distinction is stated
        because it decides something real: these archives hold the whole record, and Microsoft will
        sign a business associate agreement for a work or school account and not for a personal one.
      */}
      {clouds.length > 0 && (
        <section className="my-4 rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">Send a copy to OneDrive</h2>
          <p className="mt-0.5 text-sm text-ink-2">
            A folder that syncs to the cloud is the second copy that survives this building. Each archive is verified
            here, written there, and read back to prove it arrived &mdash; the sync client then carries it off the
            premises on its own, with nobody remembering to do anything.
          </p>
          <ul className="rows mt-2">
            {clouds.map((c) => {
              const dest = backupFolderIn(c.path);
              const already =
                isInside(s.destination2 ?? "", c) || isInside(s.destination3 ?? "", c) || isInside(s.destination, c);
              return (
                <li key={c.path} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{c.label}</span>
                    <span className="block font-mono text-xs text-ink-3">{dest}</span>
                    {!c.baaAvailable && (
                      <span className="mt-0.5 block text-xs text-warn">
                        {c.kind === "personal"
                          ? "A personal account, and Microsoft only offers a business associate agreement on Microsoft 365 business and enterprise plans. Sign in to OneDrive with the pharmacy's own Microsoft account instead, or use a USB drive kept off the premises — there is no agreement to sign with a drive."
                          : "Check the account before using this one. Google will sign a business associate agreement for a Google Workspace account and not for a personal one; Dropbox for Dropbox Business and not for Basic. Nothing about the folder on this computer says which you have."}
                      </span>
                    )}
                  </span>
                  {already ? (
                    <span className="badge badge-ok shrink-0">in use</span>
                  ) : s.destination2 && s.destination3 ? (
                    <span className="text-xs text-ink-3">all three places are set</span>
                  ) : (
                    <form action={useCloud} className="shrink-0">
                      <input type="hidden" name="root" value={c.path} />
                      <button className="btn btn-sm btn-primary">
                        Use as the {s.destination2 ? "third" : "second"} copy
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-ink-3">
            The archive holds the whole record &mdash; incidents, staff files, documents, every invoice. Whoever stores
            it is storing protected health information, and encrypting it first does not change that: HHS treats a
            cloud provider holding encrypted health records as a business associate even when it has no key. So the
            question is only ever who you have an agreement with. A pharmacy Microsoft 365 or Google Workspace account
            carries one; a personal Microsoft or Google account does not; a USB drive in a locked drawer at home needs
            none, because there is nobody to have it with. Do not share the folder with anybody. The API keys and the
            mail password are not in the archive at all.
          </p>
        </section>
      )}

      {clouds.length === 0 && s.destinations.length < 2 && (
        <Notice kind="warn">
          <b>No synced folder was found on this computer.</b> If OneDrive is signed in, its folder is usually{" "}
          <code>C:\Users\&lt;you&gt;\OneDrive</code> or <code>C:\Users\&lt;you&gt;\OneDrive - Your Company</code>. Put
          that path with <code>\PharmacyAdminBackups</code> on the end into the second box below, and every verified
          archive is written and read back there too. A work or school OneDrive is the right one: Microsoft will sign a
          business associate agreement for those and not for a personal account.
        </Notice>
      )}

      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <form action={save} className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Where to put them"
            hint="A full folder path. A USB drive or a synced cloud folder is right; a folder on this machine is better than nothing but does not survive the machine."
            className="sm:col-span-2"
          >
            <input name="destination" defaultValue={s.destination} className="field font-mono" placeholder="D:\\PharmacyBackups" />
          </Field>
          <Field
            label="And a second place"
            hint="Somewhere that does not fail at the same time as the first. A USB drive kept off the premises is the simplest answer and needs no agreement with anybody; a pharmacy OneDrive works and carries one; a personal cloud account does not. Every archive that passes verification is written and read back here too."
            className="sm:col-span-2"
          >
            <input name="destination2" defaultValue={s.destination2 ?? ""} className="field font-mono" placeholder="Leave empty for one copy only" />
          </Field>
          <Field
            label="And a third"
            hint="Three copies, on two kinds of media, one of them off the premises — the rule worth following. A USB drive in a drawer and a synced cloud folder fail in different ways, and neither of them is this computer."
            className="sm:col-span-2"
          >
            <input name="destination3" defaultValue={s.destination3 ?? ""} className="field font-mono" placeholder="Leave empty for two copies" />
          </Field>
          <Field label="How many to keep" hint="Older ones beyond this are deleted after each successful run.">
            <input name="keep" type="number" min={1} max={365} defaultValue={s.keepCount} className="field" />
          </Field>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={s.enabled} />
              Back up automatically once a day
            </label>
          </div>
          <div className="sm:col-span-2 flex gap-2">
            <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Save</button>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          <form action={now}>
            <button className="btn">Back up now</button>
          </form>
          <form action={rehearse}>
            <button className="btn">Prove the newest backup restores</button>
          </form>
        </div>
        {s.lastRun && (
          <p className="mt-2 text-xs text-ink-3">
            Last run {new Date(s.lastRun).toLocaleString()} — {s.lastResult}
          </p>
        )}
      </section>

      <h2 className="mt-8 text-sm font-semibold">Archives held</h2>
      {s.existing.length === 0 ? (
        <div className="mt-2"><Empty>None yet.</Empty></div>
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface text-sm">
          {s.existing.map((b) => (
            <li key={b.name} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="font-mono text-xs">{b.name}</span>
              <span className="whitespace-nowrap text-xs text-ink-3">{mb(b.sizeBytes)} · {new Date(b.takenAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}

      {/* ── The key ── */}
      <h2 className="mt-8 text-sm font-semibold">The encryption key</h2>
      <section className="mt-2 rounded-lg border border-line bg-surface p-4 text-sm">
        <p className="text-ink-2">
          The Anthropic API key, the MTF key and the mail password are stored encrypted. The key that unlocks them
          lives in the <code>.env</code> file on this machine and is <b>deliberately kept out of the backups</b> — if it
          were in them, every copy of a backup would carry both the locked box and its key.
        </p>
        <p className="mt-2 text-ink-2">
          That means it has to be written down somewhere else: a password manager, or on paper in the safe. Without it,
          a restore onto a new machine works fine but those three credentials have to be entered again.
        </p>
        {key ? (
          <div className="mt-3">
            <p className="text-xs text-ink-3">Write this down and store it away from the backups.</p>
            <pre className="mt-1 overflow-x-auto rounded-md border border-line bg-ground p-3 font-mono text-sm">{key}</pre>
            <a href="/settings/backups" className="mt-2 inline-block text-xs underline">Hide it</a>
          </div>
        ) : (
          <a href="/settings/backups?showKey=1" className="mt-3 inline-block rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">
            Show the key so I can write it down
          </a>
        )}
      </section>

      <h2 className="mt-8 text-sm font-semibold">What is in a backup, and how to use one</h2>
      <section className="mt-2 rounded-lg border border-line bg-surface p-4 text-sm">
        <ul className="list-disc space-y-1 pl-5 text-ink-2">
          <li>The whole database, and every document ever uploaded.</li>
          <li>
            An ordinary ZIP file containing an ordinary SQLite database. You do not need this application to open it,
            which is the point — a backup only this software can read is not a backup.
          </li>
          <li>
            <b>Verified before it is kept.</b> The archive is read back off the disk, the database inside is opened, and
            its row counts are compared table by table against the live one. Anything that fails is deleted rather than
            kept, because a bad backup sitting beside good ones is worse than none: it is the one you would reach for.
          </li>
          <li>
            A <code>HOW-TO-RESTORE.txt</code> is inside each archive, so the instructions are wherever the file is
            rather than only in an application you may not be able to start.
          </li>
          <li>
            <b>Proved again once a month.</b> Verifying at the moment of writing proves the write; it does not prove the
            file survived. So the newest archive is opened as a stranger would open it — off disk, restored to a
            scratch database — and counted. If it will not come back, this page says so before the day it matters.
          </li>
          <li>
            <b>The archive itself is not encrypted, deliberately.</b> A backup you cannot open without a password you
            have lost is not a backup, and this one has to be restorable in ten years by somebody who has never seen
            this software. The two credentials that would be dangerous — the API key and the mail password — are
            encrypted inside it and their key is kept out, as above. Everything else is readable: staff records,
            licence numbers, prescription numbers, business figures. No patient-identifying information, because this
            application does not store any. Put the archives somewhere you would put a personnel file: a drive you
            control, a locked drawer, a cloud account with two-factor sign-in on it.
          </li>
        </ul>
      </section>
    </>
  );
}
