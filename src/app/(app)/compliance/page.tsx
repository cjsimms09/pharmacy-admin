import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { dueList, type DueItem } from "@/lib/due";
import { obligationsWithStatus, completeObligation } from "@/lib/obligations";
import { todayIso, fmt } from "@/lib/dates";
import { storeFile } from "@/lib/files";
import { newId } from "@/lib/crypto";
import { PageHeader, Notice, Empty } from "@/components/ui";

export const metadata = { title: "Compliance" };
export const dynamic = "force-dynamic";

export default async function CompliancePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; show?: string }> }) {
  await requireUser();
  const { ok, error, show } = await searchParams;
  const [items, obligations] = await Promise.all([dueList({ horizonDays: show === "all" ? 3650 : 120 }), obligationsWithStatus()]);

  const overdue = items.filter((i) => i.severity === "overdue");
  const soon = items.filter((i) => i.severity === "due_soon");
  const missing = items.filter((i) => i.severity === "no_date");
  const later = items.filter((i) => i.severity === "upcoming");

  async function signOff(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const completedOn = String(fd.get("completedOn") ?? "") || todayIso();
    const notes = String(fd.get("notes") ?? "").trim() || null;

    let documentId: string | null = null;
    const file = fd.get("file");
    if (file instanceof File && file.size > 0) {
      const stored = await storeFile(file, { allowReportTypes: true });
      documentId = newId();
      const o = await db.query.obligations.findFirst({ where: eq(schema.obligations.id, id) });
      await db.insert(schema.documents).values({
        id: documentId,
        category: "policy",
        title: `${o?.title ?? "Compliance"} — ${completedOn}`,
        fileName: file.name,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storageKey: stored.storageKey,
        effectiveOn: completedOn,
        uploadedBy: u.id,
      });
    }

    try {
      await completeObligation(id, completedOn, u.name, notes, documentId);
      await audit({ action: "obligation.complete", userId: u.id, userName: u.name, details: id });
      revalidatePath("/compliance");
      redirect("/compliance?ok=" + encodeURIComponent("Signed off."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/compliance?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
    }
  }

  async function switchOff(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    await db.update(schema.obligations).set({ active: false, needsConfirmation: false, updatedAt: new Date().toISOString() }).where(eq(schema.obligations.id, id));
    await audit({ action: "obligation.disable", userId: u.id, userName: u.name, details: id });
    revalidatePath("/compliance");
    redirect("/compliance?ok=" + encodeURIComponent("Switched off. It will not be chased again."));
  }

  return (
    <>
      <PageHeader
        title="Compliance"
        subtitle="Everything the pharmacy owes — licences, training and recurring duties — in one list, worst first."
        actions={<Link href="/compliance/training" className="btn">Training register</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Overdue" value={String(overdue.length)} tone={overdue.length ? "crit" : "ok"} />
        <Stat label="Due soon" value={String(soon.length)} tone={soon.length ? "warn" : "ok"} />
        <Stat label="Nothing on file" value={String(missing.length)} tone={missing.length ? "warn" : "ok"} />
        <Stat label="Later" value={String(later.length)} />
      </div>

      <Section title="Overdue" items={overdue} empty="Nothing is overdue." />
      <Section title="Due in the next 120 days" items={soon} empty="Nothing falls due soon." />
      <Section
        title="No record, or no date"
        items={missing}
        empty="Every requirement has a record and a date."
        note="These are the ones that pass a date check while being the least compliant: a requirement with no record at all, or a record whose expiry nobody entered."
      />

      {show === "all" ? (
        <Section title="Everything else" items={later} empty="Nothing further scheduled." />
      ) : (
        later.length > 0 && (
          <p className="mt-4 text-sm">
            <Link href="/compliance?show=all" className="underline">Show the {later.length} further out</Link>
          </p>
        )
      )}

      {/* ── Sign-off ── */}
      <h2 className="mt-10 text-base font-semibold">Recurring duties</h2>
      <p className="mb-3 text-xs text-ink-3">
        Signing one off records who did it and when, files the evidence, and schedules the next one automatically.
      </p>
      <div className="space-y-3">
        {obligations.map(({ obligation: o, overdue: isLate }) => (
          <div key={o.id} className={`rounded-lg border p-4 ${isLate ? "border-red-300 bg-red-50" : "border-line bg-surface"}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{o.title}</h3>
                {o.citation && <div className="text-xs text-ink-3">{o.citation}</div>}
              </div>
              <div className="text-right text-xs">
                <div className={isLate ? "font-medium text-red-700" : ""}>{o.dueOn ? `Due ${fmt(o.dueOn)}` : "As needed"}</div>
                <div className="text-ink-3 capitalize">{o.cadence.replace(/_/g, " ")}</div>
              </div>
            </div>
            {o.detail && <p className="mt-2 text-sm text-ink-2">{o.detail}</p>}
            {o.lastCompletedOn && (
              <p className="mt-1 text-xs text-ink-3">Last done {fmt(o.lastCompletedOn)} by {o.lastCompletedBy}.</p>
            )}
            {o.needsConfirmation && (
              <Notice kind="warn">
                Seeded as a question, not a deadline — confirm whether this applies to this pharmacy before treating it
                as due.
              </Notice>
            )}

            <details className="mt-3">
              <summary className="cursor-pointer text-sm underline">Sign off</summary>
              <form action={signOff} className="mt-3 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={o.id} />
                <label className="text-xs text-ink-3">
                  Date completed
                  <input type="date" name="completedOn" defaultValue={todayIso()} className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" />
                </label>
                <label className="text-xs text-ink-3">
                  Evidence (optional)
                  <input type="file" name="file" className="mt-1 w-full text-sm text-ink" />
                </label>
                <label className="text-xs text-ink-3 sm:col-span-2">
                  Notes
                  <input name="notes" placeholder="What was done, and anything worth remembering next time" className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" />
                </label>
                <div className="sm:col-span-2">
                  <button className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">Record</button>
                </div>
              </form>
            </details>

            <form action={switchOff} className="mt-2">
              <input type="hidden" name="id" value={o.id} />
              <button className="text-xs text-ink-3 underline hover:text-ink">This does not apply to us — stop chasing it</button>
            </form>
          </div>
        ))}
      </div>
    </>
  );
}

function Section({ title, items, empty, note }: { title: string; items: DueItem[]; empty: string; note?: string }) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold">{title}</h2>
      {note && <p className="mb-2 mt-1 text-xs text-ink-3">{note}</p>}
      {items.length === 0 ? (
        <div className="mt-2"><Empty>{empty}</Empty></div>
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <Link href={i.href} className="text-sm font-medium underline">{i.title}</Link>
                <div className="mt-0.5 text-xs text-ink-3">{i.action}</div>
                {i.citation && <div className="text-xs text-ink-3">{i.citation}</div>}
              </div>
              <div className="whitespace-nowrap text-right text-xs">
                {i.dueOn ? (
                  <>
                    <div className={i.severity === "overdue" ? "font-medium text-red-700" : ""}>
                      {i.daysLeft !== null && i.daysLeft < 0 ? `${Math.abs(i.daysLeft)} days late` : `${i.daysLeft} days`}
                    </div>
                    <div className="text-ink-3">{fmt(i.dueOn)}</div>
                  </>
                ) : (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">no date</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "ok" | "crit" }) {
  const c = tone === "crit" ? "border-red-300 bg-red-50" : tone === "warn" ? "border-amber-300 bg-amber-50" : tone === "ok" ? "border-emerald-300 bg-emerald-50" : "border-line bg-surface";
  return (
    <div className={`rounded-lg border p-3 ${c}`}>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  );
}
