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
 */

let lastRequestAt = 0;

/** Called on every page render. Cheap on purpose — it is on the hot path. */
export function noteRequest(): void {
  lastRequestAt = Date.now();
}

/** True when nothing has been served for this many seconds. */
export function isIdle(seconds: number, now = Date.now()): boolean {
  if (lastRequestAt === 0) return true;
  return now - lastRequestAt >= seconds * 1000;
}

/** How long since the last page, for diagnostics. */
export function secondsSinceRequest(now = Date.now()): number | null {
  return lastRequestAt === 0 ? null : Math.round((now - lastRequestAt) / 1000);
}
