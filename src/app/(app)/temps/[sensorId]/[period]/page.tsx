import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { monthSummary, availableMonths, syncReadings, hasCredentials, f } from "@/lib/imonnit";
import { periodLabel } from "@/lib/periods";
import { newId } from "@/lib/crypto";
import { PageHeader, Notice, BackLink, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Temperature log" };

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default async function TempLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ sensorId: string; period: string }>;
  searchParams: Promise<{ ok?: string; error?: string; all?: string }>;
}) {
  const user = await requireUser();
  const { sensorId, period } = await params;
  const { ok, error, all } = await searchParams;

  const [summary, months, readings, notes, connected] = await Promise.all([
    monthSummary(sensorId, period),
    availableMonths(sensorId),
    db.query.tempReadings.findMany({
      where: and(eq(schema.tempReadings.sensorId, sensorId), eq(schema.tempReadings.periodKey, period)),
      orderBy: (r, { asc }) => [asc(r.takenAt)],
    }),
    db.query.tempNotes.findMany({
      where: and(eq(schema.tempNotes.sensorId, sensorId), eq(schema.tempNotes.periodKey, period)),
      orderBy: (n, { asc }) => [asc(n.createdAt)],
    }),
    hasCredentials(),
  ]);
  if (!summary) notFound();

  const byReading = new Map(notes.filter((n) => n.readingId).map((n) => [n.readingId!, n]));
  const monthNotes = notes.filter((n) => !n.readingId);
  const excursions = readings.filter((r) => r.excursion);
  const unexplained = excursions.filter((r) => !byReading.has(r.id));

  // The whole month is a lot to scroll. Excursions and their neighbours are what anyone looks at.
  const interesting = new Set<string>();
  readings.forEach((r, i) => {
    if (!r.excursion) return;
    for (let k = Math.max(0, i - 2); k <= Math.min(readings.length - 1, i + 2); k++) interesting.add(readings[k].id);
  });
  const listed = all === "1" ? readings : readings.filter((r) => interesting.has(r.id));

  /**
   * Fetches this one month for this one sensor.
   *
   * The routine sync resumes from the last reading a sensor holds, which is right for keeping up
   * and useless for filling a hole behind it: a sensor added later, or one that missed a run,
   * stays permanently short of a month everything else has. This asks for the month itself.
   * Re-running it is harmless — a reading is keyed on the sensor and the instant it was taken.
   */
  async function backfillMonth() {
    "use server";
    const u = await requireManager();
    const [y, m] = period.split("-").map(Number);
    if (!y || !m) redirect(`/temps/${sensorId}/${period}?error=` + encodeURIComponent("That is not a month."));
    const from = `${period}-01`;
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const r = await syncReadings({ sensorIds: [sensorId], fromIso: from, toIso: to });
    await audit({ action: "temp.backfill", userId: u.id, userName: u.name, details: `${sensorId} ${period}` });
    revalidatePath(`/temps/${sensorId}/${period}`);
    revalidatePath("/temps");
    redirect(`/temps/${sensorId}/${period}?${r.readingsAdded > 0 ? "ok" : "error"}=` + encodeURIComponent(r.message));
  }

  async function addNote(fd: FormData) {
    "use server";
    const u = await requireManager();
    const note = String(fd.get("note") ?? "").trim();
    const readingId = String(fd.get("readingId") ?? "") || null;
    if (note.length < 5) redirect(`/temps/${sensorId}/${period}?error=` + encodeURIComponent("Write what happened — a note nobody can read is not an explanation."));
    await db.insert(schema.tempNotes).values({ id: newId(), sensorId, periodKey: period, readingId, note, writtenBy: u.name });
    await audit({ action: "temp.note", userId: u.id, userName: u.name, details: `${sensorId} ${period}` });
    revalidatePath(`/temps/${sensorId}/${period}`);
    redirect(`/temps/${sensorId}/${period}?ok=` + encodeURIComponent("Noted."));
  }

  async function signOff(fd: FormData) {
    "use server";
    const u = await requireManager();
    const note = String(fd.get("note") ?? "").trim();
    const s = await monthSummary(sensorId, period);
    if (s && !s.allExplained) {
      redirect(`/temps/${sensorId}/${period}?error=` + encodeURIComponent("Every out-of-range reading needs a note before the month can be signed off."));
    }
    await db.insert(schema.tempNotes).values({
      id: newId(),
      sensorId,
      periodKey: period,
      note:
        note ||
        `Reviewed by ${u.name}. ${s?.readings.toLocaleString() ?? 0} readings, ${s?.excursions ?? 0} out of range` +
          `${s && s.excursions > 0 ? ", each explained above" : ""}.`,
      reviewed: true,
      writtenBy: u.name,
    });
    await audit({ action: "temp.review", userId: u.id, userName: u.name, details: `${sensorId} ${period}` });
    revalidatePath(`/temps/${sensorId}/${period}`);
    revalidatePath("/compliance");
    redirect(`/temps/${sensorId}/${period}?ok=` + encodeURIComponent("Month signed off."));
  }

  return (
    <>
      <BackLink href="/temps">Temperatures</BackLink>
      <PageHeader
        title={`${summary.sensorName} — ${periodLabel(period)}`}
        subtitle={`Acceptable range ${f(summary.rangeMin)} to ${f(summary.rangeMax)}.`}
        actions={
          <>
            {connected && (
              <>
                <form action={backfillMonth}>
                  <button className="btn">Pull this month from iMonnit</button>
                </form>
                <Link href={`/temps/${sensorId}/${period}/check`} className="btn">Ask what iMonnit holds</Link>
              </>
            )}
            <Link href={`/temps/${sensorId}/${period}/print`} className="btn">Print this month</Link>
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {summary.readings === 0 ? (
        <Empty>
          No readings for this month.
          {connected
            ? " The routine sync only ever moves forward from the last reading a sensor holds, so a month behind that stays empty until it is asked for. Use “Pull this month from iMonnit” above."
            : " No iMonnit key is stored, so nothing is being pulled automatically."}
        </Empty>
      ) : (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Readings" value={summary.readings.toLocaleString()} />
            <Stat label="Lowest" value={f(summary.minTenthsF!)} tone={summary.minTenthsF! < summary.rangeMin ? "crit" : undefined} />
            <Stat label="Highest" value={f(summary.maxTenthsF!)} tone={summary.maxTenthsF! > summary.rangeMax ? "crit" : undefined} />
            <Stat
              label="Out of range"
              value={String(summary.excursions)}
              tone={summary.excursions === 0 ? "ok" : unexplained.length > 0 ? "crit" : "warn"}
            />
          </div>

          {unexplained.length > 0 && (
            <Notice kind="crit">
              {unexplained.length} out-of-range reading{unexplained.length === 1 ? " has" : "s have"} no note against
              {unexplained.length === 1 ? " it" : " them"}. A month with an unexplained excursion is the thing an
              inspector stops on — write what happened and what was done about it.
            </Notice>
          )}

          {/* ── The readings ── */}
          <h2 className="mt-6 text-sm font-semibold">
            Readings {all !== "1" && listed.length < readings.length && <span className="font-normal text-ink-3">· showing what went out of range</span>}
          </h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2 text-right">Reading</th>
                  <th className="px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((r) => {
                  const n = byReading.get(r.id);
                  return (
                    <tr key={r.id} className={`border-t border-line ${r.excursion ? "bg-red-50" : ""}`}>
                      <td className="px-3 py-2 whitespace-nowrap text-xs">{when(r.takenAt)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.excursion ? "font-semibold text-red-700" : ""}`}>
                        {f(r.valueTenthsF)}
                      </td>
                      <td className="px-3 py-2">
                        {n ? (
                          <span className="text-xs">{n.note} <span className="text-ink-3">— {n.writtenBy}</span></span>
                        ) : r.excursion ? (
                          <form action={addNote} className="flex flex-wrap gap-2">
                            <input type="hidden" name="readingId" value={r.id} />
                            <input name="note" placeholder="What happened, and what was done" className="min-w-56 flex-1 rounded-md border border-line px-2 py-1 text-sm" />
                            <button className="rounded-md border border-line px-2 py-1 text-xs hover:bg-ground">Save</button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {all !== "1" && listed.length < readings.length && (
            <p className="mt-2 text-sm">
              <Link href={`/temps/${sensorId}/${period}?all=1`} className="underline">
                Show all {readings.length.toLocaleString()} readings
              </Link>
            </p>
          )}

          {/* ── Sign the month off ── */}
          <h2 className="mt-8 text-sm font-semibold">Month review</h2>
          {monthNotes.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {monthNotes.map((n) => (
                <li key={n.id} className="rounded-md border border-line bg-surface px-3 py-2">
                  {n.reviewed && <span className="mr-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">signed off</span>}
                  {n.note}
                  <span className="text-xs text-ink-3"> — {n.writtenBy}, {new Date(n.createdAt).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          )}
          {!summary.reviewed && (
            <form action={signOff} className="mt-3 rounded-lg border border-line bg-surface p-4">
              <p className="text-sm text-ink-2">
                Signing off says you have looked at the month. Data on its own is not a temperature log — an
                unreviewed month of numbers is what an inspection treats as no record at all.
              </p>
              <input name="note" placeholder="Anything worth adding (optional)" className="mt-2 w-full rounded-md border border-line px-3 py-2 text-sm" />
              <button className="mt-2 rounded-md bg-ink px-3 py-2 text-sm text-white" disabled={!summary.allExplained}>
                Sign off {periodLabel(period)}
              </button>
              {!summary.allExplained && <p className="mt-1 text-xs text-ink-3">Explain the out-of-range readings first.</p>}
            </form>
          )}
        </>
      )}

      {months.length > 1 && (
        <p className="mt-8 text-xs text-ink-3">
          Other months:{" "}
          {months.filter((m) => m !== period).map((m) => (
            <Link key={m} href={`/temps/${sensorId}/${m}`} className="mr-2 underline">{periodLabel(m)}</Link>
          ))}
        </p>
      )}
      <p className="mt-2 text-xs text-ink-3">Signed in as {user.name}.</p>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "ok" | "crit" }) {
  const c = tone === "crit" ? "border-red-300 bg-red-50" : tone === "warn" ? "border-amber-300 bg-amber-50" : tone === "ok" ? "border-emerald-300 bg-emerald-50" : "border-line bg-surface";
  return (
    <div className={`rounded-lg border p-3 ${c}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  );
}
