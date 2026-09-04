import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
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
} from "@/lib/manual-store";
import { policies, FORMS, appendixReference, suggestForm } from "@/lib/manual";
import { auditProgress, openFindings, runManualAudit, applyFinding, dismissFinding } from "@/lib/manual-audit";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Figure, Notice, Field } from "@/components/ui";

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
  searchParams: Promise<{ ok?: string; error?: string; edit?: string; ch?: string; draft?: string; note?: string; concerns?: string }>;
}) {
  const user = await requireUser();
  const { ok, error, edit, ch, draft, note, concerns } = await searchParams;
  const [rows, s, aiReady, stale, audit_, findings] = await Promise.all([
    allSections(),
    getSettings(),
    hasApiKey(),
    needingReview(),
    auditProgress(),
    openFindings(),
  ]);
  const sections = outline(rows);
  const pharmacy = s.pharmacy_name || "This pharmacy";

  const own = sections.filter((x) => x.source === "pharmacy" && !x.managedBy);
  const generated = sections.filter((x) => x.source === "site");
  const elsewhere = sections.filter((x) => x.managedBy);
  const empty = gaps(rows);
  const cites = citationMarkers(rows);
  const citeTotal = cites.reduce((n, c) => n + c.count, 0);
  const others = managers(rows);

  // Editing a section always shows its chapter, so a link straight to a section from the gaps list
  // lands you in the chapter it belongs to rather than on a page with one section on it.
  const editing = edit ? sections.find((x) => x.id === edit) : undefined;
  const openId = editing?.chapterId ?? ch;
  const chapters = sections.filter((x) => x.depth === 0);
  const open = openId ? chapters.find((c) => c.id === openId) : undefined;
  const inChapter = open ? sections.filter((x) => x.chapterId === open.id) : [];

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
              <Link href="/manual/print" className="btn btn-primary">Print the whole manual</Link>
              <form action={regenerate}><button className="btn">Refresh generated sections</button></form>
            </>
          ) : undefined
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {sections.length === 0 ? (
        <Card title="Bring your manual in" subtitle="Upload the Word file and it is split into sections on its own headings. Nothing is rewritten — the text arrives exactly as it is, and you edit from there.">
          <form action={doImport} className="flex flex-wrap items-end gap-3" encType="multipart/form-data">
            <Field label="The manual" hint="A .docx file. Word's own Heading 1, 2 and 3 marks are used to split it.">
              <input type="file" name="file" accept=".docx" className="field" />
            </Field>
            <button className="btn btn-primary">Import it</button>
          </form>
          <p className="mt-3 text-xs text-ink-3">
            The generated sections describing what this site does are written at the same time, as an appendix. After
            that, delete the descriptions of those procedures from your own sections and let the appendix carry them —
            two descriptions of one procedure is how a manual and a practice come apart.
          </p>
        </Card>
      ) : open ? (
        /* ── One chapter ── */
        <>
          <h2 className="mb-3 text-lg">{open.number}. {open.title}</h2>
          {open.managedBy && (
            <Notice kind="warn">
              This chapter is maintained by <b>{open.managedBy}</b>, not by the pharmacy. It prints as part of the
              manual and the pharmacy is bound by it, but it is not edited here — a second copy of somebody
              else&rsquo;s policy is how two versions of it start to disagree. Ask them for the change, then import the
              handbook again; the marking survives the import.
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
                      {x.source === "pharmacy" && !x.managedBy && !isEditing && (
                        <Link href={`/manual?ch=${open.id}&edit=${x.id}#${x.id}`} className="btn btn-sm">Edit</Link>
                      )}
                      {x.source === "pharmacy" && !x.managedBy && !isEditing && (
                        <form action={reviewed}>
                          <input type="hidden" name="id" value={x.id} />
                          <input type="hidden" name="ch" value={open.id} />
                          <button className="btn btn-sm">Reviewed today</button>
                        </form>
                      )}
                      <form action={add}>
                        <input type="hidden" name="after" value={x.id} />
                        <button className="btn btn-sm">Add after</button>
                      </form>
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
      ) : (
        /* ── The chapters ── */
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure value={sections.length} label="Sections" sub={`${own.length} yours, ${generated.length} generated${elsewhere.length ? `, ${elsewhere.length} maintained elsewhere` : ""}`} tone="ok" />
            <Figure
              value={empty.length}
              label={empty.length === 1 ? "Heading with no policy" : "Headings with no policy"}
              sub={empty.length === 0 ? "Nothing promised and undelivered" : "Promised in the contents, missing from the manual"}
              tone={empty.length === 0 ? "ok" : "crit"}
              href="#empty"
            />
            <Figure
              value={stale.length}
              label="Not reviewed in a year"
              sub="An annual review is a date somebody can show"
              tone={stale.length === 0 ? "ok" : "warn"}
              href="#review"
            />
            <Figure value={aiReady ? "ready" : "off"} label="Claude" sub={aiReady ? "Available on every section" : "Add an API key in Settings"} tone={aiReady ? "ok" : "muted"} href="/settings" />
          </div>

          {/*
            The audit, and what it found.
            
            First on the page because it answers the question the rest of the page cannot: not
            "has this manual been reviewed" — which is a date anybody can enter — but "is what it
            says actually right". A manual can be signed off on time for five years running and
            still describe a practice that stopped in year one.
          */}
          <Card
            id="audit"
            tone={audit_.blocking > 0 ? "crit" : findings.length > 0 ? "warn" : undefined}
            title="Audited against the requirements"
            count={`${audit_.current} of ${audit_.total} current`}
            actions={
              audit_.ready ? (
                <form action={auditNow}>
                  <button className="btn btn-sm btn-primary" disabled={audit_.due === 0}>
                    {audit_.due === 0 ? "Nothing due" : `Read ${Math.min(audit_.due, 20)} now`}
                  </button>
                </form>
              ) : (
                <Link href="/settings/connections" className="btn btn-sm">Add an API key</Link>
              )
            }
            subtitle={
              audit_.ready
                ? "Every section the pharmacy owns is read against Kansas, DEA, HIPAA and OSHA requirements and against what this site actually does — a few at a time, on their own, so the whole manual is covered within the year. Anything found appears below as something to act on rather than as a report to file."
                : "This needs an Anthropic API key. Without one the manual is still reviewed and printed, but nothing is checking what it says against the rules."
            }
            className="mb-6"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure
                value={`${audit_.current}/${audit_.total}`}
                label="Read this year"
                sub={audit_.due === 0 ? "The whole manual is current" : `${audit_.due} still due`}
                tone={audit_.due === 0 ? "ok" : "warn"}
              />
              <Figure
                value={findings.length}
                label="Open findings"
                sub={findings.length === 0 ? "Nothing outstanding" : "Each one is applied or answered"}
                tone={findings.length === 0 ? "ok" : audit_.blocking > 0 ? "crit" : "warn"}
              />
              <Figure
                value={audit_.blocking}
                label="An inspector would write up"
                sub={audit_.blocking === 0 ? "None" : "Do these first"}
                tone={audit_.blocking === 0 ? "ok" : "crit"}
              />
            </div>

            {audit_.lastResult && <p className="mt-3 text-xs text-ink-3">Last pass: {audit_.lastResult}</p>}

            {findings.length > 0 && (
              <ul className="rows mt-4">
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
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {f.suggestedBody.trim() ? (
                        <form action={applyFindingAction}>
                          <input type="hidden" name="id" value={f.id} />
                          <button className="btn btn-sm btn-primary">Put the fix in</button>
                        </form>
                      ) : (
                        /*
                          No suggested text, and that is the honest answer rather than a failure.
                          
                          Where the fix turns on a fact about this pharmacy that nobody supplied —
                          a frequency, a threshold, who does it — writing one would mean inventing
                          it, and an invented sentence in a manual is a standard the pharmacy is
                          then held to.
                        */
                        <span className="text-xs text-ink-3">
                          Needs a decision about this pharmacy, so nothing was written for you —{" "}
                          <Link href={`/manual?edit=${f.sectionId}#${f.sectionId}`} className="underline">open the section</Link>.
                        </span>
                      )}
                      <form action={dismissFindingAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="id" value={f.id} />
                        <input
                          name="reason"
                          required
                          className="field w-56 py-1 text-xs"
                          placeholder="Why this is not a problem here"
                        />
                        <button className="btn btn-sm">Not a problem</button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {empty.length > 0 && (
            <Card
              id="empty"
              tone="crit"
              title="Headings with nothing under them"
              count={empty.length}
              subtitle="An inspector who reads to the back of a manual and finds ten promised forms and no forms has learned something about the rest of it. Chapter headings are not counted here — only headings that promise a policy and deliver none."
              className="mb-6"
              actions={
                /*
                  One press for all of it.
                  
                  A dropdown and an editor per row is ten decisions and ten pieces of writing, which
                  is why these had been open for as long as anyone could remember: the work was
                  real and the row only started it. Here, a heading naming a form this site produces
                  gets the reference outright, and the rest get a draft to read.
                */
                <form action={fillGaps}>
                  <button className="btn btn-sm btn-primary">Close all {empty.length}</button>
                </form>
              }
            >
              <ul className="rows">
                {empty.map((x) => {
                  const guess = suggestForm(x.title);
                  return (
                    <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="text-sm font-medium">
                        <span className="mr-2 text-ink-3">{x.number}</span>{x.title}
                        {guess ? (
                          <span className="ml-2 text-xs font-normal text-ink-3">
                            looks like the {guess.name.toLowerCase()}
                          </span>
                        ) : (
                          <span className="ml-2 text-xs font-normal text-ink-3">no form matches — needs writing</span>
                        )}
                      </span>
                      <form action={pointAtAppendix} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="id" value={x.id} />
                        {/*
                          The match is proposed rather than hunted for.
                          
                          A pharmacist looking at "Medication Incident Form" scanned twelve formal
                          names, saw nothing called that, and concluded the site could not do it. It
                          could — under the Board's name for the same document. Naming the Board's
                          form is right on a printed form and wrong in a picker, so the picker now
                          opens on the answer and the full list stays behind it.
                        */}
                        <select name="form" required className="field max-w-[22rem] py-1 text-xs" defaultValue={guess?.name ?? ""}>
                          <option value="" disabled>Is this a form the site produces?</option>
                          {FORMS.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                        </select>
                        <button className="btn btn-sm">Point at the appendix</button>
                        <Link href={`/manual?edit=${x.id}#${x.id}`} className="btn btn-sm btn-primary">Write it myself</Link>
                      </form>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-ink-3">
                Headings promising forms, with no forms behind them, are the single thing in this manual an inspector is
                most likely to notice. Where the heading names something this system produces, the picker opens on it
                and the heading gets a sentence saying where the current version comes from — shorter, and true for
                longer, than a blank copy pasted into a manual. Where nothing matches, Claude drafts the policy against
                what this pharmacy is and what this system does, and it stays marked as drafted and unreviewed until you
                have read it. {aiReady ? "Closing all of them takes a few minutes." : "Drafting needs an Anthropic API key in Settings; without one, only the form references are filled in."}
              </p>
            </Card>
          )}

          {citeTotal > 0 && (
            <Card
              tone="warn"
              title="Footnote markers with no footnotes"
              count={citeTotal}
              subtitle="Numbers in square brackets after almost every sentence, and no reference list anywhere in the manual. The policy underneath may be perfectly good; the markers make it read as borrowed, and the chapter they are in is the controlled substances chapter."
              className="mb-6"
            >
              <ul className="rows">
                {cites.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                    <Link href={`/manual?edit=${c.id}#${c.id}`} className="text-sm font-medium hover:underline">{c.title}</Link>
                    <span className="text-xs text-ink-3">{c.count} markers</span>
                  </li>
                ))}
              </ul>
              <form action={stripCitations} className="mt-3">
                <button className="btn btn-primary">Remove all {citeTotal} markers</button>
              </form>
              <p className="mt-2 text-xs text-ink-3">
                Only brackets containing nothing but digits are removed. Anything you wrote in brackets yourself —
                &ldquo;[Reserved]&rdquo;, &ldquo;[see Appendix A]&rdquo; — stays where it is.
              </p>
            </Card>
          )}

          <datalist id="manual-managers">
            {others.map((o) => <option key={o.name} value={o.name} />)}
            <option value={s.pharmacy_name ? `${s.pharmacy_name} — clinic side` : "The medical practice"} />
          </datalist>

          <Card title="Contents" count={chapters.length} subtitle="Pick a chapter to read or edit it. Everything is one document — this is just where you open it." className="mb-6">
            <ul className="rows">
              {chapters.map((c) => {
                const kids = sections.filter((x) => x.chapterId === c.id && x.id !== c.id);
                const holes = empty.filter((x) => x.chapterId === c.id).length;
                return (
                  <li key={c.id} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`/manual?ch=${c.id}`} className="min-w-0 text-sm font-medium hover:underline">
                        <span className="mr-2 text-ink-3">{c.number}</span>{c.title}
                      </Link>
                      <span className="flex shrink-0 items-center gap-3 text-xs text-ink-3">
                        {holes > 0 && <span className="badge badge-crit">{holes} to write</span>}
                        {c.source === "site" && <span className="badge badge-ok">generated</span>}
                        {c.managedBy && <span className="badge badge-muted">{c.managedBy}</span>}
                        <span>{kids.length} {kids.length === 1 ? "section" : "sections"}</span>
                        <Link href={`/manual?ch=${c.id}`} className="btn btn-sm">Open</Link>
                      </span>
                    </div>
                    {c.source === "pharmacy" && (
                      <form action={setManager} className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                        <input type="hidden" name="chapter" value={c.id} />
                        <span>Maintained by</span>
                        <input
                          name="manager"
                          defaultValue={c.managedBy ?? ""}
                          list="manual-managers"
                          className="field w-64 py-0.5 text-xs"
                          placeholder="the pharmacy — leave empty"
                        />
                        <button className="btn btn-sm">Set for this chapter</button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card id="review" title="Annual review">
              <p className="card-sub">
                The Board expects a manual that somebody has actually read this year. Read it, change what needs
                changing, then record the date here — one date, across the whole manual, in your name.
              </p>
              <p className="mt-2 text-sm">
                {stale.length === 0
                  ? `All ${own.length} of your sections were reviewed within the last year.`
                  : `${stale.length} of ${own.length} sections have no review date inside the last year.`}
              </p>
              <form action={reviewAll} className="mt-3">
                <button className="btn btn-primary">I have reviewed the manual — record today, {user.name}</button>
              </form>
              <p className="mt-2 text-xs text-ink-3">
                A single section can also be dated on its own, from inside its chapter.
              </p>
            </Card>

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
          </div>
        </>
      )}
    </>
  );
}
