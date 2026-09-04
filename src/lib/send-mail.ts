import "server-only";
import nodemailer from "nodemailer";
import { getSettings, setSetting } from "./settings";
import { decryptText } from "./crypto";

/**
 * Sending mail, using the same mailbox the site already reads.
 *
 * One account, one app password, one thing for the pharmacy to set up. Training links go out from
 * the address staff already recognise as the pharmacy's, which matters more than it sounds: a
 * compliance link from an unfamiliar sender is a link nobody clicks.
 *
 * Reading and sending are not the same server, and the original code assumed they were — it took
 * the IMAP host, swapped a leading "imap." for "smtp.", and hard-coded port 465. That is right for
 * Gmail and wrong for most other things: Office 365 reads from outlook.office365.com and sends
 * from smtp.office365.com on 587 with STARTTLS, and nothing about the first name turns into the
 * second. So the plausible combinations are tried in order and the one that worked is remembered,
 * which turns "it did not arrive" from a mystery into a line of text.
 */

export type SendResult = { ok: true; via: string } | { ok: false; error: string; tried?: string[] };

export async function canSend(): Promise<boolean> {
  const s = await getSettings();
  return Boolean(s.mail_user && s.mail_password_enc);
}

type Target = { host: string; port: number; secure: boolean };

/**
 * Where to try sending from, best guess first.
 *
 * An explicit setting always wins — there is no cleverness that beats being told. After that the
 * providers a pharmacy actually uses are named outright rather than pattern-matched, because a
 * wrong guess here fails in the worst possible way: silently, from the user's point of view.
 */
export function smtpTargets(s: { mail_host?: string; mail_user?: string; mail_smtp_host?: string; mail_smtp_port?: string }): Target[] {
  const explicitHost = (s.mail_smtp_host ?? "").trim();
  const explicitPort = Number((s.mail_smtp_port ?? "").trim());
  if (explicitHost) {
    const port = Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : 465;
    return [{ host: explicitHost, port, secure: port === 465 }];
  }

  const imap = (s.mail_host ?? "").trim().toLowerCase();
  const domain = (s.mail_user ?? "").split("@")[1]?.toLowerCase() ?? "";

  const known: Record<string, Target[]> = {
    "gmail.com": [{ host: "smtp.gmail.com", port: 465, secure: true }],
    "googlemail.com": [{ host: "smtp.gmail.com", port: 465, secure: true }],
    "outlook.com": [{ host: "smtp-mail.outlook.com", port: 587, secure: false }],
    "hotmail.com": [{ host: "smtp-mail.outlook.com", port: 587, secure: false }],
    "live.com": [{ host: "smtp-mail.outlook.com", port: 587, secure: false }],
    "yahoo.com": [{ host: "smtp.mail.yahoo.com", port: 465, secure: true }],
    "aol.com": [{ host: "smtp.aol.com", port: 465, secure: true }],
    "fastmail.com": [{ host: "smtp.fastmail.com", port: 465, secure: true }],
    "zoho.com": [{ host: "smtp.zoho.com", port: 465, secure: true }],
  };
  if (known[domain]) return known[domain];

  const out: Target[] = [];
  const push = (host: string) => {
    if (!host) return;
    out.push({ host, port: 465, secure: true });
    out.push({ host, port: 587, secure: false });
  };

  // Office 365 and similar read from a host that shares no stem with the sending one.
  if (imap.includes("office365") || imap.includes("outlook.office")) push("smtp.office365.com");
  if (imap.startsWith("imap.")) push(imap.replace(/^imap\./, "smtp."));
  else if (imap.startsWith("mail.")) push(imap.replace(/^mail\./, "smtp."));
  if (imap) push(imap);
  if (domain) push(`smtp.${domain}`);

  // Dedupe, first occurrence wins, so the best guess stays first.
  const seen = new Set<string>();
  return out.filter((t) => {
    const k = `${t.host}:${t.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Something sent with the message.
 *
 * Training packets go out this way, which is the point: an email that says "do your HIPAA
 * training" and links to a page proves the pharmacy asked. An email carrying the material proves
 * the pharmacy provided it, and that is the difference between a training record and training.
 */
export type Attachment = { filename: string; content: string | Buffer; contentType?: string };

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  attachments: Attachment[] = [],
  html?: string,
): Promise<SendResult> {
  const s = await getSettings();

  /*
   * Every way this can fail has to leave a trace.
   *
   * These early returns did not record anything, so the two most diagnostic failures — no account
   * configured, and a password that cannot be decrypted — left the last-send result untouched.
   * A pharmacy in that state read as "nothing has been sent yet" on every screen rather than as
   * broken, which is the difference between looking at it and not.
   */
  const record = async (error: string): Promise<SendResult> => {
    await setSetting("mail_last_send_result", `${new Date().toISOString()} — FAILED to ${to || "(no address)"}. ${error}`);
    return { ok: false, error };
  };

  if (!s.mail_user || !s.mail_password_enc) {
    return record("Email is not set up yet. Settings → Email.");
  }
  if (!to?.trim()) return record("No address to send to.");

  let password: string;
  try {
    password = decryptText(s.mail_password_enc);
  } catch {
    return record("The stored mail password cannot be read — the encryption key changed.");
  }

  // Whatever worked last time is tried first; a working configuration should not be rediscovered
  // on every send.
  const targets = smtpTargets(s);
  const remembered = (s.mail_smtp_working ?? "").trim();
  const ordered = remembered
    ? [
        ...targets.filter((t) => `${t.host}:${t.port}` === remembered),
        ...targets.filter((t) => `${t.host}:${t.port}` !== remembered),
      ]
    : targets;

  const tried: string[] = [];
  for (const t of ordered) {
    const label = `${t.host}:${t.port}`;
    try {
      const transport = nodemailer.createTransport({
        host: t.host,
        port: t.port,
        secure: t.secure,
        auth: { user: s.mail_user, pass: password },
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 60_000,
      });
      // Both parts, always, when an HTML version exists: the plain text is what a phone's
      // notification preview shows and what survives a client that blocks markup, and an email
      // whose fallback is empty looks broken in exactly the situations where it matters most.
      await transport.sendMail({
        from: s.mail_user,
        to,
        subject,
        text,
        html,
        attachments: attachments.length ? attachments : undefined,
      });
      if (label !== remembered) await setSetting("mail_smtp_working", label);
      await setSetting("mail_last_send_result", `${new Date().toISOString()} — sent to ${to} via ${label}`);
      return { ok: true, via: label };
    } catch (e) {
      tried.push(`${label} → ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }

  const error = `Could not send. Tried: ${tried.join("; ")}`;
  await setSetting("mail_last_send_result", `${new Date().toISOString()} — FAILED to ${to}. ${error}`);
  return { ok: false, error, tried };
}

/**
 * Proves the pharmacy can actually send, which nothing else here did.
 *
 * The site could read a mailbox and say so, and could send mail with no way at all to find out
 * whether it had — so a training email that never arrived looked identical to one that was never
 * attempted. This sends a real message and reports exactly which host answered, or exactly what
 * every one of them said when it refused.
 */
export async function sendTestEmail(to: string): Promise<SendResult> {
  const s = await getSettings();
  const target = to.trim() || s.mail_user || "";
  if (!target) return { ok: false, error: "Enter an address to send the test to." };

  return sendMail(
    target,
    "Test from the pharmacy compliance desk",
    [
      "This is a test.",
      "",
      "If you are reading it, the site can send mail — training links, reminders and the",
      "escalation notices will all reach people from this address.",
      "",
      `Sent ${new Date().toLocaleString()} from ${s.pharmacy_name || "the pharmacy"}.`,
    ].join("\n"),
  );
}
