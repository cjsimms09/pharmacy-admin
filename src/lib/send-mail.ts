import "server-only";
import nodemailer from "nodemailer";
import { getSettings } from "./settings";
import { decryptText } from "./crypto";

/**
 * Sending mail, using the same mailbox the site already reads.
 *
 * One account, one app password, one thing for the pharmacy to set up. Training links go out
 * from the address staff already recognise as the pharmacy's, which matters more than it sounds:
 * a compliance link from an unfamiliar sender is a link nobody clicks.
 */

export type SendResult = { ok: true } | { ok: false; error: string };

export async function canSend(): Promise<boolean> {
  const s = await getSettings();
  return Boolean(s.mail_user && s.mail_password_enc);
}

export async function sendMail(to: string, subject: string, text: string): Promise<SendResult> {
  const s = await getSettings();
  if (!s.mail_user || !s.mail_password_enc) {
    return { ok: false, error: "Email is not set up yet. Settings → Email." };
  }
  let password: string;
  try {
    password = decryptText(s.mail_password_enc);
  } catch {
    return { ok: false, error: "The stored mail password cannot be read — the encryption key changed." };
  }

  // The SMTP host mirrors the IMAP one for the providers a pharmacy actually uses.
  const host = (s.mail_host || "imap.gmail.com").replace(/^imap\./, "smtp.");
  try {
    const transport = nodemailer.createTransport({
      host,
      port: 465,
      secure: true,
      auth: { user: s.mail_user, pass: password },
    });
    await transport.sendMail({ from: s.mail_user, to, subject, text });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}
