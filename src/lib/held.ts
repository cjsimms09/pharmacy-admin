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
type Entry = { at: number; fp: string; value: unknown; has: boolean; pending: Promise<unknown> | null; compute: () => Promise<unknown> };

const holds = new Map<string, Entry>();
const FRESH_MS = 10 * 60_000;
const STALE_OK_MS = 6 * 60 * 60_000;

let fpCache: { at: number; fp: string } | null = null;

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
      "(select count(*) from supplier_imports) as si, (select max(created_at) from supplier_imports) as sm",
  );
  const row = r.rows[0] ?? {};
  const fp = ["c", "a", "s", "n", "l", "o", "d", "e", "p", "g", "si", "sm"].map((k) => String(row[k] ?? "")).join("|");
  fpCache = { at: Date.now(), fp };
  return fp;
}

export async function held<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const fp = await fingerprint();
  const now = Date.now();
  const e = holds.get(key);
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
  const p = compute()
    .then((value) => {
      holds.set(key, { at: Date.now(), fp, value, has: true, pending: null, compute });
      return value;
    })
    .catch((err) => {
      if (prev?.has) holds.set(key, { ...prev, pending: null });
      else holds.delete(key);
      throw err;
    });
  holds.set(key, { at: prev?.at ?? 0, fp: prev?.fp ?? fp, value: prev?.value, has: prev?.has ?? false, pending: p, compute });
  return p;
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
  let n = 0;
  for (const [key, e] of [...holds.entries()]) {
    if (!e.has || e.pending) continue;
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
