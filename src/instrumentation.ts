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
  // A job cannot survive a restart. One still marked running was killed mid-way, and leaving it
  // that way hides the Fetch button behind a job that no longer exists.
  void (async () => {
    try {
      /*
       * Wrong data does not wait for a quiet moment.
       *
       * The payer learner wrote one link before its guard existed — a BIN recorded as belonging to
       * Health Mart Atlas, which is the courier and not a plan — and three claims were stamped with
       * it. The undo was written and put on the nightly pass, and the nightly pass is gated on the
       * site being idle, so the correction sat unrun while the wrong names stayed on the claims and
       * I reported it as fixed.
       *
       * A correction of known-wrong data belongs here, at boot, with the other things that cannot
       * wait: it is one query when there is nothing to undo, and it now also runs on every restart
       * rather than once a night.
       */
      const { unlearnCourierLinks } = await import("./lib/payer-links");
      await unlearnCourierLinks();
      /*
       * And the inbox rows the same class of bug left behind.
       *
       * Two dedupes were looking their keys up the wrong way while the sweep ran twice an hour over
       * mail it had already read: 1,822 inbox rows for 180 delivered attachments. The leaks stopped
       * on 17 September; the rows did not go anywhere on their own, and an arrivals list that
       * counts one delivery twenty-eight times is not a list anybody can use to see what is late.
       *
       * Here rather than on the nightly pass for the reason above it — a correction of known-wrong
       * data does not wait for a quiet moment — and it costs one query when there is nothing to do.
       */
      const { collapseDuplicateInboxRows } = await import("./lib/inbox-dedupe-store");
      await collapseDuplicateInboxRows();
      /*
       * And the rebate statement that describes where the pharmacy stands.
       *
       * A May 2025 sample was filed 47 minutes after the July 2026 breakdown and took its place, so
       * the standing rate, the achieved compliance and the distance to the next band were all
       * sixteen months old. Filing now refuses to let an older statement do that; this puts the one
       * already on file back. A query when there is nothing to do.
       */
      const { correctStandingRebateStatement } = await import("./lib/rebate-report-store");
      await correctStandingRebateStatement();
      const { failOrphanedNadacJob } = await import("./lib/nadac-job");
      await failOrphanedNadacJob();
      const { failOrphanedDirectoryJob } = await import("./lib/drug-directory-job");
      await failOrphanedDirectoryJob();
      const { failOrphanedCopyJob } = await import("./lib/claude-copy-job");
      await failOrphanedCopyJob();
    } catch {
      // Nothing here is worth failing a boot over.
    }
  })();

  /**
   * How long a job may be starved by the site being busy before it runs anyway.
   *
   * The idle gate is right and stays: a heavy job during a page load is what froze sign-in. But it
   * was applied to the doors as well as to the housework, and a door that only opens when nobody is
   * looking is not a door.
   *
   * Measured on 16 September 2026, while the owner was asking whether two forwarded reports had come
   * in: the mailbox had not swept for eighty minutes. Nothing had failed. Each half-hourly beat found
   * somebody using the site — him, or a check of mine — skipped the sweep entirely, and did not try
   * again for another half hour. Every document this pharmacy receives comes through that sweep or
   * the SFTP pull beside it, and both could be starved indefinitely by the site being used, which is
   * to say by the pharmacy being open.
   *
   * So the gate now yields after ninety minutes. The worst case becomes a late sweep rather than no
   * sweep, and the jobs that fetch nothing from outside keep waiting politely for a gap.
   */
  const MAX_STARVED_MS = 90 * 60 * 1000;
  const lastRunAt = new Map<string, number>();

  let busy = false;
  const whenIdle = async (name: string, job: () => Promise<void>, opts: { evenWhenBusy?: boolean } = {}) => {
    if (busy) return;
    const { isIdle } = await import("./lib/activity");
    const starved = opts.evenWhenBusy === true && Date.now() - (lastRunAt.get(name) ?? 0) > MAX_STARVED_MS;
    if (!isIdle(IDLE_SECONDS) && !starved) return;
    busy = true;
    try {
      await job();
      lastRunAt.set(name, Date.now());
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
      // A report that just loaded changed the readings; compute them now rather than on the next page.
      await warmTick();
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
      const { fetchDue, nadacAuto } = await import("./lib/nadac-fetch");
      if (!nadacAuto(s)) return;
      if (!fetchDue(s.nadac_last_fetch || null)) return;
      /*
       * Through the job, exactly as the button is.
       *
       * Two reasons. The lock: a weekly check starting while somebody is watching a fetch they
       * pressed would have two downloads writing to the same folder. And visibility: the automatic
       * pull is the one that matters most and used to leave no trace but a settings line — so when
       * somebody asked "is this actually running?", the honest answer was to go and read the
       * database. Now it writes its progress where the button's does, and the page shows it.
       */
      const { nadacJob, nadacJobRunning, startNadacFetch, runNadacFetch } = await import("./lib/nadac-job");
      if (nadacJobRunning(await nadacJob())) return;
      const who = { id: "scheduler", name: "Automatic weekly check" };
      const started = await startNadacFetch(who, "this week's NADAC file");
      if (!started.started) return;
      await runNadacFetch(who, started.runId!, "this week's NADAC file", []);
      await warmTick();
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
  /*
   * The held readings (held.ts), computed while nobody is waiting.
   *
   * Everything a page needs that takes more than a moment is held between requests and keyed on
   * the data. Computing it on the first page of the morning made that page pay for the night's
   * imports; computing it at boot made the first page wait behind the warm-up. So it is done here,
   * in the gaps: first the readings Today and Buying open with, then whatever is stale.
   */
  const warmTick = async () => {
    try {
      const { warmHeld, heapState } = await import("./lib/warm");
      const { secondsSinceRequest } = await import("./lib/activity");
      /*
       * Asked before every step, because both halves of the answer move while this runs: somebody
       * arrives, and the step before allocated. The policy is `warm-policy.ts` — the day's readings
       * warm in an ordinary gap, a page a click deeper waits for a real lull, and a process near
       * its heap ceiling warms nothing at all, because warming into a nearly full heap is what cost
       * the counter its page.
       */
      await warmHeld(() => heapState(secondsSinceRequest()));
    } catch {
      // A reading that fails to warm is computed by its next reader.
    }
  };

  /**
   * While the site is open to the internet, says so — and says when somebody is guessing at it.
   *
   * Deliberately not behind whenIdle. Every other job here waits for a gap because it is heavy and
   * nothing bad happens if it waits an hour; this one sends a short email and the thing it reports
   * is somebody attacking the login. A busy site is exactly when that must not be postponed.
   */
  const publicAccessTick = async () => {
    try {
      const { publicAccessNotices } = await import("./lib/public-access-notice");
      await publicAccessNotices();
    } catch {
      // A notice that cannot be sent must never stop the site. The red stripe is on every page regardless.
    }
  };

  /**
   * Measures the site against itself once a day, so Data health is never older than that.
   *
   * On the same beat as the backup and for the same reason: this runs on a pharmacy computer that
   * is switched off overnight, so a job scheduled for 2am would simply never happen. It takes one
   * whenever a day has passed since the last, which on a machine used every day means shortly
   * after it is turned on — and after the mail sweep above, so the morning's imports are counted
   * rather than missed by an hour.
   *
   * Behind `whenIdle`, and in a process of its own. The measurement reads the whole catalogue and
   * the whole NADAC table and took 12 to 16 seconds on the real database; every libsql call blocks
   * the event loop, so run inside the web server it was a fifteen-second outage — and the first
   * morning it ran that way it fired on a cold start after a deploy, on a machine already short of
   * memory, and the pharmacist at the counter had no page. `whenIdle` chose the moment; it could
   * not shorten the block. So this tick only decides that it is time and starts
   * `scripts/measure-data-health.ts`, which does the work where the site cannot feel it.
   *
   * The page shows the date it was measured, so a machine left switched off for a week says so on
   * its face rather than presenting week-old counts as today's.
   */
  /**
   * Every invoice the rules can now read, read again — without anybody pressing anything.
   *
   * The readers improve. On 16 September IPD's rule learned that an eleven-digit run is a line, and each half of a
   * mixed invoice began to be judged against its own printed subtotal. Neither did a thing for the invoices already
   * filed: an invoice keeps whatever the reader of the day made of it, and the only way to re-read was a button on the
   * invoices page. So a fix landed and the money stayed missing until somebody happened to press it — $1,310.68 of IPD
   * on the morning this was written.
   *
   * Nightly, rules only. `allowModel` stays false: reading a page with the model costs money, and the owner's rule is
   * that nothing spends on his behalf unless he presses it. The button keeps that job; this does the free half, which
   * is the half that follows every reader improvement.
   *
   * Invoices that already have lines are untouched — `backfillInvoiceLines` selects only those with none.
   */
  const invoiceLinesTick = async () => {
    try {
      const { getSettings, setSetting } = await import("./lib/settings");
      const s = await getSettings();
      const { todayIso } = await import("./lib/dates");
      const today = todayIso();
      if (s.invoice_lines_backfill_on === today) return;
      await setSetting("invoice_lines_backfill_on", today);
      const { backfillInvoiceLines } = await import("./lib/invoices");
      const r = await backfillInvoiceLines({ allowModel: false, user: { name: "the nightly re-read" } });
      const said = [
        `${r.linesRead} lines read off ${r.invoices} invoice${r.invoices === 1 ? "" : "s"}`,
        r.unreconciled ? `${r.unreconciled} short of the printed total` : null,
        r.unreadable ? `${r.unreadable} with no text to read` : null,
      ]
        .filter(Boolean)
        .join(", ");
      await setSetting("invoice_lines_backfill_result", `${new Date().toISOString()}: ${said}`);

      /*
       * And the same courtesy for the lines already read.
       *
       * The re-read above only takes invoices with no lines at all, which is the right rule for it —
       * but it means a line read last week keeps whatever could be said about it last week. Two of
       * the three sources that answer for a line arrive later than the reading: the FDA directory
       * gains rows on every refresh, and a delivery is often booked into PioneerRx after its invoice
       * has landed.
       *
       * On 16 September 2026 that had left 588 lines on file with one schedule between them, while
       * the directory could answer for 83 of them and registered 48 as CII. The code was right and
       * the rows were stale, so nothing but asking again would have moved them — and until they were
       * asked, the check for a Schedule II line filed as ordinary was being run over silence and
       * reported clean.
       */
      /*
       * And the invoices the reader itself recorded as not adding up.
       *
       * The gap the other two leave between them: an invoice with lines that do not reach its
       * printed total is never looked at again by either, so every improvement to the reader
       * arrives too late for exactly the invoices that needed it. Four ParMed invoices sat short
       * by $1.15, $0.13, $1.57 and $4.83 — all of it sales tax, all of it readable the moment the
       * reader knew what tax was.
       *
       * Rules only, like the rest of this tick. An invoice already known not to balance has
       * nothing to lose by being read again, and `replacesStoredLines` still refuses to trade
       * lines that add up for a read that cannot prove the same.
       */
      const { rereadShortInvoices } = await import("./lib/invoices");
      const s2 = await rereadShortInvoices({ user: { name: "the nightly re-read" } });
      await setSetting(
        "invoice_short_reread_result",
        `${new Date().toISOString()}: ${s2.checked} read again, ${s2.nowBalance} now balance` +
          (s2.recovered ? ` (${(s2.recovered / 100).toFixed(2)} explained)` : "") +
          `, ${s2.stillShort} still short`,
      );

      const { fillLineSchedules } = await import("./lib/line-schedule-backfill");
      const f = await fillLineSchedules();
      await setSetting(
        "line_schedules_backfill_result",
        `${new Date().toISOString()}: ${f.filled} of ${f.looked} unanswered lines answered${
          f.filled ? ` (${Object.entries(f.bySource).map(([k, n]) => `${n} by ${k}`).join(", ")})` : ""
        }; ${f.stillSilent} still cannot be answered by any source`,
      );
    } catch {
      // Its result setting says what happened; a re-read that fails must never take the site down.
    }
  };

  const dataHealthTick = async () => {
    try {
      const { getSettings, setSetting } = await import("./lib/settings");
      const s = await getSettings();
      const last = s.data_health_last ? Date.parse(s.data_health_last) : 0;
      if (Number.isFinite(last) && Date.now() - last < 20 * 60 * 60 * 1000) return;
      /*
       * In a process of its own, not here. The first morning this ran in the web server it fired
       * on a cold start after a deploy, read the whole catalogue and the NADAC table into a process
       * already short of memory, and the pharmacist at the counter had no page for a minute and a
       * half. `whenIdle` chose the moment; it could not shorten the block. The child writes
       * `data_health_last` itself when it finishes; the stamp here only stops a second start while
       * it runs, and is overwritten by the child's.
       */
      await setSetting("data_health_last", new Date().toISOString());
      const { spawn } = await import("node:child_process");
      const path = await import("node:path");
      const root = process.cwd();
      const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
      const child = spawn(process.execPath, [tsx, "--tsconfig", path.join(root, "tsconfig.script.json"), path.join(root, "scripts", "measure-data-health.ts")], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      /*
       * And the claims proof beside it (SESSION-RULES §1c): every stored report re-read and set against
       * the claims table, in its own process for the same reason. It writes `claims_proof` for Data
       * health to show; a night it fails leaves the last proof and its date.
       */
      const proof = spawn(process.execPath, [tsx, "--tsconfig", path.join(root, "tsconfig.script.json"), path.join(root, "scripts", "prove-claims.ts")], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      proof.unref();
      /*
       * The NADAC proof (2, BACKLOG 30) starts when the claims proof has finished rather than beside
       * it: it streams half a gigabyte of CMS files, and on a machine with seven gigabytes two proofs
       * reading at once is how the app got killed in September. Its heap is capped at what the first
       * run needed with room to spare; a night the claims proof never exits leaves the last NADAC
       * proof and its date, which Data health shows as such.
       */
      proof.on("exit", () => {
        // The prune first, on its own clock (scripts/prune-nadac.ts says why), so the proof measures the table as it should be.
        const prune = spawn(process.execPath, [tsx, "--tsconfig", path.join(root, "tsconfig.script.json"), path.join(root, "scripts", "prune-nadac.ts")], { cwd: root, detached: true, stdio: "ignore", env: process.env });
        prune.on("exit", () => {
          const nadac = spawn(process.execPath, ["--max-old-space-size=600", tsx, "--tsconfig", path.join(root, "tsconfig.script.json"), path.join(root, "scripts", "prove-nadac.ts")], { cwd: root, detached: true, stdio: "ignore", env: process.env });
          // Then the catalogue proof (2, BACKLOG 30): each wholesaler's table against the file it came from, one file in memory at a time.
          nadac.on("exit", () => {
            const cat = spawn(process.execPath, ["--max-old-space-size=500", tsx, "--tsconfig", path.join(root, "tsconfig.script.json"), path.join(root, "scripts", "prove-catalogue.ts")], { cwd: root, detached: true, stdio: "ignore", env: process.env });
            /*
             * Last in the chain: every supplier invoice re-read from its own file (2, BACKLOG 30).
             * It opens one PDF at a time and there are tens of invoices rather than millions of
             * rows, so it is the cheapest of the five — but it goes last anyway, because the rule
             * on this machine is one reader at a time and the reason for it has not changed.
             */
            cat.on("exit", () => {
              const inv = spawn(process.execPath, [tsx, "--tsconfig", path.join(root, "tsconfig.script.json"), path.join(root, "scripts", "prove-invoices.ts")], { cwd: root, detached: true, stdio: "ignore", env: process.env });
              inv.unref();
            });
            cat.unref();
          });
          nadac.unref();
        });
        prune.unref();
      });
      // And the rate backtest (BACKLOG 23): every settled network's rate against what the plan paid, kept in `rate_backtest`.
      const backtest = spawn(process.execPath, [tsx, "--tsconfig", path.join(root, "tsconfig.script.json"), path.join(root, "scripts", "backtest-rates.ts")], { cwd: root, detached: true, stdio: "ignore", env: process.env });
      backtest.unref();
    } catch {
      // A measurement that fails leaves yesterday's counts and their date, which is honest.
    }
  };

  /*
   * The remittance SFTP mailbox (sftp-pull.ts), swept on the same half hour as email: senders push
   * 835s and voucher remittances there because nobody emails a remittance, and a file that lands
   * is handled exactly as an emailed one. Skipped in silence until a host is set up.
   */
  const sftpTick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (!s.sftp_host || !s.sftp_user) return;
      const { pullSftp } = await import("./lib/sftp-pull");
      await pullSftp({ userId: null, userName: "Automatic check" });
    } catch {
      // Recorded in sftp_last_result; never lets the app down.
    }
  };

  /*
   * The morning pull from PioneerRx, at eight.
   *
   * The owner asked for it then for a reason: the night’s receiving has been keyed in by eight and
   * the day’s order is placed around four, so the shelf the order is planned against is this
   * morning’s rather than yesterday’s. The sweep runs every half hour, so this fires on the first
   * tick after eight; the script itself records the day each feed last ran and does nothing on the
   * ticks after that, which is also what makes a restart safe.
   *
   * Its own process. It reads a hundred thousand rows out of SQL Server and writes them through the
   * on-hand reader, and every one of those writes is a libsql call on whatever thread makes it.
   */
  const pioneerTick = async () => {
    try {
      if (new Date().getHours() < 8) return;
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (!s.pioneer_sql_server || !s.pioneer_sql_user) return;
      /*
       * Local, like the hour on the line above. This was the UTC date, so from 7pm Central the
       * guard saw tomorrow, started the pull that evening and stamped tomorrow done — and the eight
       * o'clock run was skipped every morning. See the note in scripts/pioneer-pull.ts, which writes
       * the markers this reads and must stay on the same clock.
       */
      const { todayIso } = await import("./lib/dates");
      const today = todayIso();
      const catalogueDue = new Date().getDay() === 1 || !s.pioneer_pull_catalogue_on;
      if (s.pioneer_pull_on_hand_on === today && s.pioneer_pull_claims_on === today && s.pioneer_pull_invoices_on === today && s.pioneer_pull_retail_on === today && !catalogueDue) return;
      const { spawn } = await import("node:child_process");
      const path = await import("node:path");
      const root = process.cwd();
      const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
      const child = spawn(process.execPath, [tsx, "--tsconfig", path.join(root, "tsconfig.script.json"), path.join(root, "scripts", "pioneer-pull.ts")], { cwd: root, detached: true, stdio: "ignore", env: process.env });
      child.unref();
    } catch {
      // Recorded in pioneer_pull_*_result; a pull that fails never touches the site.
    }
  };

  const runAll = async () => {
    await publicAccessTick();
    await whenIdle("warm", warmTick);
    /*
     * The three doors. These fetch from outside and are the only way anything gets in, so they are
     * the three allowed to run on a busy site once they have been starved long enough — see
     * MAX_STARVED_MS. Everything below them is housework on data already here and can wait for a gap.
     */
    await whenIdle("mail", tick, { evenWhenBusy: true });
    await whenIdle("sftp", sftpTick, { evenWhenBusy: true });
    await whenIdle("pioneer", pioneerTick, { evenWhenBusy: true });
    await whenIdle("invoice-lines", invoiceLinesTick);
    await whenIdle("data-health", dataHealthTick);
    /*
     * The morning check, after the jobs that would fix what it looks for.
     *
     * Ordered deliberately: the invoice re-read and the schedule backfill run above it, so a fault
     * they mend is mended before it is judged. A check that reports this morning's already-corrected
     * problem is how a check earns being ignored.
     */
    await whenIdle("daily-check", async () => {
      try {
        const { dailyCheckTick } = await import("./lib/daily-check-store");
        await dailyCheckTick();
      } catch {
        /* Its stored line says when it last succeeded; a check must never take the site down. */
      }
    });
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
    await whenIdle("payer-learn", payerLearnTick);
    await whenIdle("ar-report", arReportTick);
    await whenIdle("mtf", mtfTick);
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
  /**
   * Fetches and posts Medicare Transaction Facilitator payments, unattended.
   *
   * These arrive weeks after the fill and never on a schedule. Left to a button, the money only
   * lands when somebody remembers to go and get it — and the reason it was invisible for so long
   * is that nobody was going to check a portal every day. A fill sitting on the "dispensed at a
   * loss" list because of a payment that has since arrived is a wrong number the pharmacy acts on.
   *
   * Once a day. The remittances are published daily at most, the window looked at is three weeks
   * wide so a late one is never missed, and both the tool and this site skip what they already
   * have — so running it again costs a request and changes nothing.
   */
  const mtfTick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (s.mtf_auto === "no") return;
      if (!s.mtf_api_key_enc) return; // Nothing configured; not a failure, just nothing to do.
      const last = s.mtf_last_pull ? Date.parse(s.mtf_last_pull) : 0;
      if (Number.isFinite(last) && Date.now() - last < 20 * 60 * 60 * 1000) return;
      const { mtfCycle } = await import("./lib/mtf");
      await mtfCycle({ name: "Automatic check" });
    } catch {
      // Never allowed to stop the app. The outcome is on the Medicare MFP refunds page either way.
    }
  };

  /**
   * Posts the month-end accounts receivable report to whoever the pharmacy nominated.
   *
   * The owner asked for the report and then for this: "i should also be able to setup auto email of
   * this report to another email." It is deliberately the least clever job in this file — it reads
   * the claims already on file and hands the result to the pharmacy's own mail server. Nothing on
   * the path reaches out for money, which is the standing rule about anything that runs unattended.
   *
   * The month it is due for, and the reason it waits a few days into the new one, are in
   * `ar-report.ts`. Checked on the half-hourly beat like the backup and for the same reason: this
   * runs on a computer that is switched off overnight, so a job pinned to an hour on the 5th would
   * miss any month whose 5th falls on a Sunday.
   */
  /**
   * Learns who a BIN belongs to from the remittances that have paid it.
   *
   * The owner: "does our system get smarter and learn to attach bin/pcn or scripts to payors once we
   * start getting more 835s?? the system needs to learn." It did not — every link on file had been
   * taught by a person. This runs nightly so each remittance that arrives makes the next unnamed
   * claim more likely to name itself, and records what it learned so the learning can be read back.
   */
  const payerLearnTick = async () => {
    try {
      const { learnLinksFromRemittances } = await import("./lib/payer-links");
      const r = await learnLinksFromRemittances();
      if (r.learned === 0 && r.conflicting === 0 && r.unlearned === 0) return;
      const { setSetting } = await import("./lib/settings");
      await setSetting(
        "payer_links_learned_result",
        `${new Date().toISOString()} — ${r.learned} payer link(s) learned from remittances, ${r.claimsNamed} claim(s) named${r.unlearned ? `; ${r.unlearned} link(s) taken back because they named a courier rather than a plan` : ""}${r.conflicting ? `; ${r.conflicting} key(s) left for a person because two payers have paid on them` : ""}`,
      );
    } catch {
      // Recorded in settings; never allowed to stop the app.
    }
  };

  const arReportTick = async () => {
    try {
      const { monthlyArTick } = await import("./lib/ar-report-store");
      await monthlyArTick();
    } catch {
      // The outcome is recorded in settings and shown on the AR report page. Never stops the app.
    }
  };

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

  // The readings, more often than the half-hourly beat: a fresh one is the difference between a page and a wait.
  setTimeout(() => {
    void whenIdle("warm", warmTick);
    setInterval(() => void whenIdle("warm", warmTick), 5 * 60 * 1000).unref?.();
  }, 20 * 1000).unref?.();
}
