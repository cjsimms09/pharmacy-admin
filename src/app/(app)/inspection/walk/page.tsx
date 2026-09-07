import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { CHECKLIST } from "@/lib/self-inspection-checklist";
import { startInspection, currentInspection, answer, correct, finalise, progress, openFindings, history, knownAnswers } from "@/lib/self-inspection";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Figure, Notice, Empty, Field } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Self-inspection" };

/**
 * Walking the pharmacy against the criteria an inspector uses.
 *
 * The compliance calendar has carried a self-inspection duty all along, and closing it meant
 * attesting "I walked the pharmacy against the Board's criteria". That is a real record and a
 * weak one: it proves somebody said they looked, and nothing about what they looked at or found.
 *
 * The whole design rests on one idea — findings are the point, not the ticks. An inspection that
 * finds nothing is either a very good pharmacy or a walkthrough nobody took seriously, and this
 * screen says so out loud. What actually impresses an inspector is not a clean checklist; it is
 * two findings from March with the dates they were put right.
 */
export default async function WalkPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; section?: string }>;
}) {
  const user = await requireUser();
  const { ok, error, section } = await searchParams;

  const current = await currentInspection();
  const [answers, findings, past, known] = await Promise.all([
    current
      ? db.query.selfInspectionItems.findMany({ where: eq(schema.selfInspectionItems.inspectionId, current.id) })
      : Promise.resolve([]),
    openFindings(),
    history(),
    knownAnswers(),
  ]);
  const p = current ? await progress(current.id) : null;
  const answerFor = (key: string) => answers.find((a) => a.itemKey === key);

  const shownSection = section ?? CHECKLIST[0].key;
  const sec = CHECKLIST.find((x) => x.key === shownSection) ?? CHECKLIST[0];

  async function begin() {
    "use server";
    const u = await requireManager();
    const id = await startInspection(u);
    await audit({ action: "selfinspection.start", userId: u.id, userName: u.name, details: id });
    revalidatePath("/inspection/walk");
    redirect("/inspection/walk");
  }

  async function record(fd: FormData) {
    "use server";
    const u = await requireManager();
    const inspectionId = String(fd.get("inspectionId") ?? "");
    const itemKey = String(fd.get("itemKey") ?? "");
    const result = String(fd.get("result") ?? "") as "ok" | "finding" | "na";
    const note = String(fd.get("note") ?? "");
    const back = `/inspection/walk?section=${String(fd.get("section") ?? "")}`;
    try {
      await answer(inspectionId, itemKey, result, note);
      revalidatePath("/inspection/walk");
      redirect(`${back}#${itemKey}`);
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`${back}&error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
    }
  }

  async function fix(fd: FormData) {
    "use server";
    const u = await requireManager();
    const itemId = String(fd.get("itemId") ?? "");
    try {
      await correct(itemId, String(fd.get("action") ?? ""), u);
      await audit({ action: "selfinspection.correct", userId: u.id, userName: u.name, details: itemId });
      revalidatePath("/inspection/walk");
      revalidatePath("/");
      redirect("/inspection/walk?ok=" + encodeURIComponent("Recorded as put right."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inspection/walk?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
    }
  }

  async function finish(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      const r = await finalise(String(fd.get("inspectionId") ?? ""), u, String(fd.get("notes") ?? ""));
      await audit({ action: "selfinspection.finalise", userId: u.id, userName: u.name });
      revalidatePath("/inspection/walk");
      revalidatePath("/compliance");
      revalidatePath("/");
      redirect(
        "/inspection/walk?ok=" +
          encodeURIComponent(
            r.findings === 0
              ? "Finished and recorded on the compliance register. Nothing found — which is worth a second look, because a walkthrough that finds nothing usually means the questions were read rather than answered."
              : `Finished and recorded on the compliance register. ${r.findings} finding${r.findings === 1 ? "" : "s"} to close out — those stay on this page and on the dashboard until they are.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inspection/walk?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not finish."));
    }
  }

  return (
    <>
      <PageHeader
        tabs={familyTabs("inspection", "/inspection/walk")}
        title="Self-inspection"
        subtitle="Walk the pharmacy against the criteria an inspector uses. What impresses them is not a clean checklist — it is findings with the dates they were put right."
        actions={
          !current ? (
            <form action={begin}><button className="btn btn-primary">Start a walkthrough</button></form>
          ) : (
            <Link href="/inspection/walk/print" className="btn">Print the record</Link>
          )
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {findings.length > 0 && (
        <Card
          tone="crit"
          title="Found and not yet put right"
          count={findings.length}
          subtitle="These outlive the walkthrough that found them. They stay here and on the dashboard until somebody says what was done."
          className="mb-6"
        >
          <ul className="rows">
            {findings.map((fnd) => (
              <li key={fnd.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3>{fnd.ask}</h3>
                  <span className={`badge ${fnd.daysOpen > 30 ? "badge-crit" : "badge-warn"}`}>
                    open {fnd.daysOpen} day{fnd.daysOpen === 1 ? "" : "s"}
                  </span>
                </div>
                {fnd.note && <p className="mt-1 text-sm text-ink-2">{fnd.note}</p>}
                <p className="mt-0.5 text-xs text-ink-3">{fnd.section} · {fnd.authority}</p>
                <form action={fix} className="mt-2 flex flex-wrap gap-2">
                  <input type="hidden" name="itemId" value={fnd.id} />
                  <input name="action" placeholder="What was done about it" className="field min-w-64 flex-1" />
                  <button className="btn btn-primary">Put right</button>
                  {fnd.fixHref && <Link href={fnd.fixHref} className="btn">Open the tool</Link>}
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!current ? (
        <>
          {past.length === 0 ? (
            <Empty>
              No walkthrough has been done yet. Start one and work through it a section at a time — it does not have to
              be finished in one go.
            </Empty>
          ) : (
            <Card title="Previous walkthroughs" count={past.length}>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Started</th><th>Finished</th><th>By</th><th className="num">Items</th><th className="num">Findings</th><th>Outstanding</th></tr></thead>
                  <tbody>
                    {past.map((h) => (
                      <tr key={h.id}>
                        <td className="whitespace-nowrap text-xs">{fmt(h.startedOn)}</td>
                        <td className="whitespace-nowrap text-xs">{h.completedOn ? fmt(h.completedOn) : <span className="text-warn">unfinished</span>}</td>
                        <td className="text-xs">{h.completedBy ?? h.createdBy}</td>
                        <td className="num">{h.answered}</td>
                        <td className="num">{h.findings}</td>
                        <td>
                          {h.outstanding === 0 ? (
                            <span className="badge badge-ok">all closed</span>
                          ) : (
                            <span className="badge badge-crit">{h.outstanding} open</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure value={`${p!.answered}/${p!.total}`} label="Answered" sub={p!.complete ? "Ready to finish" : "Keep going — it saves as you answer"} tone={p!.complete ? "ok" : "warn"} />
            <Figure value={p!.findings} label="Found so far" sub={p!.findings === 0 ? "Nothing yet" : "Each needs a correction"} tone={p!.findings === 0 ? "muted" : "warn"} />
            <Figure value={p!.notApplicable} label="Not applicable here" sub="Recorded as such, not ticked green" tone="muted" />
            <Figure value={fmt(p!.startedOn)} label="Started" sub={`by ${current.createdBy}`} tone="muted" />
          </div>

          <div className="mb-4 flex flex-wrap gap-1.5">
            {CHECKLIST.map((x) => {
              const done = x.items.filter((i) => answerFor(i.key)).length;
              return (
                <Link
                  key={x.key}
                  href={`/inspection/walk?section=${x.key}`}
                  className={`btn btn-sm ${x.key === sec.key ? "btn-primary" : ""}`}
                >
                  {x.title}
                  <span className={`badge ${done === x.items.length ? "badge-ok" : "badge-muted"} ml-1`}>
                    {done}/{x.items.length}
                  </span>
                </Link>
              );
            })}
          </div>

          <Card title={sec.title} subtitle={sec.where} className="mb-6">
            <ul className="rows">
              {sec.items.map((item) => {
                const a = answerFor(item.key);
                const kn = item.autoKey ? known.get(item.autoKey) : undefined;
                return (
                  <li key={item.key} id={item.key} className="scroll-mt-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3>{item.ask}</h3>
                      {a && (
                        <span className={`badge ${a.result === "finding" ? "badge-crit" : a.result === "na" ? "badge-muted" : "badge-ok"}`}>
                          {a.result === "finding" ? "finding" : a.result === "na" ? "not applicable" : "in order"}
                        </span>
                      )}
                    </div>
                    {item.looksLike && <p className="mt-1 text-sm text-ink-2">{item.looksLike}</p>}
                    <p className="mt-0.5 text-xs text-ink-3">{item.authority}</p>
                    {a?.note && <p className="mt-1 rounded-md bg-ground px-2 py-1 text-xs text-ink-2">{a.note}</p>}

                    {/* Where the site already tracks this, it says what it believes and why, so
                        the walk is spent on the fridge and the bins rather than on re-checking
                        software. The pharmacist still presses the button — a checklist that fills
                        itself in is one nobody has read. */}
                    {kn && (
                      <div
                        className={`mt-2 rounded-md border px-2.5 py-1.5 text-xs ${
                          kn.suggests === "finding" ? "border-crit bg-crit-soft text-crit" : "border-accent bg-accent-soft text-accent"
                        }`}
                      >
                        <b>The site already knows:</b> {kn.evidence}{" "}
                        {kn.suggests === "finding" ? "Mark it as a finding unless you can see otherwise." : "Mark it in order if that matches what you can see."}
                      </div>
                    )}

                    <form action={record} className="mt-2 flex flex-wrap items-center gap-2">
                      <input type="hidden" name="inspectionId" value={current.id} />
                      <input type="hidden" name="itemKey" value={item.key} />
                      <input type="hidden" name="section" value={sec.key} />
                      <input
                        name="note"
                        defaultValue={a?.note ?? kn?.evidence ?? ""}
                        placeholder="What you saw — required if it is a finding"
                        className="field min-w-56 flex-1"
                      />
                      <button name="result" value="ok" className="btn btn-sm">In order</button>
                      <button name="result" value="finding" className="btn btn-sm btn-danger">Finding</button>
                      <button name="result" value="na" className="btn btn-sm">Not us</button>
                      {item.fixHref && (
                        <Link href={item.fixHref} className="btn btn-sm">Open the tool</Link>
                      )}
                    </form>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Finish the walkthrough" tone={p!.complete ? "ok" : undefined}>
            {p!.complete ? (
              <>
                <p className="text-sm text-ink-2">
                  All {p!.total} items answered. Finishing records it on the compliance register with a statement of
                  what was walked and what was found, and closes the annual self-inspection duty.
                </p>
                <form action={finish} className="mt-3 grid max-w-2xl gap-3">
                  <input type="hidden" name="inspectionId" value={current.id} />
                  <Field label="Anything else worth recording" hint="Optional. Who walked it with you, what you changed on the spot.">
                    <textarea name="notes" rows={2} className="field" />
                  </Field>
                  <div><button className="btn btn-primary">Finish and record it</button></div>
                </form>
              </>
            ) : (
              <p className="text-sm text-ink-2">
                {p!.total - p!.answered} item{p!.total - p!.answered === 1 ? "" : "s"} still to answer. Mark each one,
                including anything that does not apply here — a walkthrough that skipped the controlled substance
                section is not a self-inspection, and recording it as one would put a green tick on the register for
                something that did not happen.
              </p>
            )}
          </Card>
        </>
      )}
    </>
  );
}
