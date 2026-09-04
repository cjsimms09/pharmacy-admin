import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { todayIso, daysBetween, fmt, fmtLong } from "./dates";
import { dueList } from "./due";
import { complianceSummary } from "./compliance-status";
import { automationStatus } from "./automation-status";
import { cqiSnapshot, csInventoryStatus } from "./compliance";
import { rotations } from "./roster";
import { register as agreementRegister } from "./business-associates";
import { getSettings, setSetting } from "./settings";
import { sendMail } from "./send-mail";

/**
 * The weekly note to the pharmacist-in-charge.
 *
 * Everything this site knows was, until now, only knowable by opening it. That is the wrong way
 * round for compliance: the whole value of tracking a licence expiry is that somebody finds out
 * before it lapses, and a screen only tells you things on the days you happen to look at it. A
 * fortnight of not looking — which is a normal fortnight — and a renewal is late.
 *
 * So once a week the site writes to the PIC with what needs them. Three rules keep it worth
 * reading, because an unread weekly email is worse than none:
 *
 *   Nothing goes out when there is nothing to say. A cheerful "all clear" every Monday teaches
 *   people to archive it unread, and then the one that matters is archived too.
 *
 *   It leads with what is late, not with what exists. A digest that opens with a summary of
 *   everything is a report; one that opens with the three things that need doing is a prompt.
 *
 *   It says when the machinery itself has stopped. A background job that quietly dies looks
 *   exactly like one with nothing to do, and that is the one failure this whole arrangement
 *   cannot survive silently.
 */

export type Digest = {
  /** Nothing worth sending. */
  quiet: boolean;
  subject: string;
  text: string;
  counts: { late: number; expiring: number; stalled: number; questions: number };
};

/** How far ahead a renewal is worth mentioning. Long enough to actually do something about it. */
const HORIZON_DAYS = 60;

export async function buildDigest(): Promise<Digest> {
  const today = todayIso();
  const [s, compliance, dated, jobs, cqi, cs, rota, agreements, people] = await Promise.all([
    getSettings(),
    complianceSummary(),
    dueList({ horizonDays: HORIZON_DAYS }),
    automationStatus(),
    cqiSnapshot(),
    csInventoryStatus(),
    rotations(),
    agreementRegister(),
    db.query.people.findMany({ where: eq(schema.people.active, true) }),
  ]);

  const late: string[] = [];
  const soon: string[] = [];

  for (const i of compliance.missed) late.push(`${i.title} — ${i.periodLabel}, ${i.daysLate} days late`);
  for (const i of compliance.partial) late.push(`${i.title} — ${i.periodLabel}, part done`);
  for (const d of dated) {
    if (d.severity === "overdue") late.push(`${d.title} — ${Math.abs(d.daysLeft!)} days late`);
    else if (d.severity === "no_date") late.push(`${d.title} — nothing on file`);
    else if (d.severity === "due_soon") soon.push(`${d.title} — ${fmt(d.dueOn)} (${d.daysLeft} days)`);
  }

  const cqiDays = daysBetween(today, cqi.dueOn);
  if (cqi.status !== "final") {
    if (cqiDays < 0) late.push(`CQI summary for ${cqi.label} — ${-cqiDays} days late`);
    else if (cqiDays <= HORIZON_DAYS) soon.push(`CQI summary for ${cqi.label} — due ${fmt(cqi.dueOn)}`);
  }

  const csDays = cs.dueOn ? daysBetween(today, cs.dueOn) : null;
  if (!cs.last) late.push("Annual controlled substance inventory — none has ever been recorded");
  else if (csDays !== null && csDays < 0) late.push(`Annual controlled substance inventory — ${-csDays} days late`);
  else if (csDays !== null && csDays <= HORIZON_DAYS) soon.push(`Annual controlled substance inventory — due ${fmt(cs.dueOn)}`);

  // Students already on site without a complete file are working here right now, which puts them
  // ahead of anything merely approaching a date.
  for (const r of rota.filter((x) => x.presence === "here" && !x.ready)) {
    late.push(`${r.name} is on rotation without: ${r.missing.join(", ")}`);
  }
  for (const r of rota.filter((x) => x.presence === "arriving" && x.daysUntilStart !== null && x.daysUntilStart <= 14)) {
    soon.push(
      `${r.name} starts in ${r.daysUntilStart} days` +
        (r.missing.length ? ` and is missing: ${r.missing.join(", ")}` : " — everything on file"),
    );
  }

  for (const a of agreements.filter((x) => !x.endedOn && x.problem)) {
    (a.daysLeft !== null && a.daysLeft < 0 ? late : soon).push(`${a.name} — ${a.problem}`);
  }

  const stalled = jobs.filter((j) => j.state === "stale");
  const questions = compliance.unanswered;
  const noEmail = people.filter((p) => !p.email);

  const counts = {
    late: late.length,
    expiring: soon.length,
    stalled: stalled.length,
    questions: questions.length,
  };
  const quiet = counts.late === 0 && counts.stalled === 0 && counts.expiring === 0 && counts.questions === 0;

  const pharmacy = (s.pharmacy_name || "the pharmacy").trim();
  const base = (s.public_base_url || "").trim().replace(/\/$/, "");
  const link = (path: string) => (base ? `${base}${path}` : path);

  const parts: string[] = [];
  const section = (heading: string, lines: string[]) => {
    if (lines.length === 0) return;
    parts.push(heading, "-".repeat(heading.length), ...lines.map((l) => `  · ${l}`), "");
  };

  parts.push(`Compliance for ${pharmacy} — ${fmtLong(today)}`, "");

  if (stalled.length > 0) {
    // First, deliberately. Everything else in this email is only true if these are running.
    section(
      "SOMETHING THE SITE DOES FOR YOU HAS STOPPED",
      stalled.map((j) => `${j.label} — ${j.detail}`),
    );
  }
  section(`LATE (${late.length})`, late.slice(0, 25));
  if (late.length > 25) parts.push(`  … and ${late.length - 25} more.`, "");
  section(`COMING UP IN THE NEXT ${HORIZON_DAYS} DAYS (${soon.length})`, soon.slice(0, 20));
  section(
    `WAITING ON AN ANSWER FROM YOU (${questions.length})`,
    questions.map((q) => `${q.title} — does this apply here?`),
  );
  if (noEmail.length > 0) {
    section(
      "CANNOT BE REACHED",
      noEmail.map((p) => `${p.firstName} ${p.lastName} has no email address, so training cannot be sent to them`),
    );
  }

  parts.push(
    "Open the desk:",
    `  What needs you    ${link("/")}`,
    `  If they walked in ${link("/inspection")}`,
    "",
    "This goes out once a week, and only when there is something in it.",
  );

  return {
    quiet,
    subject: quiet
      ? `${pharmacy}: nothing outstanding`
      : stalled.length > 0
        ? `${pharmacy}: ${stalled.length} automatic ${stalled.length === 1 ? "job has" : "jobs have"} stopped, ${late.length} late`
        : late.length > 0
          ? `${pharmacy}: ${late.length} thing${late.length === 1 ? "" : "s"} late`
          : `${pharmacy}: ${soon.length + questions.length} thing${soon.length + questions.length === 1 ? "" : "s"} need you soon`,
    text: parts.join("\n"),
    counts,
  };
}

/**
 * Sends it, at most once a week, and only when it says something.
 *
 * The gap is measured from the last send rather than pinned to a weekday, so a computer that was
 * switched off on Monday still gets its digest on Tuesday instead of skipping the week.
 */
export async function sendWeeklyDigest(opts: { force?: boolean } = {}): Promise<{ sent: boolean; reason: string }> {
  const s = await getSettings();
  const people = await db.query.people.findMany();
  const pic = people.find((p) => p.isPic);
  if (!pic?.email) return { sent: false, reason: "No pharmacist-in-charge with an email address is on file." };

  if (!opts.force && s.digest_last_sent) {
    const days = daysBetween(s.digest_last_sent.slice(0, 10), todayIso());
    if (days < 7) return { sent: false, reason: `Last sent ${days} day${days === 1 ? "" : "s"} ago.` };
  }

  const d = await buildDigest();
  if (d.quiet && !opts.force) {
    // Still stamp the clock. Otherwise a quiet week is retried every hour for a week.
    await setSetting("digest_last_sent", new Date().toISOString());
    await setSetting("digest_last_result", `${new Date().toISOString()} — nothing outstanding, nothing sent.`);
    return { sent: false, reason: "Nothing outstanding, so nothing was sent." };
  }

  const r = await sendMail(pic.email, d.subject, d.text);
  const stamp = new Date().toISOString();
  if (r.ok) {
    await setSetting("digest_last_sent", stamp);
    await setSetting("digest_last_result", `${stamp} — sent to ${pic.email}: ${d.subject}`);
    return { sent: true, reason: `Sent to ${pic.email}.` };
  }
  await setSetting("digest_last_result", `${stamp} — FAILED: ${r.error}`);
  return { sent: false, reason: r.error };
}
