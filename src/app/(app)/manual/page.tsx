import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSettings, setSetting } from "@/lib/settings";
import { hasApiKey, draftPolicy, describeError } from "@/lib/ai";
import {
  allSections,
  outline,
  gaps,
  importDocx,
  regenerateSiteSections,
  saveSection,
  addSection,
  removeSection,
  markReviewed,
  markAllReviewed,
  needingReview,
  citationMarkers,
  stripCitationMarkers,
  setChapterManager,
  managers,
  searchSections,
} from "@/lib/manual-store";
import { policies, FORMS, appendixReference, suggestForm } from "@/lib/manual";
import {
  auditProgress,
  auditFailures,
  rereadBlockedSections,
  blockedOnFacts,
  findingsForOthers,
  openFindings,
  runManualAudit,
  applyFinding,
  dismissFinding,
  applyAllFindings,
} from "@/lib/manual-audit";
import { manualJob, startPutRight, runPutRight, isRunning, isStale, summarise, ago } from "@/lib/manual-job";
import { acknowledgementBoard, settleVersions } from "@/lib/manual-acknowledgement";
import { estimateSentence } from "@/lib/ai-spend";
import { pharmacyFacts, namedRoles } from "@/lib/pharmacy-facts";
import { fmt, todayIso } from "@/lib/dates";
import { PageHeader, Card, Figure, Notice, Field, Empty } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { JobPanel } from "@/components/job-panel";
import { after } from "next/server";

/** Same day next year, for saying plainly when a section just read comes round again. */
function nextYear(): string {
  const [y, m, d] = todayIso().split("-").map(Number);
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Policy manual" };

/**
 * The policy and procedure manual, edited here.
 *
 * Two documents describing one pharmacy always drift, and the drift is invisible until somebody
 * reads both. So there is one document and this is it. A Word file is an export of this, not the
 * other way round.
 *
 * Sections come in two kinds, and the distinction is the point. The pharmacy's own prose is
 * edited freely. The sections describing what this system does are generated and cannot be typed
 * over — because the moment they can be, they will say something the software does not do, and a
 * manual is a standard an inspector holds you to. Changing one of those means changing the
 * practice, and the text follows.
 *
 * It opens on the chapters rather than the sections. A real manual is a hundred and thirty-five
 * sections long; put them all on one screen and the screen is a scrollbar. You pick a chapter and
 * work in it, the way you would with the paper copy open on the counter.
 */
export default async function ManualPage({
  searchParams,
}: {
  searchParams: Promise<{
    ok?: string;
    error?: string;
    edit?: string;
    ch?: string;
    q?: string;
    draft?: string;
    note?: string;
    concerns?: string;
  }>;
}) {
  const user = await requireUser();
  const { ok, error, edit, ch, q, draft, note, concerns } = await searchParams;
  const [rows, s, aiReady, stale, audit_, findings, job] = await Promise.all([
    allSections(),
    getSettings(),
    hasApiKey(),
    needingReview(),
    auditProgress(),
    openFindings(),
    manualJob(),
  ]);
  const working = isRunning(job);
  // Who has signed for this manual, and who signed for an older one. Read after the sections,
  // because it fingerprints exactly what is on this page.
  /*
   * Which chapters the open findings are landing in, and who maintains each.
   *
   * The pharmacist-in-charge said plainly that the employment half of this handbook is not his to
   * change. The site has always been able to record that — but only from a select buried inside an
   * opened chapter, which is to say nowhere anybody would look. So the findings kept arriving
   * against sections he cannot edit, and the only way to stop them was to know about a control he
   * had never seen. It belongs next to the findings, which is where the problem is felt.
   */
  const [ack, stuck, facts, roles, blocked] = await Promise.all([
    acknowledgementBoard(),
    auditFailures(),
    pharmacyFacts(),
    namedRoles(),
    blockedOnFacts(),
  ]);
  const theirs = await findingsForOthers();
  const sections = outline(rows);
  const pharmacy = s.pharmacy_name || "This pharmacy";

  const own = sections.filter((x) => x.source === "pharmacy" && !x.managedBy);
  const generated = sections.filter((x) => x.source === "site");
  const elsewhere = sections.filter((x) => x.managedBy);
  const empty = gaps(rows);
  /*
   * What the press will cost, before it is pressed.
   *
   * This is a pharmacy paying its own API bill, and a button that spends money without saying how
   * much is one nobody should press. The counts are already known — what is due to be read, and
   * which empty headings need writing rather than merely pointing at a form — so the figure is
   * arithmetic rather than a guess.
   */
  const cites = citationMarkers(rows);
  const citeTotal = cites.reduce((n, c) => n + c.count, 0);
  const others = managers(rows);
  const priceTag = aiReady ? await estimateSentence(audit_.due, empty.filter((g) => !suggestForm(g.title)).length) : "";

  // Editing a section always shows its chapter, so a link straight to a section from the gaps list
  // lands you in the chapter it belongs to rather than on a page with one section on it.
  const editing = edit ? sections.find((x) => x.id === edit) : undefined;
  const openId = editing?.chapterId ?? ch;
  const chapters = sections.filter((x) => x.depth === 0);
  const open = openId ? chapters.find((c) => c.id === openId) : undefined;
  const inChapter = open ? sections.filter((x) => x.chapterId === open.id) : [];

  const query = (q ?? "").trim();
  const hits = query ? searchSections(rows, query) : [];
  const canManage = user.role !== "staff";

  /*
   * Everything wrong with the manual, in one list, in the order it matters.
   *
   * The page used to carry a card per problem — an audit card, a gaps card, a footnote-marker
   * card — each with its own button, and the pharmacist-in-charge was left to work out which of
   * them his manual needed. He does not know that. He knows the manual is not right. Which
   * operation fixes which symptom is the software's job, so the symptoms are named in one place
   * and there is one button under them.
   */
  const problems: { key: string; severity: "crit" | "warn"; what: string; fix: string }[] = [];
  if (audit_.blocking > 0) {
    problems.push({
      key: "blocking",
      severity: "crit",
      what: `${audit_.blocking} finding${audit_.blocking === 1 ? "" : "s"} an inspector would write up`,
      fix: "Each comes with the replacement text where one could be written.",
    });
  }
  if (empty.length > 0) {
    const named = empty.filter((x) => suggestForm(x.title)).length;
    problems.push({
      key: "empty",
      severity: "crit",
      what: `${empty.length} heading${empty.length === 1 ? "" : "s"} promising a policy and delivering none`,
      fix: named
        ? `${named} name a form this site produces and are filled in without a model; the rest are drafted.`
        : "Each is drafted against what this pharmacy is and what this site does.",
    });
  }
  if (findings.length - audit_.blocking > 0) {
    problems.push({
      key: "findings",
      severity: "warn",
      what: `${findings.length - audit_.blocking} weaker finding${findings.length - audit_.blocking === 1 ? "" : "s"} to answer`,
      fix: "Applied or dismissed with a reason, one at a time or all together.",
    });
  }
  if (citeTotal > 0) {
    problems.push({
      key: "cites",
      severity: "warn",
      what: `${citeTotal} footnote marker${citeTotal === 1 ? "" : "s"} with no footnotes anywhere`,
      fix: "Removed. The policies underneath are not touched.",
    });
  }
  if (audit_.due > 0) {
    problems.push({
      key: "due",
      severity: "warn",
      what: `${audit_.due} section${audit_.due === 1 ? "" : "s"} not read against the rules within the last year`,
      fix: "Read against Kansas, DEA, HIPAA and OSHA, and against what this site does.",
    });
  }
  if (stale.length > 0) {
    problems.push({
      key: "stale",
      severity: "warn",
      what: `${stale.length} section${stale.length === 1 ? "" : "s"} with no review date inside the last year`,
      fix: "Only you can sign that. The button below records today against the whole manual.",
    });
  }
  const fixable = findings.filter((f) => f.suggestedBody.trim()).length;

  async function doImport(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) redirect("/manual?error=" + encodeURIComponent("Choose the Word file."));
    if (!/\.docx$/i.test(file.name)) {
      redirect("/manual?error=" + encodeURIComponent("It has to be a .docx. An older .doc must be saved as .docx first."));
    }
    try {
      const r = await importDocx(Buffer.from(await file.arrayBuffer()), u);
      await audit({ action: "manual.import", userId: u.id, userName: u.name, details: `${r.imported} sections` });
      revalidatePath("/manual");
      redirect("/manual?ok=" + encodeURIComponent(`${r.imported} sections imported. Nothing was rewritten — read them, then use "Ask Claude" on any that need work.`));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/manual?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not read that file."));
    }
  }

  async function regenerate() {
    "use server";
    const u = await requireManager();
    const r = await regenerateSiteSections(u);
    await audit({ action: "manual.regenerate", userId: u.id, userName: u.name, details: `${r.written}` });
    revalidatePath("/manual");
    redirect("/manual?ok=" + encodeURIComponent(`${r.written} generated sections brought up to date with what the site does.`));
  }

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const back = String(fd.get("ch") ?? "");
    try {
      await saveSection(id, { title: String(fd.get("title") ?? ""), body: String(fd.get("body") ?? "") }, u);
      await audit({ action: "manual.edit", userId: u.id, userName: u.name, details: id });
      revalidatePath("/manual");
      redirect(`/manual?ch=${back}&ok=` + encodeURIComponent("Saved.") + `#${id}`);
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/manual?ch=${back}&error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  async function ask(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const instruction = String(fd.get("instruction") ?? "").trim();
    if (!instruction) redirect(`/manual?edit=${id}&error=` + encodeURIComponent("Say what you want changed."));
    const all = await allSections();
    const sec = all.find((x) => x.id === id);
    if (!sec) redirect("/manual?error=" + encodeURIComponent("That section no longer exists."));

    const set = await getSettings();
    const p = policies(set.pharmacy_name || "This pharmacy");
    try {
      const r = await draftPolicy(
        {
          title: sec.title,
          body: sec.body,
          instruction,
          context:
            `${set.pharmacy_name || "A community pharmacy"} in ${set.pharmacy_city || "Kansas"}, ${set.pharmacy_state || "KS"}. ` +
            `Independent community pharmacy. Immunizes. Performs simple non-sterile non-hazardous compounding only. ` +
            `Dispenses controlled substances. Takes pharmacy students on rotation.`,
          siteDoes: p.map((x) => `${x.title}: ${x.text[0]}`).join("\n"),
        },
        { userId: u.id, userName: u.name },
      );
      const q = new URLSearchParams({ edit: id, draft: r.body, note: r.changed });
      if (r.concerns.length) q.set("concerns", r.concerns.join(" | "));
      redirect(`/manual?${q.toString()}#${id}`);
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/manual?edit=${id}&error=` + encodeURIComponent(e instanceof Error ? e.message : "Claude could not be reached."));
    }
  }

  async function add(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = await addSection(String(fd.get("after") ?? "") || null, u);
    revalidatePath("/manual");
    redirect(`/manual?edit=${id}#${id}`);
  }

  async function remove(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      await removeSection(String(fd.get("id") ?? ""), u);
      revalidatePath("/manual");
      redirect("/manual?ok=" + encodeURIComponent("Removed from the manual. Its history is kept."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/manual?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not remove that."));
    }
  }

  /**
   * Reads the sections that are due, now rather than waiting for the background job.
   *
   * The pass runs itself a few sections at a time on the idle beat, which is the right pace for a
   * deadline a year away. This is for the day before an inspection, when the right pace is
   * "as much as you can before I get back from lunch".
   */
  async function auditNow() {
    "use server";
    const u = await requireManager();
    try {
      const r = await runManualAudit(u, { limit: 20 });
      await audit({
        action: "manual.audit",
        userId: u.id,
        userName: u.name,
        details: `${r.audited} read, ${r.findings} raised`,
      });
      revalidatePath("/manual");
      redirect(
        `/manual?${r.problems.length ? "error" : "ok"}=` +
          encodeURIComponent(
            [
              r.audited
                ? `${r.audited} section${r.audited === 1 ? "" : "s"} read against the requirements`
                : "Nothing was due",
              r.findings ? `${r.findings} finding${r.findings === 1 ? "" : "s"} raised` : "nothing found",
              r.remaining ? `${r.remaining} still due — press again, or leave it to run on its own` : "the whole manual is now current",
              ...r.problems,
            ].join(". ") + ".",
          ) + "#audit",
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/manual?error=" + encodeURIComponent(e instanceof Error ? e.message : "The audit could not run."));
    }
  }

  async function applyFindingAction(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await applyFinding(id, u);
      await audit({ action: "manual.finding.apply", userId: u.id, userName: u.name, entity: "manual", entityId: id });
      revalidatePath("/manual");
      redirect(
        "/manual?ok=" +
          encodeURIComponent(
            "Put into the manual, marked as applied from the audit and not yet reviewed. Read it — applying a suggestion is not the same as having read it.",
          ) + "#audit",
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/manual?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not apply that.") + "#audit");
    }
  }

  async function dismissFindingAction(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await dismissFinding(id, String(fd.get("reason") ?? ""), u);
      await audit({ action: "manual.finding.dismiss", userId: u.id, userName: u.name, entity: "manual", entityId: id });
      revalidatePath("/manual");
      redirect("/manual?ok=" + encodeURIComponent("Closed, with your reason on it.") + "#audit");
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/manual?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not close that.") + "#audit");
    }
  }

  /**
   * Every empty heading, closed in one press.
   *
   * The gaps list showed ten headings promising a form or a policy and delivering nothing, and
   * offered a dropdown and a text editor per row. That is ten decisions and ten pieces of writing,
   * which is why it had been ten gaps for as long as anyone could remember — the work was real and
   * the button only started it.
   *
   * Two different jobs, so two different treatments. A heading naming a form this system produces
   * gets the appendix reference, immediately and with no model involved: that is a fact about this
   * site, not a judgement. A heading naming a policy the pharmacy has to have and does not gets a
   * draft written against what this pharmacy actually is and what this system actually does.
   *
   * The drafts are marked as drafted by Claude in the section's own byline and are not recorded as
   * reviewed, so they appear in the annual review list until a person has read them. A policy
   * nobody has read is not a policy — but it is a great deal closer to one than a blank page under
   * a heading that promises it.
   */
  async function fillGaps() {
    "use server";
    const u = await requireManager();
    const rows = await allSections();
    const empty = gaps(rows);
    if (empty.length === 0) redirect("/manual?ok=" + encodeURIComponent("Nothing is empty."));

    const set = await getSettings();
    const pharmacy = set.pharmacy_name || "This pharmacy";
    const p = policies(pharmacy);
    const context =
      `${pharmacy} in ${set.pharmacy_city || "Wichita"}, ${set.pharmacy_state || "KS"}. ` +
      "Independent community pharmacy. Immunizes. Performs simple non-sterile non-hazardous compounding only. " +
      "Dispenses controlled substances. Takes pharmacy students on rotation.";
    const siteDoes = p.map((x) => `${x.title}: ${x.text[0]}`).join("\n");
    const canDraft = await hasApiKey();

    let pointed = 0;
    let drafted = 0;
    const problems: string[] = [];

    for (const x of empty) {
      const form = suggestForm(x.title);
      if (form) {
        try {
          await saveSection(x.id, { body: appendixReference(form.name) }, u);
          pointed++;
        } catch (e) {
          problems.push(`${x.title}: ${e instanceof Error ? e.message : "could not be filled in"}`);
        }
        continue;
      }
      if (!canDraft) continue;
      try {
        const r = await draftPolicy(
          {
            title: x.title,
            body: "",
            instruction:
              "This heading is in the pharmacy's policy manual and has nothing under it. Write the policy it " +
              "promises, for an independent Kansas community pharmacy, covering what a Board inspector would " +
              "look for. Describe only what this pharmacy can actually be held to. Where a detail is specific to " +
              "this pharmacy and you do not have it, raise it as a concern rather than inventing it.",
            context,
            siteDoes,
          },
          { userId: u.id, userName: u.name },
        );
        // The byline says who wrote it. A manual that cannot tell you which of its policies a
        // model drafted is one nobody can review properly.
        await saveSection(x.id, { body: r.body }, { name: `${u.name} — drafted by Claude, not yet reviewed` });
        drafted++;
      } catch (e) {
        problems.push(`${x.title}: ${describeError(e)}`);
      }
    }

    await audit({
      action: "manual.fill_gaps",
      userId: u.id,
      userName: u.name,
      details: `${pointed} pointed at a form, ${drafted} drafted`,
    });
    revalidatePath("/manual");

    const said = [
      pointed ? `${pointed} heading${pointed === 1 ? "" : "s"} now point${pointed === 1 ? "s" : ""} at the form this site produces` : "",
      drafted ? `${drafted} ${drafted === 1 ? "policy was" : "policies were"} drafted by Claude` : "",
      !canDraft && empty.length > pointed
        ? `${empty.length - pointed} need writing and there is no Anthropic API key stored, so nothing could be drafted`
        : "",
    ].filter(Boolean).join(". ");
    const tail = drafted
      ? " Read every drafted one before the manual is printed — they are marked as drafted and unreviewed until you do."
      : "";
    redirect(
      `/manual?${problems.length ? "error" : "ok"}=` +
        encodeURIComponent(`${said || "Nothing could be filled in"}.${tail} ${problems.join(" ")}`.trim()),
    );
  }

  /**
   * Fill an empty heading with a reference to the form the system produces.
   *
   * Which form a heading means is a judgement about this pharmacy, so it is picked rather than
   * guessed — "HIPAA Form" could be the notice of privacy practices or the training
   * acknowledgement, and a system that guesses wrong writes a false statement into a document an
   * inspector holds you to. One click, but a chosen one.
   */
  async function pointAtAppendix(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const form = String(fd.get("form") ?? "");
    try {
      await saveSection(id, { body: appendixReference(form) }, u);
      await audit({ action: "manual.appendix.reference", userId: u.id, userName: u.name, details: `${id} → ${form}` });
      revalidatePath("/manual");
      redirect("/manual?ok=" + encodeURIComponent("Filled in, pointing at the appendix. Read it before you print."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/manual?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not fill that in."));
    }
  }

  async function stripCitations() {
    "use server";
    const u = await requireManager();
    const r = await stripCitationMarkers(u);
    await audit({ action: "manual.citations.stripped", userId: u.id, userName: u.name, details: `${r.markers} markers in ${r.sections} sections` });
    revalidatePath("/manual");
    redirect("/manual?ok=" + encodeURIComponent(`${r.markers} footnote markers removed from ${r.sections} sections. The policies themselves are untouched — read the controlled substances chapter once before you print it.`));
  }

  async function setManager(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("chapter") ?? "");
    const name = String(fd.get("manager") ?? "").trim();
    try {
      const n = await setChapterManager(id, name || null, u);
      await audit({ action: "manual.chapter.manager", userId: u.id, userName: u.name, details: `${id} → ${name || "the pharmacy"}` });
      revalidatePath("/manual");
      redirect(
        "/manual?ok=" +
          encodeURIComponent(
            name
              ? `${n} sections marked as maintained by ${name}. They still print as part of the manual, but the site will not chase you to review them or count their gaps as yours.`
              : `${n} sections handed back to the pharmacy.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/manual?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not change that."));
    }
  }

  async function reviewed(fd: FormData) {
    "use server";
    const u = await requireManager();
    await markReviewed(String(fd.get("id") ?? ""), u);
    revalidatePath("/manual");
    redirect(`/manual?ch=${String(fd.get("ch") ?? "")}&ok=` + encodeURIComponent("Marked as reviewed today."));
  }

  /**
   * The one button.
   *
   * Runs everything the site can do to the manual without a person deciding anything: the
   * generated sections brought level with what the software actually does, empty headings that
   * name a form pointed at it, the rest drafted, borrowed footnote markers removed, and whatever
   * is due read against the requirements. It deliberately does not rewrite a policy the pharmacy
   * has already written — that is the next button along, and it says how many it will change.
   */
  /**
   * Settles acknowledgements that were signed before versions were recorded.
   *
   * Only the ones where nothing in the manual has been edited since the signature, so nothing is
   * asserted that the system cannot show. The basis goes into the record beside the version, since
   * a fingerprint that appeared afterwards has to say how it got there.
   */
  async function settleAction() {
    "use server";
    const u = await requireManager();
    const r = await settleVersions(u);
    await audit({ action: "manual.ack.settle", userId: u.id, userName: u.name, details: `${r.settled}` });
    revalidatePath("/manual");
    redirect(
      "/manual?ok=" +
        encodeURIComponent(
          r.settled === 0
            ? "Nothing could be settled from the edit history. Those signatures were given before an edit, so the only way to say which manual they cover is to ask again."
            : `${r.settled} acknowledgement${r.settled === 1 ? "" : "s"} recorded against this revision, because no section had been edited between the signature and now. ${r.left > 0 ? `${r.left} still cannot be established and would need sending again.` : "Every acknowledgement now names its manual."}`,
        ),
    );
  }

  /** Saves the roles the inherited manual keeps naming, and offers to re-read what was waiting. */
  async function saveRolesAction(fd: FormData) {
    "use server";
    const u = await requireManager();
    await setSetting("role_complaints", String(fd.get("role_complaints") ?? "").trim());
    await setSetting("role_complaints_alt", String(fd.get("role_complaints_alt") ?? "").trim());
    await setSetting("role_hiring", String(fd.get("role_hiring") ?? "").trim());
    await setSetting("role_termination", String(fd.get("role_termination") ?? "").trim());
    await setSetting("dea_schedules", String(fd.get("dea_schedules") ?? "").trim());
    await audit({ action: "manual.facts", userId: u.id, userName: u.name });
    revalidatePath("/manual");
    redirect(
      "/manual?ok=" +
        encodeURIComponent(
          "Saved. Every review from now on is told these, so the findings that said “decide this yourself” can be " +
            "written instead. Use “Read those sections again” below to redo the ones that were waiting on them.",
        ),
    );
  }

  /** Puts the sections that were only waiting on a fact back into the queue. */
  async function rereadAction() {
    "use server";
    const u = await requireManager();
    const r = await rereadBlockedSections(u);
    await audit({ action: "manual.reread", userId: u.id, userName: u.name, details: `${r.sections}` });
    revalidatePath("/manual");
    redirect(
      "/manual?ok=" +
        encodeURIComponent(
          r.sections === 0
            ? "Nothing was waiting on a fact."
            : `${r.sections} section${r.sections === 1 ? "" : "s"} put back in the queue and ${r.findings} finding${r.findings === 1 ? "" : "s"} closed as superseded. Press “Put it right” and they are read again — this time knowing who you are.`,
        ),
    );
  }

  async function putRightAction() {
    "use server";
    const u = await requireManager();
    const r = await startPutRight(u);
    /*
     * The work runs after the response, not inside it.
     *
     * A press that does the work inline holds the browser's router open for as long as it takes,
     * which stops every other link on the site responding — the site had not frozen, but there is
     * no way to tell that from the outside, and it was reported as frozen twice. Starting the job
     * and returning immediately means the press is instant, the site stays usable, and the panel
     * on this page shows what is happening.
     */
    if (r.started) after(() => runPutRight(u));
    revalidatePath("/manual");
    redirect(`/manual?${r.started ? "ok" : "error"}=` + encodeURIComponent(r.message));
  }

  /** Puts every finding that came with replacement text into the manual, in one act. */
  async function applyAllAction() {
    "use server";
    const u = await requireManager();
    const r = await applyAllFindings(u);
    await audit({ action: "manual.findings.apply_all", userId: u.id, userName: u.name, details: `${r.applied}` });
    revalidatePath("/manual");
    redirect(
      `/manual?${r.problems.length ? "error" : "ok"}=` +
        encodeURIComponent(
          [
            r.applied ? `${r.applied} section${r.applied === 1 ? "" : "s"} rewritten from the audit` : "Nothing had replacement text",
            r.left ? `${r.left} left because the fix needs a decision about this pharmacy` : "",
            "Read what changed before the manual is printed — every one is marked as applied and unreviewed.",
            ...r.problems.slice(0, 2),
          ].filter(Boolean).join(". "),
        ),
    );
  }

  async function reviewAll() {
    "use server";
    const u = await requireManager();
    const n = await markAllReviewed(u);
    await audit({ action: "manual.reviewed", userId: u.id, userName: u.name, details: `${n} sections` });
    revalidatePath("/manual");
    redirect("/manual?ok=" + encodeURIComponent(`All ${n} sections recorded as reviewed today by ${u.name}. That date is what an annual review looks like on paper.`));
  }

  return (
    <>
      <PageHeader
        title="Policy and procedure manual"
        subtitle={`${pharmacy} — one document, edited here. The Word file is an export of this, not the other way round.`}
        back={open ? { href: "/manual", label: "All chapters" } : undefined}
        actions={
          sections.length > 0 ? (
            <>
              <Link href="/manual/print" className="btn">Print it</Link>
              {canManage && problems.length > 0 && !working && (
                <form action={putRightAction}>
                  <SubmitButton pendingLabel="Starting…" disabled={!aiReady && empty.length === 0 && citeTotal === 0}>
                    Put it right
                  </SubmitButton>
                </form>
              )}
            </>
          ) : undefined
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        Whether it is running, and what happened last time.

        Both halves matter. Without the first, a press that takes four minutes looks like a press
        that did nothing. Without the second, a press whose work finished after the page was closed
        leaves no evidence it ever ran — and the honest report was "is it running? is it working?",
        asked about a button that was in fact working.
      */}
      {working && job && (
        <JobPanel step={job.step} done={job.done} total={job.total} startedAt={job.startedAt} by={job.by} />
      )}

      {!working && isStale(job) && (
        <Notice kind="warn">
          <b>The last pass stopped before it finished.</b> That normally means the computer was switched off or
          restarted while it was working. Everything it had done by then was saved. Press <b>Put it right</b> to carry
          on from there.
        </Notice>
      )}

      {!working && job?.state === "failed" && (
        <Notice kind="crit">
          <b>The last pass stopped {ago(job.finishedAt)}:</b> {job.error}
        </Notice>
      )}

      {!working && job?.state === "done" && job.result && (
        <Notice kind={job.result.problems.length ? "warn" : "ok"}>
          <b>Last pass finished {ago(job.finishedAt)}.</b> {summarise(job.result)}.
          {job.result.drafted > 0 && " Anything drafted is marked as drafted and unreviewed until you have read it."}
          {job.result.problems.length > 0 && ` ${job.result.problems.slice(0, 3).join(" ")}`}
        </Notice>
      )}

      {sections.length === 0 ? (
        <Card title="Bring your manual in" subtitle="Upload the Word file and it is split into sections on its own headings. Nothing is rewritten — the text arrives exactly as it is, and you edit from there.">
          <form action={doImport} className="flex flex-wrap items-end gap-3" encType="multipart/form-data">
            <Field label="A .docx file"><input type="file" name="file" accept=".docx" className="field" /></Field>
            <button className="btn btn-primary">Import</button>
          </form>
          <p className="mt-3 text-xs text-ink-3">
            Or start from what this site already does — {policies(pharmacy).length} generated sections describing the
            procedures it performs.
            <form action={regenerate} className="mt-2"><button className="btn btn-sm">Generate those now</button></form>
          </p>
        </Card>
      ) : (
        <>
          {/*
            What is wrong, and the one button that fixes it.

            This replaced three cards with three buttons — an audit card, a gaps card, a
            footnote-marker card — each of which asked the pharmacist-in-charge to know which
            operation his manual needed. He does not know that, and should not have to: he knows
            the manual is not right. So the symptoms are listed in one place, in the order they
            matter, and the button underneath does all of it.
          */}
          <Card
            id="state"
            tone={problems.some((p) => p.severity === "crit") ? "crit" : problems.length ? "warn" : undefined}
            title={problems.length === 0 ? "The manual is in order" : "What is wrong with the manual"}
            count={problems.length === 0 ? undefined : problems.length}
            subtitle={
              problems.length === 0
                ? `All ${own.length} of your sections are written, read against the requirements within the last year, and reviewed. Nothing is outstanding.`
                : "Everything here is fixed by one press, except the last line of each — which says what the fix actually does, so nothing happens to the manual that you did not know about."
            }
            className="mb-6"
          >
            {problems.length > 0 && (
              <ul className="rows">
                {problems.map((p) => (
                  <li key={p.key} className="flex flex-wrap items-start gap-2 py-2">
                    <span className={`badge ${p.severity === "crit" ? "badge-crit" : "badge-warn"} mt-0.5 shrink-0`}>
                      {p.severity === "crit" ? "would be written up" : "worth fixing"}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{p.what}</span>
                      <span className="block text-xs text-ink-3">{p.fix}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {canManage && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                {problems.length > 0 && !working && (
                  <form action={putRightAction}>
                    <SubmitButton
                      pendingLabel="Starting…"
                      hint="Starts straight away and then works in the background — the site stays usable and this page shows where it has got to."
                      disabled={!aiReady}
                    >
                      Put it right
                    </SubmitButton>
                  </form>
                )}
                {/*
                  The price, on the button rather than on a bill three weeks later.

                  The pharmacy pays for this directly, and a figure only visible after the fact is
                  one nobody can decide against. It also says the thing that makes the number make
                  sense: a section is read once a year, so this is an annual cost and a manual that
                  is current costs nothing to press.
                */}
                {priceTag && problems.length > 0 && !working && (
                  <span className="w-full text-xs text-ink-3">{priceTag}</span>
                )}
                {working && (
                  <span className="text-xs text-accent">
                    It is running now — the panel at the top of the page shows where it has got to.
                  </span>
                )}
                {/*
                  Rewriting existing policies is its own act, with the count on the button.

                  The press above only ever adds what was missing or corrects what the site itself
                  generated. This one changes prose the pharmacy has already written and stands
                  behind, which is a different kind of decision and should not happen inside a
                  general "fix" button.
                */}
                {fixable > 0 && (
                  <form action={applyAllAction}>
                    <SubmitButton className="btn" pendingLabel="Rewriting…" hint="A few seconds per section.">
                      Apply all {fixable} suggested rewrites
                    </SubmitButton>
                  </form>
                )}
                {stale.length > 0 && (
                  <form action={reviewAll}>
                    <button className="btn">I have reviewed the manual — record today</button>
                  </form>
                )}
                {!aiReady && (
                  <span className="text-xs text-crit">
                    <b>Claude is not connected</b>, so &ldquo;Put it right&rdquo; cannot draft anything or read the
                    manual against the rules — that is why it does nothing. Add your Anthropic API key under{" "}
                    <Link href="/settings/connections" className="underline">Settings → Claude</Link> and it will work.
                  </span>
                )}
              </div>
            )}

            {/*
              What a press actually does, said on the page.

              Three questions were asked about this button in one breath: does pressing it again
              check the same things, why do so many sections say unchecked, and does it have to be
              pressed until the manual is finished. All three have good answers and none of them
              were anywhere on the screen — the progress line gave a fraction and left the rest to
              be guessed at.
            */}
            <div className="mt-3 space-y-1 text-xs text-ink-3">
              <p>
                <b className="text-ink-2">{audit_.current} of {audit_.total}</b> sections have been read against
                Kansas, DEA, HIPAA and OSHA requirements within the last year.
                {audit_.due > 0 ? ` ${audit_.due} still to read.` : " Nothing is outstanding."}
              </p>
              {audit_.due > 0 && (
                <>
                  <p>
                    Pressing it again never re-reads a section it has already read — a section is due once a year, and
                    one read today is not due again until {fmt(nextYear())}. Each press works through up to 40
                    of them, or eight minutes&rsquo; worth, whichever comes first.
                  </p>
                  <p>
                    <b className="text-ink-2">You do not have to keep pressing it.</b> The same reading happens on its
                    own while nobody is using the site — about eight sections every half hour — so {audit_.due} left is
                    roughly {Math.max(1, Math.round(audit_.due / 16))} hour{Math.max(1, Math.round(audit_.due / 16)) === 1 ? "" : "s"} of
                    the computer being switched on and idle. The button is for when you would rather not wait.
                  </p>
                </>
              )}
              {audit_.lastResult && <p>Last pass: {audit_.lastResult}</p>}
            </div>

            {/*
              Sections that cannot be read, named rather than left to stall the queue.

              These used to be invisible and self-perpetuating: the queue is oldest-first, a
              never-read section sorts first, so the same two failures were retried first every
              time and consumed every batch — the pass reported "0 sections read" while the rest
              of the manual was never reached. They go to the back now, and they appear here so
              they can be dealt with instead of retried.
            */}
            {stuck.length > 0 && (
              <div className="mt-3 rounded-md border border-warn bg-warn-soft p-3">
                <p className="text-xs font-semibold text-warn">
                  {stuck.length} section{stuck.length === 1 ? "" : "s"} could not be read
                </p>
                <ul className="mt-1 space-y-1">
                  {stuck.slice(0, 5).map((f) => (
                    <li key={f.id} className="text-xs">
                      <Link href={`/manual?edit=${f.id}`} className="font-medium text-accent hover:underline">
                        {f.title}
                      </Link>
                      <span className="block text-ink-3">{f.why}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-ink-3">
                  The rest of the manual is read regardless — these no longer hold up the queue. A section too long to
                  read in one pass is one to split into smaller sections, which is worth doing anyway: nobody reads a
                  four-thousand-word policy either.
                </p>
              </div>
            )}
          </Card>

          {/*
            Who has signed for this manual, and who signed for an older one.

            The question asked was whether staff need to acknowledge the P&P manual. They do — not
            because one regulation says so in those words, but because four separate requirements
            are evidenced by this signature and by nothing else the pharmacy holds: HIPAA workforce
            training and its documentation, the sanctions policy that cannot stand against somebody
            never shown the rule, the exposure control plan being explained, and participation in
            the CQI programme.
            
            It is on this page rather than only on the staff page because it is a fact about the
            manual. Editing a manual eleven people have signed for is the moment that matters, and
            this is where the editing happens.
          */}
          <Card
            id="acknowledgement"
            tone={ack.missing > 0 ? "warn" : undefined}
            title="Who has acknowledged this manual"
            count={`${ack.current} of ${ack.people.length}`}
            subtitle="A signature against a manual that has since been rewritten is not the same as a signature against this one, so each is recorded with the revision it was given for."
            className="mt-6"
            actions={
              <>
                <Link href="/forms/policy-acknowledgement" className="btn">Paper form</Link>
                <Link href="/compliance/training" className="btn btn-primary">Send it</Link>
              </>
            }
          >
            <p className="text-xs text-ink-3">
              This manual is <span className="font-mono">{ack.revision.fingerprint}</span> — {ack.revision.sections}{" "}
              sections, {ack.revision.words.toLocaleString("en-US")} words
              {ack.revision.changedOn ? `, last edited ${fmt(ack.revision.changedOn)}` : ""}.
            </p>

            {ack.people.length === 0 ? (
              <Empty>Nobody is on the staff list, so there is nobody to acknowledge it.</Empty>
            ) : (
              <ul className="rows mt-2">
                {ack.people.map((a) => (
                  <li key={a.personId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <Link href={`/staff/${a.personId}`} className="text-sm font-medium text-accent hover:underline">
                        {a.name}
                      </Link>
                      <span className="mt-0.5 block text-xs text-ink-3">
                        {a.signedOn
                          ? `${a.stateLabel} · signed ${fmt(a.signedOn)}${a.signedRevision && a.signedRevision !== "legacy" ? ` for ${a.signedRevision}` : ""}`
                          : "Has not acknowledged the manual"}
                      </span>
                    </span>
                    <span
                      className={`badge shrink-0 ${
                        a.state === "current" ? "badge-ok" : a.state === "none" ? "badge-crit" : "badge-warn"
                      }`}
                    >
                      {a.state === "current" ? "current" : a.state === "none" ? "not signed" : a.state === "unknown" ? "version not recorded" : "earlier manual"}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/*
              The version that can be established without asking anybody again.

              "Acknowledged, version not recorded" is a real gap — the file shows a signature and
              cannot say of what — but the honest fix is not always to ask again. The manual records
              when each section was last edited; where nothing has been edited since somebody
              signed, the document they were shown is character for character the one on file, and
              that can simply be recorded. Asking for a signature given this morning is how people
              learn to sign without reading.
            */}
            {ack.settleable > 0 && canManage && (
              <div className="mt-3 rounded-md border border-accent bg-accent-soft p-3">
                <p className="text-sm font-semibold text-accent">
                  {ack.settleable} of these can be settled without asking anybody again
                </p>
                <p className="mt-1 text-xs text-ink-2">
                  No section of the manual has been edited since {ack.settleable === 1 ? "that person" : "those people"}{" "}
                  signed, so the manual they were shown is character for character this one. Recording it says so, and
                  records how it was established.
                </p>
                <form action={settleAction} className="mt-2">
                  <SubmitButton className="btn btn-sm btn-primary" pendingLabel="Recording…">
                    Record this revision against them
                  </SubmitButton>
                </form>
              </div>
            )}

            {(ack.superseded > 0 || ack.unknownCount > 0) && (
              <p className="mt-3 text-xs text-ink-3">
                {ack.superseded > 0 && (
                  <>
                    {ack.superseded} {ack.superseded === 1 ? "person signed" : "people signed"} for an earlier revision.
                    That is not automatically a problem — a typo corrected in a heading is not a change of policy — but
                    where the manual has changed what somebody is expected to do, send it again.{" "}
                  </>
                )}
                {ack.unknownCount > 0 && (
                  <>
                    {ack.unknownCount} signed before revisions were recorded, so the file shows an acknowledgement
                    without saying of what.
                    {ack.unknownCount > ack.settleable
                      ? ` ${ack.unknownCount - ack.settleable} of those cannot be established from the edit history — the manual was edited after they signed — so sending it again is the only way to fix ${ack.unknownCount - ack.settleable === 1 ? "that one" : "those"}.`
                      : ""}
                  </>
                )}
              </p>
            )}
          </Card>


          {/*
            What the reviewer is told about this pharmacy.

            Twenty findings came back saying a fact "was not provided to me" — the registration
            number, the pharmacist in charge, the DEA expiry. All of them are on file here and none
            of them were being passed in. That is fixed; this card exists so the pharmacist can see
            exactly what the reviewer knows, and fill in the few things the site genuinely does not
            hold.

            The named roles are the whole of nine findings. The manual was inherited from a
            physician practice and routes complaints, hiring and departures to a Human Resources
            Manager, a Chief Administrator and a Department Manager. Nobody here holds those titles,
            so the manual sends its own procedures to people who do not exist. One answer, given
            once, settles all nine.
          */}
          <Card
            id="facts"
            tone={facts.missing.length > 0 ? "warn" : undefined}
            title="What the review knows about this pharmacy"
            subtitle="The reviewer is forbidden from inventing a fact about you, which is why a missing one comes back as “decide this yourself” instead of as finished text. Everything here is passed in before a section is read."
            count={facts.missing.length > 0 ? `${facts.missing.length} missing` : "complete"}
            className="mt-6 scroll-mt-4"
          >
            <p className="rounded-md border border-line bg-ground p-3 text-xs leading-relaxed text-ink-2">
              {facts.text}
            </p>

            {facts.missing.length > 0 && (
              <ul className="rows mt-3">
                {facts.missing.map((m) => (
                  <li key={m.what} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{m.what}</span>
                      <span className="block text-xs text-ink-3">{m.why}</span>
                    </span>
                    {m.href !== "/manual#facts" && (
                      <Link href={m.href} className="btn btn-sm shrink-0">Fill it in</Link>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {canManage && (
              <form action={saveRolesAction} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <h3 className="text-sm font-semibold">Who actually holds the roles the manual names</h3>
                  <p className="mt-0.5 text-xs text-ink-3">
                    A name and a role — &ldquo;Cory Simms, owner and pharmacist-in-charge&rdquo;. These replace the
                    Human Resources Manager, the Chief Administrator and the Department Manager the inherited text
                    keeps pointing at.
                  </p>
                </div>
                <Field label="A complaint about conduct, harassment or violence goes to">
                  <input name="role_complaints" defaultValue={roles.complaints} className="field" placeholder="Cory Simms, owner and pharmacist-in-charge" />
                </Field>
                <Field label="And when the complaint is about that person, to" hint="A policy with no route around the person complained of is one nobody can use.">
                  <input name="role_complaints_alt" defaultValue={roles.complaintsAlt} className="field" />
                </Field>
                <Field label="Hiring paperwork and Form I-9 are held by">
                  <input name="role_hiring" defaultValue={roles.hiring} className="field" />
                </Field>
                <Field label="A departure is decided and processed by">
                  <input name="role_termination" defaultValue={roles.termination} className="field" />
                </Field>
                <Field label="Schedules on the DEA registration" hint="As printed on the certificate — for example 2, 2N, 3, 3N, 4, 5.">
                  <input name="dea_schedules" defaultValue={s.dea_schedules} className="field" placeholder="2, 2N, 3, 3N, 4, 5" />
                </Field>
                <div className="flex items-end">
                  <button className="btn btn-primary">Save these</button>
                </div>
              </form>
            )}

            {canManage && blocked > 0 && (
              <div className="mt-4 rounded-md border border-accent bg-accent-soft p-3">
                <p className="text-sm font-semibold text-accent">
                  {blocked} finding{blocked === 1 ? "" : "s"} said only &ldquo;decide this yourself&rdquo;
                </p>
                <p className="mt-1 text-xs text-ink-2">
                  Those are the ones the reviewer could not write because a fact was missing. Supplying the facts does
                  not re-open them on its own — the sections were read, so they are not due again for a year. This puts
                  exactly those sections back in the queue and closes the findings as superseded rather than dismissed.
                </p>
                <form action={rereadAction} className="mt-2">
                  <SubmitButton className="btn btn-sm btn-primary" pendingLabel="Putting them back…">
                    Read those sections again
                  </SubmitButton>
                </form>
              </div>
            )}
          </Card>


          {/*
            What the review found in somebody else's chapters.

            The employment half of this handbook belongs to the medical practice. The pharmacy is
            bound by it and does not write it, so these are not on the pharmacist's list — a list of
            work he cannot do is read once, found to be undoable, and then not read again.

            They are not thrown away either. "Your termination procedure never terminates the
            departing person's access to protected health information" is a real thing to hand to
            the people who maintain it, and it came out of reading their text against the rules.
          */}
          {theirs.map((group) => (
            <details key={group.manager} className="mt-6">
              <summary className="cursor-pointer text-sm font-medium text-accent hover:underline">
                {group.findings.length} finding{group.findings.length === 1 ? "" : "s"} in the chapters{" "}
                {group.manager} maintains — not yours to fix
              </summary>
              <Card className="mt-2">
                <p className="card-sub">
                  This pharmacy is bound by these sections but does not write them, so none of this is on your list
                  above and nothing here will be changed by any button on this page. It is worth passing on: it came
                  from reading their text against Kansas, DEA, HIPAA and OSHA requirements, and two of these are
                  findings against the practice rather than against you.
                </p>
                <ul className="rows mt-2">
                  {group.findings.slice(0, 20).map((f) => (
                    <li key={f.id} className="py-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className={`badge ${f.severity === "blocking" ? "badge-crit" : "badge-warn"}`}>
                          {f.severity === "blocking" ? "would be written up" : "worth raising"}
                        </span>
                        <span className="text-sm font-medium">{f.sectionTitle}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-2">{f.what}</p>
                      <p className="mt-0.5 text-xs text-ink-3">{f.why}</p>
                    </li>
                  ))}
                </ul>
                {group.findings.length > 20 && (
                  <p className="mt-2 text-xs text-ink-3">and {group.findings.length - 20} more.</p>
                )}
                <p className="mt-3 text-xs text-ink-3">
                  Print this page to hand it over, or copy the section names and what was found. Nothing here is
                  counted against the pharmacy anywhere in this site.
                </p>
              </Card>
            </details>
          ))}

          {/*
            Whose chapter is this, asked where the findings are.

            Every finding here names a section. If a run of them is landing in a chapter the
            pharmacy does not write, the answer is not to fix them one at a time — it is to say so
            once. Marking a chapter takes it out of the audit, out of this list and out of the
            annual review, and moves what was already found into the panel addressed to whoever
            does maintain it. Nothing is deleted and the chapter still prints as part of the manual.
          */}
          {findings.length > 0 && canManage && (() => {
            const byChapter = new Map<string, { title: string; count: number }>();
            for (const f of findings) {
              const node = sections.find((x) => x.id === f.sectionId);
              const chapterId = node?.chapterId ?? f.sectionId;
              const chapter = sections.find((x) => x.id === chapterId);
              if (!chapter || chapter.managedBy) continue;
              const cur = byChapter.get(chapterId) ?? { title: chapter.title, count: 0 };
              byChapter.set(chapterId, { title: cur.title, count: cur.count + 1 });
            }
            const rows = [...byChapter.entries()].filter(([, v]) => v.count >= 2).sort((a, b) => b[1].count - a[1].count);
            if (rows.length === 0) return null;
            // Names already in use elsewhere in this manual, so the usual answer is one press.
            const known = others.map((o) => o.name);
            return (
              <Card
                title="Is any of this somebody else's to fix?"
                subtitle="A chapter the pharmacy is bound by but does not write — an employment handbook from a practice next door, for instance — should not be on this list at all. Say so once and every finding in it moves to a panel addressed to them."
                className="mb-4"
              >
                <ul className="rows">
                  {rows.map(([id, v]) => (
                    <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{v.title}</span>
                        <span className="block text-xs text-ink-3">
                          {v.count} of the findings below are in this chapter
                        </span>
                      </span>
                      <form action={setManager} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="chapter" value={id} />
                        <input
                          name="manager"
                          list="known-managers"
                          placeholder="Who maintains it"
                          className="field w-56 py-1 text-xs"
                        />
                        <button className="btn btn-sm">Not ours</button>
                      </form>
                    </li>
                  ))}
                </ul>
                <datalist id="known-managers">
                  {known.map((n) => <option key={n} value={n} />)}
                </datalist>
                <p className="mt-2 text-xs text-ink-3">
                  Leave the box empty and press it to hand a chapter back to the pharmacy again. Nothing is deleted
                  either way — the chapter still prints as part of the manual, because you are still bound by it.
                </p>
              </Card>
            );
          })()}

          {/* ── The findings, where there are any ─────────────────────── */}
          {findings.length > 0 && (
            <Card
              id="findings"
              tone={audit_.blocking > 0 ? "crit" : "warn"}
              title="What the audit found"
              count={findings.length}
              subtitle="Each one names the requirement it falls short of. Where the fix could be written it comes with the text; where it turns on a fact about this pharmacy nobody supplied, it deliberately does not, because an invented sentence in a manual is a standard you are then held to."
              className="mb-6"
            >
              <ul className="rows">
                {findings.map((f) => (
                  <li key={f.id} className="py-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span
                        className={`badge ${f.severity === "blocking" ? "badge-crit" : f.severity === "should" ? "badge-warn" : "badge-muted"}`}
                      >
                        {f.severity === "blocking" ? "would be written up" : f.severity === "should" ? "weakness" : "wording"}
                      </span>
                      <Link href={`/manual?edit=${f.sectionId}#${f.sectionId}`} className="text-sm font-medium text-accent hover:underline">
                        {f.sectionTitle}
                      </Link>
                    </div>
                    <p className="mt-1 text-sm text-ink-2">{f.what}</p>
                    <p className="mt-0.5 text-xs text-ink-3">{f.why}</p>
                    {canManage && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {f.suggestedBody.trim() ? (
                          <form action={applyFindingAction}>
                            <input type="hidden" name="id" value={f.id} />
                            <button className="btn btn-sm btn-primary">Put the fix in</button>
                          </form>
                        ) : (
                          <span className="text-xs text-ink-3">
                            Needs a decision about this pharmacy —{" "}
                            <Link href={`/manual?edit=${f.sectionId}#${f.sectionId}`} className="underline">open the section</Link>.
                          </span>
                        )}
                        <form action={dismissFindingAction} className="flex flex-wrap items-center gap-1.5">
                          <input type="hidden" name="id" value={f.id} />
                          <input name="reason" required className="field w-56 py-1 text-xs" placeholder="Why this is not a problem here" />
                          <button className="btn btn-sm">Not a problem</button>
                        </form>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/*
            Finding a section without knowing which chapter it is in.

            The way anybody arrives at a manual is with a question — what do we do about a recall,
            who signs for a delivery, how long do we keep this. Answering that by remembering the
            chapter is a memory test, and the paper copy at least had an index.
          */}
          <Card
            title="Find anything in the manual"
            subtitle="Searches every heading and every word of every policy. Two words narrow it rather than widen it."
            className="mb-6"
          >
            <form className="flex flex-wrap items-center gap-2">
              <input
                name="q"
                defaultValue={query}
                placeholder="recall, epinephrine, how long we keep, who signs"
                className="field max-w-md"
                aria-label="Search the manual"
              />
              <button className="btn btn-primary">Search</button>
              {query && <Link href="/manual" className="btn">Clear</Link>}
            </form>

            {query && (
              <div className="mt-4">
                <p className="text-xs text-ink-3">
                  {hits.length === 0
                    ? `Nothing in the manual mentions “${query}”. That may itself be the finding — if it is something this pharmacy does, it belongs in here.`
                    : `${hits.length} section${hits.length === 1 ? "" : "s"} mention ${query}.`}
                </p>
                <ul className="rows mt-2">
                  {hits.slice(0, 40).map((h) => (
                    <li key={h.id} className="py-2">
                      <Link href={`/manual?ch=${h.chapterId}&q=${encodeURIComponent(query)}#${h.id}`} className="text-sm font-medium text-accent hover:underline">
                        <span className="mr-2 text-ink-3">{h.number}</span>{h.title}
                      </Link>
                      {h.inTitle && <span className="badge badge-ok ml-2">in the heading</span>}
                      <p className="mt-0.5 text-xs text-ink-3">{h.chapterTitle}</p>
                      {h.snippet && <p className="mt-1 text-xs leading-relaxed text-ink-2">{h.snippet}</p>}
                    </li>
                  ))}
                </ul>
                {hits.length > 40 && (
                  <p className="mt-2 text-xs text-ink-3">and {hits.length - 40} more — add a word to narrow it.</p>
                )}
              </div>
            )}
          </Card>

          {/*
            Contents on the left, the chapter on the right.

            The old page put you on a list of chapters, then replaced the whole screen with one
            chapter — so finding the section next door meant going back, reading the list again,
            and clicking in. Keeping the contents on screen is how a book works, and it is the
            difference between reading a manual and navigating an application.
          */}
          <div className="grid gap-4 lg:grid-cols-[18rem_1fr] lg:items-start">
            <Card title="Contents" count={chapters.length} className="lg:sticky lg:top-4">
              <ul className="-mx-1 max-h-[34rem] overflow-y-auto">
                {chapters.map((c) => {
                  const kids = sections.filter((x) => x.chapterId === c.id && x.id !== c.id);
                  const holes = empty.filter((x) => x.chapterId === c.id).length;
                  const isOpen = open?.id === c.id;
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/manual?ch=${c.id}`}
                        className={`block rounded-md px-2 py-1.5 text-sm hover:bg-ground ${isOpen ? "bg-ground font-medium" : ""}`}
                      >
                        <span className="mr-1.5 text-xs text-ink-3">{c.number}</span>
                        {c.title}
                        <span className="ml-1.5 whitespace-nowrap text-[11px] text-ink-3">
                          {holes > 0 && <span className="badge badge-crit mr-1">{holes}</span>}
                          {c.managedBy && <span className="badge badge-muted mr-1">theirs</span>}
                          {c.source === "site" && <span className="badge badge-ok mr-1">generated</span>}
                          {kids.length || ""}
                        </span>
                      </Link>
                      {isOpen && kids.length > 0 && (
                        <ul className="mb-1 ml-3 border-l border-line">
                          {kids.map((k) => (
                            <li key={k.id}>
                              <a
                                href={`#${k.id}`}
                                className={`block truncate rounded-r px-2 py-1 text-xs text-ink-2 hover:bg-ground ${k.depth > 1 ? "pl-4" : ""}`}
                                title={k.title}
                              >
                                <span className="mr-1 text-ink-3">{k.number}</span>{k.title}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>

            <div className="min-w-0">
              {!open ? (
                <Card title="Pick a chapter" subtitle="Or search above. Everything is one document — this is just where you open it.">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Figure value={sections.length} label="Sections" sub={`${own.length} yours, ${generated.length} generated`} tone="ok" />
                    <Figure
                      value={audit_.current}
                      label="Read against the rules"
                      sub={audit_.due === 0 ? "The whole manual is current" : `${audit_.due} still due`}
                      tone={audit_.due === 0 ? "ok" : "warn"}
                    />
                    <Figure
                      value={empty.length}
                      label="Still to write"
                      sub={empty.length === 0 ? "Nothing promised and undelivered" : "Headings with nothing under them"}
                      tone={empty.length === 0 ? "ok" : "crit"}
                    />
                  </div>
                  {elsewhere.length > 0 && (
                    <p className="mt-3 text-xs text-ink-3">
                      {elsewhere.length} sections are maintained by {others.map((o) => o.name).join(", ")} rather than by
                      the pharmacy. They print as part of the manual, but nothing here chases you to review them or
                      counts their gaps as yours.
                    </p>
                  )}
                </Card>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold">
                      <span className="mr-2 text-ink-3">{open.number}</span>{open.title}
                    </h2>
                    {canManage && open.source === "pharmacy" && (
                      <form action={setManager} className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                        <input type="hidden" name="chapter" value={open.id} />
                        <span>Maintained by</span>
                        <input
                          name="manager"
                          defaultValue={open.managedBy ?? ""}
                          list="manual-managers"
                          className="field w-52 py-0.5 text-xs"
                          placeholder="the pharmacy"
                        />
                        <button className="btn btn-sm">Set</button>
                      </form>
                    )}
                  </div>

                  {open.managedBy && (
                    <Notice kind="warn">
                      This chapter is maintained by {open.managedBy}, not by the pharmacy. It is not edited here — editing
                      a copy of somebody else&rsquo;s policy is how two versions of it start to disagree. Ask them for the
                      change, then import the handbook again; the marking survives the import.
                    </Notice>
                  )}

                  <div className="space-y-3">
            {inChapter.map((x) => {
              const isEditing = editing?.id === x.id;
              return (
                <section
                  key={x.id}
                  id={x.id}
                  className={`card scroll-mt-4 ${x.source === "site" ? "border-accent" : ""} ${x.depth === 0 ? "" : x.depth === 1 ? "sm:ml-4" : "sm:ml-10"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className={x.depth === 0 ? "text-base" : "text-sm"}>
                        <span className="mr-2 text-ink-3">{x.number}</span>{x.title}
                      </h3>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {x.source === "site" ? (
                          <span className="badge badge-ok mr-1.5">generated</span>
                        ) : x.managedBy ? (
                          <span className="badge badge-muted mr-1.5">{x.managedBy}</span>
                        ) : x.hasChildren ? (
                          <span className="badge badge-muted mr-1.5">heading</span>
                        ) : (
                          <span className="badge badge-muted mr-1.5">yours</span>
                        )}
                        {x.reviewedOn ? `reviewed ${fmt(x.reviewedOn)}` : "never reviewed"}
                        {x.updatedBy ? ` · last changed by ${x.updatedBy}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      {canManage && x.source === "pharmacy" && !x.managedBy && !isEditing && (
                        <Link href={`/manual?ch=${open.id}&edit=${x.id}#${x.id}`} className="btn btn-sm">Edit</Link>
                      )}
                      {canManage && x.source === "pharmacy" && !x.managedBy && !isEditing && (
                        <form action={reviewed}>
                          <input type="hidden" name="id" value={x.id} />
                          <input type="hidden" name="ch" value={open.id} />
                          <button className="btn btn-sm">Reviewed today</button>
                        </form>
                      )}
                      {canManage && (
                        <form action={add}>
                          <input type="hidden" name="after" value={x.id} />
                          <button className="btn btn-sm">Add after</button>
                        </form>
                      )}
                    </div>
                  </div>

                  {!isEditing ? (
                    <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                      {x.body.trim() ||
                        (x.hasChildren ? (
                          <span className="text-ink-3">A heading. The policies are the sections under it.</span>
                        ) : (
                          <span className="text-crit">Nothing here yet.</span>
                        ))}
                    </div>
                  ) : (
                    <>
                      <form action={save} className="mt-3 space-y-3">
                        <input type="hidden" name="id" value={x.id} />
                        <input type="hidden" name="ch" value={open.id} />
                        <Field label="Title"><input name="title" defaultValue={x.title} className="field" /></Field>
                        <Field label="The policy">
                          <textarea name="body" rows={16} defaultValue={draft ?? x.body} className="field font-sans" />
                        </Field>
                        {note && (
                          <div className="rounded-md border border-accent bg-accent-soft px-3 py-2 text-xs text-accent">
                            <b>What Claude changed:</b> {note}
                          </div>
                        )}
                        {concerns && (
                          <div className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-xs text-warn">
                            <b>Decide these before you save:</b>
                            <ul className="ml-4 mt-1 list-disc">
                              {concerns.split(" | ").map((c) => <li key={c}>{c}</li>)}
                            </ul>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button className="btn btn-primary">Save</button>
                          <Link href={`/manual?ch=${open.id}`} className="btn">Cancel</Link>
                          <button formAction={remove} name="id" value={x.id} className="btn btn-danger">Remove from the manual</button>
                        </div>
                      </form>

                      <div className="mt-4 rounded-md border border-line bg-ground p-3">
                        <h3>Ask Claude</h3>
                        <p className="mt-1 text-xs text-ink-3">
                          It will not invent a fact about this pharmacy. Anything it would have to make up comes back as
                          something for you to decide rather than as text to sign.
                        </p>
                        <form action={ask} className="mt-2 space-y-2">
                          <input type="hidden" name="id" value={x.id} />
                          <input
                            name="instruction"
                            className="field"
                            placeholder="Say what you want changed, in your own words"
                          />
                          <div className="flex flex-wrap gap-1.5">
                            {[
                              ["Check it", "Check this against Kansas and federal requirements and tell me what is missing."],
                              ["Match what we do", "Rewrite this so it describes only what we actually do."],
                              ["Point at the appendix", "This describes a procedure the compliance system now performs. Replace it with a reference to the appendix."],
                              ["Shorten it", "Shorten this without losing anything an inspector would look for."],
                              ["Draft it", "This section is empty. Draft a policy for it that fits an independent Kansas community pharmacy."],
                            ].map(([label, q]) => (
                              <button key={label} name="instruction" value={q} className="btn btn-sm" disabled={!aiReady} title={q}>
                                {label}
                              </button>
                            ))}
                          </div>
                          <button className="btn" disabled={!aiReady}>Ask</button>
                          {!aiReady && (
                            <p className="text-xs text-warn">
                              No Anthropic API key is stored. <Link href="/settings" className="underline">Add one</Link> to use this.
                            </p>
                          )}
                        </form>
                      </div>
                    </>
                  )}
                </section>
              );
            })}
                  </div>
                </>
              )}
            </div>
          </div>

          <datalist id="manual-managers">
            {others.map((o) => <option key={o.name} value={o.name} />)}
            <option value={s.pharmacy_name ? `${s.pharmacy_name} — clinic side` : "The medical practice"} />
          </datalist>

          {/*
            The rare acts, folded away.

            Replacing the whole manual and regenerating the site's own sections are things a
            pharmacy does once a year at most. Left open on the page they competed for attention
            with the work, and "Import and replace" sitting next to a search box is an accident
            waiting to happen.
          */}
          {canManage && (
            <details className="mt-6">
              <summary className="cursor-pointer text-sm font-medium text-accent">
                Replace the manual, or rebuild the generated sections
              </summary>
              <div className="mt-3 grid gap-4 lg:grid-cols-2">
                <Card title="Replace the whole manual">
                  <p className="card-sub">
                    Importing again replaces your own sections with the file&rsquo;s. The generated appendix survives,
                    because it is written from the software rather than from the document.
                  </p>
                  <form action={doImport} className="mt-2 flex flex-wrap items-end gap-3" encType="multipart/form-data">
                    <Field label="A .docx file"><input type="file" name="file" accept=".docx" className="field" /></Field>
                    <button className="btn">Import and replace</button>
                  </form>
                </Card>
                <Card title="The generated sections">
                  <p className="card-sub">
                    {generated.length} sections are written from what this software actually does, and cannot be typed
                    over — the moment they can be, they will say something the site does not do. Rebuilding them brings
                    them level with the current behaviour, which &ldquo;Put it right&rdquo; also does.
                  </p>
                  <form action={regenerate} className="mt-2"><button className="btn">Rebuild them now</button></form>
                </Card>
              </div>
            </details>
          )}
        </>
      )}
    </>
  );
}
