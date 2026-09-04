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
  const behind = Number(s.updates_behind ?? 0);
  if (behind > 0) {
    out.push({
      key: "updates",
      level: behind >= 5 ? "now" : "soon",
      title: `${behind} update${behind === 1 ? "" : "s"} ${behind === 1 ? "is" : "are"} waiting to be installed`,
      why:
        (s.updates_newest ? `The newest is “${s.updates_newest}”. ` : "") +
        "Nothing on this computer changes until they are installed, so anything already repaired is still broken here.",
      href: "/settings/updates",
      action: "Install",
    });
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
