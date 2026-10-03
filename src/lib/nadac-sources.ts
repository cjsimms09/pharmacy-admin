/**
 * Where NADAC lives on data.medicaid.gov, worked out from the site rather than written down.
 *
 * Pure apart from `discoverNadacDatasets`, which takes its fetch as an argument so the parsing
 * can be tested on a saved copy of what the site returns.
 *
 * ── How CMS lays it out ──
 *
 * data.medicaid.gov is a DKAN site. Every dataset has an identifier (a UUID) and a title, and the
 * metastore lists them all in one call:
 *
 *     GET /api/1/metastore/schemas/dataset/items?show-reference-ids=false
 *
 * Three kinds of dataset carry NADAC:
 *
 *   "NADAC (National Average Drug Acquisition Cost)"        the current weekly file, replaced
 *                                                            each week — about 25,000 rows
 *   "NADAC (National Average Drug Acquisition Cost) 2026"   one per calendar year, every weekly
 *                                                            file for that year appended, each
 *                                                            row carrying its as_of_date — a
 *                                                            million rows by December
 *   "NADAC Comparison …"                                     week-on-week change files, not wanted
 *
 * The yearly dataset gets a **new identifier every January**. A loader with the id written into
 * it works for a year and then quietly fetches nothing, or — worse, and this happened — an old
 * year. So the ids are looked up by title and cached, and the code carries no id at all.
 *
 * ── The two ways to get rows, and which to use ──
 *
 * Row query:   GET /api/1/datastore/query/{id}/0?limit=…&offset=…
 *              JSON, a few hundred rows a page. Walking a week this way is dozens of calls and a
 *              year is thousands; that is the pattern that times out inside a page request and
 *              takes the site down with it. Used here for exactly one thing: asking for the
 *              newest as_of_date, one row, sorted descending.
 *
 * Download:    GET /api/1/datastore/query/{id}/0/download?format=csv
 *              The whole dataset as one streamed CSV. With a condition on as_of_date it is one
 *              week of the yearly dataset — a few megabytes — which is how a single missing week
 *              is filled without pulling the hundred-megabyte year:
 *
 *              …/download?conditions[0][property]=as_of_date
 *                        &conditions[0][value]=2026-07-15
 *                        &conditions[0][operator]==
 *                        &format=csv
 *
 * No key, no account, no stated quota. Both forms are fetched by nadac-fetch.ts, streamed to
 * disk and parsed before anything is kept.
 */

export const METASTORE_URL = "https://data.medicaid.gov/api/1/metastore/schemas/dataset/items?show-reference-ids=false";
const BASE = "https://data.medicaid.gov/api/1/datastore/query";

export type NadacDataset = { id: string; title: string; modified: string | null };

export type NadacDatasets = {
  /** The current weekly file. Null when the listing did not carry one. */
  weekly: NadacDataset | null;
  /** The yearly archives, by four-digit year. */
  years: Record<string, NadacDataset>;
  /** When the listing was read, ISO. */
  readAt: string;
};

const TITLE = /^NADAC \(National Average Drug Acquisition Cost\)(?:\s+(\d{4}))?$/i;

/**
 * Picks the NADAC datasets out of the metastore listing.
 *
 * Exact title match, so the comparison files and anything else with "NADAC" in the name are
 * left out. A listing that carries the same title twice keeps the most recently modified.
 */
export function pickNadacDatasets(items: unknown, readAt = new Date().toISOString()): NadacDatasets {
  const out: NadacDatasets = { weekly: null, years: {}, readAt };
  if (!Array.isArray(items)) return out;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const id = typeof item.identifier === "string" ? item.identifier.trim() : "";
    const m = TITLE.exec(title);
    if (!m || !id) continue;
    const ds: NadacDataset = { id, title, modified: typeof item.modified === "string" ? item.modified : null };
    const year = m[1];
    if (!year) {
      if (!out.weekly || newer(ds, out.weekly)) out.weekly = ds;
    } else if (!out.years[year] || newer(ds, out.years[year])) {
      out.years[year] = ds;
    }
  }
  return out;
}

const newer = (a: NadacDataset, b: NadacDataset) => (a.modified ?? "") > (b.modified ?? "");

/** The whole dataset as CSV, streamed. */
export function datasetDownloadUrl(id: string): string {
  return `${BASE}/${id}/0/download?format=csv`;
}

/** One week of a yearly dataset as CSV: every row whose as_of_date is the given day. */
export function weekDownloadUrl(id: string, asOfDate: string): string {
  const p = new URLSearchParams({
    "conditions[0][property]": "as_of_date",
    "conditions[0][value]": asOfDate,
    "conditions[0][operator]": "=",
    format: "csv",
  });
  return `${BASE}/${id}/0/download?${p.toString()}`;
}

/** One row, the newest as_of_date in the dataset. */
export function latestAsOfUrl(id: string): string {
  const p = new URLSearchParams({
    limit: "1",
    offset: "0",
    count: "false",
    schema: "false",
    keys: "true",
    "properties[0]": "as_of_date",
    "sorts[0][property]": "as_of_date",
    "sorts[0][order]": "desc",
  });
  return `${BASE}/${id}/0?${p.toString()}`;
}

/** Reads the as_of_date out of a one-row query response, as yyyy-mm-dd, or null. */
export function parseLatestAsOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0] as Record<string, unknown>;
  const raw = first.as_of_date ?? first["As of Date"] ?? first.as_of;
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  if (m) return m[1];
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw.trim());
  return us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : null;
}

/**
 * The Wednesday a week's NADAC file is published on, for a date anywhere in that week.
 *
 * CMS publishes on Wednesdays. A claim filled on a Monday is priced by the file published the
 * Wednesday before it (the latest as_of on or before the fill), so the file wanted for a week is
 * the Wednesday on or before the week's Monday — and the following Wednesday, for fills later in
 * the week. Both are offered; the caller tries them in turn.
 */
export function wednesdaysFor(dateIso: string): { onOrBefore: string; after: string } {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const back = (d.getUTCDay() - 3 + 7) % 7;
  const before = new Date(d);
  before.setUTCDate(d.getUTCDate() - back);
  const after = new Date(before);
  after.setUTCDate(before.getUTCDate() + 7);
  return { onOrBefore: before.toISOString().slice(0, 10), after: after.toISOString().slice(0, 10) };
}

/**
 * Reads the metastore listing. The one network call in this file; everything else is arithmetic
 * on what it returns, so a saved listing is enough to test the rest.
 */
export async function discoverNadacDatasets(fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): Promise<NadacDatasets> {
  const res = await fetchImpl(METASTORE_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`data.medicaid.gov answered HTTP ${res.status} to the dataset listing`);
  return pickNadacDatasets(await res.json());
}
