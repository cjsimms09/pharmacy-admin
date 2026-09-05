import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { getSettings, setSetting } from "./settings";
import { loadNadacFiles, loadedFiles, looksLikeNadacHeader, nadacDir } from "./nadac";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";

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

/*
 * ── How CMS actually publishes NADAC ──
 *
 * data.medicaid.gov used to run on Socrata and now runs on DKAN; CMS published a mapping between
 * the two when they moved. The Socrata-style address (/resource/a4y5-998d.json) is the legacy
 * one, and the DKAN dataset it maps to is d5eaf378-dcef-5779-83de-acdd8347d68e. That is the
 * *current weekly* reference file — every NDC with a NADAC rate, republished each week.
 *
 * There is no API key, no account and no quota. The datastore query endpoint returns JSON with a
 * default page of 500 rows and limit/offset paging, and `/download?format=csv` returns the whole
 * distribution in one response, which is what this uses: one parse beats six hundred requests.
 *
 * One line here was simply wrong. The address carrying dfa2ab14-06c2-457a-9e36-5cb6d80f8d93 is
 * the **2022** dataset — so on the days it did resolve it would have loaded four-year-old prices
 * and reported success. It is replaced rather than kept as a fallback, because a fallback that
 * silently returns the wrong year is worse than having no fallback at all.
 */
export const KNOWN_SOURCES = [
  "https://data.medicaid.gov/api/1/datastore/query/d5eaf378-dcef-5779-83de-acdd8347d68e/0/download?format=csv",
  "https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost.csv",
  "https://download.medicaid.gov/data/NADAC%20(National%20Average%20Drug%20Acquisition%20Cost).csv",
];

/**
 * The plain weekly files, by date, tried before anything else.
 *
 * CMS publishes each week's file at a fixed address ending in the Wednesday it was published:
 * nadac-national-average-drug-acquisition-cost-01-07-2026.csv. It is a single week, a few
 * megabytes, an ordinary static file — no API, no query, nothing to go wrong. The datastore
 * addresses above are the fallback now rather than the first thing tried, because they answer
 * with the whole dataset through a query endpoint that has been slow, large, and on at least one
 * occasion refused outright.
 *
 * Several weeks are offered because "the last published file" is not knowable from here: CMS
 * publishes on a Wednesday, but not every Wednesday, and a holiday moves it. The most recent
 * Wednesday is tried, then the one before, and the first that exists is the current file.
 */
export function weeklyFileUrls(today: Date = new Date(), weeks = 8): string[] {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  // Back up to the most recent Wednesday (day 3), today included.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - 3 + 7) % 7));
  const out: string[] = [];
  for (let i = 0; i < weeks; i++) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    out.push(`https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-${mm}-${dd}-${d.getUTCFullYear()}.csv`);
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return out;
}

/**
 * The one whole-year download this offers, and why it is one.
 *
 * The weekly pull only ever carries this week. CMS also publishes a dataset per calendar year
 * holding every weekly file for that year, which is what makes filling in earlier weeks a single
 * button. But only this year's matters: the Kansas floor took effect on 1 July 2026, no claim
 * before that date can have been paid under it, and the pharmacy is starting its claim history from
 * scratch rather than carrying anything over. The 2022, 2023 and 2024 datasets were offered for a
 * while; each is a hundred-megabyte download of prices no check will ever ask for, and one of them
 * was the fallback that quietly loaded four-year-old prices as current. Nothing earlier is offered.
 *
 * CMS mints a new id each January, so an unknown year returns nothing rather than guessing at a
 * URL — a guessed id would either 404 or, far worse, quietly fetch a different year.
 */
const YEAR_DATASETS: Record<string, string> = {
  "2026": "fbb83258-11c7-47f5-8b18-5f8e79f7e704",
};

/** The bulk download for a calendar year, or null where we do not know that year's dataset. */
export function yearArchiveUrl(year: string | number): string | null {
  const id = YEAR_DATASETS[String(year)];
  return id ? `https://data.medicaid.gov/api/1/datastore/query/${id}/0/download?format=csv` : null;
}

/** The years we can fetch whole, newest first, for the screen to offer. */
export function archiveYears(): string[] {
  return Object.keys(YEAR_DATASETS).sort().reverse();
}

/**
 * Whether the automatic pull is on.
 *
 * Unset means on. That is deliberate and it is the one setting here that defaults to doing
 * something: each weekly file carries only the prices in force that week, so a month with this
 * off is a month of history that cannot be recovered later — CMS's current file has forgotten it.
 * The cost of being wrong in this direction is one free public download a week; the cost of being
 * wrong in the other is a gap nobody can fill.
 */
export function nadacAuto(s: { nadac_auto?: string }): boolean {
  return s.nadac_auto !== "no";
}

/**
 * The most this will pull into memory at once.
 *
 * Generous enough for any weekly file and for a year archive that turns out to be modest, and
 * small enough that refusing is survivable where the alternative is the process being killed.
 */
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

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
export async function fetchNadac(onProgress?: (text: string) => void | Promise<void>): Promise<FetchResult> {
  const s = await getSettings();
  const { heldWeeks } = await import("./nadac");
  const held = await heldWeeks();
  const sources = weeklySourcesNeeded(held, s.nadac_source_url);
  if (sources.length === 0) {
    // Every week this knows how to ask for is already in the database. Saying so plainly is the
    // whole point: it is the ordinary outcome of a daily check, and it costs no download at all.
    const latest = [...held].sort().pop() ?? null;
    const message = `Nothing new — the newest weekly file CMS has published is already held${latest ? ` (prices in force ${latest})` : ""}.`;
    await setSetting("nadac_last_fetch", new Date().toISOString());
    await setSetting("nadac_last_result", message);
    await setSetting("nadac_last_ok", new Date().toISOString());
    return { ok: true, source: null, message, added: 0, rowsParsed: 0, fileAsOf: latest };
  }
  return fetchNadacFrom(sources, onProgress);
}

/**
 * Where "Fetch now" looks, in order: the pharmacy's own address, then the dated weekly files.
 *
 * The datastore addresses in KNOWN_SOURCES are deliberately *not* here any more. That endpoint
 * does not serve the current week — it serves the entire NADAC history, every weekly file CMS has
 * published since 2021, which is seven hundred thousand rows and a download measured in minutes.
 * It is why "fetch the latest NADAC" took a quarter of an hour and reported a file dated 2021.
 * A weekly pull wants this week: one dated file, about thirty thousand rows, a few megabytes.
 * The history remains available deliberately, from the back-fill button, where somebody has asked
 * for it and is told what it costs.
 */
export function weeklySources(override?: string | null): string[] {
  return [override?.trim(), ...weeklyFileUrls()].filter(Boolean) as string[];
}

/** The Wednesday a weekly file's address is for, as ISO, or null for any other address. */
export function weekOfUrl(url: string): string | null {
  const m = /nadac-national-average-drug-acquisition-cost-(\d{2})-(\d{2})-(\d{4})\.csv/i.exec(url);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * The weekly addresses worth trying, given what is already held.
 *
 * This is what makes a daily check free. Each weekly file carries one effective date — the
 * Wednesday in its own address — so if prices for that Wednesday are already in the database there
 * is nothing in the file to learn, and no reason to spend several megabytes finding out. What is
 * left is exactly the pharmacy's own question: pick up what is new and nothing else.
 *
 * The pharmacy's own override address is never filtered out. It exists for the day CMS moves the
 * file, and its contents cannot be guessed from its name.
 */
export function weeklySourcesNeeded(held: Set<string>, override?: string | null): string[] {
  return weeklySources(override).filter((u) => {
    const week = weekOfUrl(u);
    return week === null || !held.has(week);
  });
}

/**
 * Loads NADAC from wherever it is told to, trying the addresses in order.
 *
 * Separated from the weekly pull so the same well-tested path can be pointed at a back file. The
 * weekly download only ever carries the prices in force this week, so a claim from July can only
 * be priced from a file published around July — and no amount of fetching the current file will
 * ever produce one. CMS publishes the older files; this is how they get in without somebody
 * downloading ten of them by hand.
 *
 * Every guard that applies to the weekly pull applies here, and for the same reason: a download is
 * parsed before it is written, so an HTML error page saved as a .csv cannot sit in the folder
 * looking like data.
 */
export async function fetchNadacFrom(sources: string[], onProgress?: (text: string) => void | Promise<void>): Promise<FetchResult> {
  const tried: string[] = [];

  for (const url of sources) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { accept: "text/csv,application/octet-stream,*/*" },
        // Thirty minutes: the body is streamed and the signal covers the whole read, so this has
        // to allow for a year archive over a pharmacy's internet connection, not just the headers.
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!res.ok) {
        tried.push(`${short(url)} → HTTP ${res.status}`);
        continue;
      }

      /*
       * Streamed to disk, never held in memory.
       *
       * The first version did res.text() and parsed the whole thing before writing it. A weekly
       * file survived that; a year archive is a hundred megabytes of text, which is gigabytes of
       * objects, on the one thread that also serves every page — and that is what kept stopping
       * the site. Now the body goes straight to a file in chunks, with a running byte count that
       * stops a download larger than the ceiling, and the first chunk is checked for a NADAC header
       * so an HTML error page never gets saved as a .csv. Loading is the streaming loader's job.
       */
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_DOWNLOAD_BYTES) {
        tried.push(`${short(url)} → ${(declared / 1_048_576).toFixed(0)} MB, larger than this will download.`);
        continue;
      }
      if (!res.body) { tried.push(`${short(url)} → empty response`); continue; }

      const dir = nadacDir();
      await fs.mkdir(dir, { recursive: true });
      await onProgress?.(`Downloading ${short(url)}`);
      const dl = await streamToFile(res.body, dir, (bytes) => onProgress?.(`Downloading ${short(url)}: ${(bytes / 1_048_576).toFixed(0)} MB`));
      if (!dl.ok) { tried.push(`${short(url)} → ${dl.why}`); continue; }

      // Already on disk under another name: the same bytes, loaded before. Nothing to do.
      const manifest = await loadedFiles();
      if (Object.values(manifest).some((m) => m.sha256 === dl.sha256)) {
        await fs.unlink(dl.path).catch(() => {});
        const message = `Nothing new — the file at ${short(url)} is one already loaded.`;
        await setSetting("nadac_last_fetch", new Date().toISOString());
        await setSetting("nadac_last_result", message);
        await setSetting("nadac_last_ok", new Date().toISOString());
        return { ok: true, source: url, message, added: 0, rowsParsed: 0, fileAsOf: null };
      }

      const finalName = `nadac-${new Date().toISOString().slice(0, 10)}-${dl.sha256.slice(0, 8)}.csv`;
      await fs.rename(dl.path, path.join(dir, finalName));

      const reports = await loadNadacFiles({ onProgress, sha256: { [finalName]: dl.sha256 } });
      const mine = reports.find((r) => r.file === finalName);
      const added = mine?.added ?? 0;
      if (!mine || mine.rows === 0) {
        tried.push(`${short(url)} → downloaded, but no NADAC rows could be read from it`);
        continue;
      }

      /*
       * What was fetched, and from where.
       *
       * The message says the span it covers, how many weeks are in it, and which address it came
       * from, so a wrong source becomes obvious on the first read instead of never — a whole year
       * of 2022 once announced itself as "the file published 2022-01-05".
       */
      const stamp = mine.fileAsOf ?? new Date().toISOString().slice(0, 10);
      const covers =
        mine.weeks > 1 && mine.fileAsOfLatest && mine.fileAsOfLatest !== stamp
          ? `${mine.weeks} weekly files, ${stamp} to ${mine.fileAsOfLatest}`
          : `the file published ${stamp}`;
      const message =
        (added > 0
          ? `${added.toLocaleString()} new prices from ${covers}.`
          : `Nothing new — ${covers} holds only prices already held.`) + ` Source: ${short(url)}.`;
      await setSetting("nadac_last_fetch", new Date().toISOString());
      await setSetting("nadac_last_result", message);
      await setSetting("nadac_last_ok", new Date().toISOString());
      return { ok: true, source: url, message, added, rowsParsed: mine.rows, fileAsOf: stamp };
    } catch (e) {
      tried.push(`${short(url)} → ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }

  /*
   * The message says what was tried, without eight lines of "not published yet".
   *
   * Most of the addresses are dated weekly files that do not exist — that is the design, not a
   * fault — so a plain list of them buries the one failure that matters. Missing weeks are
   * counted in a phrase and everything else is named.
   */
  const missing = tried.filter((t) => /HTTP 40[34]$/.test(t)).length;
  const notable = tried.filter((t) => !/HTTP 40[34]$/.test(t));
  const parts = [
    missing > 0 ? `${missing} weekly file${missing === 1 ? "" : "s"} were not there (that is normal for a week CMS has not published)` : null,
    ...notable,
  ].filter(Boolean);
  const message =
    `Could not fetch NADAC. ${parts.join("; ")}. ` +
    `If CMS has moved the file, find its address on data.medicaid.gov and paste it in — everything else keeps working.`;
  await setSetting("nadac_last_fetch", new Date().toISOString());
  await setSetting("nadac_last_result", message);
  return { ok: false, source: null, message, added: 0, rowsParsed: 0, fileAsOf: null };
}

/**
 * An address, shortened to the part that identifies which dataset it is.
 *
 * Taking the last path segment was fine for download.medicaid.gov, where the filename says what
 * the file is. It is useless for a DKAN address, where every one ends in "download" — so three
 * different datasets all reported as the same word. The dataset id is the identifying part, and
 * the known ones are named outright, because "2022 archive" tells somebody something that a UUID
 * never will.
 */
const KNOWN_IDS: Record<string, string> = {
  "d5eaf378-dcef-5779-83de-acdd8347d68e": "current weekly file",
  "fbb83258-11c7-47f5-8b18-5f8e79f7e704": "2026 archive",
  "99315a95-37ac-4eee-946a-3c523b4c481e": "2024 archive",
  "4a00010a-132b-4e4d-a611-543c9521280f": "2023 archive",
  "dfa2ab14-06c2-457a-9e36-5cb6d80f8d93": "2022 archive",
};

const WEEKLY_FILE = /nadac-national-average-drug-acquisition-cost-(\d{2})-(\d{2})-(\d{4})\.csv/i;

const short = (u: string) => {
  const w = WEEKLY_FILE.exec(u);
  if (w) return `the weekly file for ${w[1]}/${w[2]}/${w[3]}`;
  try {
    const url = new URL(u);
    const id = url.pathname.split("/").find((p) => /^[0-9a-f-]{36}$/i.test(p));
    if (id) return `${url.host} ${KNOWN_IDS[id.toLowerCase()] ?? id}`;
    return `${url.host} ${url.pathname.split("/").pop() || ""}`.trim();
  } catch {
    return u;
  }
};

/**
 * Whether a pull is due.
 *
 * Daily, because a check now costs nothing. Each weekly file carries the Wednesday in its own
 * address, so a week already in the database is never asked for again — the ordinary daily check
 * finds every week held and stops without a single byte downloaded. Only the week CMS has just
 * published is fetched, once. Checking twice a week was the old compromise, made when every check
 * meant downloading a file to find out it held nothing new.
 */
export function fetchDue(lastIso: string | null, now = Date.now()): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  return now - last >= 20 * 60 * 60 * 1000;
}

/**
 * Writes a response body to a temporary file in chunks, hashing as it goes.
 *
 * Refuses on the first chunk if it does not begin with a NADAC header, and part-way through if the
 * byte count passes the ceiling — in both cases the partial file is removed. Memory use is one
 * chunk, whatever the file's size.
 */
async function streamToFile(
  body: ReadableStream<Uint8Array>,
  dir: string,
  onBytes?: (bytes: number) => void | Promise<void>,
): Promise<{ ok: true; path: string; bytes: number; sha256: string } | { ok: false; why: string }> {
  const tmp = path.join(dir, `.download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  const out = createWriteStream(tmp);
  const hash = createHash("sha256");
  let bytes = 0;
  let first = true;
  let lastTick = Date.now();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (first) {
        first = false;
        if (!looksLikeNadacHeader(Buffer.from(value.subarray(0, 8192)).toString("utf8"))) {
          throw new Error("the response does not begin with a NADAC header (NDC, NADAC Per Unit, Effective Date)");
        }
      }
      bytes += value.length;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error(`larger than ${(MAX_DOWNLOAD_BYTES / 1_048_576).toFixed(0)} MB`);
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      if (onBytes && Date.now() - lastTick > 2000) { lastTick = Date.now(); await onBytes(bytes); }
    }
    await new Promise<void>((resolve, reject) => { out.end(); out.on("finish", () => resolve()); out.on("error", reject); });
    return { ok: true, path: tmp, bytes, sha256: hash.digest("hex") };
  } catch (e) {
    await reader.cancel().catch(() => {});
    out.destroy();
    await fs.unlink(tmp).catch(() => {});
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}
