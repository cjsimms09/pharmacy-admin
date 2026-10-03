import "server-only";
import { and, gt, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { sendMail } from "./send-mail";
import { getSettings, setSetting } from "./settings";
import { readAccess, writeAccess, isOpen, timeLeft } from "./public-access";
import { audit } from "./audit";

/**
 * Telling the pharmacist-in-charge, repeatedly, that the site is still open to the internet.
 *
 * An exposure lasting an afternoon needs a red stripe on the page and nothing else: whoever opened
 * it is in the building and will close it before going home. An exposure lasting a fortnight needs
 * something different, because a stripe seen every morning for two weeks stops being read by about
 * the third day. That is not carelessness, it is how warnings work.
 *
 * So three things arrive by email, and each answers a question that is otherwise unanswerable from
 * where the pharmacist is standing:
 *
 * The address changed. A quick tunnel does not survive two weeks — Cloudflare drops it and hands
 * back a different address — and the pharmacist cannot pass on an address they have not been told.
 * Without this the site is up, working, and unreachable by the person it was opened for.
 *
 * It is still open. Once a day, with the date it ends, so closing early is always one press away
 * and the run never quietly becomes permanent.
 *
 * Somebody is guessing at the login. This is the one that matters. Five wrong passwords now block
 * an account (login-throttle.ts), but blocking silently means an attack looks exactly like nothing
 * happening. A door onto the internet with nobody watching it is the thing that turns a considered
 * decision into a bad one, so this watches it.
 */

/** Failures inside this window make a burst worth mentioning. */
const ATTACK_WINDOW_MINUTES = 60;

/** Blocked attempts in that window before the pharmacist is told. */
const ATTACK_THRESHOLD = 3;

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function recipient(): Promise<string | null> {
  const people = await db.query.people.findMany();
  return people.find((p) => p.isPic)?.email ?? null;
}

/**
 * Runs on the site's ordinary background beat. Never throws: a notice that cannot be sent must
 * never be the reason a pharmacy cannot open its records.
 */
export async function publicAccessNotices(now = new Date()): Promise<{ sent: string[]; reason: string }> {
  const sent: string[] = [];
  const access = readAccess();
  if (!isOpen(access, now)) return { sent, reason: "Not open to the internet." };

  const to = await recipient();
  if (!to) return { sent, reason: "No pharmacist-in-charge with an email address is on file." };

  const s = await getSettings();
  const ends = new Date(access!.expiresAt).toLocaleString();
  const where = access!.url ?? "(still coming up)";

  /* ── The address changed, so the person who needs it is told what it is now ── */
  if (access!.url && s.public_access_last_url !== access!.url) {
    const first = !s.public_access_last_url;
    const r = await sendMail(
      to,
      first ? "The pharmacy site is now reachable from outside" : "The pharmacy site's outside address has changed",
      [
        first
          ? "The site has been opened to the internet, as asked for."
          : "The tunnel dropped and came back on a different address. The old one no longer works — this is the one to use and to pass on.",
        "",
        `Address: ${where}`,
        `Opened for: ${access!.reason}`,
        `Closes: ${ends} (${timeLeft(access, now)} from now)`,
        "",
        "Anyone with that address reaches the pharmacy's real records and only the login stands in front of them.",
        "To close it now: Settings, Use from another computer, Close it now. Or press Close it now on the red stripe at the top of any page.",
      ].join("\n"),
    );
    if (r.ok) {
      await setSetting("public_access_last_url", access!.url);
      sent.push("address");
    }
  }

  /* ── It is still open, once a day ── */
  if (access!.noticedOn !== today(now)) {
    const r = await sendMail(
      to,
      `The pharmacy site is still open to the internet — closes ${ends}`,
      [
        `The site has been reachable from outside since ${new Date(access!.requestedAt).toLocaleString()}.`,
        "",
        `Address: ${where}`,
        `Opened for: ${access!.reason}`,
        `Opened by: ${access!.requestedBy}`,
        `Closes on its own: ${ends} — ${timeLeft(access, now)} from now.`,
        "",
        "This message arrives once a day for as long as it is open, so the run cannot quietly become permanent.",
        "To close it now: Settings, Use from another computer, Close it now.",
      ].join("\n"),
    );
    if (r.ok) {
      writeAccess({ ...access!, noticedOn: today(now) });
      sent.push("daily");
    }
  }

  /* ── Somebody is guessing at the login ── */
  const since = new Date(now.getTime() - ATTACK_WINDOW_MINUTES * 60_000).toISOString();
  const blocked = await db
    .select({ at: schema.auditEvents.at, details: schema.auditEvents.details })
    .from(schema.auditEvents)
    .where(and(gt(schema.auditEvents.at, since), inArray(schema.auditEvents.action, ["login.blocked"])));

  if (blocked.length >= ATTACK_THRESHOLD) {
    // Told once an hour at most: an alarm that arrives every minute is an alarm that gets filtered.
    const lastTold = s.public_access_attack_told ?? "";
    if (lastTold < since) {
      const accounts = [...new Set(blocked.map((b) => (b.details ?? "").replace(/^username=/, "").split(" ")[0]))];
      const r = await sendMail(
        to,
        "Somebody is trying passwords against the pharmacy site",
        [
          `${blocked.length} login attempts have been blocked in the last hour while the site is open to the internet.`,
          `Account${accounts.length === 1 ? "" : "s"} being tried: ${accounts.join(", ")}`,
          "",
          "Each account stops answering after five wrong passwords in fifteen minutes, so nothing has been broken into by guessing.",
          "But this is what an attack looks like, and the site is currently reachable from anywhere.",
          "",
          "If this was not you or somebody in the pharmacy: close the outside access now.",
          "Settings, Use from another computer, Close it now — or the red stripe at the top of any page.",
          "",
          `Address currently open: ${where}`,
          "Every attempt is in the audit log.",
        ].join("\n"),
      );
      if (r.ok) {
        await setSetting("public_access_attack_told", now.toISOString());
        await audit({ action: "public_access.attack_reported", details: `${blocked.length} blocked attempts, accounts: ${accounts.join(", ")}` });
        sent.push("attack");
      }
    }
  }

  return { sent, reason: sent.length ? `Sent: ${sent.join(", ")}.` : "Nothing new to say." };
}
