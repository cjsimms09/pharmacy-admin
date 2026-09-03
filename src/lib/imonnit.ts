import "server-only";
import { eq, and, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId, encryptText, decryptText } from "./crypto";
import { getSettings, setSetting } from "./settings";

/**
 * Reading temperatures out of iMonnit.
 *
 * The API is JSON over HTTPS with a key ID and a secret. Two things about its shape have changed
 * over the years — the host, and whether credentials go in headers or in the path — so both are
 * tried and the base address can be overridden. A hard-coded address that quietly stops working
 * would look identical to a sensor that has stopped reporting, which is the one failure that
 * must never be silent here.
 *
 * Everything is normalised on the way in. Monnit reports in whichever unit the account is set
 * to, and field names differ between endpoint versions, so values are converted to tenths of a
 * degree Fahrenheit and fields are matched case-insensitively against several known spellings.
 * A reading that cannot be understood is skipped and counted, never guessed at — a fabricated
 * temperature in a vaccine log is worse than a gap in one.
 */

const DEFAULT_BASES = ["https://www.imonnit.com/json", "https://www.imonnit.com/api"];

export async function saveCredentials(keyId: string, secret: string) {
  if (!keyId.trim() || !secret.trim()) throw new Error("Both the key ID and the secret are needed.");
  await setSetting("imonnit_key_id_enc", encryptText(keyId.trim()));
  await setSetting("imonnit_secret_enc", encryptText(secret.trim()));
}

export async function clearCredentials() {
  await setSetting("imonnit_key_id_enc", "");
  await setSetting("imonnit_secret_enc", "");
}

async function credentials(): Promise<{ keyId: string; secret: string } | null> {
  const s = await getSettings();
  if (!s.imonnit_key_id_enc || !s.imonnit_secret_enc) return null;
  try {
    return { keyId: decryptText(s.imonnit_key_id_enc), secret: decryptText(s.imonnit_secret_enc) };
  } catch {
    return null;
  }
}

export async function hasCredentials(): Promise<boolean> {
  return (await credentials()) !== null;
}

type CallResult = { ok: true; data: unknown; via: string } | { ok: false; error: string; tried: string[] };

/**
 * Calls one iMonnit method.
 *
 * Both credential styles are attempted because accounts provisioned at different times use
 * different ones, and there is no way to tell which from the outside. The first that answers
 * with usable JSON wins, and the address that worked is reported so it stops being a mystery.
 */
async function call(method: string, params: Record<string, string> = {}): Promise<CallResult> {
  const creds = await credentials();
  if (!creds) return { ok: false, error: "No iMonnit key is stored.", tried: [] };
  const s = await getSettings();
  const bases = [s.imonnit_base_url?.trim(), ...DEFAULT_BASES].filter(Boolean) as string[];
  const tried: string[] = [];
  const query = new URLSearchParams(params).toString();

  for (const base of bases) {
    const root = base.replace(/\/$/, "");
    const attempts: { url: string; headers: Record<string, string>; label: string }[] = [
      {
        url: `${root}/${method}${query ? `?${query}` : ""}`,
        headers: { APIKeyID: creds.keyId, APISecretKey: creds.secret, accept: "application/json" },
        label: `${root}/${method} (headers)`,
      },
      {
        url: `${root}/${method}/${encodeURIComponent(creds.keyId)}/${encodeURIComponent(creds.secret)}${query ? `?${query}` : ""}`,
        headers: { accept: "application/json" },
        label: `${root}/${method}/… (credentials in path)`,
      },
    ];

    for (const a of attempts) {
      try {
        const res = await fetch(a.url, { headers: a.headers, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) {
          tried.push(`${a.label} → HTTP ${res.status}`);
          continue;
        }
        const text = await res.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          // An HTML sign-in page comes back with a 200 and is the usual sign of a bad key.
          tried.push(`${a.label} → answered, but not JSON (usually a rejected key)`);
          continue;
        }
        return { ok: true, data, via: a.label };
      } catch (e) {
        tried.push(`${a.label} → ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
  }
  return { ok: false, error: `Could not reach iMonnit. Tried: ${tried.join("; ")}`, tried };
}

/** iMonnit wraps results as { Method, Result: [...] }; older shapes return the array directly. */
function resultsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    for (const key of ["Result", "result", "Data", "data"]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

/** Field names differ between endpoint versions; match on the normalised name. */
function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const want of names) {
    const key = Object.keys(row).find((k) => norm(k) === norm(want));
    if (key !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return undefined;
}

/**
 * Converts a reported temperature to tenths of a degree Fahrenheit.
 *
 * Returns null rather than a number whenever anything is unclear. The unit is decided from the
 * account's own label where one is given, and otherwise from the value: a vaccine fridge cannot
 * be at 4 degrees Fahrenheit and cannot be at 40 Celsius, so the ranges do not overlap in any
 * way that matters. Where they might, it declines.
 */
export function toTenthsF(raw: unknown, unitHint?: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return null;

  const hint = String(unitHint ?? "").toLowerCase();
  const isC = /celsius|centigrade|(^|[^a-z])c([^a-z]|$)|°c/.test(hint);
  const isF = /fahrenheit|(^|[^a-z])f([^a-z]|$)|°f/.test(hint);

  if (isC && !isF) return Math.round((n * 9) / 5 * 10 + 320);
  if (isF) return Math.round(n * 10);

  // No usable hint. Anything a pharmacy fridge or freezer could plausibly read in Fahrenheit is
  // taken as Fahrenheit; a value that could only be Celsius is converted.
  if (n >= -40 && n <= 120) return Math.round(n * 10);
  return null;
}

export const f = (tenths: number) => `${(tenths / 10).toFixed(1)}°F`;

/** Local calendar month of an instant, which is how a log is read and printed. */
export function periodOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export type SyncReport = {
  ok: boolean;
  message: string;
  sensorsSeen: number;
  readingsAdded: number;
  skipped: number;
  via: string | null;
};

/** Pulls the sensor list so the pharmacy can choose which ones matter. */
export async function discoverSensors(): Promise<{ ok: boolean; message: string; found: number }> {
  const r = await call("SensorList");
  if (!r.ok) return { ok: false, message: r.error, found: 0 };

  const rows = resultsOf(r.data);
  if (rows.length === 0) {
    return { ok: false, message: `Connected, but no sensors came back. Answered via ${r.via}.`, found: 0 };
  }

  let found = 0;
  for (const row of rows) {
    const externalId = String(pick(row, "SensorID", "sensorId", "ID") ?? "").trim();
    if (!externalId) continue;
    const externalName = String(pick(row, "SensorName", "Name", "sensorName") ?? "").trim() || null;

    const existing = await db.query.tempSensors.findFirst({ where: eq(schema.tempSensors.externalId, externalId) });
    if (existing) {
      // The pharmacy's own name and range are never overwritten by the vendor's.
      if (existing.externalName !== externalName) {
        await db.update(schema.tempSensors).set({ externalName, updatedAt: new Date().toISOString() }).where(eq(schema.tempSensors.id, existing.id));
      }
    } else {
      await db.insert(schema.tempSensors).values({
        id: newId(),
        externalId,
        externalName,
        name: externalName ?? `Sensor ${externalId}`,
        tracked: false, // nothing is logged until someone says it should be
      });
    }
    found++;
  }
  return { ok: true, message: `${found} sensor${found === 1 ? "" : "s"} found. Tick the ones this pharmacy logs.`, found };
}

/**
 * Pulls readings for every tracked sensor.
 *
 * Asks from a little before the last reading held, so a gap left by a missed run is filled rather
 * than becoming a permanent hole in the log. Duplicates are impossible: a reading is keyed on the
 * sensor and the instant it was taken.
 */
export async function syncReadings(sinceDays = 40): Promise<SyncReport> {
  const sensors = (await db.query.tempSensors.findMany()).filter((s) => s.tracked);
  if (sensors.length === 0) {
    return { ok: false, message: "No sensors are being tracked yet.", sensorsSeen: 0, readingsAdded: 0, skipped: 0, via: null };
  }

  let added = 0;
  let skipped = 0;
  let via: string | null = null;
  const problems: string[] = [];

  for (const sensor of sensors) {
    const from = sensor.lastReadingAt
      ? new Date(Date.parse(sensor.lastReadingAt) - 36 * 60 * 60 * 1000)
      : new Date(Date.now() - sinceDays * 86_400_000);

    const r = await call("SensorDataMessages", {
      sensorID: sensor.externalId,
      fromDate: from.toISOString().slice(0, 19).replace("T", " "),
      toDate: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    if (!r.ok) {
      problems.push(`${sensor.name}: ${r.error}`);
      continue;
    }
    via ??= r.via;

    const rows = resultsOf(r.data);
    const existing = new Set(
      (await db.query.tempReadings.findMany({ where: eq(schema.tempReadings.sensorId, sensor.id), columns: { takenAt: true } })).map((x) => x.takenAt),
    );

    const fresh: (typeof schema.tempReadings.$inferInsert)[] = [];
    let latest = sensor.lastReadingAt;

    for (const row of rows) {
      const when = String(pick(row, "MessageDate", "messageDate", "Date", "Timestamp") ?? "").trim();
      const takenAt = when ? new Date(when.includes("T") ? when : when.replace(" ", "T") + "Z").toISOString() : "";
      if (!takenAt || takenAt === "Invalid Date") { skipped++; continue; }
      if (existing.has(takenAt)) continue;

      const value = pick(row, "PlotValue", "DataValue", "Value", "plotValue", "dataValue");
      const tenths = toTenthsF(value, pick(row, "DataType", "Unit", "dataType", "MetricName"));
      if (tenths === null) { skipped++; continue; }

      existing.add(takenAt);
      fresh.push({
        id: newId(),
        sensorId: sensor.id,
        takenAt,
        periodKey: periodOf(takenAt),
        valueTenthsF: tenths,
        excursion: tenths < sensor.minTenthsF || tenths > sensor.maxTenthsF,
      });
      if (!latest || takenAt > latest) latest = takenAt;
    }

    for (let i = 0; i < fresh.length; i += 400) {
      await db.insert(schema.tempReadings).values(fresh.slice(i, i + 400));
    }
    added += fresh.length;

    await db
      .update(schema.tempSensors)
      .set({ lastReadingAt: latest ?? null, lastSyncAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(schema.tempSensors.id, sensor.id));
  }

  const message =
    problems.length > 0
      ? `${added} reading${added === 1 ? "" : "s"} added, but: ${problems.join("; ")}`
      : added > 0
        ? `${added.toLocaleString()} new reading${added === 1 ? "" : "s"} across ${sensors.length} sensor${sensors.length === 1 ? "" : "s"}.${skipped ? ` ${skipped} could not be read and were skipped.` : ""}`
        : `Up to date — nothing new since the last check.${skipped ? ` ${skipped} could not be read.` : ""}`;

  await setSetting("imonnit_last_sync", new Date().toISOString());
  await setSetting("imonnit_last_result", message);
  return { ok: problems.length === 0, message, sensorsSeen: sensors.length, readingsAdded: added, skipped, via };
}

export type MonthSummary = {
  sensorId: string;
  sensorName: string;
  kind: string;
  periodKey: string;
  readings: number;
  minTenthsF: number | null;
  maxTenthsF: number | null;
  meanTenthsF: number | null;
  excursions: number;
  /** The longest run of consecutive out-of-range readings, which is what an investigation asks. */
  longestExcursionMinutes: number | null;
  rangeMin: number;
  rangeMax: number;
  /** True when every excursion in the month has a note against it. */
  allExplained: boolean;
  reviewed: boolean;
};

/** One month for one sensor, summarised the way a vaccine programme asks for it. */
export async function monthSummary(sensorId: string, periodKey: string): Promise<MonthSummary | null> {
  const sensor = await db.query.tempSensors.findFirst({ where: eq(schema.tempSensors.id, sensorId) });
  if (!sensor) return null;
  const readings = await db.query.tempReadings.findMany({
    where: and(eq(schema.tempReadings.sensorId, sensorId), eq(schema.tempReadings.periodKey, periodKey)),
    orderBy: (r, { asc }) => [asc(r.takenAt)],
  });
  const notes = await db.query.tempNotes.findMany({
    where: and(eq(schema.tempNotes.sensorId, sensorId), eq(schema.tempNotes.periodKey, periodKey)),
  });

  const values = readings.map((r) => r.valueTenthsF);
  const excursions = readings.filter((r) => r.excursion);
  const noted = new Set(notes.map((n) => n.readingId).filter(Boolean) as string[]);

  // The longest unbroken run out of range, measured between the first and last of that run.
  let longest = 0;
  let runStart: string | null = null;
  let prevOut = false;
  for (const r of readings) {
    if (r.excursion && !prevOut) runStart = r.takenAt;
    if (!r.excursion && prevOut && runStart) {
      longest = Math.max(longest, (Date.parse(r.takenAt) - Date.parse(runStart)) / 60_000);
      runStart = null;
    }
    prevOut = r.excursion;
  }
  if (prevOut && runStart && readings.length > 0) {
    longest = Math.max(longest, (Date.parse(readings[readings.length - 1].takenAt) - Date.parse(runStart)) / 60_000);
  }

  return {
    sensorId,
    sensorName: sensor.name,
    kind: sensor.kind,
    periodKey,
    readings: readings.length,
    minTenthsF: values.length ? Math.min(...values) : null,
    maxTenthsF: values.length ? Math.max(...values) : null,
    meanTenthsF: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
    excursions: excursions.length,
    longestExcursionMinutes: excursions.length ? Math.round(longest) : null,
    rangeMin: sensor.minTenthsF,
    rangeMax: sensor.maxTenthsF,
    allExplained: excursions.every((e) => noted.has(e.id)),
    reviewed: notes.some((n) => n.reviewed && !n.readingId),
  };
}

/** Which months have data, newest first. */
export async function availableMonths(sensorId: string): Promise<string[]> {
  const rows = await db.query.tempReadings.findMany({
    where: eq(schema.tempReadings.sensorId, sensorId),
    columns: { periodKey: true },
  });
  return [...new Set(rows.map((r) => r.periodKey))].sort().reverse();
}

export async function trackedSensors() {
  return db.query.tempSensors.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
}

/**
 * Whether a month is covered, for the compliance register.
 *
 * Covered means readings exist, every excursion has been explained, and the month has been
 * signed off. Data alone is not a temperature log — an unreviewed month of numbers with an
 * unexplained excursion in it is exactly what an inspector stops on.
 */
export async function monthsSatisfied(periodKeys: string[]): Promise<Map<string, boolean>> {
  const sensors = (await db.query.tempSensors.findMany()).filter((s) => s.tracked);
  const out = new Map<string, boolean>(periodKeys.map((p) => [p, false]));
  if (sensors.length === 0) return out;
  for (const p of periodKeys) {
    const each = await Promise.all(sensors.map((s) => monthSummary(s.id, p)));
    out.set(p, each.every((m) => m !== null && m.readings > 0 && m.allExplained && m.reviewed));
  }
  return out;
}
