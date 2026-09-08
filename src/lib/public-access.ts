import fs from "node:fs";
import path from "node:path";

/**
 * Letting the site be reached from outside the pharmacy, on purpose and for a stated length of time.
 *
 * This is the real database. Every contract, every claim, the prescription numbers, the DEA and
 * NPI numbers, the staff records. So the whole design here is about the two ways this goes wrong
 * in practice, neither of which is somebody deciding to do it:
 *
 * It gets left on. So exposure is never open-ended: it carries an expiry it cannot outlive, and the
 * launcher closes it when the clock runs out whether or not anybody remembers. It does survive a
 * restart, up to that expiry — over a run measured in weeks the machine will reboot for its own
 * reasons, and an exposure that had to be re-opened by hand every time would simply be re-opened
 * by hand every time, with less thought each time. The date it ends is the control, not the reboot.
 *
 * And it gets forgotten. A site that looks identical whether or not the world can see it is a site
 * somebody will type a password into without thinking. So while it is open the app says so on every
 * page, in a colour nobody can ignore, with the time remaining and the way to stop it — and over a
 * long run it says so by email once a day as well, because a stripe you have seen every morning for
 * a fortnight is a stripe you have stopped reading.
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
  /**
   * The day a "this is still open" notice last went out.
   *
   * A fortnight is long enough that the thing keeping this safe is not the expiry — it is somebody
   * being told, every day, that it is still open. Kept on the record rather than in settings so it
   * travels with the exposure and resets when a new one begins.
   */
  noticedOn?: string | null;
};

/**
 * Nothing may be exposed for longer than this in one go, whatever is asked for.
 *
 * Three weeks, because the work this exists for is measured in weeks and a ceiling that forces
 * somebody to re-open it every eight hours is a ceiling they will route around — the real risk is
 * not the length of the window, it is a window nobody is watching. So the length went up and the
 * watching came with it: a notice every day it is still open, and an alarm the moment somebody
 * starts guessing at the login.
 *
 * It is still a ceiling and not a default. A run this long ends on a date, and the date is on the
 * screen from the first day.
 */
export const MAX_HOURS = 21 * 24;

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
 * The time remaining, said the way a person would say it.
 *
 * "20,160 minutes" is a number nobody converts. Over a fortnight the useful unit is days; on the
 * last afternoon it is hours, and in the last hour it is minutes — because that is when the figure
 * starts mattering again.
 */
export function timeLeft(a: PublicAccess | null, now = new Date()): string {
  const mins = minutesLeft(a, now);
  if (mins <= 0) return "no time";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/**
 * Turns a requested duration into an expiry, refusing anything longer than the ceiling.
 *
 * The point is not to second-guess the person. It is that "a little while" and "until I remember to
 * turn it off" are the same input, and only one of them is ever what anybody means — so every
 * exposure ends on a date somebody chose, even the ones nobody thinks about again.
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
