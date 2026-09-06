import "server-only";
import { db, schema } from "@/db";
import { todayIso, daysBetween, fmt, addDays } from "./dates";
import { onSiteToday } from "./roster";
import { dueList } from "./due";
import { csInventoryStatus } from "./compliance";
import { invoiceIssues, type InvoiceIssue } from "./invoices";
import { monthState, monthLabel, weekdaysIn, monthIsOurs } from "./deliveries";
import { getSettings } from "./settings";
import { TRAINING_LABEL, CREDENTIAL_LABEL } from "./labels";

/**
 * What is worth interrupting the pharmacist-in-charge for, and what is not.
 *
 * The old dashboard listed everything due inside sixty days, which is not an alert list — it is
 * an inventory of the future. A licence expiring in eight weeks sat in red next to one that
 * expired last Tuesday, and the effect of that is not vigilance. It is that the screen stops
 * being read, which costs more than having no screen at all.
 *
 * So there are two levels and nothing else.
 *
 * "Now" means the pharmacy is exposed today: something has expired, lapsed, been missed, or
 * stopped working. Every one of these is a sentence somebody could be asked to explain this
 * afternoon.
 *
 * "Soon" means it needs doing this month and cannot be done in an afternoon — a licence renewal,
 * a training round. Thirty days, because that is the shortest notice that is still useful for
 * things that take weeks, and because a warning that arrives two months early is one you will see
 * sixty times before it matters.
 *
 * Anything else is not an alert. It is on its own page, where somebody looking for it will find
 * it, and it stays off this list so that the list keeps meaning something.
 */

export type AlertLevel = "now" | "soon";

export type Alert = {
  key: string;
  level: AlertLevel;
  /** What is wrong, in the words somebody would use out loud. */
  title: string;
  /** Why it matters, or when it happened. One sentence. */
  why: string;
  href: string;
  /** What the link does, where a verb is clearer than "open". */
  action?: string;
};

/** Warning for anything that takes weeks to put right. The pharmacist asked for thirty days. */
export const SOON_DAYS = 30;

/**
 * A weekday's deliveries may go unentered for one day without complaint.
 *
 * Entering yesterday's count this morning is the normal rhythm of the job, and a system that
 * complains about it every single morning is one whose complaints get ignored by Thursday. Two
 * days is a genuine lapse: the count is now being remembered rather than read.
 */
export const DELIVERY_GRACE_DAYS = 1;

export async function alerts(): Promise<Alert[]> {
  const today = todayIso();
  const out: Alert[] = [];

  const [due, cs, invoiceProblems, s, people] = await Promise.all([
    dueList({ horizonDays: SOON_DAYS }),
    csInventoryStatus(),
    invoiceIssues(),
    getSettings(),
    onSiteToday(),
  ]);

  // ── People: licences, credentials, training ───────────────────────
  for (const d of due) {
    if (d.severity === "overdue") {
      out.push({
        key: `due-${d.id}`,
        level: "now",
        title: d.title,
        why:
          d.daysLeft !== null
            ? `${Math.abs(d.daysLeft)} day${Math.abs(d.daysLeft) === 1 ? "" : "s"} past${d.dueOn ? ` — was due ${fmt(d.dueOn)}` : ""}. ${d.action}`
            : d.action,
        href: d.href,
      });
      continue;
    }
    if (d.severity === "no_date") {
      // On file, and nothing can say whether it is still valid. That is not a future problem.
      out.push({
        key: `undated-${d.id}`,
        level: "now",
        title: d.title,
        why: "On file with no expiry date, so nothing here can tell you whether it is still current.",
        href: d.href,
      });
      continue;
    }
    if (d.severity === "due_soon") {
      out.push({
        key: `soon-${d.id}`,
        level: "soon",
        title: d.title,
        why: d.dueOn ? `Due ${fmt(d.dueOn)} — ${d.daysLeft} days. ${d.action}` : d.action,
        href: d.href,
      });
    }
  }

  // ── The annual controlled substance inventory ─────────────────────
  // A year and ten days is the outside limit; past that the pharmacy has no lawful inventory.
  if (cs.last) {
    const dueOn = addDays(cs.last, 375);
    const left = daysBetween(today, dueOn);
    if (left < 0) {
      out.push({
        key: "cs-inventory",
        level: "now",
        title: "The annual controlled substance inventory is overdue",
        why: `Last taken ${fmt(cs.last)}. There is no lawful inventory on file until another is done.`,
        href: "/inventory",
        action: "Take it",
      });
    } else if (left <= SOON_DAYS) {
      out.push({
        key: "cs-inventory-soon",
        level: "soon",
        title: "The annual controlled substance inventory is due",
        why: `Last taken ${fmt(cs.last)}, so the next is due by ${fmt(dueOn)}.`,
        href: "/inventory",
        action: "Take it",
      });
    }
  } else {
    out.push({
      key: "cs-inventory-never",
      level: "now",
      title: "No controlled substance inventory has ever been recorded",
      why: "21 CFR 1304.11 requires one, and it is the first thing a DEA inspector asks for.",
      href: "/inventory",
      action: "Take it",
    });
  }

  // ── The driver's day ──────────────────────────────────────────────
  /*
   * Two days of silence, not one.
   *
   * Yesterday's count entered this morning is the normal rhythm of the job. Complaining about
   * that every morning is how a list of complaints stops being read by Thursday. Two days means
   * somebody is now remembering the number rather than reading it, and the invoice is what
   * suffers.
   */
  if (s.driver_invoice_to) {
    const months = [today.slice(0, 7)];
    // Early in a month, the month that just ended is the one with the gap in it.
    if (Number(today.slice(8, 10)) <= 7) {
      const prev = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
      months.push(prev);
    }
    for (const month of months) {
      // A month the site was never asked to cover is not a gap. The pharmacy was running before
      // this screen existed, and demanding it back-fill history before the complaining stops is
      // how a feature gets turned off.
      if (!(await monthIsOurs(month)).ours) continue;
      const state = await monthState(month);
      const stale = state.missing.filter((d) => daysBetween(d, today) > DELIVERY_GRACE_DAYS);
      if (stale.length === 0) continue;
      out.push({
        key: `deliveries-${month}`,
        level: "now",
        title:
          stale.length === 1
            ? `No delivery count for ${fmt(stale[0])}`
            : `No delivery count for ${stale.length} days in ${monthLabel(month)}`,
        why:
          stale.length === 1
            ? "The driver is paid per trip, and the count is now being remembered rather than read."
            : `The oldest is ${fmt(stale[0])}. The month cannot be invoiced until every weekday has an answer.`,
        href: `/deliveries?month=${month}`,
        action: "Enter it",
      });
    }

    // A finished month nobody has invoiced is the driver waiting to be paid.
    const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    if (weekdaysIn(lastMonth).length > 0 && (await monthIsOurs(lastMonth)).ours) {
      const prev = await monthState(lastMonth);
      if (prev.complete && (!prev.invoice || prev.invoice.status !== "sent")) {
        out.push({
          key: `deliveries-uninvoiced-${lastMonth}`,
          level: "now",
          title: `${monthLabel(lastMonth)} is finished but has not been invoiced`,
          why: "Every weekday has an answer, so the driver is waiting on the invoice rather than on the count.",
          href: `/deliveries?month=${lastMonth}`,
          action: "Send it",
        });
      }
    }
  }

  // ── The invoice archive ───────────────────────────────────────────
  // Only the blocking ones. The rest live on their own page, which is where somebody who cares
  // about them is already standing.
  for (const p of invoiceProblems.filter((x: InvoiceIssue) => x.severity === "blocking")) {
    out.push({
      key: `invoice-${p.key}`,
      level: "now",
      title: p.title,
      why: p.detail,
      href: p.href ?? "/inventory/invoices",
      action: p.action,
    });
  }

  // ── The things that run themselves, when they stop ────────────────
  /*
   * A backup that failed is the only automation failure that belongs on this list.
   *
   * The others — a mail sweep, a price download — are recoverable by the next run and nobody is
   * worse off for a day of silence. A backup is different: every day it does not run is a day the
   * pharmacy would lose, and it is invisible by nature.
   */
  const failedAt = s.backup_last_failure ? Date.parse(s.backup_last_failure) : NaN;
  const ranAt = s.backup_last_run ? Date.parse(s.backup_last_run) : NaN;
  if (s.backup_enabled !== "no") {
    if (Number.isFinite(failedAt) && (!Number.isFinite(ranAt) || failedAt > ranAt)) {
      out.push({
        key: "backup-failed",
        level: "now",
        title: "The backup is failing",
        why: s.backup_last_result || "The last attempt did not complete, so nothing since then is backed up.",
        href: "/settings/backups",
        action: "Look at it",
      });
    } else if (!Number.isFinite(ranAt) || (Date.now() - ranAt) / 3_600_000 > 50) {
      out.push({
        key: "backup-stale",
        level: "now",
        title: "No backup has run for two days",
        why: "Every day without one is a day of records that would not survive this computer.",
        href: "/settings/backups",
        action: "Run one",
      });
    }
  }

  /*
   * An installation that is behind is the alert that explains the other alerts.
   *
   * Repairs are made and pushed, and then nothing changes on the pharmacy's own computer until
   * somebody installs them — so a bug that was fixed a week ago is still being hit, reported
   * again, and investigated again. That happened: three separate things were reported as broken
   * after they had been repaired, because the copy in the pharmacy predated every one of the
   * repairs.
   *
   * It sits with the things that need doing today for exactly that reason. It is not a feature
   * request; it is the difference between running the software that was fixed and the software
   * that was not.
   */
  /*
   * Counted against this copy, not remembered from the last network check.
   *
   * The stored figure was not rewritten when updates were installed, so this said ten were waiting
   * on a computer already running them — and named one from a week earlier. A wrong notice on the
   * first screen of the day teaches the reader to scroll past the right one.
   */
  /*
   * The ceiling that has stopped everything, said out loud before somebody presses a button.
   *
   * With prices being read as zero this could never fire; now that they are read properly it can,
   * and the first anybody would otherwise know is a button that appears to fail. A limit reached
   * is not a fault, but it is indistinguishable from one unless something says so first.
   */
  try {
    const { monthlyCap, dollars: money } = await import("./ai-spend");
    const limit = await monthlyCap();
    if (limit.over) {
      out.push({
        key: "ai-cap",
        level: "now",
        title: `Claude has stopped at the ${money(limit.cap!)} monthly ceiling`,
        why:
          `${money(limit.spent)} has been spent in the last month, so nothing further is being sent — the manual will not be read, ` +
          `invoices needing judgement will not be read, and any button that asks Claude something will refuse. ` +
          (limit.isDefault
            ? "Nothing here chose that figure; it is the built-in limit, so that software spending your money on a computer you are not sitting at cannot run away."
            : "It is the ceiling you set.") +
          " Raise it or turn it off under Settings → Claude.",
        href: "/settings#claude",
        action: "Raise it",
      });
    }
  } catch {
    // No key, no settings, nothing to say. A cost ceiling is never the reason a page fails to load.
  }

  const { pendingUpdates } = await import("./updates");
  const pending = await pendingUpdates();
  const behind = pending.behind;
  if (behind > 0) {
    out.push({
      key: "updates",
      level: behind >= 5 ? "now" : "soon",
      title: `${behind} update${behind === 1 ? "" : "s"} ${behind === 1 ? "is" : "are"} waiting to be installed`,
      why:
        (pending.newest ? `The newest is “${pending.newest}”. ` : "") +
        "Nothing on this computer changes until they are installed, so anything already repaired is still broken here.",
      href: "/settings/updates",
      action: "Install",
    });
  }

  /*
   * Nobody has signed for the manual.
   *
   * Only the never-signed case alerts. Somebody holding a signature against an earlier revision is
   * a judgement — a typo corrected in a heading is not a change of policy, and alerting on every
   * edit would train the pharmacist-in-charge to ignore this the way he learned to ignore the old
   * board. That state is shown on the manual page, where it can be looked at with the change that
   * caused it in front of him.
   */
  if (people.length > 0) {
    const { acknowledgementGap } = await import("./manual-acknowledgement");
    const gap = await acknowledgementGap();
    if (gap.missing > 0) {
      out.push({
        key: "manual-ack",
        level: "soon",
        title: `${gap.missing} ${gap.missing === 1 ? "person has" : "people have"} not acknowledged the policy manual`,
        why:
          "It is the record that the workforce was trained on the privacy policies, that the exposure control plan " +
          "was explained, and that a sanction for breaking a rule could be defended — 45 CFR 164.530(b) and (e), " +
          "29 CFR 1910.1030(g)(2).",
        href: "/manual#acknowledgement",
        action: "Send it",
      });
    }
  }

  /*
   * Trainings that are one conversation away from being complete.
   *
   * A person who replied to a bloodborne email has done everything asked of them and has no record
   * to show for it, because the standard also wants an opportunity to ask questions of somebody
   * who knows the subject. That is the pharmacist-in-charge's few minutes, and it is the kind of
   * thing that never happens if it is only visible on a page nobody opens. It is "soon" rather
   * than "now": the person is not out of compliance for having replied, but the file is incomplete
   * until this is done.
   */
  {
    const { awaitingQuestionsAndAnswers } = await import("./training-replies");
    const waiting = await awaitingQuestionsAndAnswers();
    if (waiting.length > 0) {
      out.push({
        key: "training-qa-waiting",
        level: "soon",
        title:
          waiting.length === 1
            ? `${waiting[0].name} is waiting on a few minutes with you`
            : `${waiting.length} people are waiting on a few minutes with you`,
        why:
          `They replied to say they read the material, and that is on file. The bloodborne standard also asks for a ` +
          `chance to ask questions of somebody who knows the subject — 29 CFR 1910.1030(g)(2)(vii)(N). Until you go ` +
          `through it with them and record it, there is no training record and no certificate.`,
        href: "/compliance/training",
        action: "Record it",
      });
    }
  }

  /*
   * A certified record that has stopped matching what it certifies.
   *
   * Never a nag to sign: nothing sets a cadence for certifying the training file, and a monthly
   * reminder to re-sign a record that has not changed is exactly the kind of alert that teaches
   * somebody to ignore the rest. This fires only where a signature already exists and the file has
   * moved on underneath it — which is the state worth knowing about, because a certificate against
   * a document that has since changed is worse than no certificate at all.
   */
  if (people.length > 0) {
    const { trainingFileSignature } = await import("./record-signatures");
    const sig = await trainingFileSignature();
    if (sig.changed) {
      out.push({
        key: "training-file-signature",
        level: "soon",
        title: "The workforce training record has changed since you certified it",
        why: `Signed by ${sig.signedName} on ${sig.signedOn}. Training has been recorded since, so that certificate no longer covers the whole file. It stays where it is — it is still true of the version it covered — and signing again adds a second certification covering the record as it stands now.`,
        href: "/compliance/training/records",
        action: "Look at it",
      });
    }
  }

  /*
   * The weekly price history, quietly not being collected.
   *
   * This one earns an alert where most background jobs do not, because the damage is not
   * recoverable by noticing later. Each weekly NADAC file carries only the prices in force that
   * week; CMS's current file has forgotten July. A month during which this was failing is a month
   * of prices that cannot be fetched afterwards at any price, and the first anybody would know is
   * when a claim from that month could not be checked against the floor.
   *
   * So: only where it is switched on, and only once it has actually gone quiet for a fortnight —
   * CMS publishes weekly, so a single missed Wednesday is not news.
   */
  {
    const { getSettings } = await import("./settings");
    const { nadacAuto } = await import("./nadac-fetch");
    const s = await getSettings();
    if (nadacAuto(s)) {
      const lastOk = s.nadac_last_ok ? Date.parse(s.nadac_last_ok) : NaN;
      const quietDays = Number.isFinite(lastOk) ? (Date.now() - lastOk) / 86_400_000 : null;
      if (quietDays === null || quietDays > 14) {
        out.push({
          key: "nadac-quiet",
          level: "soon",
          title:
            quietDays === null
              ? "NADAC prices have never been downloaded"
              : `NADAC prices have not downloaded for ${Math.floor(quietDays)} days`,
          why:
            (s.nadac_last_result ? `${s.nadac_last_result} ` : "") +
            "Each weekly file from CMS holds only the prices in force that week, so a month not collected cannot " +
            "be fetched later — the current file has forgotten it. It is a free public download needing no account. " +
            "Open the page and press Fetch now; if CMS has moved the file, paste the new address in the box there.",
          href: "/nadac",
          action: "Fetch it",
        });
      }
    }
  }

  // ── A pharmacy with nobody in charge of it ────────────────────────
  if (people.length > 0 && !people.some((p) => p.isPic)) {
    out.push({
      key: "no-pic",
      level: "now",
      title: "No pharmacist-in-charge is recorded",
      why: "Kansas requires one, and this site puts their name on every Board form it prints.",
      href: "/staff",
      action: "Set one",
    });
  }

  /*
   * Supplies, because running out of 16 dram vials stops the pharmacy as surely as anything else
   * on this list and is the one thing here nobody is reminded of by a regulator.
   *
   * "Order now" means the stock left is down to the lead time plus the cushion — so it is not a
   * warning that it is getting low, it is the last day the order can go and still arrive in time.
   */
  try {
    const { suppliesAlert } = await import("./supplies-store");
    const sup = await suppliesAlert();
    if (sup && sup.toOrder > 0) {
      out.push({
        key: "supplies-order",
        level: "now",
        title: `${sup.toOrder} ${sup.toOrder === 1 ? "supply needs" : "supplies need"} ordering: ${sup.names.join(", ")}`,
        why: "What is left is down to the delivery time plus the cushion. Ordering later than today spends the cushion.",
        href: "/purchasing/supplies",
        action: "Order",
      });
    }
    if (sup && sup.neverCounted > 0) {
      out.push({
        key: "supplies-count",
        level: "soon",
        title: `${sup.neverCounted} ${sup.neverCounted === 1 ? "supply has" : "supplies have"} never been counted`,
        why: "Nothing can be predicted about an item nobody has counted. One count is a position; a second gives the rate.",
        href: "/purchasing/supplies",
        action: "Count",
      });
    }
  } catch (e) {
    // Never let the supplies board take the whole dashboard down with it.
    void e;
  }

  // Worst first, and within a level the oldest problem first — which is the order somebody would
  // work them in anyway.
  const rank: Record<AlertLevel, number> = { now: 0, soon: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Just the counts, for anywhere that needs to say how bad things are without listing them. */
export async function alertCounts(): Promise<{ now: number; soon: number }> {
  const all = await alerts();
  return { now: all.filter((a) => a.level === "now").length, soon: all.filter((a) => a.level === "soon").length };
}

void schema;
void db;
void TRAINING_LABEL;
void CREDENTIAL_LABEL;
