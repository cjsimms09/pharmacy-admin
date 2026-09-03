import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSettings, setSetting } from "./settings";
import { decryptText, encryptText, newId } from "./crypto";
import { storeFile, ALLOWED_MIME, MAX_FILE_BYTES } from "./files";
import { classify, parseSupplierRules, supplierFor } from "./autoroute";
import { importClaims } from "./claims";
import { importSupplierCatalog } from "./suppliers";
import { loadNadacFiles, nadacDir } from "./nadac";
import { gateFile } from "./phi-gate";
import { audit } from "./audit";
import { matchTrainingReplies, completeByEmailReply } from "./training-replies";

/**
 * Sweeps the pharmacy's admin mailbox for scheduled reports.
 *
 * Rules:
 *  - Only messages from an allowed sender are processed; anything else is left unread and recorded
 *    as "ignored" so nothing arrives in the app by accident.
 *  - Every attachment passes the ingestion gate before it is stored (see phi-gate.ts).
 *  - Processed messages are marked read so the same report is never handled twice; the message id
 *    is also recorded, so a re-sent report cannot create a duplicate.
 *  - The password is a Google app password, stored encrypted, never rendered back to the browser.
 */

const ATTACHMENT_MIME = new Set([
  ...ALLOWED_MIME,
  "text/csv",
  "text/plain",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream", // Gmail sends some report types this way; the extension check below decides
]);
const ATTACHMENT_EXT = /\.(pdf|csv|tsv|txt|xls|xlsx|jpg|jpeg|png)$/i;

export class MailNotConfiguredError extends Error {
  constructor() {
    super("The mailbox isn't set up yet. Add the address and app password under Settings → Email.");
  }
}

export async function saveMailPassword(password: string) {
  await setSetting("mail_password_enc", encryptText(password.replace(/\s+/g, "")));
}
export async function clearMailPassword() {
  await setSetting("mail_password_enc", "");
}
export async function hasMailPassword(): Promise<boolean> {
  const s = await getSettings();
  return Boolean(s.mail_password_enc);
}

export function allowedSendersOf(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function senderAllowed(from: string, allowed: string[]): boolean {
  const f = from.toLowerCase();
  return allowed.some((a) => (a.startsWith("@") ? f.endsWith(a) : f === a));
}

async function connect(): Promise<ImapFlow> {
  const s = await getSettings();
  if (!s.mail_user || !s.mail_password_enc) throw new MailNotConfiguredError();
  const client = new ImapFlow({
    host: s.mail_host || "imap.gmail.com",
    port: Number(s.mail_port || 993),
    secure: true,
    auth: { user: s.mail_user, pass: decryptText(s.mail_password_enc) },
    logger: false,
    socketTimeout: 120_000,
  });
  await client.connect();
  return client;
}

export async function testMailbox(): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  let client: ImapFlow | null = null;
  try {
    client = await connect();
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    return { ok: true, detail: `Connected. ${box.exists} message${box.exists === 1 ? "" : "s"} in the inbox.` };
  } catch (e) {
    return { ok: false, error: describeMailError(e) };
  } finally {
    await client?.logout().catch(() => {});
  }
}

export function describeMailError(e: unknown): string {
  if (e instanceof MailNotConfiguredError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(msg)) {
    return "Gmail rejected the sign-in. Use a 16-character App password (not the normal account password), and make sure 2-Step Verification is on for that Google account.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
    return "Could not reach the mail server. Check the computer's internet connection and the server address under Settings → Email.";
  }
  return msg.split("\n")[0];
}

export type SweepResult = { stored: number; rejected: number; ignored: number; imported: number; errors: string[] };

/** Reads new mail, stores allowed attachments, and records everything it saw. */
export async function sweepMailbox(ctx: { userId: string | null; userName: string | null }): Promise<SweepResult> {
  const s = await getSettings();
  const allowed = allowedSendersOf(s.mail_allowed_senders);
  const result: SweepResult = { stored: 0, rejected: 0, ignored: 0, imported: 0, errors: [] };
  let client: ImapFlow | null = null;
  try {
    client = await connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      const uids = (unseen || []).slice(-50); // newest 50 unread, so a backlog can't stall the sweep
      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const from = parsed.from?.value?.[0]?.address?.toLowerCase() ?? "";
          const messageId = parsed.messageId ?? `uid-${uid}`;
          const subject = (parsed.subject ?? "").slice(0, 300);
          const receivedAt = (parsed.date ?? new Date()).toISOString();

          const already = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.messageId, messageId) });
          if (already) continue;

          // A member of staff replying to their own training email is not a report sender and
          // will not be on the allowed list. Check it first, and match on the code *and* the
          // address so a forwarded code from somebody else cannot close somebody's training.
          const trainingMatches = await matchTrainingReplies({
            from,
            subject,
            text: `${parsed.text ?? ""}\n${parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ") : ""}`,
          });
          if (trainingMatches.length > 0) {
            const closed: string[] = [];
            for (const m of trainingMatches) {
              try {
                const done = await completeByEmailReply(m.assignmentId, {
                  from,
                  subject,
                  text: parsed.text ?? "",
                  receivedAt,
                  raw: msg.source.toString("utf8"),
                });
                closed.push(`${done.label} for ${done.personName}`);
              } catch (e) {
                result.errors.push(`Training reply from ${from}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            if (closed.length > 0) {
              await db.insert(schema.inboxItems).values({
                id: newId(),
                messageId,
                receivedAt,
                fromAddress: from,
                subject,
                status: "stored",
                reason: `Training attestation recorded — ${closed.join("; ")}. The reply itself is filed as the evidence.`,
              });
              result.stored++;
            }
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
            continue;
          }

          if (allowed.length > 0 && !senderAllowed(from, allowed)) {
            await db.insert(schema.inboxItems).values({
              id: newId(),
              messageId,
              receivedAt,
              fromAddress: from || "(unknown)",
              subject,
              status: "ignored",
              reason: "Sender is not on the allowed list, so the message was left unread and nothing was stored.",
            });
            result.ignored++;
            continue;
          }

          const attachments = (parsed.attachments ?? []).filter(
            (a) => a.filename && ATTACHMENT_EXT.test(a.filename) && ATTACHMENT_MIME.has(a.contentType ?? ""),
          );
          if (attachments.length === 0) {
            await db.insert(schema.inboxItems).values({
              id: newId(),
              messageId,
              receivedAt,
              fromAddress: from,
              subject,
              status: "ignored",
              reason: "No report attachment on this message.",
            });
            result.ignored++;
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
            continue;
          }

          for (const att of attachments) {
            const fileName = att.filename!;
            const buf = att.content as Buffer;
            const itemId = newId();
            if (buf.length > MAX_FILE_BYTES) {
              await db.insert(schema.inboxItems).values({ id: itemId, messageId: `${messageId}#${fileName}`, receivedAt, fromAddress: from, subject, fileName, status: "rejected", reason: "Attachment is larger than 20 MB." });
              result.rejected++;
              continue;
            }
            const gate = gateFile(fileName, buf);
            if (!gate.ok) {
              await db.insert(schema.inboxItems).values({ id: itemId, messageId: `${messageId}#${fileName}`, receivedAt, fromAddress: from, subject, fileName, status: "rejected", reason: gate.reason, scanned: true });
              result.rejected++;
              await audit({ action: "inbox.rejected", userId: ctx.userId, userName: ctx.userName, details: `${fileName}: ${gate.reason}` });
              continue;
            }
            const file = new File([new Uint8Array(buf)], fileName, { type: att.contentType || "application/octet-stream" });
            const stored = await storeFile(file, { allowReportTypes: true });
            const docId = newId();
            await db.insert(schema.documents).values({
              id: docId,
              category: "report",
              title: subject || fileName,
              fileName,
              mimeType: stored.mimeType,
              sizeBytes: stored.sizeBytes,
              sha256: stored.sha256,
              storageKey: stored.storageKey,
              inboxItemId: itemId,
              notes: `Received by email from ${from}`,
              uploadedBy: ctx.userId ?? "mailbox-sweep",
            });
            // ── Auto-import ────────────────────────────────────────
            // The attachment is filed as a document either way. If it is also recognisable as a
            // report the site knows how to read, load it now so a scheduled report becomes
            // usable without anyone opening it. Anything unrecognised, or any failure, leaves
            // the document exactly as it was — the fallback is the behaviour we already had.
            let routedAs: string | null = null;
            let routeResult: string | null = null;
            if ((s.mail_auto_import ?? "").toLowerCase() === "yes") {
              const cls = classify(fileName, buf);
              routedAs = cls.kind;
              try {
                if (cls.kind === "claims") {
                  const r = await importClaims(buf, fileName, ctx.userId ?? "mailbox-sweep");
                  routeResult = `${r.claimsAdded} claims added, ${r.duplicates} already held, ${r.skipped} skipped`;
                  result.imported++;
                } else if (cls.kind === "supplier_catalog") {
                  const supplier = supplierFor(parseSupplierRules(s.mail_supplier_rules ?? ""), from, subject);
                  if (!supplier) {
                    routeResult =
                      "Recognised as a supplier price file, but no rule says which supplier it came from. " +
                      "Add one in Settings → Email, then load it from Purchasing.";
                  } else {
                    const r = await importSupplierCatalog(buf, fileName, supplier, ctx.userId ?? "mailbox-sweep");
                    routeResult = `${supplier}: ${r.itemsAdded} new, ${r.itemsUpdated} updated, ${r.skipped} skipped`;
                    result.imported++;
                  }
                } else if (cls.kind === "nadac") {
                  const dir = nadacDir();
                  await fs.mkdir(dir, { recursive: true });
                  await fs.writeFile(path.join(dir, path.basename(fileName).replace(/[^A-Za-z0-9._-]/g, "_")), buf);
                  const reports = await loadNadacFiles();
                  const added = reports.reduce((n, r) => n + r.added, 0);
                  routeResult = `${added.toLocaleString()} NADAC prices added`;
                  result.imported++;
                } else {
                  routeResult = cls.why;
                }
              } catch (e) {
                // A failed import must not lose the document or stop the sweep.
                routeResult = `Filed, but could not be loaded: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
              }
            }

            await db.insert(schema.inboxItems).values({
              id: itemId,
              messageId: `${messageId}#${fileName}`,
              receivedAt,
              fromAddress: from,
              subject,
              fileName,
              documentId: docId,
              status: "stored",
              scanned: gate.scanned,
              reason: gate.note ?? null,
              routedAs,
              routeResult,
            });
            result.stored++;
          }
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        } catch (e) {
          result.errors.push(e instanceof Error ? e.message.split("\n")[0] : String(e));
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    result.errors.push(describeMailError(e));
  } finally {
    await client?.logout().catch(() => {});
  }
  const summary = `${result.stored} stored, ${result.rejected} rejected, ${result.ignored} ignored${result.errors.length ? `, ${result.errors.length} error(s)` : ""}`;
  await setSetting("mail_last_sweep", new Date().toISOString());
  await setSetting("mail_last_result", result.errors.length ? `${summary} — ${result.errors[0]}` : summary);
  await audit({ action: "inbox.sweep", userId: ctx.userId, userName: ctx.userName, details: summary });
  return result;
}
