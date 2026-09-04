import "server-only";
import { and, asc, eq, isNull, or, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso, daysBetween } from "./dates";
import { getSettings, setSetting } from "./settings";
import { hasApiKey, reviewPolicy, describeError } from "./ai";
import { policies, suggestForm, appendixReference } from "./manual";
import { allSections, saveSection } from "./manual-store";

/**
 * Reading the manual against the rules, a few sections at a time, for ever.
 *
 * The pharmacy's annual review was a date somebody put their name to. That is what the regulation
 * asks for and it is worth nothing on its own: a manual can be reviewed on time for five years
 * running and still say the pharmacy does something it stopped doing in year one. Nobody rereads
 * a hundred and fifty sections against Kansas, DEA, HIPAA and OSHA once a year. They sign.
 *
 * So the audit is continuous rather than annual, and the annual part is only the deadline. Every
 * section has a date it was last actually read against the requirements; anything older than a
 * year is due; a handful are done on each idle turn of the background job. The pharmacy never
 * waits for a long run and never pays for one, and by the time the year is up the whole manual
 * has been through it.
 *
 * Findings are rows to work through rather than a report to file. Each carries the replacement
 * text where one could be written, so acting on it is a button; each has to be applied or
 * dismissed with a reason, because a finding waved away silently is hidden rather than closed.
 */

/** A section not read against the requirements within this many days is due again. */
export const AUDIT_INTERVAL_DAYS = 365;

export type Finding = typeof schema.manualFindings.$inferSelect;

export type AuditProgress = {
  /** Sections the pharmacy owns and is therefore audited on. */
  total: number;
  /** Of those, read against the requirements within the last year. */
  current: number;
  due: number;
  /** Findings nobody has applied or dismissed. */
  open: number;
  blocking: number;
  lastRunAt: string | null;
  lastResult: string | null;
  /** Whether it can run at all. */
  ready: boolean;
  /** Off when the pharmacy has switched the automatic pass off. */
  automatic: boolean;
};

/**
 * The sections this pharmacy is answerable for.
 *
 * Site-generated sections describe what the software does and are regenerated rather than
 * audited. Sections the medical practice maintains are not the pharmacy's to change, and chasing
 * findings on somebody else's policy is how a findings list stops being read.
 */
async function auditable() {
  const rows = await allSections();
  return rows.filter((r) => r.source === "pharmacy" && !r.managedBy && !r.retiredOn);
}

export async function auditProgress(): Promise<AuditProgress> {
  const [rows, findings, s, ready] = await Promise.all([
    auditable(),
    db.query.manualFindings.findMany({
      where: and(isNull(schema.manualFindings.appliedAt), isNull(schema.manualFindings.dismissedAt)),
    }),
    getSettings(),
    hasApiKey(),
  ]);

  const today = todayIso();
  const current = rows.filter((r) => !isAuditDue(r.auditedOn, today)).length;
  return {
    total: rows.length,
    current,
    due: rows.length - current,
    open: findings.length,
    blocking: findings.filter((f) => f.severity === "blocking").length,
    lastRunAt: s.manual_audit_last || null,
    lastResult: s.manual_audit_result || null,
    ready,
    automatic: s.manual_audit_auto !== "no",
  };
}

/**
 * Whether a section needs reading again.
 *
 * Never audited counts as due, which is the whole point on the day this is switched on: a manual
 * that has never been checked should not read as current merely because nothing has expired yet.
 */
export function isAuditDue(auditedOn: string | null | undefined, today: string): boolean {
  if (!auditedOn) return true;
  return daysBetween(auditedOn, today) >= AUDIT_INTERVAL_DAYS;
}

/** Sections due, oldest first, with never-audited ones ahead of everything. */
async function due(limit: number) {
  const rows = await auditable();
  const today = todayIso();
  return rows
    .filter((r) => isAuditDue(r.auditedOn, today))
    .sort((a, b) => (a.auditedOn ?? "").localeCompare(b.auditedOn ?? ""))
    .slice(0, limit);
}

export type AuditRun = { audited: number; findings: number; remaining: number; problems: string[] };

/**
 * Audits the next few sections that are due.
 *
 * Bounded on purpose. A hundred and fifty model calls in one request is a page that appears to
 * hang, a bill nobody chose, and a job that cannot be interrupted — and none of that buys
 * anything, because the deadline is a year away. Small batches run on the idle beat and the work
 * finishes long before it is due.
 *
 * An empty heading naming a form this system produces is dealt with without a model at all: that
 * is a fact about this site, not a judgement, and it should not cost a call to establish.
 */
export async function runManualAudit(
  user: { id: string; name: string },
  opts: { limit?: number } = {},
): Promise<AuditRun> {
  const limit = Math.max(1, Math.min(opts.limit ?? 4, 40));
  const rows = await due(limit);
  const out: AuditRun = { audited: 0, findings: 0, remaining: 0, problems: [] };
  if (rows.length === 0) {
    out.remaining = 0;
    return out;
  }

  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const context =
    `${pharmacy} in ${s.pharmacy_city || "Wichita"}, ${s.pharmacy_state || "KS"}. ` +
    "Independent community pharmacy. Immunizes. Performs simple non-sterile non-hazardous compounding only. " +
    "Dispenses controlled substances. Takes pharmacy students on rotation.";
  const siteDoes = policies(pharmacy).map((x) => `${x.title}: ${x.text[0]}`).join("\n");
  const now = new Date().toISOString();

  for (const sec of rows) {
    // The one case that needs no model: an empty heading naming a form this site produces.
    if (!sec.body.trim()) {
      const form = suggestForm(sec.title);
      if (form) {
        try {
          await saveSection(sec.id, { body: appendixReference(form.name) }, { name: "Annual audit" });
          await db
            .update(schema.manualSections)
            .set({ auditedOn: todayIso() })
            .where(eq(schema.manualSections.id, sec.id));
          out.audited++;
          continue;
        } catch {
          // Fall through and let the review look at it like anything else.
        }
      }
    }

    try {
      const r = await reviewPolicy(
        { title: sec.title, body: sec.body, context, siteDoes },
        { userId: user.id, userName: user.name },
      );
      for (const f of r.findings) {
        // One open finding per section per problem. Re-auditing a section nobody has acted on
        // should not stack three copies of the same sentence in the list.
        const existing = await db.query.manualFindings.findFirst({
          where: and(
            eq(schema.manualFindings.sectionId, sec.id),
            eq(schema.manualFindings.what, f.what),
            isNull(schema.manualFindings.appliedAt),
            isNull(schema.manualFindings.dismissedAt),
          ),
        });
        if (existing) continue;
        await db.insert(schema.manualFindings).values({
          id: newId(),
          sectionId: sec.id,
          sectionTitle: sec.title,
          severity: f.severity,
          what: f.what,
          why: f.why,
          suggestedBody: r.suggestedBody ?? "",
        });
        out.findings++;
      }
      await db
        .update(schema.manualSections)
        .set({ auditedOn: todayIso() })
        .where(eq(schema.manualSections.id, sec.id));
      out.audited++;
    } catch (e) {
      out.problems.push(`${sec.title}: ${describeError(e)}`);
      // Not marked as audited. A section the model could not be asked about is still due.
    }
  }

  out.remaining = (await due(9999)).length;
  await setSetting("manual_audit_last", now);
  await setSetting(
    "manual_audit_result",
    [
      `${out.audited} section${out.audited === 1 ? "" : "s"} read`,
      out.findings ? `${out.findings} finding${out.findings === 1 ? "" : "s"} raised` : "nothing found",
      out.remaining ? `${out.remaining} still due` : "the whole manual is current",
      ...out.problems.slice(0, 2),
    ].join(". ") + ".",
  );
  return out;
}

export async function openFindings(): Promise<Finding[]> {
  return db.query.manualFindings.findMany({
    where: and(isNull(schema.manualFindings.appliedAt), isNull(schema.manualFindings.dismissedAt)),
    orderBy: (f, { asc: a }) => [a(f.severity), a(f.createdAt)],
  });
}

/**
 * Puts the audit's text into the manual.
 *
 * The section is saved through the ordinary path, so the same protections apply — a generated
 * section cannot be overwritten, and neither can one somebody else maintains. The byline says the
 * audit wrote it and that nobody has read it yet, and the section is not marked as reviewed,
 * because applying a suggestion is not the same as having read it.
 */
export async function applyFinding(id: string, user: { name: string }): Promise<void> {
  const f = await db.query.manualFindings.findFirst({ where: eq(schema.manualFindings.id, id) });
  if (!f) throw new Error("That finding no longer exists.");
  if (!f.suggestedBody.trim()) {
    throw new Error(
      "There is no suggested text for this one — it needs a decision about this pharmacy that nothing here can make. Open the section and write it.",
    );
  }
  await saveSection(f.sectionId, { body: f.suggestedBody }, { name: `${user.name} — applied from the audit, not yet reviewed` });
  await db
    .update(schema.manualFindings)
    .set({ appliedAt: new Date().toISOString(), closedBy: user.name })
    .where(eq(schema.manualFindings.id, id));
}

/** Closes a finding without changing the manual. The reason is required, and is the record. */
export async function dismissFinding(id: string, reason: string, user: { name: string }): Promise<void> {
  const why = reason.trim();
  if (!why) {
    throw new Error(
      "Say why. A finding closed with no reason is hidden rather than answered, and the reason is what you would tell an inspector who found the same thing.",
    );
  }
  await db
    .update(schema.manualFindings)
    .set({ dismissedAt: new Date().toISOString(), dismissedReason: why, closedBy: user.name })
    .where(eq(schema.manualFindings.id, id));
}

/** Everything closed, for the record an inspector would ask to see. */
export async function closedFindings(limit = 100): Promise<Finding[]> {
  const rows = await db.query.manualFindings.findMany({ orderBy: (f, { desc }) => [desc(f.createdAt)] });
  return rows.filter((f) => f.appliedAt || f.dismissedAt).slice(0, limit);
}

// Referenced so the query helpers stay imported where the shape of a filter changes later.
void or;
void lt;
void asc;

export type PutRightResult = {
  regenerated: number;
  pointed: number;
  drafted: number;
  markersRemoved: number;
  audited: number;
  raised: number;
  remaining: number;
  problems: string[];
};

/**
 * Everything the site can do to the manual on its own, in one press.
 *
 * The work was spread over four buttons on four cards — regenerate, fill the gaps, strip the
 * markers, run the audit — and the pharmacist-in-charge is not supposed to know which of those
 * his manual needs. He knows the manual is not right. Knowing which of four operations fixes
 * which of four symptoms is the software's job, and asking him to work it out is how a page ends
 * up looking busy and doing nothing.
 *
 * The order matters and is not arbitrary. The generated sections are brought level with what the
 * software actually does first, so that everything after this is judged against the truth. Empty
 * headings naming a form the site produces are settled without a model, because that is a fact
 * rather than a judgement. What is left empty gets drafted. Borrowed footnote markers go. Only
 * then is anything read against the requirements, so the audit is never spending a call on a
 * section that was about to be replaced anyway.
 *
 * Nothing here rewrites a policy the pharmacy has already written. That is deliberate: this is
 * the button somebody presses without reading the consequences, so it may only add what was
 * missing and correct what the site itself generated. Changing existing prose is a separate,
 * explicit act.
 */
export async function putRight(user: { id: string; name: string }, opts: { auditLimit?: number } = {}): Promise<PutRightResult> {
  const out: PutRightResult = {
    regenerated: 0,
    pointed: 0,
    drafted: 0,
    markersRemoved: 0,
    audited: 0,
    raised: 0,
    remaining: 0,
    problems: [],
  };

  // ── 1. The generated half, level with what the software does ──
  try {
    const { regenerateSiteSections } = await import("./manual-store");
    out.regenerated = (await regenerateSiteSections(user)).written;
  } catch (e) {
    out.problems.push(`The generated sections could not be refreshed: ${describeError(e)}`);
  }

  // ── 2 and 3. Empty headings: point at a form, or draft the policy ──
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const context =
    `${pharmacy} in ${s.pharmacy_city || "Wichita"}, ${s.pharmacy_state || "KS"}. ` +
    "Independent community pharmacy. Immunizes. Performs simple non-sterile non-hazardous compounding only. " +
    "Dispenses controlled substances. Takes pharmacy students on rotation.";
  const siteDoes = policies(pharmacy).map((x) => `${x.title}: ${x.text[0]}`).join("\n");
  const canDraft = await hasApiKey();

  const { gaps } = await import("./manual-store");
  for (const g of gaps(await allSections())) {
    const form = suggestForm(g.title);
    if (form) {
      try {
        await saveSection(g.id, { body: appendixReference(form.name) }, user);
        out.pointed++;
      } catch (e) {
        out.problems.push(`${g.title}: ${describeError(e)}`);
      }
      continue;
    }
    if (!canDraft) continue;
    try {
      const { draftPolicy } = await import("./ai");
      const r = await draftPolicy(
        {
          title: g.title,
          body: "",
          instruction:
            "This heading is in the pharmacy's policy manual and has nothing under it. Write the policy it " +
            "promises, for an independent Kansas community pharmacy, covering what a Board inspector would look " +
            "for. Describe only what this pharmacy can actually be held to. Where a detail is specific to this " +
            "pharmacy and you do not have it, raise it as a concern rather than inventing it.",
          context,
          siteDoes,
        },
        { userId: user.id, userName: user.name },
      );
      await saveSection(g.id, { body: r.body }, { name: `${user.name} — drafted by Claude, not yet reviewed` });
      out.drafted++;
    } catch (e) {
      out.problems.push(`${g.title}: ${describeError(e)}`);
    }
  }

  // ── 4. Footnote markers with no footnotes ──
  try {
    const { stripCitationMarkers } = await import("./manual-store");
    out.markersRemoved = (await stripCitationMarkers(user)).markers;
  } catch (e) {
    out.problems.push(`The footnote markers could not be removed: ${describeError(e)}`);
  }

  // ── 5. Read what is due against the requirements ──
  if (canDraft) {
    const r = await runManualAudit(user, { limit: opts.auditLimit ?? 25 });
    out.audited = r.audited;
    out.raised = r.findings;
    out.remaining = r.remaining;
    out.problems.push(...r.problems);
  } else {
    out.problems.push("No Anthropic API key is stored, so nothing could be drafted or read against the rules.");
  }

  return out;
}

/**
 * Applies every finding that came with replacement text.
 *
 * Separate from putRight, and separate on purpose. This one changes policies the pharmacy has
 * already written, which is a different kind of act from filling in a blank — so it is its own
 * button, with the number of sections it will change written on it, rather than something that
 * happens inside a general "fix" press.
 *
 * Findings with no suggested text are left alone and stay on the list. Those are the ones whose
 * fix turns on a fact about this pharmacy that nobody supplied, and inventing one would put a
 * sentence in a manual that the pharmacy is then held to.
 */
export async function applyAllFindings(user: { name: string }): Promise<{ applied: number; left: number; problems: string[] }> {
  const open = await openFindings();
  const out = { applied: 0, left: 0, problems: [] as string[] };
  for (const f of open) {
    if (!f.suggestedBody.trim()) {
      out.left++;
      continue;
    }
    try {
      await applyFinding(f.id, user);
      out.applied++;
    } catch (e) {
      out.problems.push(`${f.sectionTitle}: ${describeError(e)}`);
    }
  }
  return out;
}
