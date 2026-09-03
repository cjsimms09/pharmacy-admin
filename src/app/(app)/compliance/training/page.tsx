import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { TRAINING_CADENCE, addMonths } from "@/lib/due";
import { TRAINING_LABEL, PERSON_ROLE_LABEL } from "@/lib/labels";
import { TRAINING_TYPES, type TrainingType } from "@/db/schema";
import { todayIso, fmt, daysUntil } from "@/lib/dates";
import { storeFile } from "@/lib/files";
import { newId } from "@/lib/crypto";
import { PageHeader, Notice, BackLink, Empty } from "@/components/ui";

export const metadata = { title: "Training register" };
export const dynamic = "force-dynamic";

export default async function TrainingPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; person?: string }> }) {
  await requireUser();
  const { ok, error } = await searchParams;
  const [people, trainings] = await Promise.all([
    db.query.people.findMany({ where: eq(schema.people.active, true), orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.trainings.findMany({ orderBy: (t, { desc }) => [desc(t.completedOn)] }),
  ]);

  const required = (Object.keys(TRAINING_CADENCE) as TrainingType[]);

  async function record(fd: FormData) {
    "use server";
    const u = await requireManager();
    const personId = String(fd.get("personId") ?? "");
    const type = String(fd.get("type") ?? "") as TrainingType;
    const completedOn = String(fd.get("completedOn") ?? "") || todayIso();
    const provider = String(fd.get("provider") ?? "").trim() || null;
    if (!personId || !type) redirect("/compliance/training?error=" + encodeURIComponent("Pick a person and a training."));

    let documentId: string | null = null;
    const file = fd.get("file");
    if (file instanceof File && file.size > 0) {
      const stored = await storeFile(file, { allowReportTypes: true });
      documentId = newId();
      await db.insert(schema.documents).values({
        id: documentId,
        category: "ce_certificate",
        title: `${TRAINING_LABEL[type]} — ${completedOn}`,
        fileName: file.name,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storageKey: stored.storageKey,
        personId,
        effectiveOn: completedOn,
        uploadedBy: u.id,
      });
    }

    const months = TRAINING_CADENCE[type]?.months;
    await db.insert(schema.trainings).values({
      id: newId(),
      personId,
      type,
      completedOn,
      cycleYear: Number(completedOn.slice(0, 4)),
      expiresOn: months ? addMonths(completedOn, months) : null,
      provider,
      documentId,
      createdBy: u.id,
    });
    await audit({ action: "training.record", userId: u.id, userName: u.name, details: `${type} for ${personId} on ${completedOn}` });
    revalidatePath("/compliance/training");
    revalidatePath("/compliance");
    redirect("/compliance/training?ok=" + encodeURIComponent("Recorded."));
  }

  return (
    <>
      <BackLink href="/compliance">Compliance</BackLink>
      <PageHeader
        title="Training register"
        subtitle="Who has completed what, and when it next falls due. One row per person, one column per requirement."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {people.length === 0 ? (
        <Empty>No active staff. <Link href="/staff/new" className="underline">Add someone first.</Link></Empty>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-3 py-2">Person</th>
                  {required.map((t) => <th key={t} className="px-3 py-2">{TRAINING_LABEL[t]}</th>)}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      <Link href={`/staff/${p.id}`} className="font-medium underline">{p.firstName} {p.lastName}</Link>
                      <div className="text-xs text-ink-3">{PERSON_ROLE_LABEL[p.role as keyof typeof PERSON_ROLE_LABEL] ?? p.role}</div>
                    </td>
                    {required.map((t) => {
                      if (t === "immunization_protocol_review" && !p.administersVaccines) {
                        return <td key={t} className="px-3 py-2 text-xs text-ink-3">n/a</td>;
                      }
                      const last = trainings.filter((x) => x.personId === p.id && x.type === t)[0];
                      if (!last) return <td key={t} className="px-3 py-2"><span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800">never</span></td>;
                      const due = last.expiresOn;
                      const left = due ? daysUntil(due) : null;
                      const tone = left === null ? "bg-ground text-ink-3" : left < 0 ? "bg-red-100 text-red-800" : left <= 30 ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800";
                      return (
                        <td key={t} className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>
                            {left === null ? "done" : left < 0 ? `${Math.abs(left)}d late` : `${left}d`}
                          </span>
                          <div className="mt-0.5 text-xs text-ink-3">{fmt(last.completedOn)}</div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="mt-8 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold">Record a completion</h2>
            <form action={record} className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-ink-3">
                Person
                <select name="personId" className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink">
                  {people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                </select>
              </label>
              <label className="text-xs text-ink-3">
                Training
                <select name="type" className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink">
                  {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_LABEL[t]}</option>)}
                </select>
              </label>
              <label className="text-xs text-ink-3">
                Date completed
                <input type="date" name="completedOn" defaultValue={todayIso()} className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" />
              </label>
              <label className="text-xs text-ink-3">
                Provider
                <input name="provider" placeholder="e.g. Pharmacist's Letter, HMA, in-house" className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" />
              </label>
              <label className="text-xs text-ink-3 sm:col-span-2">
                Certificate
                <input type="file" name="file" className="mt-1 w-full text-sm text-ink" />
              </label>
              <div className="sm:col-span-2">
                <button className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">Record</button>
              </div>
            </form>
            <p className="mt-2 text-xs text-ink-3">
              The next due date is set automatically from the requirement&rsquo;s cadence. Uploading the certificate
              files it against that person at the same time — a completion with no evidence is worth very little at
              inspection.
            </p>
          </section>

          <section className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm">
            <h2 className="text-sm font-semibold">What is chased, and why</h2>
            <ul className="mt-2 space-y-1 text-ink-2">
              {(Object.entries(TRAINING_CADENCE) as [TrainingType, { months: number; why: string }][]).map(([t, c]) => (
                <li key={t}><b>{TRAINING_LABEL[t]}</b> — every {c.months} months. {c.why}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-3">
              Anything else can still be recorded and filed, but is not chased: a one-off certificate does not lapse,
              and reminders about things that never expire train people to ignore the list.
            </p>
          </section>
        </>
      )}
    </>
  );
}
