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
import { assignTraining, openAssignments, STATEMENTS, linkFor } from "@/lib/training-assignments";
import { canSend } from "@/lib/send-mail";

export const metadata = { title: "Training register" };
export const dynamic = "force-dynamic";

export default async function TrainingPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; person?: string }> }) {
  await requireUser();
  const { ok, error } = await searchParams;
  const [assignments, mailReady, people, trainings] = await Promise.all([
    openAssignments(),
    canSend(),
    db.query.people.findMany({ where: eq(schema.people.active, true), orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.trainings.findMany({ orderBy: (t, { desc }) => [desc(t.completedOn)] }),
  ]);
  const outstanding = assignments.filter((a) => !a.completedAt);

  const required = (Object.keys(TRAINING_CADENCE) as TrainingType[]);

  async function assign(fd: FormData) {
    "use server";
    const u = await requireManager();
    const type = String(fd.get("type") ?? "") as TrainingType;
    const ids = fd.getAll("personIds").map(String).filter(Boolean);
    if (ids.length === 0) redirect("/compliance/training?error=" + encodeURIComponent("Pick at least one person."));
    try {
      const r = await assignTraining(ids, type, { dueOn: String(fd.get("dueOn") ?? "") || undefined, materialUrl: String(fd.get("materialUrl") ?? "").trim() || null }, u);
      await audit({ action: "training.assign", userId: u.id, userName: u.name, details: `${type} to ${ids.length}` });
      revalidatePath("/compliance/training");
      const bits = [`${r.assigned} assigned, ${r.emailed} emailed`];
      if (r.problems.length) bits.push(r.problems.join(" "));
      redirect("/compliance/training?ok=" + encodeURIComponent(bits.join(". ")));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/compliance/training?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not assign that."));
    }
  }

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
                          <div className="mt-0.5 text-xs text-ink-3">
                            {fmt(last.completedOn)}
                            {/* Who stood behind the record. A signature from the person is
                                stronger than the PIC's word for it, and both are legitimate, so
                                the difference is shown rather than hidden. */}
                            {last.provider === "Signed online" && <span className="ml-1 text-emerald-700">signed</span>}
                            {last.provider?.startsWith("In-house") && <span className="ml-1">PIC attested</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Assign, so the person does it and signs it themselves ── */}
          <section className="mt-8 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold">Assign training</h2>
            <p className="mt-1 text-xs text-ink-3">
              Each person gets a link by email. They work through it, read what they are confirming, and type their
              name. That signature — with the time, the device and the exact wording — is the record. It is stronger
              evidence than you entering it on their behalf, because it comes from them.
            </p>
            {!mailReady && (
              <Notice kind="warn">
                Email is not set up, so links cannot be sent. Settings → Email first.
              </Notice>
            )}
            <form action={assign} className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs text-ink-3">
                  Training
                  <select name="type" className="field">
                    {TRAINING_TYPES.filter((t) => STATEMENTS[t]).map((t) => (
                      <option key={t} value={t}>{TRAINING_LABEL[t]}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-ink-3">
                  Due by
                  <input type="date" name="dueOn" className="field" />
                </label>
                <label className="text-xs text-ink-3">
                  Link to the material (optional)
                  <input name="materialUrl" className="field" placeholder="https://..." />
                </label>
              </div>
              <fieldset>
                <legend className="text-xs text-ink-3">Who</legend>
                <div className="mt-1 flex flex-wrap gap-3">
                  {people.map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" name="personIds" value={p.id} defaultChecked />
                      {p.firstName} {p.lastName}
                      {!p.email && <span className="text-xs text-warn">no email</span>}
                    </label>
                  ))}
                </div>
              </fieldset>
              <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Assign and send</button>
            </form>
          </section>

          {outstanding.length > 0 && (
            <>
              <h2 className="mt-8 text-sm font-semibold">Waiting on staff</h2>
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface text-sm">
                {outstanding.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div>
                      <b>{a.person ? `${a.person.firstName} ${a.person.lastName}` : "—"}</b> · {TRAINING_LABEL[a.type]}
                      <div className="text-xs text-ink-3">
                        due {fmt(a.dueOn)}
                        {a.sentAt ? ` · sent ${fmt(a.sentAt.slice(0, 10))}` : " · not sent"}
                        {a.remindersSent > 0 && ` · ${a.remindersSent} reminder${a.remindersSent === 1 ? "" : "s"}`}
                        {a.sendError && <span className="text-warn"> · {a.sendError}</span>}
                      </div>
                    </div>
                    <span className={`badge ${daysUntil(a.dueOn)! < 0 ? "badge-crit" : "badge-warn"}`}>
                      {daysUntil(a.dueOn)! < 0 ? `${Math.abs(daysUntil(a.dueOn)!)}d late` : `${daysUntil(a.dueOn)}d`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <section className="mt-8 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold">Record a completion yourself</h2>
            <p className="mt-1 text-xs text-ink-3">
              For training done on paper or elsewhere. Upload the certificate — a completion with no evidence behind
              it is worth very little at inspection.
            </p>
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
