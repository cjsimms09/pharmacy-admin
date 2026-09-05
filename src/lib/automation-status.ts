import "server-only";
import { getSettings } from "./settings";

/**
 * What the site is doing without being asked, and whether it is still doing it.
 *
 * A background job that silently stops looks exactly like one that has nothing to do. That is
 * the whole risk of automating compliance: the pharmacy stops watching a thing precisely because
 * the software promised to watch it, and nobody finds out it stopped until someone asks for
 * August's temperature log. So each job says when it last ran, what it said, and whether that
 * was recently enough to trust.
 *
 * "Off" is a legitimate state and is shown plainly. Nagging about a feature the pharmacy chose
 * not to use is how the rest of the screen loses its authority.
 */

export type JobState = "ok" | "stale" | "never" | "off";

export type JobStatus = {
  key: string;
  label: string;
  state: JobState;
  /** When it last ran, ISO, or null. */
  lastAt: string | null;
  /** What it said last time. */
  detail: string;
  href: string;
};

/** How long each job may go quiet before its silence is itself the news. */
const MAX_QUIET_HOURS: Record<string, number> = {
  temps: 26,
  backup: 50,
  mail: 26,
  nadac: 8 * 24,
  cqi: 50,
  reminders: 8 * 24,
  // Four sections an hour when there is anything due, and nothing at all when the manual is
  // current — so a fortnight of silence is normal and only a month of it is news.
  manual_audit: 31 * 24,
  // Weekly, with a day of slack for a computer that was switched off over a weekend.
  digest: 8 * 24,
  /*
   * The claims export, scheduled out of PioneerRx and swept in from the mailbox.
   *
   * Nine days: a report scheduled weekly, plus slack for a bank holiday and a closed weekend.
   * The failure worth catching is not a late file — it is a scheduled report somebody deleted or
   * that started bouncing, after which claims simply stop arriving and every figure downstream
   * quietly goes stale while continuing to look right.
   */
  claims: 9 * 24,
};

function ageHours(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function judge(key: string, enabled: boolean, lastAt: string | null | undefined): JobState {
  if (!enabled) return "off";
  const age = ageHours(lastAt);
  if (age === null) return "never";
  return age > MAX_QUIET_HOURS[key] ? "stale" : "ok";
}

/** A recorded failure that is newer than the last good run — the drive that stopped being there. */
function backupFailedSinceLastRun(failedAt: string | undefined, lastRun: string | undefined): boolean {
  const f = failedAt ? Date.parse(failedAt) : NaN;
  if (!Number.isFinite(f)) return false;
  const r = lastRun ? Date.parse(lastRun) : NaN;
  return !Number.isFinite(r) || f > r;
}

export async function automationStatus(): Promise<JobStatus[]> {
  const s = await getSettings();
  const on = (v: string | undefined) => v === "yes";

  const jobs: JobStatus[] = [
    {
      key: "temps",
      label: "Fridge and room temperatures",
      state: judge("temps", Boolean(s.imonnit_key_id_enc && s.imonnit_secret_enc), s.imonnit_last_sync),
      lastAt: s.imonnit_last_sync ?? null,
      detail: s.imonnit_last_result ?? "No iMonnit key is stored yet, so nothing is being pulled.",
      href: "/temps",
    },
    {
      key: "backup",
      label: "Verified backup",
      // On unless deliberately switched off, matching backupStatus().
      //
      // A failure recorded since the last success outranks the clock. A backup that ran fine
      // yesterday and could not find the stick this morning is still "recent" by age, and that is
      // exactly the morning the pharmacy needs to be told — an unplugged drive reads as healthy
      // for two days otherwise, which is two days of believing something is being kept.
      state:
        s.backup_enabled === "no"
          ? "off"
          : backupFailedSinceLastRun(s.backup_last_failure, s.backup_last_run)
            ? "stale"
            : judge("backup", true, s.backup_last_run),
      lastAt: s.backup_last_run ?? null,
      detail:
        s.backup_enabled === "no"
          ? "Backups are switched off, so nothing here survives this computer."
          : (s.backup_last_result ?? "No backup has run yet."),
      href: "/settings/backups",
    },
    {
      key: "mail",
      label: "Mailbox sweep",
      state: judge("mail", on(s.mail_enabled), s.mail_last_sweep),
      lastAt: s.mail_last_sweep ?? null,
      detail: s.mail_last_result ?? "Not connected. Reports emailed here are not being filed.",
      href: "/inbox",
    },
    {
      key: "cqi",
      label: "CQI drafting and carry-forward",
      state: judge("cqi", true, s.cqi_automation_last),
      lastAt: s.cqi_automation_last ?? null,
      detail: s.cqi_automation_result ?? "Reviews are started and summaries assembled on their own.",
      href: "/cqi",
    },
    {
      key: "digest",
      label: "Your weekly compliance note",
      state: judge("digest", Boolean(s.mail_user && s.mail_password_enc), s.digest_last_sent),
      lastAt: s.digest_last_sent ?? null,
      detail:
        s.digest_last_result ??
        "Once a week you are emailed what is late, what is expiring and whether anything here has stopped — and only in a week that has something in it.",
      href: "/settings/email",
    },
    {
      key: "manual_audit",
      label: "Policy manual audit",
      state: judge("manual_audit", Boolean(s.anthropic_api_key_enc) && s.manual_audit_auto !== "no", s.manual_audit_last),
      lastAt: s.manual_audit_last ?? null,
      detail:
        s.manual_audit_result ??
        "Every section is read against Kansas, DEA, HIPAA and OSHA requirements and against what this site does, a few at a time, so the whole manual is covered within the year.",
      href: "/manual#audit",
    },
    {
      key: "reminders",
      label: "Training reminders",
      state: judge("reminders", true, s.training_reminders_last),
      lastAt: s.training_reminders_last ?? null,
      detail: "Anyone with an outstanding assignment is chased weekly, then escalated to you.",
      href: "/compliance/training",
    },
  ];

  /*
   * Claims arriving on their own.
   *
   * Only where the reimbursement side is switched on, because a pharmacy that is not doing this
   * work has no scheduled report to have stopped. Where it is on, silence is the whole point: the
   * floor review reads perfectly well against a month-old file, and would go on reading well for
   * a year.
   */
  if (s.feature_reimbursement === "yes") {
    const { latestClaimImport } = await import("./claims");
    const last = await latestClaimImport();
    jobs.push({
      key: "claims",
      label: "Claims export",
      state: judge("claims", true, last),
      lastAt: last,
      detail: last
        ? `Last export loaded ${last.slice(0, 10)}.`
        : "No claims export has ever been loaded. Schedule the PioneerRx report to email the pharmacy address and it lands here on its own.",
      href: "/claims",
    });
  }

  /*
   * NADAC is on this strip whether or not the reimbursement pages are.
   *
   * It used to be hidden behind that flag, which was a mistake of exactly the kind this strip
   * exists to catch. The collection runs regardless — deliberately, because each weekly file
   * carries only the prices in force that week and a month not collected cannot be recovered —
   * so hiding its status meant a job that had quietly stopped had nowhere to say so. A silent
   * failure of a thing that is supposed to be building history is the worst case, not a tidier
   * dashboard.
   */
  {
    const { nadacAuto } = await import("./nadac-fetch");
    const auto = nadacAuto(s);
    jobs.push({
      key: "nadac",
      label: "NADAC prices",
      state: judge("nadac", auto, s.nadac_last_ok || null),
      lastAt: s.nadac_last_ok ?? s.nadac_last_fetch ?? null,
      detail: auto
        ? (s.nadac_last_result ?? "Switched on, but it has not run yet.")
        : "Automatic pulls are off, so the weekly price history is not being collected.",
      href: "/nadac",
    });
  }

  // Worst first: something that has quietly stopped is the only thing on this strip worth
  // reading, and it should not be third in a row of green.
  const rank: Record<JobState, number> = { stale: 0, never: 1, off: 2, ok: 3 };
  return jobs.sort((a, b) => rank[a.state] - rank[b.state]);
}
