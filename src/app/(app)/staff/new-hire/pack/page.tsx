import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { COURSES } from "@/lib/courses";
import { TRAINING_CADENCE, trainingApplies } from "@/lib/due";
import { TRAINING_LABEL } from "@/lib/labels";
import { fmtLong, todayIso } from "@/lib/dates";
import { PrintButton } from "@/components/print-button";
import { logo } from "@/lib/branding";
import type { TrainingType } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Training pack" };

/**
 * Every training manual a new starter must work through, as one document to hand them.
 *
 * The courses already exist and can each be read on screen, one at a time, by somebody who has
 * been sent a link and remembers to follow it. That is fine for the annual refresher and useless
 * on a first morning: a new technician needs something in their hands, and the pharmacist showing
 * them round needs to know what is in it without clicking through seven screens.
 *
 * So: a cover with the pharmacy's own name and mark, a contents page, and then the material in
 * order. Generated from the same courses the site tests people on, which is the point — a printed
 * pack that drifts from the course somebody is later examined on is worse than no pack at all.
 *
 * Who it covers is a choice made here rather than by the reader. A pack "for everybody" would
 * carry the technician course to pharmacists and the immunization review to people who do not
 * immunise, and a pack with material in it that does not apply teaches people to skim.
 */
export default async function TrainingPackPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; immuniser?: string }>;
}) {
  await requireUser();
  const { role: roleParam, immuniser } = await searchParams;
  const role = roleParam === "pharmacist" || roleParam === "intern" ? roleParam : "technician";
  const administersVaccines = immuniser === "1";

  const [s, people, mark] = await Promise.all([
    getSettings(),
    db.query.people.findMany({ where: eq(schema.people.active, true) }),
    logo(),
  ]);
  const pic = people.find((p) => p.isPic);
  const pharmacy = s.pharmacy_name || "This pharmacy";

  /*
   * The courses this person actually owes, in the order the cadence table lists them — which is
   * the order the rest of the site uses, so the pack and the screens agree about what comes first.
   */
  const person = { role, administersVaccines };
  const types = (Object.keys(TRAINING_CADENCE) as TrainingType[]).filter(
    (t) => trainingApplies(t, person) && COURSES[t] !== undefined,
  );
  const courses = types.map((t) => ({ type: t, course: COURSES[t]! }));
  const minutes = courses.reduce((n, c) => n + (c.course.minutes ?? 0), 0);

  const roleWord = role === "pharmacist" ? "pharmacist" : role === "intern" ? "intern" : "technician";

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 print:px-0 print:py-0">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Link href="/staff/new-hire" className="text-sm text-accent underline">← New employee</Link>
        <div className="flex items-center gap-2">
          {/* The pack differs by role, so the choice belongs on the page rather than in a guess. */}
          <form method="get" className="flex items-center gap-2 text-xs">
            <select name="role" defaultValue={role} className="rounded-md border border-line px-2 py-1">
              <option value="technician">Technician</option>
              <option value="pharmacist">Pharmacist</option>
              <option value="intern">Intern</option>
            </select>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="immuniser" value="1" defaultChecked={administersVaccines} />
              Immunises
            </label>
            <button className="rounded-md border border-line px-2 py-1">Rebuild</button>
          </form>
          <PrintButton />
        </div>
      </div>

      {/* ── Cover ─────────────────────────────────────────────────────────── */}
      <section className="flex min-h-[60vh] flex-col justify-center border-b border-line pb-16 text-center print:min-h-[80vh] print:break-after-page">
        {mark && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mark.url} alt="" className="mx-auto mb-8 max-h-24 w-auto" />
        )}
        <h1 className="text-3xl font-bold tracking-tight">{pharmacy}</h1>
        <p className="mt-2 text-lg">Training pack</p>
        <p className="mt-1 text-sm text-ink-2">
          For a new {roleWord}
          {administersVaccines ? " who administers vaccines" : ""}
        </p>
        <div className="mx-auto mt-10 w-full max-w-sm border-t border-line pt-6 text-left text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-3">Courses</dt>
            <dd>{courses.length}</dd>
            <dt className="text-ink-3">Reading time</dt>
            <dd>about {Math.round(minutes / 5) * 5} minutes</dd>
            <dt className="text-ink-3">Prepared</dt>
            <dd>{fmtLong(todayIso())}</dd>
            {pic && (
              <>
                <dt className="text-ink-3">Pharmacist in charge</dt>
                <dd>
                  {pic.firstName} {pic.lastName}
                </dd>
              </>
            )}
          </dl>
        </div>
        <p className="mx-auto mt-10 max-w-md text-xs leading-relaxed text-ink-3">
          Read each course, then answer its questions on the site. The certificate is issued on a pass and filed
          against your record — this pack is the reading, not the record.
        </p>
      </section>

      {/* ── Contents ──────────────────────────────────────────────────────── */}
      <section className="border-b border-line py-10 print:break-after-page">
        <h2 className="text-xl font-semibold">Contents</h2>
        <ol className="mt-4 space-y-2 text-sm">
          {courses.map((c, i) => (
            <li key={c.type} className="flex items-baseline gap-3">
              <span className="w-6 shrink-0 tabular-nums text-ink-3">{i + 1}.</span>
              <span className="flex-1">
                <b>{c.course.title}</b>
                <span className="block text-xs text-ink-3">
                  {TRAINING_LABEL[c.type] ?? c.type} · {c.course.sections.length} sections ·{" "}
                  {c.course.questions.length} questions · about {c.course.minutes} minutes
                </span>
              </span>
            </li>
          ))}
        </ol>
        {courses.length === 0 && (
          <p className="mt-4 text-sm text-ink-2">No written course applies to this role yet.</p>
        )}
      </section>

      {/* ── The material ──────────────────────────────────────────────────── */}
      {courses.map((c, i) => (
        <section key={c.type} className="border-b border-line py-10 print:break-after-page">
          <p className="text-xs uppercase tracking-wide text-ink-3">Course {i + 1} of {courses.length}</p>
          <h2 className="mt-1 text-2xl font-semibold">{c.course.title}</h2>
          <p className="mt-1 text-sm text-ink-2">
            {TRAINING_LABEL[c.type] ?? c.type} · about {c.course.minutes} minutes
          </p>

          {c.course.sections.map((sec, j) => (
            <div key={j} className="mt-6 break-inside-avoid">
              <h3 className="text-base font-semibold">
                {i + 1}.{j + 1} {sec.heading}
              </h3>
              {sec.body.map((para, k) => (
                <p key={k} className="mt-2 text-sm leading-relaxed">{para}</p>
              ))}
              {sec.takeaways && sec.takeaways.length > 0 && (
                <div className="mt-3 rounded-md border border-line bg-ground p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">What to remember</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                    {sec.takeaways.map((t, k) => (
                      <li key={k}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}

          {/*
            The questions, without their answers.
            
            A pack somebody can read the answers off is a pack that certifies nothing. They are here
            so a new starter knows what they will be asked and can read for it, which is the whole
            purpose of telling somebody the shape of an exam.
          */}
          {c.course.questions.length > 0 && (
            <div className="mt-8 break-inside-avoid">
              <h3 className="text-base font-semibold">What you will be asked</h3>
              <p className="mt-1 text-xs text-ink-3">
                Answered on the site, not here. {c.course.questions.length} questions, all of them from the material above.
              </p>
              <ol className="mt-3 space-y-1 text-sm">
                {c.course.questions.map((q, k) => (
                  <li key={k} className="flex gap-3">
                    <span className="w-6 shrink-0 tabular-nums text-ink-3">{k + 1}.</span>
                    <span>{q.q}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      ))}

      <p className="py-8 text-center text-xs text-ink-3">
        {pharmacy} · Training pack for a new {roleWord} · prepared {fmtLong(todayIso())}
      </p>
    </div>
  );
}
