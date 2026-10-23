/**
 * How many wrong passwords a login is allowed before it stops answering.
 *
 * The site had no limit at all. On the pharmacy LAN that is a weakness; reachable from the
 * internet it is the whole security of the thing, because a password is only as good as the number
 * of attempts an attacker gets, and unlimited attempts makes every password guessable given an
 * afternoon.
 *
 * Counted per username rather than per address on purpose. The pharmacy sits behind one address —
 * throttling that would lock out the whole shop the moment somebody fat-fingered a password twice —
 * and an attacker with a list of addresses defeats it anyway. What has to be made expensive is
 * guessing one account's password, and that is exactly what this counts.
 *
 * Pure, so the rule can be read and tested without a database.
 */

/** Failures inside this window count against the account. */
export const WINDOW_MINUTES = 15;

/** Wrong answers allowed before the door closes. */
export const ALLOWED = 5;

export type Attempt = { at: string; ok: boolean };

/**
 * Whether this username may try again, and what to say if not.
 *
 * `attempts` is every login recorded for the username, newest first or oldest first — the order
 * does not matter. A success clears what came before it: somebody who mistyped four times and then
 * got in is not one attempt from being locked out for the rest of the afternoon.
 */
export function loginAllowed(attempts: Attempt[], now = new Date()): { allowed: true } | { allowed: false; waitMinutes: number; says: string } {
  const cutoff = new Date(now.getTime() - WINDOW_MINUTES * 60_000).toISOString();
  const nowIso = now.toISOString();

  // Anything at or before the last success is water under the bridge.
  let lastOk = "";
  for (const a of attempts) if (a.ok && a.at > lastOk && a.at <= nowIso) lastOk = a.at;

  const live = attempts
    .filter((a) => !a.ok && a.at > cutoff && a.at > lastOk && a.at <= nowIso)
    .map((a) => a.at)
    .sort();

  if (live.length < ALLOWED) return { allowed: true };

  // The door reopens when the oldest failure still counting ages out of the window.
  const oldest = new Date(live[live.length - ALLOWED]).getTime();
  const waitMs = oldest + WINDOW_MINUTES * 60_000 - now.getTime();
  const waitMinutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return {
    allowed: false,
    waitMinutes,
    says:
      `Too many wrong passwords for this account. Try again in ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}. ` +
      `If this was not you, somebody is guessing at this login — the attempts are in the audit log.`,
  };
}
