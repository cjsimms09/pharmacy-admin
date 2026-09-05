import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { practiceDecisions, answerDecision } from "@/lib/practice-decisions";
import { rereadBlockedSections } from "@/lib/manual-audit";
import { PageHeader, Notice, Card } from "@/components/ui";

export const metadata = { title: "How this pharmacy works" };
export const dynamic = "force-dynamic";

/**
 * The questions the manual is waiting on, asked once.
 *
 * Every one of these arrived as a finding that said, in different words, "the pharmacy has to
 * decide this" — how often expiry is checked, what date the biennial inventory is anchored to,
 * whether a second person verifies a count. The reviewer was right to refuse to invent them, and
 * right to raise them; what it could not do was ask. So they came back unchanged on every pass,
 * twenty-three of them, and the findings list stopped being read.
 *
 * Answering one here is the whole loop: the sentence joins the fact sheet the reviewer is given,
 * the sections that were only waiting on it go back in the queue, and the next pass writes the
 * text into the manual instead of asking again.
 */
export default async function DecisionsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser();
  const { ok, error } = await searchParams;
  const decisions = await practiceDecisions();
  const outstanding = decisions.filter((d) => !d.answer);

  async function answer(fd: FormData) {
    "use server";
    const u = await requireManager();
    const key = String(fd.get("key") ?? "");
    const value = String(fd.get("value") ?? "");
    try {
      await answerDecision(key, value);
      // The sections that were waiting on a fact go back in the queue at once — supplying the
      // answer and then waiting a year for the section to come round again is not an answer.
      const back = await rereadBlockedSections(u);
      await audit({ action: "manual.decision", userId: u.id, userName: u.name, details: `${key} = ${value || "(unanswered)"}` });
      revalidatePath("/manual/decisions");
      revalidatePath("/manual");
      redirect(
        "/manual/decisions?ok=" +
          encodeURIComponent(
            value
              ? `Recorded.${back.sections ? ` ${back.sections} section${back.sections === 1 ? "" : "s"} put back in the queue — press “Put it right” on the manual and they are written this pass.` : ""}`
              : "Unanswered. The manual will go back to asking about this.",
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/manual/decisions?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
    }
  }

  return (
    <>
      <PageHeader
        back={{ href: "/manual", label: "P&P manual" }}
        title="How this pharmacy works"
        subtitle="The handful of things the manual has to state and only you can settle. Each one is a finding the reviewer keeps raising because it will not invent a fact about your pharmacy — answer it here and it writes the text instead."
        actions={<Link href="/manual" className="btn">Back to the manual</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {outstanding.length === 0 ? (
        <Notice kind="ok">
          All settled. Press <b>Put it right</b> on the <Link href="/manual" className="underline">manual</Link> and the
          sections that were waiting on these are written with the answers.
        </Notice>
      ) : (
        <Notice kind="warn">
          <b>{outstanding.length} still to settle.</b> Until each is answered the sections that depend on it cannot be
          written, and the reviewer will go on raising it. Nothing is assumed in the meantime — an unanswered question
          contributes nothing, which is the point.
        </Notice>
      )}

      <div className="mt-4 space-y-4">
        {decisions.map((d) => (
          <Card
            key={d.key}
            title={d.question}
            subtitle={d.why}
            className={d.answer ? undefined : "border-warn"}
          >
            <p className="text-xs text-ink-3">
              <span className="badge badge-muted">{d.affects}</span>
              {d.answer ? (
                <span className="ml-2 text-accent">Answered</span>
              ) : (
                <span className="ml-2 text-warn">Waiting on you</span>
              )}
            </p>

            <form action={answer} className="mt-3 space-y-2">
              <input type="hidden" name="key" value={d.key} />
              {d.choices.map((c) => (
                <label key={c.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-2 text-sm hover:bg-ground">
                  <input type="radio" name="value" value={c.value} defaultChecked={d.answer === c.value} className="mt-1" />
                  <span>
                    <span className="font-medium">
                      {c.label}
                      {c.recommended && <span className="badge badge-ok ml-2">suggested</span>}
                    </span>
                    {/*
                      The exact sentence, not a summary of it.

                      What goes into the manual is what an inspector reads back, so the person
                      choosing should see the words rather than a label and a promise.
                    */}
                    <span className="mt-1 block text-xs text-ink-2">{c.sentence}</span>
                  </span>
                </label>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <button className="btn btn-primary btn-sm">{d.answer ? "Change it" : "That's how we do it"}</button>
                {d.answer && (
                  <button name="value" value="" className="btn btn-sm" title="Put this back to unanswered.">
                    Unanswer
                  </button>
                )}
              </div>
            </form>
          </Card>
        ))}
      </div>
    </>
  );
}
