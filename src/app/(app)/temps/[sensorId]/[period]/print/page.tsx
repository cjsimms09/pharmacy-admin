import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { monthSummary, f } from "@/lib/imonnit";
import { periodLabel } from "@/lib/periods";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Temperature log" };

/**
 * The month as a document.
 *
 * Printed for a VFC visit or an excursion investigation, so it leads with the things those ask
 * for first — the range, the extremes, every excursion with its explanation — and only then the
 * readings themselves. A signature line at the end, because a log nobody signed is a spreadsheet.
 */
export default async function TempPrintPage({ params }: { params: Promise<{ sensorId: string; period: string }> }) {
  await requireUser();
  const { sensorId, period } = await params;
  const [summary, s, readings, notes, sensor] = await Promise.all([
    monthSummary(sensorId, period),
    getSettings(),
    db.query.tempReadings.findMany({
      where: and(eq(schema.tempReadings.sensorId, sensorId), eq(schema.tempReadings.periodKey, period)),
      orderBy: (r, { asc }) => [asc(r.takenAt)],
    }),
    db.query.tempNotes.findMany({ where: and(eq(schema.tempNotes.sensorId, sensorId), eq(schema.tempNotes.periodKey, period)) }),
    db.query.tempSensors.findFirst({ where: eq(schema.tempSensors.id, sensorId) }),
  ]);
  if (!summary || !sensor) notFound();

  const byReading = new Map(notes.filter((n) => n.readingId).map((n) => [n.readingId!, n]));
  const excursions = readings.filter((r) => r.excursion);
  const review = notes.find((n) => n.reviewed && !n.readingId);

  // One row per day: what a printed log is actually read as.
  const days = new Map<string, { min: number; max: number; n: number; out: number }>();
  for (const r of readings) {
    const day = new Date(r.takenAt).toISOString().slice(0, 10);
    const e = days.get(day) ?? { min: r.valueTenthsF, max: r.valueTenthsF, n: 0, out: 0 };
    e.min = Math.min(e.min, r.valueTenthsF);
    e.max = Math.max(e.max, r.valueTenthsF);
    e.n++;
    if (r.excursion) e.out++;
    days.set(day, e);
  }

  return (
    <main className="print-block mx-auto max-w-3xl p-8 text-[11pt]">
      <header className="print-heading border-b-2 border-black pb-3">
        <h1 className="text-xl font-bold">Temperature log — {periodLabel(period)}</h1>
        <p className="mt-1 text-sm">
          <b>{sensor.name}</b> ({sensor.kind}) · acceptable range {f(sensor.minTenthsF)} to {f(sensor.maxTenthsF)}
        </p>
        <p className="text-sm">
          {s.pharmacy_name || "Pharmacy"}
          {s.pharmacy_registration_number ? ` · registration ${s.pharmacy_registration_number}` : ""}
          {s.pharmacy_address ? ` · ${s.pharmacy_address}, ${s.pharmacy_city} ${s.pharmacy_state}` : ""}
        </p>
        <p className="mt-1 text-xs">
          Continuous monitoring, recorded automatically. Sensor {sensor.externalName ?? sensor.externalId} via iMonnit.
        </p>
      </header>

      <section className="print-block mt-4">
        <h2 className="font-bold">Summary</h2>
        <table className="mt-1 w-full text-sm">
          <tbody>
            <tr><td className="w-56 py-0.5">Readings recorded</td><td className="tabular-nums">{summary.readings.toLocaleString()}</td></tr>
            <tr><td className="py-0.5">Lowest</td><td className="tabular-nums">{summary.minTenthsF !== null ? f(summary.minTenthsF) : "—"}</td></tr>
            <tr><td className="py-0.5">Highest</td><td className="tabular-nums">{summary.maxTenthsF !== null ? f(summary.maxTenthsF) : "—"}</td></tr>
            <tr><td className="py-0.5">Average</td><td className="tabular-nums">{summary.meanTenthsF !== null ? f(summary.meanTenthsF) : "—"}</td></tr>
            <tr>
              <td className="py-0.5">Readings outside range</td>
              <td className="tabular-nums">
                {summary.excursions}
                {summary.longestExcursionMinutes ? ` (longest continuous run ${summary.longestExcursionMinutes} minutes)` : ""}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {excursions.length > 0 && (
        <section className="print-block mt-4">
          <h2 className="font-bold">Excursions and what was done</h2>
          <table className="mt-1 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-black text-left">
                <th className="py-1">When</th>
                <th className="py-1">Reading</th>
                <th className="py-1">Explanation</th>
              </tr>
            </thead>
            <tbody>
              {excursions.map((r) => (
                <tr key={r.id} className="border-b border-gray-300 align-top">
                  <td className="py-1 whitespace-nowrap">{new Date(r.takenAt).toLocaleString()}</td>
                  <td className="py-1 tabular-nums">{f(r.valueTenthsF)}</td>
                  <td className="py-1">
                    {byReading.get(r.id)?.note ?? <span className="italic">Not explained.</span>}
                    {byReading.get(r.id) && <span className="text-xs"> — {byReading.get(r.id)!.writtenBy}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="print-block mt-4">
        <h2 className="font-bold">Daily record</h2>
        <table className="mt-1 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-black text-left">
              <th className="py-1">Date</th>
              <th className="py-1 text-right">Low</th>
              <th className="py-1 text-right">High</th>
              <th className="py-1 text-right">Readings</th>
              <th className="py-1">In range</th>
            </tr>
          </thead>
          <tbody>
            {[...days.entries()].sort().map(([day, d]) => (
              <tr key={day} className="border-b border-gray-200">
                <td className="py-0.5">{day}</td>
                <td className="py-0.5 text-right tabular-nums">{f(d.min)}</td>
                <td className="py-0.5 text-right tabular-nums">{f(d.max)}</td>
                <td className="py-0.5 text-right tabular-nums">{d.n}</td>
                <td className="py-0.5">{d.out === 0 ? "Yes" : `No — ${d.out} reading${d.out === 1 ? "" : "s"} out`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="print-signature mt-6 border-t border-black pt-3">
        <h2 className="font-bold">Review</h2>
        {review ? (
          <p className="mt-1 text-sm">
            {review.note} — <b>{review.writtenBy}</b>, {new Date(review.createdAt).toLocaleDateString()}
          </p>
        ) : (
          <p className="mt-1 text-sm italic">This month has not been signed off.</p>
        )}
        <div className="mt-8 grid grid-cols-2 gap-8 text-sm">
          <div className="border-t border-black pt-1">Pharmacist-in-charge — signature</div>
          <div className="border-t border-black pt-1">Date</div>
        </div>
      </section>
    </main>
  );
}
