import "server-only";
import { db } from "@/db";

/**
 * Results held between requests, and shared between callers inside one.
 *
 * The site's pages are built from a handful of expensive readings — every fill grouped from the
 * claims, the product ledger, today's buy list, the books — and each page asked for several of
 * them, and several pages asked for the same one twice through different helpers. On a year of
 * claims that was thirteen seconds for Today and fourteen for the books, most of it the same scan
 * of the same table repeated. Nothing in those readings changes between two page loads a minute
 * apart unless a file was loaded or something was typed, and both of those leave a mark.
 *
 * So a reading is computed once and held, keyed on a fingerprint of the tables that feed it:
 * the count of claims, the newest audit event (every load and every edit writes one), the price
 * files, the benchmark, the invoices, the counts, the driver's invoices. The same fingerprint
 * within ten minutes is the held value; the same fingerprint later is the held value served at
 * once while a fresh one is computed behind it; a different fingerprint is computed now. Two
 * callers arriving together share one computation. A held value is shared by reference, so a
 * reader never sorts or writes into what it is given.
 */
type Entry = { at: number; read: number; fp: string; value: unknown; has: boolean; pending: Promise<unknown> | null; compute: () => Promise<unknown> };

const holds = new Map<string, Entry>();
const FRESH_MS = 10 * 60_000;
const STALE_OK_MS = 6 * 60 * 60_000;
/*
 * What nobody has asked for in six hours is dropped, and only what somebody asked for in the last
 * hour is refreshed behind. Several keys carry today's date or a period — `books:<period>:<day>`,
 * `recent:<n>:<day>` — so every day added entries that nothing would ever read again, and the idle
 * refresh recomputed all of them, every five minutes, for as long as the site had been up. That is
 * the shape of a process that is 1.3 GB an hour after it starts on a machine with 765 MB free.
 */
const RECENT_MS = 60 * 60_000;
const MOST_HELD = 48;

let fpCache: { at: number; fp: string } | null = null;

/**
 * Forgets the cached fingerprint, so the next reading is taken against the tables as they are now.
 *
 * ── Why this had to exist ──
 *
 * The owner, classifying plans: "im also hitting record on some of them and nothing is happening,
 * they arent going away". They were being recorded. Every press landed — the audit log and
 * `decided_on` both showed his determinations — and the page he was sent back to showed each plan
 * exactly as it had been, so he pressed again.
 *
 * The two-second cache below is why. A server action writes, redirects, and the page re-renders well
 * inside two seconds; `fingerprint()` then returns the fingerprint taken *before* the write,
 * `held()` finds a value whose fingerprint matches and is younger than ten minutes, and serves it.
 * The work was done and the screen said otherwise — the fault this project has spent days on, this
 * time in the caching layer rather than in any one page, and therefore on every action at once.
 *
 * So every write clears it. Called from `audit()`, which every action that changes anything already
 * goes through — that is the whole reason it hangs off audit rather than being called by hand at
 * each site, where the next action somebody writes would forget it.
 *
 * The two seconds are still worth keeping: they exist so one page load asking for six readings takes
 * one fingerprint rather than six, and nothing is written in the middle of a single render.
 */
export function forgetFingerprint(): void {
  fpCache = null;
}

/** What the readings depend on, in one cheap statement. Cached for two seconds so one page load asks once. */
export async function fingerprint(): Promise<string> {
  if (fpCache && Date.now() - fpCache.at < 2_000) return fpCache.fp;
  const client = (db as unknown as { $client: { execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const r = await client.execute(
    "select (select count(*) from claims) as c, (select max(at) from audit_events) as a, (select count(*) from supplier_items) as s, " +
      "(select max(file_as_of) from nadac_prices) as n, (select count(*) from invoice_lines) as l, (select max(counted_on) from on_hand_imports) as o, " +
      "(select count(*) from driver_invoices) as d, (select count(*) from expenses) as e, (select count(*) from claim_payments) as p, (select count(*) from plan_groups) as g, " +
      /*
       * The price files, by their import rather than by their row count.
       *
       * A catalogue import replaces only the NDCs the file covers — it deletes them and puts them
       * back — so next week's McKesson file, which lists the same drugs at new prices, lands on the
       * same number of rows. Counting `supplier_items` therefore misses the one change that matters
       * most to the buy list, and nothing else here would catch it: the supplier import path writes
       * no audit event. An import always writes a row here, so this is the term that moves.
       */
      "(select count(*) from supplier_imports) as si, (select max(created_at) from supplier_imports) as sm, " +
      /*
       * A correction the pharmacist typed, named on its own rather than left to the audit row.
       *
       * A settled package is the one edit where being served a stale figure reads as the site
       * ignoring the person using it — they went and looked at the bottle. The audit event would
       * catch it, but that is a coincidence of two writes rather than a promise, and this is a
       * promise.
       */
      "(select count(*) from ndc_pack_fixes) as f, (select max(corrected_at) from ndc_pack_fixes) as fa",
  );
  const row = r.rows[0] ?? {};
  const fp = ["c", "a", "s", "n", "l", "o", "d", "e", "p", "g", "si", "sm", "f", "fa"].map((k) => String(row[k] ?? "")).join("|");
  fpCache = { at: Date.now(), fp };
  return fp;
}

export async function held<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const fp = await fingerprint();
  const now = Date.now();
  const e = holds.get(key);
  if (e) e.read = now;
  if (e && e.has && e.fp === fp) {
    if (now - e.at < FRESH_MS) return e.value as T;
    if (now - e.at < STALE_OK_MS) {
      // Stale but unchanged underneath: serve it, and refresh behind.
      if (!e.pending) e.pending = run(key, fp, compute);
      return e.value as T;
    }
  }
  if (e?.pending) return e.pending as Promise<T>;
  return run(key, fp, compute);
}

function run<T>(key: string, fp: string, compute: () => Promise<T>): Promise<T> {
  const prev = holds.get(key);
  const read = prev?.read ?? Date.now();
  const p = compute()
    .then((value) => {
      holds.set(key, { at: Date.now(), read: holds.get(key)?.read ?? read, fp, value, has: true, pending: null, compute });
      evict();
      return value;
    })
    .catch((err) => {
      if (prev?.has) holds.set(key, { ...prev, pending: null });
      else holds.delete(key);
      throw err;
    });
  holds.set(key, { at: prev?.at ?? 0, read, fp: prev?.fp ?? fp, value: prev?.value, has: prev?.has ?? false, pending: p, compute });
  return p;
}

/** Drops what nobody has read in six hours, then the least recently read past the cap. Never what is computing. */
function evict(now = Date.now()): number {
  let n = 0;
  for (const [key, e] of [...holds.entries()]) {
    if (e.pending) continue;
    if (now - e.read > STALE_OK_MS) {
      holds.delete(key);
      n++;
    }
  }
  if (holds.size > MOST_HELD) {
    const idle = [...holds.entries()].filter(([, e]) => !e.pending).sort((a, b) => a[1].read - b[1].read);
    for (const [key] of idle.slice(0, holds.size - MOST_HELD)) {
      holds.delete(key);
      n++;
    }
  }
  return n;
}

/**
 * Recompute whatever is held and stale or behind the data, one at a time, for the idle minutes.
 *
 * Called by the scheduler when nobody has used the site for a while, so the morning's first page
 * finds everything fresh rather than paying for the night's imports itself. Returns how many were
 * refreshed.
 */
export async function refreshStale(maxAgeMs = FRESH_MS): Promise<number> {
  const fp = await fingerprint();
  evict();
  let n = 0;
  for (const [key, e] of [...holds.entries()]) {
    if (!e.has || e.pending) continue;
    // Only what somebody has actually opened lately: a reading nobody wants fresh is not recomputed.
    if (Date.now() - e.read > RECENT_MS) continue;
    if (e.fp === fp && Date.now() - e.at < maxAgeMs) continue;
    try {
      await run(key, fp, e.compute);
      n++;
    } catch {
      // Its next reader computes it; nothing to do here.
    }
  }
  return n;
}

/** Drop what is held, all of it or by key prefix, for the import that knows it changed the world. */
export function forgetHeld(prefix?: string): void {
  if (!prefix) holds.clear();
  else for (const k of [...holds.keys()]) if (k.startsWith(prefix)) holds.delete(k);
  fpCache = null;
}

/** What is held and how old, for the feeds page. */
export function heldStatus(): { key: string; ageSeconds: number; refreshing: boolean }[] {
  const now = Date.now();
  return [...holds.entries()].filter(([, e]) => e.has).map(([key, e]) => ({ key, ageSeconds: Math.round((now - e.at) / 1000), refreshing: e.pending !== null }));
}
