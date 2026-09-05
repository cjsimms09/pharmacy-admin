import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { courseFor } from "@/lib/courses";
import { packetText, packetFileName, courseVersion } from "@/lib/course-packet";
import { getSettings } from "@/lib/settings";
import { TRAINING_CADENCE } from "@/lib/due";
import { PageHeader, BackLink } from "@/components/ui";
import type { TrainingType } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Course" };

/**
 * The course, as the pharmacist-in-charge sees it.
 *
 * Worth its own page for one reason: the PIC is the person who has to stand behind this material
 * if it is ever questioned, and cannot do that without having read it. It also shows the packet
 * exactly as it is attached to the email, so there is never a question about what staff were
 * actually sent.
 */
export default async function CoursePage({ params }: { params: Promise<{ type: string }> }) {
  await requireUser();
  const { type } = await params;
  const course = courseFor(type as TrainingType);
  if (!course) notFound();
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "the pharmacy";
  const cadence = TRAINING_CADENCE[course.type];

  return (
    <>
      <BackLink href="/compliance/training">Training</BackLink>
      <PageHeader
        title={course.title}
        subtitle={`About ${course.minutes} minutes · ${cadence ? `repeats every ${cadence.months} months` : "does not repeat"} · material version ${courseVersion(course)}`}
      />

      <section className="card mb-6">
        <h2 className="font-semibold">What this satisfies</h2>
        <p className="mt-1 text-sm text-ink-2">{course.authority}</p>
        {course.liveQuestionsRequired && (
          <p className="mt-2 rounded-md border border-warn bg-warn-soft p-3 text-sm text-warn">
            This standard also requires an opportunity for interactive questions and answers with someone
            knowledgeable in the subject. A page cannot be that person. The site names you, asks the member of staff to
            confirm they can ask you, and records that on the certificate — but you do have to actually answer if
            somebody asks.
          </p>
        )}
        <p className="mt-2 text-xs text-ink-3">
          This is in-house training, which is what the rules contemplate: they require training on this pharmacy&rsquo;s
          own policies and name no accreditor. It is not continuing education and does not claim to be. Where a Part D
          plan or PSAO insists on its own module, use theirs as well — file it under &ldquo;they did an outside
          course&rdquo; on the training screen.
        </p>
      </section>

      <section className="card mb-6">
        <p className="text-sm italic text-ink-2">{course.intro}</p>

        {course.objectives && course.objectives.length > 0 && (
          <div className="mt-4 rounded-md border border-line bg-ground p-3">
            <h2 className="text-sm font-semibold">What they should be able to do afterwards</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
              {course.objectives.map((o) => <li key={o}>{o}</li>)}
            </ul>
          </div>
        )}

        <div className="mt-5 space-y-6">
          {course.sections.map((sec, i) => (
            <div key={sec.heading}>
              <h2 className="font-semibold">{i + 1}. {sec.heading}</h2>
              <div className="mt-1 space-y-2 text-sm leading-relaxed text-ink-2">
                {sec.body.map((p) => <p key={p}>{p}</p>)}
              </div>
              {sec.takeaways && sec.takeaways.length > 0 && (
                <div className="mt-3 rounded-md bg-ground px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Key points</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-2">
                    {sec.takeaways.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>

        {(course.seeAlso?.length || course.references?.length) && (
          <div className="mt-6 border-t border-line pt-4 text-xs text-ink-3">
            {course.seeAlso && course.seeAlso.length > 0 && (
              <>
                <p className="font-semibold">This pharmacy&rsquo;s own rules on the subject</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {course.seeAlso.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </>
            )}
            {course.references && course.references.length > 0 && (
              <>
                <p className="mt-3 font-semibold">The regulations and sources behind it</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {course.references.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      <section className="card mb-6">
        <h2 className="font-semibold">The questions, and the answers</h2>
        <p className="mt-1 text-xs text-ink-3">
          Every one has to be right before anything is recorded. A wrong answer sends them back with the reason, so
          there is no such thing here as a training record with a failed check behind it.
        </p>
        <ol className="mt-3 space-y-4">
          {course.questions.map((q, i) => (
            <li key={q.q} className="rounded-md border border-line bg-ground p-3">
              <p className="text-sm font-medium">{i + 1}. {q.q}</p>
              <ul className="mt-2 space-y-1 text-sm">
                {q.options.map((o, oi) => (
                  <li key={o} className={oi === q.answer ? "font-medium text-accent" : "text-ink-2"}>
                    {"abcd"[oi]}) {o}{oi === q.answer ? " ✓" : ""}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-3">{q.why}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h2 className="font-semibold">What is attached to their email</h2>
        <p className="mt-1 text-xs text-ink-3">
          Sent as <span className="font-mono">{packetFileName(course)}</span>. This is what proves the pharmacy provided
          the material rather than merely asked for it, and the certificate names this exact version.
        </p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-md border border-line bg-ground p-3 text-xs leading-relaxed">
          {packetText(course, pharmacy)}
        </pre>
        <p className="mt-3 text-xs text-ink-3">
          <Link href="/compliance/training" className="text-accent underline">Back to training</Link>
        </p>
      </section>
    </>
  );
}
