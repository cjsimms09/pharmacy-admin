import Link from "next/link";
import { isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { linkForItem } from "@/lib/training-assignments";
import { TRAINING_LABEL } from "@/lib/labels";
import { courseFor } from "@/lib/courses";
import { fmt, fmtLong, todayIso } from "@/lib/dates";
import { PrintButton } from "@/components/print-button";
import type { TrainingType } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hand the training over" };

/**
 * Training that does not depend on email arriving.
 *
 * Email is the convenient route and it is not a reliable one: an address can be mistyped, a
 * provider can accept a message and drop it, a filter can eat the attachment, and none of that is
 * visible from inside this building. A compliance system whose only delivery mechanism can fail
 * silently is a compliance system that fails silently.
 *
 * So this is the route that cannot fail. One slip per person, listing what they owe, the address
 * that opens it, and the code that identifies them. Print it and hand it over; or read the code
 * out; or open the link on the pharmacy computer and pass them the keyboard. The training, the
 * questions, the attestation and the certificate all work exactly the same way afterwards —
 * nothing about the record depends on how the person was told.
 */
export default async function HandoutPage() {
  await requireUser();
  const [assignments, people, s] = await Promise.all([
    db.query.trainingAssignments.findMany({ where: isNull(schema.trainingAssignments.completedAt) }),
    db.query.people.findMany(),
    getSettings(),
  ]);

  const pharmacy = s.pharmacy_name || "the pharmacy";
  const base = (s.public_base_url || "").trim();

  const withLinks = await Promise.all(
    assignments.map(async (a) => ({ a, url: await linkForItem(a.type, a.token) })),
  );
  const byPerson = people
    .filter((p) => p.active)
    .map((p) => ({ person: p, items: withLinks.filter((x) => x.a.personId === p.id) }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => a.person.lastName.localeCompare(b.person.lastName));

  return (
    <div className="mx-auto max-w-[8.5in] bg-white text-black print:max-w-none">
      <div className="no-print mb-4 rounded-md border border-line bg-ground px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/compliance/training" className="text-ink-2 hover:text-ink">← Back to training</Link>
          <PrintButton />
        </div>
        <p className="mt-2 text-xs text-ink-2">
          One slip per person, for handing over on paper. Cut along the lines. Nothing here depends on email
          arriving — the link and the code are all anybody needs, and the certificate is produced the same way
          afterwards.
        </p>
        {withLinks.some((x) => /localhost/.test(x.url)) && (
          <p className="mt-2 text-xs text-crit">
            <b>No address is set for this site</b>, so {base ? "some" : "the"} links below say <code>localhost</code> and will only work on
            this computer. Set one under{" "}
            <Link href="/settings/network" className="underline">Settings → Network</Link> and reprint, or have people
            complete it on this computer.
          </p>
        )}
      </div>

      {byPerson.length === 0 ? (
        <p className="text-sm">Nobody has outstanding training. Nothing to hand out.</p>
      ) : (
        byPerson.map(({ person, items }, i) => (
          <section
            key={person.id}
            className={`border-2 border-dashed border-black p-5 ${i > 0 ? "mt-6 print-page-break" : ""}`}
          >
            <div className="flex items-baseline justify-between border-b border-black pb-2">
              <div>
                <div className="text-lg font-bold">{person.firstName} {person.lastName}</div>
                <div className="text-[11px]">{pharmacy} · training due</div>
              </div>
              <div className="text-[10px]">Issued {fmtLong(todayIso())}</div>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed">
              You have {items.length} training{items.length === 1 ? "" : "s"} to complete. Open the address below on a
              phone or a computer — no password is needed. Each is a short read and a few questions, and you type your
              name at the end. That is your record; a certificate is filed for you automatically.
            </p>

            <table className="mt-3 w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  <th className="border border-black px-2 py-1 text-left">Training</th>
                  <th className="border border-black px-2 py-1 text-left">Due</th>
                  <th className="border border-black px-2 py-1 text-left">Open this</th>
                  <th className="border border-black px-2 py-1 text-left">Your code</th>
                </tr>
              </thead>
              <tbody>
                {items.map(({ a, url }) => {
                  const course = courseFor(a.type as TrainingType);
                  return (
                    <tr key={a.id}>
                      <td className="border border-black px-2 py-1">
                        {course?.title ?? TRAINING_LABEL[a.type as TrainingType]}
                        {course?.minutes ? <span className="text-neutral-600"> · about {course.minutes} min</span> : null}
                      </td>
                      <td className="border border-black px-2 py-1 whitespace-nowrap">{fmt(a.dueOn)}</td>
                      <td className="border border-black px-2 py-1 font-mono text-[10px] break-all">{url}</td>
                      <td className="border border-black px-2 py-1 font-mono whitespace-nowrap">{a.replyCode ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <p className="mt-3 text-[10px] leading-relaxed text-neutral-700">
              Cannot open the link? Tell the pharmacist-in-charge your code and complete it on the pharmacy computer.
              Either way the record is the same.
            </p>

            <div className="no-print mt-3 flex flex-wrap gap-2">
              {items.map(({ a, url }) => (
                <a key={a.id} href={url} target="_blank" rel="noreferrer" className="btn btn-sm">
                  Open {TRAINING_LABEL[a.type as TrainingType]} now
                </a>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
