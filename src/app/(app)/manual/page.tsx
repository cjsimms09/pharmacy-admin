import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { hasApiKey, draftPolicy } from "@/lib/ai";
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
} from "@/lib/manual-store";
import { policies, FORMS, appendixReference } from "@/lib/manual";
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
  const [rows, s, aiReady, stale] = await Promise.all([allSections(), getSettings(), hasApiKey(), needingReview()]);
  const sections = outline(rows);
  const pharmacy = s.pharmacy_name || "This pharmacy";

  const own = sections.filter((x) => x.source === "pharmacy");
  const generated = sections.filter((x) => x.source === "site");
  const empty = gaps(rows);

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
                      {x.source === "pharmacy" && !isEditing && (
                        <Link href={`/manual?ch=${open.id}&edit=${x.id}#${x.id}`} className="btn btn-sm">Edit</Link>
                      )}
                      {x.source === "pharmacy" && !isEditing && (
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
            <Figure value={sections.length} label="Sections" sub={`${own.length} yours, ${generated.length} generated`} tone="ok" />
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

          {empty.length > 0 && (
            <Card
              id="empty"
              tone="crit"
              title="Headings with nothing under them"
              count={empty.length}
              subtitle="An inspector who reads to the back of a manual and finds ten promised forms and no forms has learned something about the rest of it. Chapter headings are not counted here — only headings that promise a policy and deliver none."
              className="mb-6"
            >
              <ul className="rows">
                {empty.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-sm font-medium"><span className="mr-2 text-ink-3">{x.number}</span>{x.title}</span>
                    <form action={pointAtAppendix} className="flex flex-wrap items-center gap-1.5">
                      <input type="hidden" name="id" value={x.id} />
                      <select name="form" required className="field max-w-[22rem] py-1 text-xs" defaultValue="">
                        <option value="" disabled>Is this a form the site produces?</option>
                        {FORMS.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                      </select>
                      <button className="btn btn-sm">Point at the appendix</button>
                      <Link href={`/manual?edit=${x.id}#${x.id}`} className="btn btn-sm btn-primary">Write it myself</Link>
                    </form>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-3">
                Ten headings promising forms, with no forms behind them, is the single thing in this manual an inspector
                is most likely to notice. Where the heading names something this system produces, pick it and the
                heading gets a sentence saying where the current version comes from — which is both shorter and true for
                longer than a blank copy pasted into a manual.
              </p>
            </Card>
          )}

          <Card title="Contents" count={chapters.length} subtitle="Pick a chapter to read or edit it. Everything is one document — this is just where you open it." className="mb-6">
            <ul className="rows">
              {chapters.map((c) => {
                const kids = sections.filter((x) => x.chapterId === c.id && x.id !== c.id);
                const holes = empty.filter((x) => x.chapterId === c.id).length;
                return (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={`/manual?ch=${c.id}`} className="min-w-0 text-sm font-medium hover:underline">
                      <span className="mr-2 text-ink-3">{c.number}</span>{c.title}
                    </Link>
                    <span className="flex shrink-0 items-center gap-3 text-xs text-ink-3">
                      {holes > 0 && <span className="badge badge-crit">{holes} to write</span>}
                      {c.source === "site" && <span className="badge badge-ok">generated</span>}
                      <span>{kids.length} {kids.length === 1 ? "section" : "sections"}</span>
                      <Link href={`/manual?ch=${c.id}`} className="btn btn-sm">Open</Link>
                    </span>
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
