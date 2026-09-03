import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { hasCredentials, saveCredentials, clearCredentials, discoverSensors, syncReadings, trackedSensors, monthSummary, availableMonths, f } from "@/lib/imonnit";
import { getSettings, setSetting } from "@/lib/settings";
import { periodLabel } from "@/lib/periods";
import { PageHeader, Notice, Empty, Field } from "@/components/ui";

export const metadata = { title: "Temperatures" };
export const dynamic = "force-dynamic";

export default async function TempsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser();
  const { ok, error } = await searchParams;
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

  return (
    <>
      <PageHeader
        title="Temperatures"
        subtitle="Refrigerator and freezer readings, kept here so a month can be printed, explained and signed without going back to the vendor."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {!connected ? (
        <section className="my-4 max-w-2xl rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">Connect to iMonnit</h2>
          <p className="mt-1 text-sm text-ink-2">
            In iMonnit, the API key lives under your account settings — it comes as two parts, an ID and a secret.
            Both are stored encrypted here and never shown again.
          </p>
          <form action={connect} className="mt-3 space-y-3">
            <Field label="API Key ID"><input name="keyId" className="field font-mono" autoComplete="off" /></Field>
            <Field label="API Secret Key"><input name="secret" type="password" className="field font-mono" autoComplete="off" /></Field>
            <Field label="Address (leave blank unless Monnit have told you otherwise)">
              <input name="baseUrl" defaultValue={s.imonnit_base_url} placeholder="https://www.imonnit.com/json" className="field font-mono text-xs" />
            </Field>
            <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Connect and find sensors</button>
          </form>
        </section>
      ) : (
        <>
          {/* ── This month and last, per unit ── */}
          {tracked.length === 0 ? (
            <Notice kind="warn">Connected, but no sensors are being logged yet. Choose them below.</Notice>
          ) : (
            <div className="my-4 grid gap-3 sm:grid-cols-2">
              {cards.map(({ sensor, summary }) =>
                summary === null ? null : (
                  <article key={`${sensor.id}-${summary.periodKey}`} className={`rounded-lg border p-4 ${summary.excursions > 0 && !summary.allExplained ? "border-red-300 bg-red-50" : summary.readings === 0 ? "border-amber-300 bg-amber-50" : "border-line bg-surface"}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="font-semibold">{sensor.name}</h3>
                      <span className="text-xs text-ink-3">{periodLabel(summary.periodKey)}</span>
                    </div>
                    {summary.readings === 0 ? (
                      <p className="mt-2 text-sm">No readings for this month.</p>
                    ) : (
                      <>
                        <p className="mt-2 text-sm tabular-nums">
                          {f(summary.minTenthsF!)} to {f(summary.maxTenthsF!)}
                          <span className="text-ink-3"> · {summary.readings.toLocaleString()} readings · range {f(summary.rangeMin)}–{f(summary.rangeMax)}</span>
                        </p>
                        <p className="mt-1 text-sm">
                          {summary.excursions === 0 ? (
                            <span className="text-emerald-700">In range all month.</span>
                          ) : (
                            <span className={summary.allExplained ? "text-amber-800" : "text-red-700"}>
                              {summary.excursions} reading{summary.excursions === 1 ? "" : "s"} out of range
                              {summary.longestExcursionMinutes ? `, longest run ${summary.longestExcursionMinutes} min` : ""}
                              {summary.allExplained ? " — all explained." : " — not yet explained."}
                            </span>
                          )}
                        </p>
                        <p className="mt-1 text-xs">
                          {summary.reviewed ? <span className="text-emerald-700">Month signed off.</span> : <span className="text-ink-3">Not signed off yet.</span>}
                        </p>
                      </>
                    )}
                    <Link href={`/temps/${sensor.id}/${summary.periodKey}`} className="mt-3 inline-block rounded-md border border-line px-3 py-1.5 text-sm hover:bg-ground">
                      Open the log
                    </Link>
                  </article>
                ),
              )}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <form action={pull}><button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Fetch new readings</button></form>
            <form action={refresh}><button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Look for new sensors</button></form>
            <form action={backfill} className="flex items-end gap-2">
              <label className="text-xs text-ink-3">
                Or go back and collect history from
                <input type="date" name="fromIso" className="field" defaultValue={`${now.getFullYear()}-01-01`} />
              </label>
              <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Fetch history</button>
            </form>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            History is asked for a month at a time, so a long range is slow but does not time out. Readings already
            held are recognised and not stored twice, so this is safe to run again. How far back anything exists
            depends on how long your iMonnit plan keeps it — if a range comes back empty, that is the limit rather
            than a fault here.
          </p>
          {s.imonnit_last_sync && (
            <p className="mt-2 text-xs text-ink-3">Last checked {new Date(s.imonnit_last_sync).toLocaleString()} — {s.imonnit_last_result}</p>
          )}

          {/* ── Which sensors matter ── */}
          <h2 className="mt-8 text-sm font-semibold">Sensors</h2>
          <p className="mb-2 text-xs text-ink-3">
            Only ticked sensors are logged here. An iMonnit account usually carries more than the pharmacy needs to
            keep records for, and logging the rest just buries the two that matter.
          </p>
          {sensors.length === 0 ? (
            <Empty>No sensors found yet.</Empty>
          ) : (
            <form action={saveSensors}>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                    <tr>
                      <th className="px-3 py-2">Log it</th>
                      <th className="px-3 py-2">Name it</th>
                      <th className="px-3 py-2">What it is</th>
                      <th className="px-3 py-2">Acceptable range (°F)</th>
                      <th className="px-3 py-2">In iMonnit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sensors.map((x) => (
                      <tr key={x.id} className="border-t border-line">
                        <td className="px-3 py-2"><input type="checkbox" name={`track-${x.id}`} defaultChecked={x.tracked} /></td>
                        <td className="px-3 py-2"><input name={`name-${x.id}`} defaultValue={x.name} className="w-48 rounded-md border border-line px-2 py-1 text-sm" /></td>
                        <td className="px-3 py-2">
                          <select name={`kind-${x.id}`} defaultValue={x.kind} className="rounded-md border border-line px-2 py-1 text-sm">
                            <option value="refrigerator">Refrigerator</option>
                            <option value="freezer">Freezer</option>
                            <option value="room">Room</option>
                            <option value="other">Other</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <input name={`min-${x.id}`} type="number" step="0.1" defaultValue={(x.minTenthsF / 10).toFixed(1)} className="w-20 rounded-md border border-line px-2 py-1 text-sm" />
                          {" to "}
                          <input name={`max-${x.id}`} type="number" step="0.1" defaultValue={(x.maxTenthsF / 10).toFixed(1)} className="w-20 rounded-md border border-line px-2 py-1 text-sm" />
                        </td>
                        <td className="px-3 py-2 text-xs text-ink-3">{x.externalName ?? "—"} <span className="font-mono">#{x.externalId}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-3">
                Vaccine refrigerators are usually 36 to 46 °F and freezers −58 to +5 °F. Set them to whatever your own
                protocol says — the range is what decides when a reading counts as an excursion.
              </p>
              <button className="mt-3 rounded-md bg-ink px-3 py-2 text-sm text-white">Save</button>
            </form>
          )}

          <form action={disconnect} className="mt-6">
            <button className="text-xs text-ink-3 underline hover:text-ink">Disconnect from iMonnit</button>
          </form>
        </>
      )}
    </>
  );
}
