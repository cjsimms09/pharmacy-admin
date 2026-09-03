/**
 * Runs once when the server starts.
 *
 * Two recurring jobs: the mailbox check, so reports arrive without anyone clicking anything, and
 * the daily backup. Both are wrapped so a failure records itself and never takes the app down —
 * a pharmacy that cannot open its compliance records because a mail server was unreachable would
 * be a worse outcome than either job missing a turn.
 *
 * Only active in the Node.js runtime of a running server.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_BACKGROUND_JOBS === "1") return;

  const EVERY_MS = 30 * 60 * 1000;
  const START_DELAY_MS = 60 * 1000; // let the server settle before the first check
  /** Nothing served for this long means it is safe to take the connection for a while. */
  const IDLE_SECONDS = 90;

  /**
   * One heavy job at a time, and only when nobody is using the site.
   *
   * The connection is serialized, so a job that takes a minute stops the site for a minute.
   * Waiting for a gap costs nothing — a backup taken ninety seconds after the last page load is
   * worth exactly what one taken during it is worth, and the pharmacy computer is idle almost
   * all day.
   */
  let busy = false;
  const whenIdle = async (name: string, job: () => Promise<void>) => {
    if (busy) return;
    const { isIdle } = await import("./lib/activity");
    if (!isIdle(IDLE_SECONDS)) return;
    busy = true;
    try {
      await job();
    } catch {
      // Every job records its own outcome. None may take the app down.
    } finally {
      busy = false;
    }
  };

  const tick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (s.mail_enabled !== "yes" || !s.mail_user || !s.mail_password_enc) return;
      const { sweepMailbox } = await import("./lib/mailbox");
      await sweepMailbox({ userId: null, userName: "Automatic check" });
    } catch {
      // Never let a mail problem take the app down; the result is recorded in settings and the audit log.
    }
  };

  /**
   * Backs up at most once a day.
   *
   * Checked on the same half-hourly beat rather than scheduled for a fixed hour, because this
   * runs on a pharmacy computer that is switched off overnight — a 2am job would simply never
   * happen. Instead it takes one whenever a day has passed since the last, which on a machine
   * used every day means shortly after it is turned on.
   */
  const backupTick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (s.backup_enabled !== "yes") return;

      const last = s.backup_last_run ? Date.parse(s.backup_last_run) : 0;
      if (Number.isFinite(last) && Date.now() - last < 20 * 60 * 60 * 1000) return;

      const { runBackup, backupStatus, pruneBackups } = await import("./lib/backup");
      const status = await backupStatus();
      const r = await runBackup(status.destination);
      if (r.ok) await pruneBackups(status.destination, status.keepCount);
    } catch {
      // The outcome is recorded in settings and shown on the backups page.
    }
  };

  /**
   * Chases outstanding training once a day.
   *
   * One reminder a week per person while it is outstanding, then four and it stops emailing and
   * becomes the PIC's problem instead. Past that point it is a management conversation, and
   * another copy in the inbox is not going to have it.
   */
  const reminderTick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (!s.mail_user || !s.mail_password_enc) return;
      const last = s.training_reminders_last ? Date.parse(s.training_reminders_last) : 0;
      if (Number.isFinite(last) && Date.now() - last < 20 * 60 * 60 * 1000) return;
      const { sendReminders } = await import("./lib/training-assignments");
      await sendReminders();
      const { setSetting } = await import("./lib/settings");
      await setSetting("training_reminders_last", new Date().toISOString());
    } catch {
      // Recorded on the training page; never allowed to stop the app.
    }
  };

  /**
   * Pulls NADAC from CMS.
   *
   * Runs whether or not the reimbursement pages are switched on, and deliberately so: each weekly
   * file carries only the prices in force that week, so a month with the collection off is a
   * month of history that has to be reconstructed file by file later. It is free, it is one
   * download, and having it already there is the whole point.
   */
  const nadacTick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (s.nadac_auto !== "yes") return;
      const { fetchDue, fetchNadac } = await import("./lib/nadac-fetch");
      if (!fetchDue(s.nadac_last_fetch || null)) return;
      await fetchNadac();
    } catch {
      // The outcome is recorded in settings and shown on the NADAC page.
    }
  };

  /**
   * Runs the jobs in turn, each waiting for a gap.
   *
   * Sequential rather than together: four jobs starting at once on one connection is the same
   * stall as one long job, and there is no hurry about any of them.
   */
  const runAll = async () => {
    await whenIdle("mail", tick);
    await whenIdle("backup", backupTick);
    await whenIdle("reminders", reminderTick);
    await whenIdle("nadac", nadacTick);
    await whenIdle("technician-list", technicianListTick);
  };

  /** Files the technician list for any whole month that does not have one. */
  const technicianListTick = async () => {
    try {
      const { fileDueSnapshots } = await import("./lib/technician-list");
      await fileDueSnapshots();
    } catch {
      // Nothing here may stop the app; the compliance screen shows any month still missing.
    }
  };

  setTimeout(() => {
    void runAll();
    setInterval(() => void runAll(), EVERY_MS).unref?.();
  }, START_DELAY_MS).unref?.();
}
