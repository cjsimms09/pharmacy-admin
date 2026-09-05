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
      // On unless deliberately switched off: the pharmacy that most needs a backup is the one
      // that never found the switch.
      if (s.backup_enabled === "no") return;

      const { runBackup, backupStatus, pruneBackups, rehearseRestore } = await import("./lib/backup");
      const status = await backupStatus();

      const last = s.backup_last_run ? Date.parse(s.backup_last_run) : 0;
      if (!Number.isFinite(last) || Date.now() - last >= 20 * 60 * 60 * 1000) {
        const r = await runBackup(status.destination, [status.destination2, status.destination3]);
        // Prune every place a copy went, or the drive that is never looked at fills up quietly.
        if (r.ok) for (const where of status.destinations) await pruneBackups(where, status.keepCount);
        return; // one heavy job per turn; the rehearsal can wait for the next idle gap
      }

      /*
       * Once a month, prove an archive already on disk still restores.
       *
       * Verifying at the moment of writing proves the write. It does not prove the file survived
       * the month — that the stick is still good, that a sync client has not replaced it with a
       * placeholder, that the folder still exists. Those are the ways backups actually fail, and
       * every one is invisible until the day it matters.
       */
      const lastRehearsal = s.backup_restore_last ? Date.parse(s.backup_restore_last) : 0;
      if (!Number.isFinite(lastRehearsal) || Date.now() - lastRehearsal >= 30 * 24 * 60 * 60 * 1000) {
        await rehearseRestore(status.destination);
      }
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
      const { fetchDue, fetchNadac, nadacAuto } = await import("./lib/nadac-fetch");
      if (!nadacAuto(s)) return;
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
    await whenIdle("temperatures", tempTick);
    await whenIdle("cqi", cqiTick);
    await whenIdle("digest", digestTick);
    await whenIdle("updates", updateTick);
    await whenIdle("manual-audit", manualAuditTick);
    await whenIdle("deliveries", deliveryTick);
  };

  /**
   * Pulls temperature readings.
   *
   * Hourly rather than on the half-hourly beat: sensors report every few minutes, and a gap of
   * an hour in when they are collected is invisible in a monthly log.
   */
  const tempTick = async () => {
    try {
      const { hasCredentials, syncReadings } = await import("./lib/imonnit");
      if (!(await hasCredentials())) return;
      const { getSettings, setSetting } = await import("./lib/settings");
      const s = await getSettings();
      const last = s.imonnit_last_sync ? Date.parse(s.imonnit_last_sync) : 0;
      if (Number.isFinite(last) && Date.now() - last < 55 * 60 * 1000) return;
      await syncReadings();
      await setSetting("imonnit_last_sync", new Date().toISOString());
    } catch {
      // Recorded on the Temperatures page.
    }
  };

  /**
   * Runs the CQI cycle forward.
   *
   * Twice a day is plenty: the deadlines it serves are measured in days, and drafting an analysis
   * takes a minute or two of the shared connection.
   */
  const cqiTick = async () => {
    try {
      const { getSettings, setSetting } = await import("./lib/settings");
      const s = await getSettings();
      const last = s.cqi_automation_last ? Date.parse(s.cqi_automation_last) : 0;
      if (Number.isFinite(last) && Date.now() - last < 11 * 60 * 60 * 1000) return;
      const { runCqiAutomation } = await import("./lib/cqi-auto");
      const r = await runCqiAutomation();
      await setSetting("cqi_automation_last", new Date().toISOString());
      await setSetting(
        "cqi_automation_result",
        [
          r.reviewsStarted ? `${r.reviewsStarted} review(s) opened` : "",
          r.drafted ? `${r.drafted} analysis drafted` : "",
          r.attached ? `${r.attached} item(s) attached to the summary` : "",
          r.skipped ?? "",
        ].filter(Boolean).join(". ") || "Nothing to do.",
      );
    } catch {
      // Shown on the CQI page; never allowed to stop the app.
    }
  };

  /**
   * The weekly note to the pharmacist-in-charge.
   *
   * Last in the run, deliberately: it summarises the state of everything above it, so it should
   * read that state after those jobs have had their turn rather than before. Its own once-a-week
   * gate lives in the digest module, so running this hourly costs nothing.
   */
  const digestTick = async () => {
    try {
      const { sendWeeklyDigest } = await import("./lib/digest");
      await sendWeeklyDigest();
    } catch {
      // A digest that cannot be built or sent must never stop the app. Settings → Email shows
      // the last result, and everything in it is on the screen regardless.
    }
  };

  /**
   * Notices once a day that a newer version is waiting.
   *
   * Not because updating is urgent, but because the alternative was that it was never noticed at
   * all: the only way to find out was to open a settings sub-page and press a button, so fixes sat
   * on GitHub while the pharmacy kept hitting the bugs they fixed.
   */
  const updateTick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      const last = s.updates_last_check ? Date.parse(s.updates_last_check) : 0;
      if (Number.isFinite(last) && Date.now() - last < 20 * 60 * 60 * 1000) return;
      const { refreshUpdateCheck } = await import("./lib/updates");
      await refreshUpdateCheck();
    } catch {
      // Never allowed to stop the app. The outcome is recorded in settings either way.
    }
  };

  /**
   * Reads a few sections of the policy manual against the requirements.
   *
   * The regulation asks for an annual review, which in practice is a signature: nobody rereads a
   * hundred and fifty sections against Kansas, DEA, HIPAA and OSHA once a year, so a manual can be
   * reviewed on time for years and still describe a practice that stopped in year one.
   *
   * Four sections per turn, at most once an hour. That is deliberately slow — the deadline is a
   * year away, a long run would be a bill nobody chose and a page that appears to hang, and at
   * this rate the whole manual has been read long before it is due.
   */
  const manualAuditTick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (s.manual_audit_auto === "no") return;
      /*
       * Never at the same time as a pass somebody started by hand.
       *
       * Two passes reading and rewriting the same sections at once would race each other, and the
       * one a person is watching should win. This is also where a job whose process went away —
       * the computer switched off mid-pass — gets marked as stopped, so the button is never left
       * permanently unpressable.
       */
      const { reapStale, isRunning, manualJob } = await import("./lib/manual-job");
      await reapStale();
      if (isRunning(await manualJob())) return;
      const { hasApiKey } = await import("./lib/ai");
      if (!(await hasApiKey())) return;
      const last = s.manual_audit_last ? Date.parse(s.manual_audit_last) : 0;
      if (Number.isFinite(last) && Date.now() - last < 25 * 60 * 1000) return;
      const { runManualAudit, auditProgress } = await import("./lib/manual-audit");
      /*
       * Faster while there is a backlog, and idle to a crawl once there is not.
       *
       * This is where the bulk of the reading happens — the button on the page is only the part
       * that shows somebody it is working. A hundred and fifty sections at four an hour is most
       * of two days; at eight every half hour it is a few hours, all of it while nobody is using
       * the site, and it costs nothing once the manual is current because there is nothing due.
       */
      const progress = await auditProgress();
      await runManualAudit({ id: "system", name: "Annual audit" }, { limit: progress.due > 20 ? 8 : 4 });
    } catch {
      // The outcome is recorded in settings and shown on the manual page.
    }
  };

  /**
   * Sends a finished delivery month that has not gone out.
   *
   * The invoice normally goes at the moment the last weekday is entered, which is the right time
   * and needs no job at all. This is for the two ways that misses: the mail server was down that
   * afternoon, or the last day was entered and something threw. Once a day is enough — the driver
   * is not waiting on the hour.
   */
  const deliveryTick = async () => {
    try {
      const { getSettings, setSetting } = await import("./lib/settings");
      const s = await getSettings();
      if (s.driver_invoice_auto === "no") return;
      if (!s.driver_invoice_to || !s.mail_user || !s.mail_password_enc) return;
      const last = s.driver_invoice_last_check ? Date.parse(s.driver_invoice_last_check) : 0;
      if (Number.isFinite(last) && Date.now() - last < 20 * 60 * 60 * 1000) return;
      const { catchUpInvoices } = await import("./lib/deliveries");
      const done = await catchUpInvoices({ name: "Automatic" });
      await setSetting("driver_invoice_last_check", new Date().toISOString());
      if (done.length) await setSetting("driver_invoice_last_result", done.join(" "));
    } catch {
      // Shown on the Deliveries page either way; never allowed to stop the app.
    }
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
