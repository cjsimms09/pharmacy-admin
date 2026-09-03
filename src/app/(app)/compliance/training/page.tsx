import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { TRAINING_CADENCE, addMonths } from "@/lib/due";
import { TRAINING_LABEL, TRAINING_SHORT, PERSON_ROLE_LABEL } from "@/lib/labels";
import { type TrainingType } from "@/db/schema";
import { todayIso, fmt, daysUntil } from "@/lib/dates";
import { storeFile } from "@/lib/files";
import { newId } from "@/lib/crypto";
import { PageHeader, Notice, Empty, Card, Figure } from "@/components/ui";
import {
  assignTraining,
  sendOutstanding,
  openAssignments,
  recordGroupTraining,
  linkFor,
} from "@/lib/training-assignments";
import { REPLY_PHRASE } from "@/lib/training-replies";
import { courseFor } from "@/lib/courses";
import { canSend } from "@/lib/send-mail";
import { onSiteToday } from "@/lib/roster";

export const metadata = { title: "Training" };
export const dynamic = "force-dynamic";

/**
 * One screen for the whole of training.
 *
 * The previous version was a register — it told you the state of the world and left you to go
 * somewhere else to change it. That is the pattern that makes a compliance system take ten
 * clicks and three guesses to do one thing. Here the grid that shows who owes what is the same
 * grid you tick to send it, the outstanding list carries the buttons that chase or close it, and
 * the certificates are on the same page as the completions they belong to.
 */

const REQUIRED = Object.keys(TRAINING_CADENCE) as TrainingType[];

export default async function TrainingPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser();
  const { ok, error } = await searchParams;
  const [assignments, mailReady, people, trainings] = await Promise.all([
    openAssignments(),
    canSend(),
    onSiteToday(),
    db.query.trainings.findMany({ orderBy: (t, { desc }) => [desc(t.completedOn)] }),
  ]);
  const outstanding = assignments.filter((a) => !a.completedAt);
  // Resolved up front: linkFor reads a setting, and awaiting inside the table would mean one
  // lookup per row inside JSX, which is not allowed and would be wasteful if it were.
  const links = new Map(await Promise.all(outstanding.map(async (a) => [a.id, await linkFor(a.token)] as const)));
  const done = assignments.filter((a) => a.completedAt && a.trainingId);
  const today = todayIso();

  /**
   * Where one person stands on one requirement.
   *
   * Four states, and the distinction that matters most is between "they owe this" and "they owe
   * this and I have already sent it" — the whole question when looking at this grid is what is
   * left to do, and a screen that cannot tell you what you already sent makes you send it twice.
   */
  const state = (personId: string, type: TrainingType) => {
    const last = trainings.filter((x) => x.personId === personId && x.type === type)[0];
    const open = outstanding.find((a) => a.personId === personId && a.type === type);
    const sent = open
      ? {
          on: open.sentAt ? fmt(open.sentAt.slice(0, 10)) : null,
          reminders: open.remindersSent,
          error: open.sendError,
          code: open.replyCode,
        }
      : null;

    if (!last) return { label: "never", tone: "badge-crit", due: true, sent };
    const dueOn = last.expiresOn ?? addMonths(last.completedOn, TRAINING_CADENCE[type]?.months ?? 12);
    const left = daysUntil(dueOn)!;
    if (left < 0) return { label: `${-left}d late`, tone: "badge-crit", due: true, sent };
    if (left <= 45) return { label: `due ${dueOn.slice(5)}`, tone: "badge-warn", due: true, sent };
    return { label: dueOn.slice(5), tone: "badge-ok", due: false, sent };
  };

  const cells = people.flatMap((p) => REQUIRED.map((t) => ({ p, t, st: state(p.id, t) })));
  const owed = cells.filter((c) => c.st.due).length;
  const awaiting = cells.filter((c) => c.st.sent).length;
  const toSend = cells.filter((c) => c.st.due && !c.st.sent).length;
  const noEmail = people.filter((p) => !p.email).length;

  // ── actions ─────────────────────────────────────────────────────
  async function send(fd: FormData) {
    "use server";
    const u = await requireManager();
    const picks = fd.getAll("pick").map(String).filter(Boolean);
    if (picks.length === 0) {
      redirect("/compliance/training?error=" + encodeURIComponent("Nothing was ticked."));
    }
    const dueOn = String(fd.get("dueOn") ?? "") || undefined;
    const byType = new Map<TrainingType, string[]>();
    for (const p of picks) {
      const [personId, type] = p.split("|");
      if (!personId || !type) continue;
      byType.set(type as TrainingType, [...(byType.get(type as TrainingType) ?? []), personId]);
    }
    try {
      let assigned = 0;
      const problems: string[] = [];
      // Create every assignment first, then send once per person. Otherwise somebody with three
      // trainings gets three emails, and three emails is how all three get ignored.
      for (const [type, ids] of byType) {
        const r = await assignTraining(ids, type, { dueOn, email: false }, u);
        assigned += r.assigned;
        problems.push(...r.problems);
      }
      const everyone = [...new Set(picks.map((p) => p.split("|")[0]))];
      const sent = await sendOutstanding(everyone);
      problems.push(...sent.problems);
      await audit({ action: "training.assign", userId: u.id, userName: u.name, details: `${picks.length} picks` });
      revalidatePath("/compliance/training");
      revalidatePath("/compliance");
      revalidatePath("/");
      const bits = [
        `${assigned} assigned. ${sent.emailed} ${sent.emailed === 1 ? "person" : "people"} emailed — one email each, covering everything they owe.`,
      ];
      if (problems.length) bits.push(problems.join(" "));
      redirect("/compliance/training?ok=" + encodeURIComponent(bits.join(" ")));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/compliance/training?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not send that."));
    }
  }

  async function chase(fd: FormData) {
    "use server";
    const u = await requireManager();
    const personId = String(fd.get("personId") ?? "");
    const r = await sendOutstanding(personId ? [personId] : undefined);
    await audit({ action: "training.resend", userId: u.id, userName: u.name, details: personId || "everyone" });
    revalidatePath("/compliance/training");
    const msg = r.emailed > 0 ? `Sent again to ${r.emailed} ${r.emailed === 1 ? "person" : "people"}.` : "Nothing to send.";
    redirect(`/compliance/training?${r.problems.length ? "error" : "ok"}=` + encodeURIComponent([msg, ...r.problems].join(" ")));
  }

  async function attestGroup(fd: FormData) {
    "use server";
    const u = await requireManager();
    const type = String(fd.get("type") ?? "") as TrainingType;
    const ids = fd.getAll("personIds").map(String).filter(Boolean);
    try {
      const r = await recordGroupTraining(ids, type, u, { how: String(fd.get("how") ?? "") });
      await audit({ action: "training.attest", userId: u.id, userName: u.name, details: `${type} for ${r.recorded}` });
      revalidatePath("/compliance/training");
      revalidatePath("/compliance");
      revalidatePath("/");
      redirect("/compliance/training?ok=" + encodeURIComponent(`Recorded for ${r.names.join(", ")}.`));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/compliance/training?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
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
        category: "training_record",
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
      createdBy: u.name,
    });
    await audit({ action: "training.record", userId: u.id, userName: u.name, details: `${type} for ${personId} on ${completedOn}` });
    revalidatePath("/compliance/training");
    revalidatePath("/compliance");
    revalidatePath("/");
    redirect("/compliance/training?ok=" + encodeURIComponent("Recorded."));
  }

  if (people.length === 0) {
    return (
      <>
        <PageHeader back={{ href: "/compliance", label: "Compliance" }} title="Training" />
        <Empty>No active staff. <Link href="/staff/new" className="underline">Add someone first.</Link></Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        back={{ href: "/compliance", label: "Compliance" }}
        title="Training"
        subtitle={
          owed === 0
            ? "Everyone is current on everything."
            : `${owed} training${owed === 1 ? "" : "s"} due or overdue across ${people.length} ${people.length === 1 ? "person" : "people"}.`
        }
        actions={
          outstanding.length > 0 ? (
            <form action={chase}>
              <button className="btn">Chase all {outstanding.length} outstanding</button>
            </form>
          ) : undefined
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}
      {!mailReady && (
        <Notice kind="warn">
          Email is not set up, so nothing can be sent. <Link href="/settings/email" className="underline">Set it up</Link> —
          until then, the only route is recording training you delivered yourself.
        </Notice>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={toSend} label="Still to send" sub={toSend === 0 ? "Nothing waiting to go out" : "Ticked below and ready"} tone={toSend === 0 ? "ok" : "crit"} />
        <Figure value={awaiting} label="Sent, not back" sub={awaiting === 0 ? "Nobody owes you a reply" : "Chased weekly on their own"} tone={awaiting === 0 ? "ok" : "warn"} />
        <Figure value={done.length} label="Completed" sub="Each has a certificate" tone="ok" />
        <Figure
          value={noEmail}
          label="Missing an email"
          sub={noEmail === 0 ? "Everyone can be reached" : "They cannot be sent anything"}
          tone={noEmail === 0 ? "ok" : "crit"}
        />
      </div>

      {/* ── Tick and send. The grid that shows the gap is the grid that closes it. ── */}
      <form action={send}>
        <Card
          title="Who needs what"
          count={`${toSend} to send`}
          subtitle="Anything due and not yet sent is ticked. Something already sent is not ticked again — tick it only to send a duplicate. Click a column heading to read the course and see exactly what gets attached to their email."
          className="mb-6"
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  {REQUIRED.map((t) => (
                    <th key={t} className="whitespace-nowrap" title={TRAINING_LABEL[t]}>
                      {courseFor(t) ? (
                        <Link href={`/compliance/training/course/${t}`} className="text-accent hover:underline">
                          {TRAINING_SHORT[t]}
                        </Link>
                      ) : (
                        TRAINING_SHORT[t]
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} className="align-top">
                    <td className="whitespace-nowrap">
                      <Link href={`/staff/${p.id}`} className="font-medium text-accent hover:underline">
                        {p.firstName} {p.lastName}
                      </Link>
                      <div className="text-xs text-ink-3">
                        {PERSON_ROLE_LABEL[p.role as keyof typeof PERSON_ROLE_LABEL] ?? p.role}
                        {!p.email && <span className="text-crit"> · no email on file</span>}
                      </div>
                    </td>
                    {REQUIRED.map((t) => {
                      const st = state(p.id, t);
                      // Three visually distinct states, because the only question asked of this
                      // grid is what is left to do: current, owed and not yet sent, owed and
                      // waiting on them.
                      return (
                        <td key={t}>
                          {st.sent ? (
                            <div>
                              <span className="badge badge-muted">sent{st.sent.on ? ` ${st.sent.on}` : ""}</span>
                              <div className="mt-1 text-[11px] leading-tight text-ink-3">
                                {st.sent.error ? (
                                  <span className="text-crit">{st.sent.error}</span>
                                ) : (
                                  <>
                                    {st.sent.reminders > 0 ? `${st.sent.reminders} reminder${st.sent.reminders === 1 ? "" : "s"}` : "awaiting them"}
                                    {st.sent.code && <span className="ml-1 font-mono">{st.sent.code}</span>}
                                  </>
                                )}
                              </div>
                              <label className="mt-1 flex items-center gap-1 text-[11px] text-ink-3">
                                <input type="checkbox" name="pick" value={`${p.id}|${t}`} /> resend
                              </label>
                            </div>
                          ) : st.due ? (
                            <label className="flex cursor-pointer items-center gap-1.5">
                              <input type="checkbox" name="pick" value={`${p.id}|${t}`} defaultChecked />
                              <span className={`badge ${st.tone}`}>{st.label}</span>
                            </label>
                          ) : (
                            <span className={`badge ${st.tone}`} title="Current — nothing to do">{st.label}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <label className="text-sm">
              Due by
              <input type="date" name="dueOn" defaultValue={addMonths(today, 1)} className="field ml-2 w-auto" />
            </label>
            <button className="btn btn-primary" disabled={!mailReady}>
              Send {toSend > 0 ? `the ${toSend} ticked` : "what is ticked"}
            </button>
            <p className="text-xs text-ink-3">
              One email per person covering everything ticked for them, with the course attached. They complete it on
              their phone, or reply to the email.
            </p>
          </div>
        </Card>
      </form>

      {/* ── What is out and not back ── */}
      {outstanding.length > 0 && (
        <section className="card mb-6">
          <h2 className="mb-3 font-semibold">Sent and waiting ({outstanding.length})</h2>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Person</th><th>Training</th><th>Due</th><th>Sent</th><th>Reply code</th><th>Link</th></tr>
              </thead>
              <tbody>
                {outstanding.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap">{a.person ? `${a.person.firstName} ${a.person.lastName}` : "—"}</td>
                    <td>{TRAINING_LABEL[a.type]}</td>
                    <td className="whitespace-nowrap">
                      {fmt(a.dueOn)}
                      {a.dueOn < today && <span className="badge badge-crit ml-2">late</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs text-ink-2">
                      {a.sentAt ? fmt(a.sentAt.slice(0, 10)) : <span className="text-crit">not sent</span>}
                      {a.remindersSent > 0 && ` · ${a.remindersSent} reminder${a.remindersSent === 1 ? "" : "s"}`}
                      {a.sendError && <div className="text-crit">{a.sendError}</div>}
                    </td>
                    <td className="font-mono text-xs">{a.replyCode ?? "—"}</td>
                    <td className="text-xs">
                      <a href={links.get(a.id)} className="text-accent hover:underline" target="_blank" rel="noreferrer">open</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-3">
            Reminders go out weekly on their own and stop after four, at which point you are emailed instead — another
            email is not what is missing by then.
          </p>
        </section>
      )}

      {/* ── The two other ways it gets done ── */}
      <section className="card mb-6">
        <h2 className="font-semibold">If they did it another way</h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <details className="rounded-md border border-line bg-ground p-3">
            <summary className="cursor-pointer text-sm font-medium">I trained them myself</summary>
            <form action={attestGroup} className="mt-3 space-y-3">
              <label className="block text-sm">
                Training
                <select name="type" className="field mt-1">
                  {REQUIRED.map((t) => <option key={t} value={t}>{TRAINING_LABEL[t]}</option>)}
                </select>
              </label>
              <fieldset className="text-sm">
                <legend className="mb-1">Who was there</legend>
                <div className="space-y-1">
                  {people.map((p) => (
                    <label key={p.id} className="flex items-center gap-2">
                      <input type="checkbox" name="personIds" value={p.id} />
                      {p.firstName} {p.lastName}
                    </label>
                  ))}
                </div>
              </fieldset>
              <input name="how" placeholder="How it was done — a staff meeting, one to one, the vendor's slides" className="field" />
              <p className="text-xs text-ink-3">
                This records that you delivered it and that each of them understood it — in those words, and that they
                did not sign individually. An inspector can tell the two kinds of record apart, which is what keeps
                both of them worth having.
              </p>
              <button className="btn">Record it</button>
            </form>
          </details>

          <details className="rounded-md border border-line bg-ground p-3">
            <summary className="cursor-pointer text-sm font-medium">They did an outside course — file the certificate</summary>
            <form action={record} className="mt-3 space-y-3">
              <label className="block text-sm">
                Person
                <select name="personId" className="field mt-1">
                  {people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                </select>
              </label>
              <label className="block text-sm">
                Training
                <select name="type" className="field mt-1">
                  {REQUIRED.map((t) => <option key={t} value={t}>{TRAINING_LABEL[t]}</option>)}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  Completed on
                  <input type="date" name="completedOn" defaultValue={today} className="field mt-1" />
                </label>
                <label className="block text-sm">
                  Provider
                  <input name="provider" placeholder="CMS, the PSAO, a vendor" className="field mt-1" />
                </label>
              </div>
              <label className="block text-sm">
                Their certificate
                <input type="file" name="file" className="field mt-1" />
              </label>
              <button className="btn">File it</button>
            </form>
          </details>
        </div>
      </section>

      {/* ── How the email reply route works, stated once, where it is relevant ── */}
      <section className="card mb-6">
        <h2 className="font-semibold">Replying by email counts</h2>
        <p className="mt-1 text-sm text-ink-2">
          Every training email carries a code. If someone replies from their own address with the words{" "}
          <b>{REPLY_PHRASE}</b> and that code, the site files the reply as their attestation, records the training and
          produces their certificate — no action needed from you. One reply can close several at once, because quoting
          the original brings all the codes with it.
        </p>
        <p className="mt-2 text-xs text-ink-3">
          The link is the better record: it captures a typed signature, the time, the device, and that they answered
          the questions correctly. A reply records that they told you they did it, and the certificate says so on its
          face. Both are real; they are not identical, and a file where every record claims to be the stronger kind is
          the one that gets picked apart.
        </p>
      </section>

      {/* ── Certificates ── */}
      {done.length > 0 && (
        <section className="card">
          <h2 className="mb-3 font-semibold">Completed</h2>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Person</th><th>Training</th><th>Completed</th><th>How</th><th>Certificate</th></tr></thead>
              <tbody>
                {done.slice(0, 40).map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap">{a.person ? `${a.person.firstName} ${a.person.lastName}` : "—"}</td>
                    <td>{TRAINING_LABEL[a.type]}</td>
                    <td className="whitespace-nowrap">{fmt(a.completedAt!.slice(0, 10))}</td>
                    <td className="text-xs text-ink-2">
                      {a.completedVia === "email_reply"
                        ? `Email reply${a.replyFromAddress ? ` from ${a.replyFromAddress}` : ""}`
                        : a.completedVia === "pic_recorded"
                          ? "Recorded by the PIC"
                          : `Signed${a.quizTotal ? ` · ${a.quizCorrect}/${a.quizTotal} correct` : ""}`}
                    </td>
                    <td>
                      <Link href={`/certificates/${a.trainingId}`} className="text-accent hover:underline">open</Link>
                      {a.replyDocumentId && (
                        <>
                          {" · "}
                          <a href={`/files/${a.replyDocumentId}`} className="text-accent hover:underline" target="_blank" rel="noreferrer">
                            the reply
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
