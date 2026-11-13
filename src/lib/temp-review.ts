import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Which tracked sensors have a finished month nobody has signed off.
 *
 * The readings arrive on their own and are complete; what turns them into a record is somebody
 * having looked at the month and said so — `temp_notes.reviewed`, which is what the month's page
 * sets. August 2026 was signed off that way. September was not, and nothing on any screen mentioned
 * it: the owner found out by asking on 1 October.
 *
 * ── What is deliberately not reported ──
 *
 * A sensor nobody is tracking. Seven are on file and two are watched; the other five have never
 * returned a reading and are not part of the record, so asking for a signature on them would be
 * asking for a signature on nothing.
 *
 * A tracked sensor with no readings in the month. That is a real state and a different one — there
 * is nothing to review, and it is the feed that needs looking at rather than the log. It belongs to
 * whatever watches the feed, not to a request for a signature.
 *
 * So this answers one question only: of the sensors that recorded the month, which ones has nobody
 * signed. `null` is never returned for "do not know"; a sensor either has a reviewed note for the
 * period or it does not.
 */
export type UnsignedTemperatureMonth = {
  sensorId: string;
  name: string;
  readings: number;
  /** Readings outside the sensor's own range, which is what the reviewer is being asked to look at. */
  outOfRange: number;
};

export async function unsignedTemperatureMonths(month: string): Promise<UnsignedTemperatureMonth[]> {
  const sensors = await db.query.tempSensors.findMany({
    where: eq(schema.tempSensors.tracked, true),
    columns: { id: true, name: true },
  });
  if (sensors.length === 0) return [];

  const notes = await db.query.tempNotes.findMany({
    where: and(eq(schema.tempNotes.periodKey, month), eq(schema.tempNotes.reviewed, true)),
    columns: { sensorId: true },
  });
  const signed = new Set(notes.map((n) => n.sensorId));

  const out: UnsignedTemperatureMonth[] = [];
  for (const s of sensors) {
    if (signed.has(s.id)) continue;
    /*
     * Filtered on the reading's own period key, not on a date range over `takenAt`.
     *
     * The stamps are UTC and this pharmacy is six hours behind it, so a range of `2026-09-01` to
     * `2026-09-32` over `takenAt` quietly takes six hours of 1 September into August's bucket and
     * six hours of 1 October into September's. `periodKey` is the month the row was filed under,
     * which is the same key the month's own page and the sign-off note use — so this counts exactly
     * the readings the person signing is looking at.
     */
    const readings = await db.query.tempReadings.findMany({
      where: and(eq(schema.tempReadings.sensorId, s.id), eq(schema.tempReadings.periodKey, month)),
      columns: { excursion: true },
    });
    /* Nothing recorded is not an unsigned month. See the note above. */
    if (readings.length === 0) continue;
    out.push({
      sensorId: s.id,
      name: s.name,
      readings: readings.length,
      /* The reading's own flag, set when it was stored against the sensor's range at the time. */
      outOfRange: readings.filter((r) => r.excursion).length,
    });
  }
  return out;
}
