import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { getSettings, setSetting } from "./settings";
import { loadNadacFiles, nadacDir, parseNadacCsv } from "./nadac";

/**
 * Pulling NADAC from CMS automatically.
 *
 * It is free, public, and needs no key or account — the only reason this was ever manual is that
 * nobody had written it. Published weekly rather than daily, on a Wednesday, so this checks a
 * couple of times a week and does nothing when there is nothing new.
 *
 * Two things shape the implementation.
 *
 * CMS moves its download addresses. The dataset has lived at several URLs over the years, so
 * several known shapes are tried in turn and the pharmacy can override with its own — a hard
 * -coded address that quietly starts 404ing would look exactly like "no new data this week",
 * which is the worst way for this to fail.
 *
 * And a download is only kept if it parses. A truncated transfer or an HTML error page saved as
 * a .csv would otherwise sit in the folder looking like data, so the response is parsed before
 * it is written and a file that yields no usable rows is discarded with the reason kept.
 */

/** Where the current weekly file has lived. Tried in order; the first that parses wins. */
const KNOWN_SOURCES = [
  "https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost.csv",
  "https://data.medicaid.gov/api/1/datastore/query/dfa2ab14-06c2-457a-9e36-5cb6d80f8d93/0/download?format=csv",
  "https://download.medicaid.gov/data/NADAC%20(National%20Average%20Drug%20Acquisition%20Cost).csv",
];

export type FetchResult = {
  ok: boolean;
  source: string | null;
  message: string;
  added: number;
  rowsParsed: number;
  fileAsOf: string | null;
};

/**
 * Fetches the current file and loads it.
 *
 * Safe to run repeatedly: prices are keyed on NDC plus effective date, so re-fetching the same
 * week adds nothing, and the weekly files overlap enough to fill each other's gaps.
 */
export async function fetchNadac(): Promise<FetchResult> {
  const s = await getSettings();
  const sources = [s.nadac_source_url?.trim(), ...KNOWN_SOURCES].filter(Boolean) as string[];
  const tried: string[] = [];

  for (const url of sources) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { accept: "text/csv,application/octet-stream,*/*" },
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        tried.push(`${short(url)} → HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();

      // Parse before writing. An HTML error page saved as a .csv sits in the folder looking like
      // data and quietly prices nothing.
      const parsed = parseNadacCsv(text);
      if (parsed.rows.length === 0) {
        tried.push(`${short(url)} → downloaded, but no NADAC rows could be read from it`);
        continue;
      }

      const stamp = parsed.fileAsOf ?? new Date().toISOString().slice(0, 10);
      const dir = nadacDir();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `nadac-${stamp}.csv`), text);

      const reports = await loadNadacFiles();
      const added = reports.reduce((n, r) => n + r.added, 0);

      const message =
        added > 0
          ? `${added.toLocaleString()} new prices from the file published ${stamp}.`
          : `Up to date — the file published ${stamp} holds nothing we did not already have.`;
      await setSetting("nadac_last_fetch", new Date().toISOString());
      await setSetting("nadac_last_result", message);
      return { ok: true, source: url, message, added, rowsParsed: parsed.rows.length, fileAsOf: stamp };
    } catch (e) {
      tried.push(`${short(url)} → ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }

  const message =
    `Could not fetch NADAC. Tried ${tried.length} address${tried.length === 1 ? "" : "es"}: ${tried.join("; ")}. ` +
    `If CMS has moved the file, find its address on data.medicaid.gov and paste it in — everything else keeps working.`;
  await setSetting("nadac_last_fetch", new Date().toISOString());
  await setSetting("nadac_last_result", message);
  return { ok: false, source: null, message, added: 0, rowsParsed: 0, fileAsOf: null };
}

const short = (u: string) => {
  try {
    return new URL(u).pathname.split("/").pop() || u;
  } catch {
    return u;
  }
};

/**
 * Whether a pull is due.
 *
 * CMS publishes weekly, so checking twice a week catches a new file within days without asking
 * for the same download over and over. There is no benefit to daily and no cost to being a day
 * late — a price effective this week is still the price when it is fetched on Friday.
 */
export function fetchDue(lastIso: string | null, now = Date.now()): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  return now - last >= 3.5 * 24 * 60 * 60 * 1000;
}
