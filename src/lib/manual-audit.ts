import "server-only";
import { and, asc, eq, isNull, or, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso, daysBetween } from "./dates";
import { getSettings, setSetting } from "./settings";
import { hasApiKey, reviewPolicy, describeError } from "./ai";
import { policies, suggestForm, appendixReference } from "./manual";
import { pharmacyFacts } from "./pharmacy-facts";
import { allSections, saveSection, outline } from "./manual-store";

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

/**
 * How many times a section may fail before it stops being retried on its own.
 *
 * A section that fails stays due, and a thing that is always due is retried for ever. Once
 * everything else has been read, the only sections left are the ones that cannot be, and the
 * half-hourly beat would retry them every half hour indefinitely — a model call each time, on the
 * pharmacy's own account, with nobody at the computer to notice. Three attempts is enough to ride
 * out a bad afternoon at the API and few enough that a genuinely unreadable section costs pennies
 * rather than running until somebody looks at a bill.
 *
 * Parked is not resolved. It is still due, still counted, still named on the page with its reason.
 * What changes is that a person has to ask for it again.
 */
export const MAX_AUDIT_ATTEMPTS = 3;

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
/**
 * The sections to read next, oldest first — with the ones that could not be read at the back.
 *
 * The ordering is the whole of a real bug. A never-audited section sorts first, so two sections
 * that fail every time were retried first every time and consumed every batch: the pass reported
 * "0 sections read" while a hundred and eighteen others were never reached, indefinitely. A failed
 * attempt is not a read — the section is still due — but it is an attempt, and something tried an
 * hour ago should go behind something never tried at all.
 */
async function due(limit: number, opts: { includeParked?: boolean } = {}) {
  const rows = await auditable();
  const today = todayIso();
  const lastTried = (r: { auditedOn: string | null; auditFailedOn: string | null }) =>
    [r.auditedOn ?? "", r.auditFailedOn ?? ""].sort().at(-1) ?? "";
  return rows
    .filter((r) => isAuditDue(r.auditedOn, today))
    // Parked sections are still due; they are simply not tried again without being asked for.
    .filter((r) => (opts.includeParked ? true : (r.auditFailCount ?? 0) < MAX_AUDIT_ATTEMPTS))
    .sort((a, b) => lastTried(a).localeCompare(lastTried(b)))
    .slice(0, limit);
}

/** Sections that cannot be read, with the reason, so they can be dealt with rather than retried. */
export async function auditFailures(): Promise<
  { id: string; title: string; when: string; why: string; attempts: number; parked: boolean }[]
> {
  const rows = await auditable();
  return rows
    .filter((r) => r.auditFailedOn && isAuditDue(r.auditedOn, todayIso()))
    .map((r) => ({
      id: r.id,
      title: r.title,
      when: r.auditFailedOn!,
      why: r.auditError ?? "No reason was recorded.",
      attempts: r.auditFailCount ?? 0,
      parked: (r.auditFailCount ?? 0) >= MAX_AUDIT_ATTEMPTS,
    }))
    .sort((a, b) => b.when.localeCompare(a.when));
}

export type AuditRun = { audited: number; findings: number; remaining: number; problems: string[] };

/**
 * Where the work has got to, reported as it happens.
 *
 * Not decoration. This runs for minutes against a model, and a button with no visible effect is
 * one somebody presses again, and again, and then reports as broken — which is exactly what
 * happened. Whoever starts the job decides what to do with these; the background beat throws
 * them away, the page writes them where it can show them.
 */
export type Progress = (p: { step: string; done: number; total: number }) => void | Promise<void>;

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
  opts: { limit?: number; deadline?: number; onProgress?: Progress } = {},
): Promise<AuditRun> {
  const limit = Math.max(1, Math.min(opts.limit ?? 4, 40));
  // A wall clock as well as a count. A model call that takes a minute turns a batch of five into
  // five minutes, and a request that long is indistinguishable from a frozen site to the person
  // waiting on it.
  const deadline = opts.deadline ?? Date.now() + 90_000;
  const rows = await due(limit);
  const out: AuditRun = { audited: 0, findings: 0, remaining: 0, problems: [] };
  if (rows.length === 0) {
    out.remaining = 0;
    return out;
  }

  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  /*
   * Everything the site knows about this pharmacy, rather than four generic sentences.
   *
   * The old context said the pharmacy was independent, immunized and dispensed controlled
   * substances, and nothing else — so the reviewer, correctly forbidden from inventing facts, kept
   * returning "the registration number was not provided to me" and "the pharmacist in charge was
   * not provided". Both are on file here. Withholding them turned twenty fixable findings into
   * twenty things for the pharmacist to write himself.
   */
  const context = (await pharmacyFacts()).text;
  const siteDoes = policies(pharmacy).map((x) => `${x.title}: ${x.text[0]}`).join("\n");
  const now = new Date().toISOString();

  for (const [n, sec] of rows.entries()) {
    if (Date.now() > deadline) break;
    await opts.onProgress?.({ step: `Reading “${sec.title}” against the rules`, done: n, total: rows.length });
    // The one case that needs no model: an empty heading naming a form this site produces.
    if (!sec.body.trim()) {
      const form = suggestForm(sec.title);
      if (form) {
        try {
          await saveSection(sec.id, { body: appendixReference(form.name) }, { name: "Annual audit" });
          await db
            .update(schema.manualSections)
            .set({ auditedOn: todayIso(), auditFailedOn: null, auditError: null, auditFailCount: 0 })
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
        .set({ auditedOn: todayIso(), auditFailedOn: null, auditError: null })
        .where(eq(schema.manualSections.id, sec.id));
      out.audited++;
    } catch (e) {
      const why = describeError(e);
      out.problems.push(`${sec.title}: ${why}`);
      /*
       * Not marked as audited — a section that could not be read is still due. But the attempt is
       * recorded, and that is the fix for a real stall: the queue is oldest-first and a
       * never-audited section sorts first, so two sections that fail every time were retried
       * first every time and consumed every batch. The pass reported "0 sections read" while a
       * hundred and eighteen others were never reached.
       */
      const attempts = (sec.auditFailCount ?? 0) + 1;
      await db
        .update(schema.manualSections)
        .set({
          auditFailedOn: new Date().toISOString(),
          auditError: why.slice(0, 500),
          auditFailCount: attempts,
        })
        .where(eq(schema.manualSections.id, sec.id));
      if (attempts >= MAX_AUDIT_ATTEMPTS) {
        out.problems.push(
          `“${sec.title}” has now failed ${attempts} times and will not be tried again on its own. It is still due and still listed; ask for it and it will be tried again.`,
        );
      }
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

/**
 * The findings that are this pharmacy's to act on.
 *
 * Not everything the reviewer once said. The employment half of this handbook is maintained by the
 * medical practice next door — the pharmacy is bound by it but does not write it — and the audit
 * has excluded that chapter from being read for some time. What it did not do was filter the
 * findings raised before the chapter was marked, so nine sections the pharmacist cannot edit sat
 * at the top of his list telling him to rewrite them. A list of work somebody else has to do is
 * worse than no list: it is read once, found to be undoable, and then not read again.
 */
export async function openFindings(): Promise<Finding[]> {
  const [rows, mine] = await Promise.all([
    db.query.manualFindings.findMany({
      where: and(isNull(schema.manualFindings.appliedAt), isNull(schema.manualFindings.dismissedAt)),
      orderBy: (f, { asc: a }) => [a(f.severity), a(f.createdAt)],
    }),
    auditable(),
  ]);
  const ours = new Set(mine.map((s) => s.id));
  return rows.filter((f) => ours.has(f.sectionId));
}

/**
 * Findings in the chapters somebody else maintains, kept rather than discarded.
 *
 * They are not the pharmacy's to fix and must not sit on his list. They are still worth having:
 * "your handbook gives termination decisions to Administration or Physicians and never terminates
 * the departing person's access to protected health information" is a real thing to hand to the
 * practice that writes it, and it came from reading their text against the rules.
 */
export async function findingsForOthers(): Promise<{ manager: string; findings: Finding[] }[]> {
  const [rows, all] = await Promise.all([
    db.query.manualFindings.findMany({
      where: and(isNull(schema.manualFindings.appliedAt), isNull(schema.manualFindings.dismissedAt)),
      orderBy: (f, { asc: a }) => [a(f.severity), a(f.createdAt)],
    }),
    allSections(),
  ]);
  const managerOf = new Map(all.filter((s) => s.managedBy).map((s) => [s.id, s.managedBy!]));
  const by = new Map<string, Finding[]>();
  for (const f of rows) {
    const manager = managerOf.get(f.sectionId);
    if (!manager) continue;
    by.set(manager, [...(by.get(manager) ?? []), f]);
  }
  return [...by.entries()].map(([manager, findings]) => ({ manager, findings }));
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
  /** Sections still to be read against the rules after this press. */
  remaining: number;
  /** Empty headings still to be written after this press. */
  stillEmpty: number;
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
export async function putRight(
  user: { id: string; name: string },
  opts: { auditLimit?: number; draftLimit?: number; budgetMs?: number; onProgress?: Progress } = {},
): Promise<PutRightResult> {
  /*
   * Bounded, because a press has to finish while somebody is looking at it.
   *
   * The first version did everything: up to nineteen drafts and twenty-five audits in a single
   * request. That is forty-odd model calls, ten minutes or more, and a browser that gives up long
   * before the server does — so the button appeared to do nothing at all, which is the worst
   * possible failure for the one button the page is built around.
   *
   * A press now does a minute of work and says exactly what is left. Pressing again continues,
   * and the background job continues on its own regardless, so nothing depends on anybody
   * pressing it a second time.
   */
  const auditLimit = opts.auditLimit ?? 5;
  const draftLimit = opts.draftLimit ?? 5;
  /*
   * A hard stop, in seconds rather than in items, and a short one.
   *
   * The count alone was not enough. The site appeared to freeze after this button was pressed,
   * because a request that takes minutes is a frozen site as far as anybody watching is
   * concerned. Counting items assumes each one takes a predictable time; a clock does not have to
   * assume anything.
   *
   * Thirty seconds, because that is about as long as somebody will watch a button before deciding
   * it is broken. The press is not where the bulk of the work happens — the background pass is,
   * and it runs whether or not anybody presses anything. This is the part that shows you it is
   * working. Whatever finishes is saved as it goes, so stopping early loses nothing.
   */
  const deadline = Date.now() + (opts.budgetMs ?? 30_000);

  const out: PutRightResult = {
    regenerated: 0,
    pointed: 0,
    drafted: 0,
    markersRemoved: 0,
    audited: 0,
    raised: 0,
    remaining: 0,
    stillEmpty: 0,
    problems: [],
  };

  const say = opts.onProgress ?? (() => {});

  // ── 1. The generated half, level with what the software does ──
  await say({ step: "Bringing the generated sections level with what the site does", done: 0, total: 0 });
  try {
    const { regenerateSiteSections } = await import("./manual-store");
    out.regenerated = (await regenerateSiteSections(user)).written;
  } catch (e) {
    out.problems.push(`The generated sections could not be refreshed: ${describeError(e)}`);
  }

  // ── 2 and 3. Empty headings: point at a form, or draft the policy ──
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  /*
   * Everything the site knows about this pharmacy, rather than four generic sentences.
   *
   * The old context said the pharmacy was independent, immunized and dispensed controlled
   * substances, and nothing else — so the reviewer, correctly forbidden from inventing facts, kept
   * returning "the registration number was not provided to me" and "the pharmacist in charge was
   * not provided". Both are on file here. Withholding them turned twenty fixable findings into
   * twenty things for the pharmacist to write himself.
   */
  const context = (await pharmacyFacts()).text;
  const siteDoes = policies(pharmacy).map((x) => `${x.title}: ${x.text[0]}`).join("\n");
  const canDraft = await hasApiKey();

  const { gaps } = await import("./manual-store");
  const empty = gaps(await allSections());
  // Pointing at a form costs nothing, so all of those are done. Drafting costs a model call
  // each, so those are the ones that are rationed.
  let draftsLeft = draftLimit;
  for (const [n, g] of empty.entries()) {
    await say({ step: `Filling in “${g.title}”`, done: n, total: empty.length });
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
    if (draftsLeft <= 0 || Date.now() > deadline) continue;
    draftsLeft--;
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
  await say({ step: "Removing footnote markers that point at nothing", done: 0, total: 0 });
  try {
    const { stripCitationMarkers } = await import("./manual-store");
    out.markersRemoved = (await stripCitationMarkers(user)).markers;
  } catch (e) {
    out.problems.push(`The footnote markers could not be removed: ${describeError(e)}`);
  }

  out.stillEmpty = gaps(await allSections()).length;

  // ── 5. Read what is due against the requirements ──
  if (canDraft) {
    const r = await runManualAudit(user, { limit: auditLimit, deadline, onProgress: opts.onProgress });
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

/**
 * Puts back into the queue the sections that were only waiting on a fact.
 *
 * A finding that came with no replacement text is one the reviewer could not write because a fact
 * about this pharmacy was missing — the registration number, who receives a complaint, which
 * schedules the DEA registration covers. Once those are on file the same section reads completely
 * differently, but it will not be read again for a year: it was audited, and it is not due.
 *
 * So supplying the facts is not enough on its own. This clears the audit date on exactly those
 * sections, and closes the findings that were only ever "you have to decide this" — they are not
 * dismissed as wrong, they are superseded by an answer.
 */
export async function rereadBlockedSections(user: { name: string }): Promise<{ sections: number; findings: number }> {
  const open = await db.query.manualFindings.findMany({
    where: and(isNull(schema.manualFindings.appliedAt), isNull(schema.manualFindings.dismissedAt)),
  });
  // No suggested text is the marker: the reviewer had a finding and could not write the fix.
  // Only ours. openFindings already filters, but this reads the table directly and a section the
  // practice maintains must never be put back in the queue by anything.
  const ours = new Set((await auditable()).map((s) => s.id));
  const blocked = open.filter((f) => !f.suggestedBody.trim() && ours.has(f.sectionId));
  const sectionIds = [...new Set(blocked.map((f) => f.sectionId))];

  for (const id of sectionIds) {
    await db
      .update(schema.manualSections)
      .set({ auditedOn: null, auditFailedOn: null, auditError: null })
      .where(eq(schema.manualSections.id, id));
  }
  for (const f of blocked) {
    await db
      .update(schema.manualFindings)
      .set({
        dismissedAt: new Date().toISOString(),
        dismissedReason: `Superseded — the pharmacy supplied what this was waiting on, and the section is being read again. Closed by ${user.name}.`,
        closedBy: user.name,
      })
      .where(eq(schema.manualFindings.id, f.id));
  }
  return { sections: sectionIds.length, findings: blocked.length };
}

/** How many findings are open only because a fact about the pharmacy was missing. */
export async function blockedOnFacts(): Promise<number> {
  return (await openFindings()).filter((f) => !f.suggestedBody.trim()).length;
}

/**
 * Unparks the sections that stopped being retried, when somebody asks for them.
 *
 * Parking is a cost control, not a verdict. Whatever made a section unreadable may have been a bad
 * afternoon at the API, or may have been fixed by splitting the section in two — but neither is
 * something the site can know, so it waits to be told.
 */
export async function retryParked(): Promise<number> {
  const rows = await auditable();
  const parked = rows.filter((r) => (r.auditFailCount ?? 0) >= MAX_AUDIT_ATTEMPTS);
  for (const r of parked) {
    await db.update(schema.manualSections).set({ auditFailCount: 0 }).where(eq(schema.manualSections.id, r.id));
  }
  return parked.length;
}

/**
 * Puts one chapter's sections back in the queue, because somebody asked for that chapter.
 *
 * The queue is otherwise driven by dates — a section read this year is not due — and the only
 * way to say "read this one now" was to wait. A chapter the pharmacy has just rewritten, or one it
 * has just taken back from the practice, deserves a reading on request. Sections the practice
 * maintains and sections the site writes are never queued by this, whatever chapter they sit in.
 */
export async function requeueChapter(chapterId: string): Promise<number> {
  const rows = outline(await allSections());
  const mine = rows.filter((r) => r.chapterId === chapterId && r.source === "pharmacy" && !r.managedBy && !r.retiredOn);
  for (const r of mine) {
    await db
      .update(schema.manualSections)
      .set({ auditedOn: null, auditFailedOn: null, auditError: null, auditFailCount: 0 })
      .where(eq(schema.manualSections.id, r.id));
  }
  return mine.length;
}
