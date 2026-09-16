import "server-only";
import { db } from "@/db";
import { evictions, MAX_HELD } from "./held-evict";

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
/*
 * `at` is when the value was computed and `readAt` when a reader was last handed it, and they are
 * different questions. `refreshStale` recomputes on every idle tick, so a reading nobody has opened
 * since Tuesday looks brand new by `at`; the one somebody opens every morning is the one worth
 * keeping. Freshness is decided by `at`, and what to let go of by `readAt`.
 */
type Entry = { at: number; readAt: number; fp: string; value: unknown; has: boolean; pending: Promise<unknown> | null; compute: () => Promise<unknown> };

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


/**
 * Drop the least recently read once there are more held readings than the ceiling.
 *
 * There was a ceiling on how *old* a value could be and none on how *many* there could be, and
 * nothing here ever removed an entry — `refreshStale` recomputes rather than drops, and
 * `forgetHeld` only fires when an import knows what it invalidated. Several keys carry a date or a
 * range somebody browsed (`books:2026-09:2026-09-08`, `recent:6:2026-09-08`), so the cache gained
 * an entry a day, each holding a whole period's object graph, none of it ever read again. Invisible
 * on a cold start and obvious after a fortnight — and this machine is left running for weeks.
 *
 * The policy is in `held-evict.ts` so it can be checked without a cache.
 */
function evictExcess(): void {
  if (holds.size <= MAX_HELD) return;
  const entries = [...holds.entries()].map(([key, e]) => ({ key, readAt: e.readAt, pending: e.pending !== null, has: e.has }));
  for (const key of evictions(entries, MAX_HELD)) holds.delete(key);
}

let fpCache: { at: number; fp: string } | null = null;

/*
 * Audit actions that record somebody looking, not something changing.
 *
 * The newest audit event is a term in the fingerprint, and before this list every event counted.
 * Measured on 15 September 2026, over seven days: 124 document views, 83 sign-ins and 72 test-suite
 * rows each threw away every held reading on the site, and so did 112 of the last 132 inbox sweeps,
 * which found nothing. Money found takes nineteen seconds to rebuild from cold, so the owner signing
 * in was enough to make his own first page slow.
 *
 * Only actions that write no row any reading depends on belong here. When in doubt, leave it out: a
 * reading recomputed for nothing costs seconds, and a reading that missed a real change is the
 * "I pressed it and nothing happened" fault this cache has already had once.
 */
const LOOKS_ONLY = ["document.view", "login.success", "login.failed", "login.blocked", "pioneer-sql.test", "mail.test", "diagnostics.export"] as const;

/** Whether an audit action records a look rather than a change, so the held readings need not move. */
export function changesNothing(action: string): boolean {
  return (LOOKS_ONLY as readonly string[]).includes(action) || action.startsWith("test.");
}

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
    "select (select count(*) from claims) as c, " +
      `(select max(at) from audit_events where action not in (${LOOKS_ONLY.map((a) => `'${a}'`).join(",")}) and action not like 'test.%') as a, ` +
      "(select count(*) from supplier_items) as s, (select count(*) from supplier_invoices) as si2, " +
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
  const fp = ["c", "a", "s", "si2", "n", "l", "o", "d", "e", "p", "g", "si", "sm", "f", "fa"].map((k) => String(row[k] ?? "")).join("|");
  fpCache = { at: Date.now(), fp };
  return fp;
}

export async function held<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const fp = await fingerprint();
  const now = Date.now();
  const e = holds.get(key);
  if (e) e.readAt = now;
  if (e && e.has && e.fp === fp) {
    if (now - e.at < FRESH_MS) {
      e.readAt = now;
      return e.value as T;
    }
    if (now - e.at < STALE_OK_MS) {
      // Stale but unchanged underneath: serve it, and refresh behind.
      e.readAt = now;
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
      // A refresh does not count as a read: `refreshStale` recomputes everything on an idle tick,
      // and a value nobody asked for must not look recently wanted because of it.
      holds.set(key, { at: Date.now(), readAt: prev?.readAt ?? Date.now(), fp, value, has: true, pending: null, compute });
      evictExcess();
      return value;
    })
    .catch((err) => {
      if (prev?.has) holds.set(key, { ...prev, pending: null });
      else holds.delete(key);
      throw err;
    });
  holds.set(key, { at: prev?.at ?? 0, readAt: prev?.readAt ?? Date.now(), fp: prev?.fp ?? fp, value: prev?.value, has: prev?.has ?? false, pending: p, compute });
  return p;
}

/**
 * Drops what nobody has read in six hours, then hands the ceiling to `held-evict.ts`.
 *
 * Two rules, and they answer different questions: an entry nobody has opened since this morning is
 * not worth recomputing on an idle tick however much room there is, and past the ceiling the least
 * recently read goes whatever its age. The second is A's policy, pure and tested apart from the cache.
 */
function evict(now = Date.now()): number {
  let n = 0;
  for (const [key, e] of [...holds.entries()]) {
    if (e.pending) continue;
    if (now - e.readAt > STALE_OK_MS) {
      holds.delete(key);
      n++;
    }
  }
  const before = holds.size;
  evictExcess();
  return n + (before - holds.size);
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
    if (Date.now() - e.readAt > RECENT_MS) continue;
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

/** What is held, how old, and how long since anybody read it — for the feeds page. */
export function heldStatus(): { key: string; ageSeconds: number; unreadSeconds: number; refreshing: boolean }[] {
  const now = Date.now();
  return [...holds.entries()]
    .filter(([, e]) => e.has)
    .map(([key, e]) => ({ key, ageSeconds: Math.round((now - e.at) / 1000), unreadSeconds: Math.round((now - e.readAt) / 1000), refreshing: e.pending !== null }));
}

/**
 * How full the cache is, for the page that reports what this process is using.
 *
 * Said out loud because the alternative was measuring it with a profiler on the pharmacy's own
 * computer while somebody waited at the counter. A site that has cost this pharmacy its counter
 * twice should be able to answer "how much are you holding" by itself.
 */
export function heldSize(): { entries: number; ceiling: number } {
  return { entries: holds.size, ceiling: MAX_HELD };
}
