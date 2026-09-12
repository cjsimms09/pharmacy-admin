import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { hasCredentials, saveCredentials, clearCredentials, discoverSensors, syncReadings, trackedSensors, monthSummary, diagnose, recentReadings, unexplainedExcursions, monthsBySensor, f,
  monthsAwaitingSignOff,
} from "@/lib/imonnit";
import { getSettings, setSetting } from "@/lib/settings";
import { periodLabel } from "@/lib/periods";
import { PageHeader, Notice, Empty, Field, Card, Figure } from "@/components/ui";
import { newId } from "@/lib/crypto";

export const metadata = { title: "Temperatures" };
export const dynamic = "force-dynamic";

export default async function TempsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; raw?: string }> }) {
  await requireUser();
  const { ok, error, raw } = await searchParams;
  const [connected, sensors, s] = await Promise.all([hasCredentials(), trackedSensors(), getSettings()]);
  const tracked = sensors.filter((x) => x.tracked);

  // This month and last, which is what anyone actually looks at.
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  const cards = await Promise.all(
    tracked.flatMap((sensor) => [lastMonth, thisMonth].map(async (p) => ({ sensor, summary: await monthSummary(sensor.id, p) }))),
  );

  // The three questions this page is actually asked, in the order they get asked: is anything
  // unexplained, what has it been doing lately, and where is the month I need to print.
  const [unexplained, latest, months, awaiting] = await Promise.all([
    unexplainedExcursions(),
    recentReadings(30),
    monthsBySensor(),
    monthsAwaitingSignOff(),
  ]);
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const readingsToday = latest.filter((r) => r.takenAt >= dayAgo).length;

  async function explain(fd: FormData) {
    "use server";
    const u = await requireManager();
    const readingId = String(fd.get("readingId") ?? "");
    const sensorId = String(fd.get("sensorId") ?? "");
    const periodKey = String(fd.get("periodKey") ?? "");
    const note = String(fd.get("note") ?? "").trim();
    if (note.length < 5) {
      redirect("/temps?error=" + encodeURIComponent("Write what happened — a note nobody can read is not an explanation."));
    }
    await db.insert(schema.tempNotes).values({ id: newId(), sensorId, periodKey, readingId, note, writtenBy: u.name });
    await audit({ action: "temp.note", userId: u.id, userName: u.name, details: `${sensorId} ${periodKey}` });
    revalidatePath("/temps");
    revalidatePath(`/temps/${sensorId}/${periodKey}`);
    revalidatePath("/compliance");
    revalidatePath("/");
    redirect("/temps?ok=" + encodeURIComponent("Noted."));
  }

  async function connect(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      await saveCredentials(String(fd.get("keyId") ?? ""), String(fd.get("secret") ?? ""));
      await setSetting("imonnit_base_url", String(fd.get("baseUrl") ?? "").trim());
      await audit({ action: "imonnit.connect", userId: u.id, userName: u.name });
      const d = await discoverSensors();
      revalidatePath("/temps");
      redirect(`/temps?${d.ok ? "ok" : "error"}=` + encodeURIComponent(d.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/temps?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  async function disconnect() {
    "use server";
    const u = await requireManager();
    await clearCredentials();
    await audit({ action: "imonnit.disconnect", userId: u.id, userName: u.name });
    revalidatePath("/temps");
    redirect("/temps?ok=" + encodeURIComponent("Disconnected. The readings already collected are kept."));
  }

  async function refresh() {
    "use server";
    const u = await requireManager();
    const d = await discoverSensors();
    await audit({ action: "imonnit.discover", userId: u.id, userName: u.name, details: d.message.slice(0, 150) });
    revalidatePath("/temps");
    redirect(`/temps?${d.ok ? "ok" : "error"}=` + encodeURIComponent(d.message));
  }

  async function pull() {
    "use server";
    const u = await requireManager();
    const r = await syncReadings();
    await audit({ action: "imonnit.sync", userId: u.id, userName: u.name, details: r.message.slice(0, 200) });
    revalidatePath("/temps");
    redirect(`/temps?${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
  }

  async function showRaw() {
    "use server";
    const u = await requireManager();
    const d = await diagnose();
    await audit({ action: "imonnit.diagnose", userId: u.id, userName: u.name, details: d.message.slice(0, 200) });
    const q = new URLSearchParams({ [d.ok ? "ok" : "error"]: d.message });
    if (d.sample) q.set("raw", d.sample);
    redirect("/temps?" + q.toString());
  }

  async function backfill(fd: FormData) {
    "use server";
    const u = await requireManager();
    const fromIso = String(fd.get("fromIso") ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso)) redirect("/temps?error=" + encodeURIComponent("Pick a date to start from."));
    const r = await syncReadings({ fromIso });
    await audit({ action: "imonnit.backfill", userId: u.id, userName: u.name, details: `from ${fromIso}: ${r.message}`.slice(0, 200) });
    revalidatePath("/temps");
    revalidatePath("/compliance");
    redirect(`/temps?${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
  }

  async function saveSensors(fd: FormData) {
    "use server";
    const u = await requireManager();
    for (const sensor of await db.query.tempSensors.findMany()) {
      const on = fd.get(`track-${sensor.id}`) !== null;
      const name = String(fd.get(`name-${sensor.id}`) ?? "").trim() || sensor.externalName || `Sensor ${sensor.externalId}`;
      const kind = String(fd.get(`kind-${sensor.id}`) ?? sensor.kind) as typeof sensor.kind;
      const min = Math.round(Number(fd.get(`min-${sensor.id}`)) * 10);
      const max = Math.round(Number(fd.get(`max-${sensor.id}`)) * 10);
      await db
        .update(schema.tempSensors)
        .set({
          tracked: on,
          name,
          kind,
          minTenthsF: Number.isFinite(min) ? min : sensor.minTenthsF,
          maxTenthsF: Number.isFinite(max) ? max : sensor.maxTenthsF,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.tempSensors.id, sensor.id));
    }
    await audit({ action: "imonnit.sensors", userId: u.id, userName: u.name });
    revalidatePath("/temps");
    redirect("/temps?ok=" + encodeURIComponent("Saved."));
  }

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <>
      <PageHeader
        title="Temperatures"
        subtitle="Every reading kept here, so a month can be printed, explained and signed without going back to the vendor."
        actions={
          connected ? (
            <>
              <form action={pull}><button className="btn btn-primary">Pull the latest</button></form>
              {tracked[0] && (
                <Link href={`/temps/${tracked[0].id}/${lastMonth}/print`} className="btn">Print last month</Link>
              )}
            </>
          ) : undefined
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {!connected ? (
        <Card title="Connect to iMonnit" className="max-w-2xl">
          <p className="text-sm text-ink-2">
            The key and secret come from iMonnit under Settings, API. They are stored encrypted on this computer and
            never shown again.
          </p>
          <form action={connect} className="mt-3 grid gap-3">
            <Field label="API key ID"><input name="keyId" className="field font-mono" autoComplete="off" /></Field>
            <Field label="API secret key"><input name="secret" type="password" className="field font-mono" autoComplete="new-password" /></Field>
            <Field label="Address (only if iMonnit told you a different one)" hint="Leave blank unless you have been given one.">
              <input name="baseUrl" className="field font-mono" placeholder="https://www.imonnit.com/json" defaultValue={s.imonnit_base_url} />
            </Field>
            <div><button className="btn btn-primary">Connect and find sensors</button></div>
          </form>
        </Card>
      ) : tracked.length === 0 ? (
        <Empty>
          No sensors are being logged yet. Open <b>Setup</b> below, tick the ones this pharmacy keeps records for, and
          set their acceptable range.
        </Empty>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure
              value={unexplained.length}
              label="Unexplained excursions"
              sub={unexplained.length === 0 ? "Every out-of-range reading has a note" : "An inspector stops on these"}
              tone={unexplained.length === 0 ? "ok" : "crit"}
              href="#unexplained"
            />
            <Figure
              value={readingsToday}
              label="Readings in the last day"
              sub={readingsToday === 0 ? "Nothing has come in — check the sensors" : `Across ${tracked.length} sensor${tracked.length === 1 ? "" : "s"}`}
              tone={readingsToday === 0 ? "crit" : "ok"}
            />
            <Figure
              value={awaiting.length}
              label="Months awaiting sign-off"
              sub={
                awaiting.length === 0
                  ? "Every month that has ended is signed"
                  : "Ended, logged, and nobody has signed it yet"
              }
              tone={awaiting.length === 0 ? "ok" : "crit"}
              href="#awaiting"
            />
            <Figure
              value={tracked.length}
              label="Sensors logging"
              sub={tracked.map((t) => t.name).join(", ")}
              tone="ok"
              href="#setup"
            />
          </div>

          {awaiting.length > 0 && (
            <Card
              id="awaiting"
              tone="crit"
              title="Months that have ended and are not signed"
              count={awaiting.length}
              subtitle="The readings file themselves. The sign-off cannot — a system that closed a month on its own would be manufacturing the one part of the record that is supposed to mean somebody looked, which is exactly the part an inspector asks about."
              className="mb-6"
            >
              <ul className="rows">
                {awaiting.map((a) => (
                  <li key={`${a.sensorId}-${a.periodKey}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-sm">
                      <span className="font-medium">{a.sensorName}</span>
                      <span className="ml-2 text-ink-3">{periodLabel(a.periodKey)}</span>
                    </span>
                    <span className="flex items-center gap-3 text-xs text-ink-3">
                      <span>{a.readings} readings</span>
                      {a.unexplained > 0 && <span className="badge badge-crit">{a.unexplained} to explain first</span>}
                      <Link href={`/temps/${a.sensorId}/${a.periodKey}`} className="btn btn-sm btn-primary">
                        {a.unexplained > 0 ? "Explain and sign" : "Review and sign"}
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* ── The one list that matters ── */}
          <Card
            id="unexplained"
            title="Needs an explanation"
            count={unexplained.length}
            tone={unexplained.length > 0 ? "crit" : undefined}
            subtitle={
              unexplained.length === 0
                ? "Every out-of-range reading has a note against it. That is the state a month has to be in before it can be signed off."
                : "Out-of-range readings with nothing written against them, oldest first. A month cannot be signed off until each has a note, and an unexplained excursion is the thing an inspector stops on. Say what happened and what was done about it."
            }
            className="mb-6"
          >
            {unexplained.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing outstanding.</p>
            ) : (
              <ul className="rows">
                {unexplained.slice(0, 40).map((r) => (
                  <li key={r.id} className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3>
                        {r.sensorName} — {f(r.valueTenthsF)}{" "}
                        <span className="font-normal text-ink-3">
                          on {when(r.takenAt)} · range {f(r.rangeMin)} to {f(r.rangeMax)}
                        </span>
                      </h3>
                      <span className="badge badge-crit">
                        {r.valueTenthsF < r.rangeMin ? "too cold" : "too warm"} by{" "}
                        {f(r.valueTenthsF < r.rangeMin ? r.rangeMin - r.valueTenthsF : r.valueTenthsF - r.rangeMax)}
                      </span>
                    </div>
                    <form action={explain} className="mt-2 flex flex-wrap gap-2">
                      <input type="hidden" name="readingId" value={r.id} />
                      <input type="hidden" name="sensorId" value={r.sensorId} />
                      <input type="hidden" name="periodKey" value={r.periodKey} />
                      <input
                        name="note"
                        placeholder="What happened, and what was done about it — door left ajar during a delivery, stock checked and remained in range"
                        className="field min-w-64 flex-1"
                      />
                      <button className="btn btn-primary">Save the note</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            {unexplained.length > 40 && (
              <p className="mt-3 text-xs text-ink-3">Showing the oldest 40 of {unexplained.length}.</p>
            )}
          </Card>

          {/* ── What it has been doing ── */}
          <Card
            title="Latest readings"
            count={latest.length}
            subtitle="Newest first, across every sensor being logged. Out-of-range readings are marked; anything without a note is in the list above."
            className="mb-6"
          >
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>When</th><th>Sensor</th><th className="num">Reading</th><th>Note</th></tr></thead>
                <tbody>
                  {latest.map((r) => (
                    <tr key={r.id} className={r.excursion ? "bg-crit-soft/40" : ""}>
                      <td className="whitespace-nowrap text-xs">{when(r.takenAt)}</td>
                      <td className="whitespace-nowrap text-xs">{r.sensorName}</td>
                      <td className={`num ${r.excursion ? "font-semibold text-crit" : ""}`}>{f(r.valueTenthsF)}</td>
                      <td className="text-xs text-ink-2">
                        {r.note ? (
                          <>{r.note} <span className="text-ink-3">— {r.noteBy}</span></>
                        ) : r.excursion ? (
                          <span className="text-crit">out of range, no note yet</span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── Any month, per sensor ── */}
          <Card
            id="months"
            title="Months"
            subtitle="Every month that has readings. Open one to see it in full, note anything out of range, sign it off and print it."
            className="mb-6"
          >
            <div className="space-y-4">
              {tracked.map((sensor) => {
                const mine = months.get(sensor.id) ?? [];
                return (
                  <div key={sensor.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3>{sensor.name}</h3>
                      <span className="text-xs text-ink-3">
                        {f(sensor.minTenthsF)} to {f(sensor.maxTenthsF)} · {sensor.kind}
                      </span>
                    </div>
                    {mine.length === 0 ? (
                      <p className="mt-1 text-sm text-ink-3">No readings on file yet.</p>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {mine.map((m) => {
                          const card = cards.find((c) => c.sensor.id === sensor.id && c.summary?.periodKey === m);
                          const sum = card?.summary;
                          const tone = sum?.reviewed
                            ? "badge-ok"
                            : sum && !sum.allExplained
                              ? "badge-crit"
                              : "badge-muted";
                          return (
                            <Link
                              key={m}
                              href={`/temps/${sensor.id}/${m}`}
                              className="btn btn-sm"
                              title={
                                sum
                                  ? `${sum.readings} readings, ${sum.excursions} out of range${sum.reviewed ? ", signed off" : ""}`
                                  : "Open this month"
                              }
                            >
                              {periodLabel(m)}
                              {sum && <span className={`badge ${tone} ml-1.5`}>{sum.reviewed ? "signed" : sum.excursions > 0 ? sum.excursions : "ok"}</span>}
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 border-t border-line pt-4">
              <h3>Go to a month</h3>
              <form action={backfill} className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="Pull history from" hint="Fetches everything from this date forward. Safe to run again — a reading is never stored twice.">
                  <input name="fromIso" type="date" className="field w-auto" />
                </Field>
                <button className="btn">Pull it</button>
              </form>
            </div>
          </Card>

          {/* ── Everything to do with setup, out of the way ── */}
          <Card id="setup" title="Setup" className="mb-6">
            <details>
              <summary className="cursor-pointer text-sm font-medium text-accent">Sensors, ranges and the connection</summary>

              <p className="mt-3 text-sm text-ink-2">
                Only ticked sensors are logged. An iMonnit account usually carries more than the pharmacy needs records
                for, and logging the rest just buries the two that matter.
              </p>
              <form action={saveSensors} className="mt-3">
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr><th>Log it</th><th>Name it</th><th>What it is</th><th>Acceptable range (°F)</th><th>In iMonnit</th></tr>
                    </thead>
                    <tbody>
                      {sensors.map((x) => (
                        <tr key={x.id}>
                          <td><input type="checkbox" name={`track-${x.id}`} defaultChecked={x.tracked} /></td>
                          <td><input name={`name-${x.id}`} defaultValue={x.name} className="field w-44" /></td>
                          <td>
                            <select name={`kind-${x.id}`} defaultValue={x.kind} className="field w-auto">
                              <option value="refrigerator">Refrigerator</option>
                              <option value="freezer">Freezer</option>
                              <option value="room">Room</option>
                              <option value="other">Other</option>
                            </select>
                          </td>
                          <td className="whitespace-nowrap">
                            <input name={`min-${x.id}`} type="number" step="0.1" defaultValue={(x.minTenthsF / 10).toFixed(1)} className="field w-20" />
                            {" to "}
                            <input name={`max-${x.id}`} type="number" step="0.1" defaultValue={(x.maxTenthsF / 10).toFixed(1)} className="field w-20" />
                          </td>
                          <td className="text-xs text-ink-3">{x.externalName ?? "—"} <span className="font-mono">#{x.externalId}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-ink-3">
                  Vaccine refrigerators are usually 36 to 46 °F and freezers −58 to +5 °F. Set them to whatever your own
                  protocol says — the range is what decides when a reading counts as an excursion.
                </p>
                <button className="btn btn-primary mt-3">Save the sensors</button>
              </form>

              <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
                <form action={refresh}><button className="btn">Look for new sensors</button></form>
                <form action={showRaw}><button className="btn">Show exactly what iMonnit sent</button></form>
                <form action={disconnect}><button className="btn btn-danger">Disconnect from iMonnit</button></form>
              </div>
              {raw && (
                <details className="mt-3 rounded-md border border-line bg-ground p-3" open>
                  <summary className="cursor-pointer text-sm font-medium">What iMonnit sent</summary>
                  <p className="mt-1 text-xs text-ink-3">
                    If readings are being skipped, this says why: the field names here are what the account actually
                    returns, and they differ between iMonnit versions.
                  </p>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-ink-2">{raw}</pre>
                </details>
              )}
            </details>
          </Card>
        </>
      )}
    </>
  );
}
