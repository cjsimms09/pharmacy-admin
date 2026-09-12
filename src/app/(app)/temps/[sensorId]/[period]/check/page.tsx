import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { diagnose } from "@/lib/imonnit";
import { periodLabel } from "@/lib/periods";
import { PageHeader, BackLink, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "What iMonnit holds" };

/**
 * Asks iMonnit, out loud, what it actually has for one sensor in one month.
 *
 * There are two completely different reasons a month can be empty, and from the log they look
 * identical: the readings arrived and could not be understood, or the account never had them.
 * The first is ours to fix and the second is a retention setting at Monnit — chasing the wrong
 * one costs days. This shows the raw reply, so the question is settled rather than argued.
 */
export default async function CheckPage({ params }: { params: Promise<{ sensorId: string; period: string }> }) {
  await requireManager();
  const { sensorId, period } = await params;
  const sensor = await db.query.tempSensors.findFirst({ where: eq(schema.tempSensors.id, sensorId) });
  if (!sensor) notFound();

  const [y, m] = period.split("-").map(Number);
  if (!y || !m) notFound();
  const fromIso = `${period}-01`;
  const toIso = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const held = await db.query.tempReadings.findMany({
    where: eq(schema.tempReadings.sensorId, sensorId),
    columns: { takenAt: true },
  });
  const earliest = held.map((r) => r.takenAt).sort()[0] ?? null;

  const d = await diagnose({ sensorId, fromIso, toIso });

  return (
    <>
      <BackLink href={`/temps/${sensorId}/${period}`}>{periodLabel(period)}</BackLink>
      <PageHeader
        title={`What iMonnit holds — ${sensor.name}`}
        subtitle={`${periodLabel(period)} · asked for ${fromIso} to ${toIso}`}
      />

      <Notice kind={d.ok ? "ok" : "crit"}>{d.message}</Notice>

      <section className="card mb-6">
        <h2 className="font-semibold">How to read this</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>
            <b>Rows came back but nothing was stored</b> — the readings exist and the site could not read a field. That
            is a bug here and the sample below shows which field.
          </li>
          <li>
            <b>No rows came back</b> — the account holds nothing for this sensor in this month. Nothing on this side can
            recover it. iMonnit keeps a limited window of history depending on the plan, and once a month has aged out
            of that window it is gone from the source, not just from here. If this month matters, the only routes are a
            plan that retains longer, or an export taken from iMonnit before the window closes.
          </li>
          <li>
            <b>An error instead of rows</b> — the key, the address or the account is the problem, and the message above
            says which was tried.
          </li>
        </ul>
        <p className="mt-3 text-sm text-ink-2">
          The oldest reading this site holds for {sensor.name} is{" "}
          <b>{earliest ? earliest.slice(0, 10) : "none at all"}</b>. If that date is roughly where iMonnit&rsquo;s history
          stops for every sensor, the account&rsquo;s retention window is the answer and no amount of asking will change it.
        </p>
      </section>

      {d.sample && (
        <section className="card">
          <h2 className="font-semibold">The reply, exactly as it arrived</h2>
          <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-ground p-3 text-xs">{d.sample}</pre>
        </section>
      )}
    </>
  );
}
