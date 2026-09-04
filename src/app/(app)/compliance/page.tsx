import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { complianceSummary, type OpenItem, type Unanswered } from "@/lib/compliance-status";
import { attestAction, answerAction } from "../_actions/compliance";
import { periodLabel } from "@/lib/periods";
import { dueList } from "@/lib/due";
import { assignTraining, recordGroupTraining } from "@/lib/training-assignments";
import { TRAINING_LABEL } from "@/lib/labels";
import type { TrainingType } from "@/db/schema";
import { fmt, todayIso } from "@/lib/dates";
import { storeFile } from "@/lib/files";
import { newId } from "@/lib/crypto";
import { PageHeader, Notice } from "@/components/ui";
import { AttestForm } from "@/components/attest-form";

export const metadata = { title: "Compliance" };
export const dynamic = "force-dynamic";

export default async function CompliancePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; all?: string }> }) {
  const user = await requireUser();
  const { ok, error, all } = await searchParams;
  const [summary, expiring] = await Promise.all([complianceSummary(), dueList({ horizonDays: 60 })]);

  // Credentials and training are their own thing; only what is actually late or missing belongs
  // on this screen, and everything else waits until it is close enough to matter.
  const people = expiring.filter((e) => e.severity === "overdue" || e.severity === "no_date" || (e.daysLeft ?? 999) <= 45);
  // Only what is actually late. A duty for the month we are still in is not overdue and must not
  // be shown as though it were — being told on the third of the month that the month is not
  // finished is how a screen earns the right to be ignored. The current period is offered
  // separately, quietly, for anyone who wants to get ahead.
  const needsAction = [...summary.missed, ...summary.partial];
  const shown = needsAction;
  const notYetDue = summary.openNow;
  const clean = needsAction.length === 0 && people.length === 0;

  async function assignFromList(fd: FormData) {
    "use server";
    const u = await requireManager();
    const type = String(fd.get("trainingType") ?? "") as TrainingType;
    const ids = String(fd.get("personIds") ?? "").split(",").filter(Boolean);
    try {
      const r = await assignTraining(ids, type, {}, u);
      await audit({ action: "training.assign", userId: u.id, userName: u.name, details: `${type} to ${ids.length}` });
      revalidatePath("/compliance");
      const bits = [`${TRAINING_LABEL[type]}: ${r.emailed} link${r.emailed === 1 ? "" : "s"} sent`];
      if (r.problems.length) bits.push(r.problems.join(" "));
      redirect("/compliance?ok=" + encodeURIComponent(bits.join(". ")));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/compliance?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not assign that."));
    }
  }

  async function attestTraining(fd: FormData) {
    "use server";
    const u = await requireManager();
    const type = String(fd.get("trainingType") ?? "") as TrainingType;
    const ids = String(fd.get("personIds") ?? "").split(",").filter(Boolean);
    try {
      const r = await recordGroupTraining(ids, type, u, { how: String(fd.get("how") ?? "") });
      await audit({ action: "training.attest", userId: u.id, userName: u.name, details: `${type} for ${r.recorded}` });
      revalidatePath("/compliance");
      revalidatePath("/compliance/training");
      redirect("/compliance?ok=" + encodeURIComponent(`Recorded for ${r.names.join(", ")}.`));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/compliance?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
    }
  }

  async function fileEvidence(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("obligationId") ?? "");
    const periodKey = String(fd.get("periodKey") ?? "");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) redirect("/compliance?error=" + encodeURIComponent("Choose a file."));
    const o = await db.query.obligations.findFirst({ where: eq(schema.obligations.id, id) });
    const stored = await storeFile(file, { allowReportTypes: true });
    const docId = newId();
    await db.insert(schema.documents).values({
      id: docId,
      category: "policy",
      title: `${o?.title ?? "Compliance"} — ${periodLabel(periodKey)}`,
      fileName: file.name,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      effectiveOn: todayIso(),
      uploadedBy: u.id,
    });
    await db.insert(schema.obligationCompletions).values({
      id: newId(),
      obligationId: id,
      periodKey,
      completedOn: todayIso(),
      completedBy: u.name,
      statement: `${file.name} filed as evidence for ${periodLabel(periodKey)}.`,
      documentId: docId,
    });
    await audit({ action: "compliance.evidence", userId: u.id, userName: u.name, details: `${id} ${periodKey} ${file.name}` });
    revalidatePath("/compliance");
    redirect("/compliance?ok=" + encodeURIComponent(`Filed for ${periodLabel(periodKey)}.`));
  }

  return (
    <>
      <PageHeader
        title="Compliance"
        subtitle={
          clean
            ? "Nothing outstanding."
            : `${needsAction.length + people.length} thing${needsAction.length + people.length === 1 ? "" : "s"} need you.`
        }
        actions={
          <>
            <Link href="/compliance/attestations" className="btn">What I have signed</Link>
            <Link href="/compliance/register" className="btn">Full register</Link>
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {clean ? (
        <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-6">
          <h2 className="text-lg font-semibold text-emerald-900">You are clean.</h2>
          <p className="mt-1 text-sm text-emerald-900">
            Every period is covered, every licence is current, and nothing is due in the next 45 days. The register
            holds the detail if you need to show someone.
          </p>
        </section>
      ) : (
        <>
          {summary.missed.length > 0 && (
            <p className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
              <b>{summary.missed.length} period{summary.missed.length === 1 ? "" : "s"} went by without being covered.</b>{" "}
              Those do not become fine because a later one was done — they are what an inspector finds. Closing one now
              records the date it was actually done, which is honest and still better than a gap.
            </p>
          )}

          <div className="space-y-3">
            {shown.map((i) => (
              <Item key={`${i.obligationId}-${i.periodKey}`} i={i} attestAction={attestAction} fileAction={fileEvidence} signerName={user.name} />
            ))}

            {people.map((p) => (
              <article key={p.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">{p.title}</h3>
                    {/* For a training this is what the training actually covers, which is the
                        question anyone asks first when a requirement they did not set appears. */}
                    {p.citation && <p className="mt-0.5 text-xs text-ink-3">{p.citation}</p>}
                    <p className="mt-1 text-sm text-ink-2">{p.action}</p>
                  </div>
                  <Badge state={p.severity === "overdue" ? "missed" : p.severity === "no_date" ? "partial" : "open"}>
                    {p.daysLeft === null ? "nothing on file" : p.daysLeft < 0 ? `${Math.abs(p.daysLeft)} days late` : `${p.daysLeft} days`}
                  </Badge>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {p.trainingType && p.personIds && p.personIds.length > 0 ? (
                    <>
                      <form action={assignFromList}>
                        <input type="hidden" name="trainingType" value={p.trainingType} />
                        <input type="hidden" name="personIds" value={p.personIds.join(",")} />
                        <button className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">
                          Send it to {p.personIds.length === 1 ? "them" : `all ${p.personIds.length}`}
                        </button>
                      </form>
                      <details className="w-full">
                        <summary className="cursor-pointer text-sm underline">or I trained them myself</summary>
                        <form action={attestTraining} className="mt-2 rounded-md border border-line bg-ground p-3">
                          <input type="hidden" name="trainingType" value={p.trainingType} />
                          <input type="hidden" name="personIds" value={p.personIds.join(",")} />
                          <p className="text-xs text-ink-2">
                            Records that you delivered this and that each of them understood it. It says so in those
                            words, and that they did not sign individually — an inspector can tell the two kinds of
                            record apart, which is what keeps both of them worth having.
                          </p>
                          <input
                            name="how"
                            placeholder="Optional: how it was done — a staff meeting, one to one, the vendor's slides"
                            className="mt-2 w-full rounded-md border border-line px-2 py-1.5 text-sm"
                          />
                          <button className="mt-2 rounded-md bg-ink px-3 py-1.5 text-sm text-white">
                            Record it for {p.personIds.length === 1 ? "them" : `all ${p.personIds.length}`}
                          </button>
                        </form>
                      </details>
                    </>
                  ) : (
                    <Link href={p.href} className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">Open</Link>
                  )}
                </div>
              </article>
            ))}
          </div>


        </>
      )}

      {summary.unanswered.length > 0 && (
        <section className="mt-8 rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">Does this apply here?</h2>
          <p className="mt-1 text-xs text-ink-3">
            {summary.unanswered.length} duty{summary.unanswered.length === 1 ? "" : " duties"} shipped switched on because
            leaving out a rule that does apply is the expensive mistake. Answer once and it is settled — a &ldquo;no&rdquo;
            is recorded with today&rsquo;s date and your name, so the register shows it was considered rather than missed.
            Nothing here is counting against you in the meantime.
          </p>
          <div className="mt-3 space-y-2">
            {summary.unanswered.map((q) => (
              <Question key={q.obligationId} q={q} action={answerAction} />
            ))}
          </div>
        </section>
      )}

      {notYetDue.length > 0 && (
        <details className="mt-8" open={all === "1"}>
          <summary className="cursor-pointer text-sm text-ink-2">
            {notYetDue.length} thing{notYetDue.length === 1 ? "" : "s"} for the current period — not due yet
          </summary>
          <p className="mt-1 text-xs text-ink-3">
            These become due when the period ends. Nothing here is late, and nothing here will be counted against you
            until then — but a five-minute job is often easier done now than remembered later.
          </p>
          <div className="mt-3 space-y-3">
            {notYetDue.map((i) => (
              <Item key={`${i.obligationId}-${i.periodKey}`} i={i} attestAction={attestAction} fileAction={fileEvidence} signerName={user.name} />
            ))}
          </div>
        </details>
      )}

      <p className="mt-8 text-xs text-ink-3">
        Signed in as {user.name}. Every attestation records who made it, when, and the exact words agreed to.
      </p>
    </>
  );
}

/**
 * One outstanding thing, with its closure attached.
 *
 * The action lives on the item rather than behind a link, because the whole point is that a
 * thirty-second duty should take thirty seconds. Sending someone to another page to tick
 * something is how a five-minute job becomes one that waits a fortnight.
 */
function Item({
  i,
  attestAction,
  fileAction,
  signerName,
}: {
  i: OpenItem;
  attestAction: (fd: FormData) => Promise<void>;
  fileAction: (fd: FormData) => Promise<void>;
  signerName: string;
}) {
  const border = i.state === "missed" ? "border-red-300 bg-red-50" : i.state === "partial" ? "border-amber-300 bg-amber-50" : "border-line bg-surface";
  return (
    <article className={`rounded-lg border p-4 ${border}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{i.title}</h3>
          <div className="mt-0.5 text-xs text-ink-3">
            {i.periodLabel}
            {i.expected > 1 && ` · ${i.have} of ${i.expected} filed`}
            {i.minutes !== null && ` · about ${i.minutes} min`}
            {i.citation && ` · ${i.citation}`}
          </div>
        </div>
        <Badge state={i.state}>
          {i.state === "missed" ? `${i.daysLate} days late` : i.state === "partial" ? "part done" : `due ${fmt(i.dueOn)}`}
        </Badge>
      </div>

      {/* ── attest: the sentence, then the two acts that make it a signature ── */}
      {i.kind === "attest" && i.statement && (
        <AttestForm
          action={attestAction}
          obligationId={i.obligationId}
          periodKey={i.periodKey}
          statement={i.statement}
          back="/compliance"
          defaultName={signerName}
          minutes={i.minutes}
        />
      )}

      {/* ── evidence: upload where it stands ── */}
      {i.kind === "evidence" && (
        <form action={fileAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="obligationId" value={i.obligationId} />
          <input type="hidden" name="periodKey" value={i.periodKey} />
          <input type="file" name="file" className="text-sm" />
          <button className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">File it</button>
          {i.detail && <span className="w-full text-xs text-ink-3">{i.detail}</span>}
        </form>
      )}

      {/* ── witnessed: nothing to tick, only somewhere to go ── */}
      {i.kind === "witnessed" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {i.missing && <span className="text-sm text-ink-2">{i.missing}</span>}
          {i.href && <Link href={i.href} className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">Go and do it</Link>}
          <span className="text-xs text-ink-3">This closes itself once done — there is nothing here to tick.</span>
        </div>
      )}

      {i.kind === "renewal" && i.href && (
        <Link href={i.href} className="mt-3 inline-block rounded-md bg-ink px-3 py-1.5 text-sm text-white">Open</Link>
      )}
    </article>
  );
}

/**
 * One duty that is still a question, with both answers on it.
 *
 * Two buttons, not a checkbox: "not applicable" is a decision a PIC should be able to point at
 * later, and a thing that quietly disappears when unticked cannot be pointed at.
 */
function Question({ q, action }: { q: Unanswered; action: (fd: FormData) => Promise<void> }) {
  return (
    <article className="rounded-md border border-line bg-ground p-3">
      <h3 className="text-sm font-medium">{q.title}</h3>
      {q.detail && <p className="mt-0.5 text-xs text-ink-2">{q.detail}</p>}
      {q.citation && <p className="mt-0.5 text-xs text-ink-3">{q.citation}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <form action={action}>
          <input type="hidden" name="obligationId" value={q.obligationId} />
          <input type="hidden" name="applies" value="yes" />
          <input type="hidden" name="back" value="/compliance" />
          <button className="btn btn-primary">Yes, we do this</button>
        </form>
        <form action={action}>
          <input type="hidden" name="obligationId" value={q.obligationId} />
          <input type="hidden" name="applies" value="no" />
          <input type="hidden" name="back" value="/compliance" />
          <button className="btn">Not us — switch it off</button>
        </form>
      </div>
    </article>
  );
}

function Badge({ state, children }: { state: "missed" | "partial" | "open" | "satisfied"; children: React.ReactNode }) {
  const c = state === "missed" ? "bg-red-100 text-red-800" : state === "partial" ? "bg-amber-100 text-amber-900" : "bg-ground text-ink-2";
  return <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${c}`}>{children}</span>;
}
