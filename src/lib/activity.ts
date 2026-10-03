/**
 * Whether anybody is using the site right now.
 *
 * The database is opened with a single serialized connection, which is right for a one-computer
 * pharmacy — it makes SQLITE_BUSY impossible inside the process — but it has a consequence that
 * was not thought through: every query waits behind every other. A background job that takes a
 * minute does not slow the site down, it stops it, and four of them share a thirty-minute timer.
 *
 * So heavy work waits for a gap. A pharmacy computer is idle almost all of the time, and a
 * backup that runs ninety seconds after the last page load rather than during one is worth
 * exactly as much.
 *
 * ── Three faults that made "the login never works", fixed 15 September ──
 *
 * 1. **The sign-in page did not count as somebody using the site.** `noteRequest` was called only
 *    from the signed-in layout. A person on /login pressing Sign in was invisible, so every heavy
 *    job treated the site as empty and ran while they tried to get in. Measured after the first
 *    fix went live: the sign-in page answered in 12–18 milliseconds five times running, then took
 *    25.8 seconds, while it was being requested every three seconds. The login page and the login
 *    action now note a request.
 *
 * 2. **A restart assumed nobody was there.** `lastRequestAt` began at 0, which `isIdle` read as
 *    "idle" — so sixty seconds after every restart the warm-up started, and restarts happen during
 *    the working day, when a deploy has just thrown somebody out and they are coming back to sign
 *    in. This file's own principle is "when in doubt, do not start", and with nothing observed
 *    there is nothing but doubt. The clock now starts at the moment this module is first loaded.
 *
 * 3. **The clock may not have been the same clock in both places.** The scheduler in
 *    instrumentation.ts and the pages are compiled as separate bundles, and a module-level
 *    variable is not guaranteed to be one variable across them — a page could record activity in
 *    one copy while the scheduler read another that never changed. Nobody had shown that it was
 *    shared, and "probably" is not good enough for the thing that decides whether the site is
 *    usable. It lives on `globalThis` now, the way the database connection already does.
 */

type Clock = { __pharmacyLastRequestAt?: number };
const g = globalThis as typeof globalThis & Clock;

/* First load counts as activity: with nothing observed yet, the site is not assumed empty. */
if (g.__pharmacyLastRequestAt === undefined) g.__pharmacyLastRequestAt = Date.now();

/** Called on every page render, and on a sign-in attempt. Cheap on purpose — it is on the hot path. */
export function noteRequest(): void {
  g.__pharmacyLastRequestAt = Date.now();
}

/** True when nothing has been served for this many seconds. */
export function isIdle(seconds: number, now = Date.now()): boolean {
  return now - (g.__pharmacyLastRequestAt ?? now) >= seconds * 1000;
}

/** How long since the last page, for diagnostics. */
export function secondsSinceRequest(now = Date.now()): number {
  return Math.round((now - (g.__pharmacyLastRequestAt ?? now)) / 1000);
}
