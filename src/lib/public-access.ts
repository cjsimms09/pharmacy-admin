import fs from "node:fs";
import path from "node:path";

/**
 * Letting the site be reached from outside the pharmacy, on purpose and for a stated length of time.
 *
 * This is the real database. Every contract, every claim, the prescription numbers, the DEA and
 * NPI numbers, the staff records. So the whole design here is about the two ways this goes wrong
 * in practice, neither of which is somebody deciding to do it:
 *
 * It gets left on. Somebody opens it for an afternoon's work, the afternoon ends, and it is still
 * answering the internet a month later. So exposure is never open-ended: it carries an expiry it
 * cannot outlive, the launcher closes it when the clock runs out whether or not anybody remembers,
 * and it does not survive a restart — a computer switched on in the morning comes up private.
 *
 * And it gets forgotten. A site that looks identical whether or not the world can see it is a site
 * somebody will type a password into without thinking. So while it is open the app says so on every
 * page, in a colour nobody can ignore, with the minutes remaining and the way to stop it.
 *
 * The record lives in a file rather than the database on purpose: the launcher has to read it
 * before the app exists, and write it before the app is told which address it is answering on.
 */

export type PublicAccess = {
  /** The address the world reaches it on, once the tunnel has one. Null while it is still coming up. */
  url: string | null;
  requestedAt: string;
  expiresAt: string;
  requestedBy: string;
  /** What the person opening it said it was for, so the audit log has a reason and not just a time. */
  reason: string;
};

/** Nothing may be exposed for longer than this in one go, whatever is asked for. */
export const MAX_HOURS = 8;

export function accessFile(root = process.cwd()): string {
  return path.join(root, "data", "public-access.json");
}

/** What was asked for, or null. Never throws: an unreadable record means not exposed. */
export function readAccess(root = process.cwd()): PublicAccess | null {
  try {
    const raw = fs.readFileSync(accessFile(root), "utf8");
    const a = JSON.parse(raw) as PublicAccess;
    return a && typeof a.expiresAt === "string" ? a : null;
  } catch {
    return null;
  }
}

export function writeAccess(a: PublicAccess, root = process.cwd()): void {
  fs.mkdirSync(path.dirname(accessFile(root)), { recursive: true });
  fs.writeFileSync(accessFile(root), JSON.stringify(a, null, 2));
}

export function clearAccess(root = process.cwd()): void {
  try {
    fs.rmSync(accessFile(root), { force: true });
  } catch {
    // A record that cannot be removed is handled by the expiry, which is the thing that matters.
  }
}

/**
 * Whether this record still opens the door.
 *
 * A record with no expiry, an unreadable one, or one whose time has passed is closed. There is no
 * "assume it is fine" branch here by design: every uncertain answer is the safe one.
 */
export function isOpen(a: PublicAccess | null, now = new Date()): boolean {
  if (!a) return false;
  const ends = Date.parse(a.expiresAt);
  return Number.isFinite(ends) && ends > now.getTime();
}

export function minutesLeft(a: PublicAccess | null, now = new Date()): number {
  if (!isOpen(a, now)) return 0;
  return Math.max(0, Math.ceil((Date.parse(a!.expiresAt) - now.getTime()) / 60_000));
}

/**
 * Turns a requested duration into an expiry, refusing anything longer than the ceiling.
 *
 * Asked for a fortnight, it gives eight hours. The point is not to second-guess the person — it is
 * that "a little while" and "until I remember to turn it off" are the same input, and only one of
 * them is what anybody means.
 */
export function expiryFor(hours: number, now = new Date()): string {
  const capped = Math.min(Math.max(hours, 0.25), MAX_HOURS);
  return new Date(now.getTime() + capped * 3_600_000).toISOString();
}

/**
 * The origins server actions may be called from.
 *
 * Next checks the Origin of a server action against the host it thinks it is serving, and a tunnel
 * makes those two different things: the browser says the tunnel's address, the app sees localhost.
 * Without this every page renders perfectly and every button does nothing — the exact shape of
 * fault that has already cost this pharmacy two days, so it is settled here rather than discovered.
 */
export function allowedOrigins(url: string | null | undefined): string[] {
  if (!url) return [];
  try {
    const u = new URL(url);
    // Next matches on host, with and without the port, so both spellings go in.
    return u.port ? [u.host, u.hostname] : [u.host];
  } catch {
    return [];
  }
}
