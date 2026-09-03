import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { assignmentByToken, completeAssignment } from "@/lib/training-assignments";
import { courseFor } from "@/lib/courses";
import { TRAINING_LABEL } from "@/lib/labels";
import { db, schema } from "@/db";
import { getSettings } from "@/lib/settings";
import { fmt } from "@/lib/dates";

export const metadata = { title: "Training" };
export const dynamic = "force-dynamic";

/**
 * What a member of staff sees. No login, no account, works on a phone.
 *
 * The course itself is on this page now, rather than a link to somebody else's website. A free
 * course that has moved, expired or turned into a sales page produces staff who cannot do the
 * training and a pharmacist-in-charge who does not find out until an inspector asks — and a
 * pharmacy that cannot produce the material its staff were trained on has training records
 * rather than training.
 *
 * Everything else here is here because leaving it out would weaken the record. They see their own
 * name, so a forwarded link is obviously wrong. They see the exact words before they sign rather
 * than after. They answer questions, so the record says they understood it rather than that they
 * scrolled past it. And they type their name rather than tick a box, because a typed name is a
 * deliberate act and a tick is something people do to make a page go away.
 */
export default async function TrainingLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; done?: string; wrong?: string }>;
}) {
  const { token } = await params;
  const { error, done, wrong } = await searchParams;
  const found = await assignmentByToken(token);
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "the pharmacy";
  const pic = (await db.query.people.findMany()).find((p) => p.isPic);
  const picName = pic ? `${pic.firstName} ${pic.lastName}` : "the pharmacist-in-charge";

  if (!found || !found.person) {
    return (
      <Shell pharmacy={pharmacy}>
        <h1 className="text-xl font-semibold">This link is not valid</h1>
        <p className="mt-2 text-ink-2">It may have been mistyped. Ask the pharmacist-in-charge to send it again.</p>
      </Shell>
    );
  }

  const { assignment: a, person } = found;
  const course = courseFor(a.type);
  const wrongIndexes = new Set((wrong ?? "").split(",").filter(Boolean).map(Number));

  if (done === "1" || a.completedAt) {
    return (
      <Shell pharmacy={pharmacy}>
        <div className="rounded-lg border border-accent bg-accent-soft p-5">
          <h1 className="text-xl font-semibold text-accent">Signed. Thank you.</h1>
          <p className="mt-2 text-sm">
            Your {TRAINING_LABEL[a.type].toLowerCase()} is recorded{a.signedName ? ` in the name of ${a.signedName}` : ""}
            {a.completedAt ? ` on ${fmt(a.completedAt.slice(0, 10))}` : ""}. There is nothing else for you to do.
          </p>
          {a.trainingId && (
            <p className="mt-3">
              <Link href={`/t/${token}/certificate`} className="font-medium underline">
                Open your certificate
              </Link>{" "}
              — print it or save it as a PDF. This page keeps working, so you can come back to it.
            </p>
          )}
        </div>
      </Shell>
    );
  }

  async function sign(fd: FormData) {
    "use server";
    const h = await headers();
    const answers = (course?.questions ?? []).map((_, i) => {
      const raw = fd.get(`q${i}`);
      return raw === null || raw === "" ? null : Number(raw);
    });
    const r = await completeAssignment(
      token,
      {
        signedName: String(fd.get("signedName") ?? ""),
        answers,
        liveQuestions: fd.get("liveQuestions") === "yes",
      },
      {
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        agent: h.get("user-agent") ?? null,
      },
    );
    if (r.ok) redirect(`/t/${token}?done=1`);
    const q = new URLSearchParams({ error: r.error });
    if (r.wrong?.length) q.set("wrong", r.wrong.map((w) => w.index).join(","));
    redirect(`/t/${token}?${q.toString()}`);
  }

  return (
    <Shell pharmacy={pharmacy}>
      <p className="text-sm text-ink-3">For {person.firstName} {person.lastName}</p>
      <h1 className="mt-1 text-2xl font-semibold">{course?.title ?? TRAINING_LABEL[a.type]}</h1>
      <p className="mt-1 text-sm text-ink-2">
        Due by {fmt(a.dueOn)}.{course ? ` About ${course.minutes} minutes.` : ""}
      </p>

      {error && <p className="mt-4 rounded-md border border-crit bg-crit-soft px-3 py-2 text-sm text-crit">{error}</p>}

      {course ? (
        <>
          <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm">{course.intro}</p>

          {a.materialUrl && (
            <p className="mt-3 text-sm text-ink-2">
              {pharmacy} has also given you{" "}
              <a href={a.materialUrl} target="_blank" rel="noreferrer" className="underline">this material</a> for this
              training. Work through it as well as the course below.
            </p>
          )}

          <div className="mt-6 space-y-5">
            {course.sections.map((sec, i) => (
              <section key={sec.heading} className="rounded-lg border border-line bg-surface p-4">
                <h2 className="font-semibold">
                  {i + 1}. {sec.heading}
                </h2>
                <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink-2">
                  {sec.body.map((para) => <p key={para}>{para}</p>)}
                </div>
              </section>
            ))}
          </div>

          <form action={sign} className="mt-8">
            <section className="rounded-lg border border-line bg-surface p-4">
              <h2 className="font-semibold">A few questions</h2>
              <p className="mt-1 text-sm text-ink-2">
                All of them have to be right. If one is not, you will be brought back here with the reason — nothing is
                recorded until they are all correct, so there is no such thing as a failed attempt on your record.
              </p>
              <ol className="mt-4 space-y-5">
                {course.questions.map((q, i) => (
                  <li key={q.q} className={`rounded-md border p-3 ${wrongIndexes.has(i) ? "border-crit bg-crit-soft" : "border-line"}`}>
                    <p className="text-sm font-medium">{i + 1}. {q.q}</p>
                    <div className="mt-2 space-y-2">
                      {q.options.map((opt, oi) => (
                        <label key={opt} className="flex items-start gap-2 text-sm">
                          <input type="radio" name={`q${i}`} value={oi} className="mt-1" />
                          <span>{opt}</span>
                        </label>
                      ))}
                    </div>
                    {wrongIndexes.has(i) && <p className="mt-2 text-xs text-crit">{q.why}</p>}
                  </li>
                ))}
              </ol>
            </section>

            {course.liveQuestionsRequired && (
              <section className="mt-4 rounded-lg border border-line bg-surface p-4">
                <h2 className="font-semibold">Your chance to ask</h2>
                <p className="mt-1 text-sm text-ink-2">
                  This training has to include an opportunity to ask questions of someone who knows the subject — a web
                  page cannot be that person. {picName} is that person here, and will answer anything about this in the
                  pharmacy, by phone or by email. If you have a question, ask before you sign.
                </p>
                <label className="mt-3 flex items-start gap-2 text-sm">
                  <input type="checkbox" name="liveQuestions" value="yes" className="mt-1" />
                  <span>
                    I understand I can ask {picName} questions about this training, and I have had the chance to do so.
                  </span>
                </label>
              </section>
            )}

            <section className="mt-4 rounded-lg border border-line bg-surface p-4">
              <h2 className="font-semibold">What you are confirming</h2>
              <p className="mt-2 rounded-md border border-line bg-ground p-3 text-sm italic">&ldquo;{a.statement}&rdquo;</p>
              <label className="mt-4 block text-sm">
                Type your full name
                <input
                  name="signedName"
                  autoComplete="name"
                  placeholder={`${person.firstName} ${person.lastName}`}
                  className="mt-1 w-full rounded-md border border-line px-3 py-2.5 text-base"
                />
              </label>
              <p className="mt-2 text-xs text-ink-3">
                Typing your name here is your signature. The date, time and this device are recorded with it. When you
                finish, a certificate is produced that you can keep.
              </p>
              <button className="mt-3 w-full rounded-md bg-accent px-4 py-3 text-base font-medium text-white sm:w-auto">
                Sign and finish
              </button>
            </section>
          </form>
        </>
      ) : (
        // No written course for this one — the immunization protocol review, for instance, is
        // reading the pharmacy's own document, which cannot live in the software.
        <form action={sign} className="mt-6 space-y-4">
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-semibold">1. Work through the training</h2>
            {a.materialUrl ? (
              <p className="mt-1 text-sm">
                <a href={a.materialUrl} target="_blank" rel="noreferrer" className="underline">Open the training material</a>{" "}
                — come back to this page afterwards to sign.
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-2">
                Use the material {pharmacy} has given you. If you are not sure what that is, ask {picName} before you
                sign — signing without doing it helps nobody and is the one thing that makes this record worthless.
              </p>
            )}
          </section>
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-semibold">2. Read what you are confirming</h2>
            <p className="mt-2 rounded-md border border-line bg-ground p-3 text-sm italic">&ldquo;{a.statement}&rdquo;</p>
          </section>
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-semibold">3. Sign it</h2>
            <label className="mt-3 block text-sm">
              Type your full name
              <input
                name="signedName"
                autoComplete="name"
                placeholder={`${person.firstName} ${person.lastName}`}
                className="mt-1 w-full rounded-md border border-line px-3 py-2.5 text-base"
              />
            </label>
            <p className="mt-2 text-xs text-ink-3">
              Typing your name here is your signature. The date, time and this device are recorded with it.
            </p>
            <button className="mt-3 w-full rounded-md bg-accent px-4 py-3 text-base font-medium text-white sm:w-auto">
              Sign and finish
            </button>
          </section>
        </form>
      )}
    </Shell>
  );
}

function Shell({ pharmacy, children }: { pharmacy: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <p className="text-xs uppercase tracking-wide text-ink-3">{pharmacy}</p>
      <div className="mt-2">{children}</div>
      <p className="mt-10 text-xs text-ink-3">This link is personal. If it was not sent to you, please do not use it.</p>
    </main>
  );
}
