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
import { importPioneerCatalog } from "./suppliers";
import { importRxTransactions, describeTransactionImport } from "./claims";
import { describeFileName } from "./pioneer-catalog";
import { acceptableAttachment } from "./autoroute";
import { importSupplierCatalog } from "./suppliers";
import { allSuppliers, supplierForSender } from "./suppliers-registry";
import { loadNadacFiles, nadacDir } from "./nadac";
import { gateFile } from "./phi-gate";
import { audit } from "./audit";
import { matchTrainingReplies, completeByEmailReply } from "./training-replies";
import { matchCertificateReply, fileCertificateReply } from "./credential-requests";
import { isBounce, parseBounce, describeBounce } from "./bounces";
import { looksLikeInvoice, fileInvoice, filingFor } from "./invoices";

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
  /*
   * The supplier register, read once for the whole sweep.
   *
   * Retired suppliers are included deliberately. An invoice arriving from a wholesaler the
   * pharmacy has stopped buying from is still a record it has to keep, and refusing to recognise
   * the sender would file it as an ordinary report — commingled with everything else, which is
   * the one outcome 1304.04(h)(1) does not allow.
   */
  const register = await allSuppliers(true);
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

          /*
           * Never consume our own outgoing mail.
           *
           * Where a member of staff's address is the same mailbox this site reads — the
           * pharmacist-in-charge, usually — a training email sent to them lands right back here as
           * unread mail. The sweep would then open it, decide it was not a report, and mark it
           * read: the message arrives and silently stops being new, which from the far side looks
           * exactly like an email that never came. Left untouched and unread, so it behaves like
           * any other message in the mailbox.
           */
          const self = (s.mail_user ?? "").trim().toLowerCase();
          if (self && from === self) {
            continue;
          }

          /*
           * A bounce is checked before anything else.
           *
           * It comes from mailer-daemon, which is not on the allowed-senders list, so it used to
           * be filed as "ignored" and never seen — the one message that knows why a training
           * email never arrived, discarded, while the screen went on saying the email was sent.
           *
           * It also quotes the original message back, reply code and all, so leaving it to fall
           * through to the training-reply matcher is asking for trouble.
           */
          const headerBlock = msg.source.toString("utf8").split(/\r?\n\r?\n/)[0] ?? "";
          const bodyText = `${parsed.text ?? ""}\n${parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ") : ""}`;
          if (isBounce({ from, subject, text: bodyText, headers: headerBlock })) {
            const b = parseBounce({ from, subject, text: bodyText });
            const note = describeBounce(b);
            let attached = "";
            if (b.recipient) {
              const person = (await db.query.people.findMany()).find(
                (x) => (x.email ?? "").toLowerCase() === b.recipient,
              );
              if (person) {
                // Mark what they were owed as undelivered, so it shows against them rather than
                // only in a mailbox nobody reads.
                const open = await db.query.trainingAssignments.findMany({
                  where: eq(schema.trainingAssignments.personId, person.id),
                });
                for (const a of open.filter((x) => !x.completedAt)) {
                  await db
                    .update(schema.trainingAssignments)
                    .set({ sendError: note, sentAt: b.permanent ? null : a.sentAt })
                    .where(eq(schema.trainingAssignments.id, a.id));
                }
                attached = ` Marked against ${person.firstName} ${person.lastName}.`;
              } else {
                attached = " No member of staff has that address on file.";
              }
            }
            await db.insert(schema.inboxItems).values({
              id: newId(),
              messageId,
              receivedAt,
              fromAddress: from || "(unknown)",
              subject,
              status: "stored",
              reason: `Delivery failure. ${note}${attached}`,
            });
            result.stored++;
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
            continue;
          }

          /*
           * A member of staff sending in the certificate they were asked for.
           *
           * Checked alongside the training replies and before the allowed-senders list, for the
           * same reason: staff are not report senders and will never be on that list, so the one
           * message that closes the gap would otherwise be filed as "ignored".
           *
           * Matched on the code and the sender's own address together. A code forwarded to
           * somebody else must not be able to file a certificate under the wrong name — that is
           * the document an inspector asks to see.
           */
          const certMatches = await matchCertificateReply({ from, subject, text: bodyText });
          if (certMatches.length > 0) {
            const certAttachments = (parsed.attachments ?? []).filter(
              (a) => a.filename && ATTACHMENT_EXT.test(a.filename) && ATTACHMENT_MIME.has(a.contentType ?? ""),
            );
            const filed: string[] = [];
            for (const m of certMatches) {
              const att = certAttachments.shift();
              if (!att) {
                // They replied with the code and forgot the photo. Say so rather than closing it.
                await db.insert(schema.inboxItems).values({
                  id: newId(),
                  messageId: `${messageId}#${m.requestId}`,
                  receivedAt,
                  fromAddress: from,
                  subject,
                  status: "ignored",
                  reason: `${m.personName} replied about their ${m.type} but attached nothing, so the request is still open.`,
                });
                result.ignored++;
                continue;
              }
              try {
                const buf = att.content as Buffer;
                const fileName = att.filename!;
                const file = new File([new Uint8Array(buf)], fileName, {
                  type: att.contentType || "application/octet-stream",
                });
                const stored = await storeFile(file, { allowReportTypes: true });
                const docId = newId();
                await db.insert(schema.documents).values({
                  id: docId,
                  category: "license",
                  title: `${m.personName} — sent in by email`,
                  fileName,
                  mimeType: file.type,
                  sizeBytes: buf.length,
                  storageKey: stored.storageKey,
                  sha256: stored.sha256,
                  uploadedBy: m.personName,
                });
                await fileCertificateReply(m.requestId, docId, { name: m.personName });
                filed.push(`${m.personName}'s ${m.type}`);
              } catch (e) {
                result.errors.push(`Certificate from ${from}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            if (filed.length > 0) {
              await db.insert(schema.inboxItems).values({
                id: newId(),
                messageId,
                receivedAt,
                fromAddress: from,
                subject,
                status: "stored",
                reason: `Certificate filed — ${filed.join("; ")}. The record is created with the dates blank; enter them from the document.`,
              });
              result.stored++;
            }
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
            continue;
          }

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
                closed.push(
                  done.insufficient
                    ? `${done.label} for ${done.personName} — reply filed, but this training is not closed by it: the bloodborne standard asks for questions and answers with somebody who knows the subject, which an email cannot show. They have been told what is still needed and the reminders continue.`
                    : `${done.label} for ${done.personName}`,
                );
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
                reason: `Training reply handled — ${closed.join("; ")}. The reply itself is filed as the evidence.`,
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

          const verdicts = (parsed.attachments ?? []).map((a) => ({ a, v: acceptableAttachment({ filename: a.filename, contentType: a.contentType, content: a.content as Buffer }) }));
          const attachments = verdicts.filter((x) => x.v.ok).map((x) => x.a);
          if (attachments.length === 0) {
            // Say what was on the message, not just that nothing usable was. On the first Sunday
            // the scheduled files arrive, this line is how somebody finds out they came as a zip.
            const declined = verdicts.filter((x) => !x.v.ok).map((x) => (x.v as { why: string }).why);
            await db.insert(schema.inboxItems).values({
              id: newId(),
              messageId,
              receivedAt,
              fromAddress: from,
              subject,
              status: "ignored",
              reason: declined.length
                ? `Nothing on this message was a type this reads: ${declined.slice(0, 5).join("; ")}${declined.length > 5 ? "; …" : ""}.`
                : "No attachment on this message.",
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
            /*
             * A supplier invoice takes a different path, and has to take it here.
             *
             * 21 CFR 1304.04(h)(1) requires Schedule II records to be kept separately from every
             * other record the registrant holds. Filing the invoice as an ordinary report first
             * and sorting it afterwards would mean it was, however briefly, commingled — and
             * "we moved it later" is not what separately maintained means. So the schedule is
             * decided before anything is written, and the invoice is only ever in one place.
             */
            /*
             * Who sent it: the register first, the old settings line only as a fallback.
             *
             * The register knows the addresses against a named supplier, which is what lets an
             * invoice be filed under that supplier's identity rather than under a string somebody
             * typed. The free-text rules stay honoured so a pharmacy that has not moved its
             * suppliers across yet goes on filing invoices exactly as before.
             */
            const matched = supplierForSender(register, from);
            const supplierName =
              matched?.name ?? supplierFor(parseSupplierRules(s.mail_supplier_rules ?? ""), from, subject);
            if (
              looksLikeInvoice({
                fileName,
                mimeType: att.contentType ?? "",
                subject,
                supplier: supplierName,
              })
            ) {
              try {
                const filed = await fileInvoice(
                  buf,
                  {
                    fileName,
                    mimeType: att.contentType ?? "application/pdf",
                    supplier: supplierName,
                    supplierId: matched?.id ?? null,
                    from: from || "(unknown)",
                    subject,
                  },
                  { userId: ctx.userId ?? "mailbox-sweep", userName: ctx.userName ?? "Automatic check" },
                );
                const where = filingFor(filed.schedule).label;
                await db.insert(schema.inboxItems).values({
                  id: itemId,
                  messageId: `${messageId}#${fileName}`,
                  receivedAt,
                  fromAddress: from || "(unknown)",
                  subject,
                  fileName,
                  documentId: filed.documentId,
                  status: "stored",
                  reason: filed.needsReview
                    ? `Supplier invoice, held with the Schedule II records until somebody confirms what it carries.`
                    : `Supplier invoice, filed under ${where}, kept apart from every other record.`,
                  scanned: true,
                });
                result.stored++;
                await audit({
                  action: "invoice.filed",
                  userId: ctx.userId,
                  userName: ctx.userName,
                  entity: "document",
                  entityId: filed.documentId,
                  details: `${supplierName ?? "supplier"} · ${filed.schedule}`,
                });
                await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
                continue;
              } catch (e) {
                // Falls through to the ordinary path. An invoice filed as a report is visible and
                // fixable; an invoice dropped on the floor is not.
                await audit({
                  action: "invoice.failed",
                  userId: ctx.userId,
                  userName: ctx.userName,
                  details: `${fileName}: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
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
            if ((s.mail_auto_import ?? "").toLowerCase() !== "yes") {
              // Filed, and the line says why it went no further — otherwise a scheduled report that
              // arrives with the switch off looks identical to one that arrived and failed.
              routeResult = "Filed only: automatic loading is switched off under Settings → Email.";
            } else {
              const r = await importRecognised(buf, fileName, from, subject, s, ctx);
              routedAs = r.routedAs;
              routeResult = r.routeResult;
              if (r.imported) result.imported++;
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

/**
 * Loads a stored attachment as whatever the site recognises it to be, and says what happened.
 *
 * Shared by the sweep, at the moment a message arrives, and by "Read again" on the Inbox, after
 * somebody has changed a rule — so both take exactly the same path, and a file that failed on
 * arrival and loads on a second reading did so for the reason the person changed, not because
 * the two paths differ.
 */
async function importRecognised(
  buf: Buffer,
  fileName: string,
  from: string,
  subject: string,
  s: Awaited<ReturnType<typeof getSettings>>,
  ctx: { userId?: string | null; userName?: string | null },
): Promise<{ routedAs: string; routeResult: string | null; imported: boolean }> {
  const cls = classify(fileName, buf);
  let routeResult: string | null = null;
  let imported = false;
  try {
    if (cls.kind === "claims") {
      const r = await importClaims(buf, fileName, ctx.userId ?? "mailbox-sweep");
      routeResult = `${r.claimsAdded} claims added, ${r.duplicates} already held, ${r.skipped} skipped`;
      imported = true;
    } else if (cls.kind === "rx_transactions") {
      // The daily claims feed. Paid rows become claims, reversals cancel the claims they name,
      // unsold rows wait for the day they sell.
      const r = await importRxTransactions(buf, fileName, ctx.userId ?? "mailbox-sweep");
      routeResult = describeTransactionImport(r);
      if (r.claimsAdded || r.reversed) imported = true;
    } else if (cls.kind === "pioneer_catalog") {
      // Names its own supplier inside the file, so no sender rule is needed — and the filename
      // is checked against it, so MCKCatalog carrying IPD prices is refused.
      const r = await importPioneerCatalog(buf, fileName, ctx.userId ?? "mailbox-sweep");
      const loaded = r.suppliers
        .map((x) => `${x.supplier}: ${x.itemsAdded.toLocaleString()} new, ${x.itemsUpdated.toLocaleString()} repriced${x.shortDated ? `, ${x.shortDated} short-dated lots noted` : ""}${x.rebated !== null ? `, ${x.rebated.toLocaleString()} rebated` : ", no rebate column"}`)
        .join("; ");
      const bits = [
        r.suppliers.length ? loaded + (r.pricedOn ? ` (prices as of ${r.pricedOn})` : "") : "Recognised as a PioneerRx catalogue but nothing could be loaded.",
        ...r.problems,
        describeFileName(fileName),
      ];
      routeResult = bits.join(" ");
      if (r.suppliers.length) imported = true;
    } else if (cls.kind === "supplier_catalog") {
      const supplier = supplierFor(parseSupplierRules(s.mail_supplier_rules ?? ""), from, subject);
      if (!supplier) {
        routeResult =
          "Recognised as a supplier price file, but no rule says which supplier it came from. " +
          "Add one in Settings → Email, then load it from Purchasing.";
      } else {
        const r = await importSupplierCatalog(buf, fileName, supplier, ctx.userId ?? "mailbox-sweep");
        routeResult = `${supplier}: ${r.itemsAdded} new, ${r.itemsUpdated} updated, ${r.skipped} skipped`;
        imported = true;
      }
    } else if (cls.kind === "nadac") {
      const dir = nadacDir();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, path.basename(fileName).replace(/[^A-Za-z0-9._-]/g, "_")), buf);
      const reports = await loadNadacFiles();
      const added = reports.reduce((n, r) => n + r.added, 0);
      routeResult = `${added.toLocaleString()} NADAC prices added`;
      imported = true;
    } else {
      routeResult = cls.why;
    }
  } catch (e) {
    // A failed import must not lose the document or stop the sweep.
    routeResult = `Filed, but could not be loaded: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  }
  return { routedAs: cls.kind, routeResult, imported };
}

/**
 * Reads a stored attachment again, with today's rules.
 *
 * The case that needed it: an invoice from a supplier whose sending address was not yet on the
 * register arrived, was not recognised as an invoice, and was filed as an ordinary report. The
 * pharmacist then added the address. Nothing re-read the message — it was marked read, its id
 * recorded, and the sweep rightly never touches a message twice. This is the second reading: the
 * same bytes, the same decisions as on arrival, with whatever has changed since. An invoice
 * recognised this time is filed where its schedule says and the misfiled copy is withdrawn; a
 * report recognised this time is loaded; and the Inbox line is rewritten to say what happened.
 */
export async function rereadInboxItem(itemId: string, ctx: { userId: string; userName: string }): Promise<string> {
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item) throw new Error("That inbox line no longer exists.");
  if (!item.documentId) throw new Error("Nothing was stored for this line, so there is nothing to read again. If the sender was not allowed, add the address and have the report sent again.");
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, item.documentId) });
  if (!doc) throw new Error("The stored document has been removed, so there is nothing to read again.");
  if (doc.category.startsWith("invoice")) return "This is already filed as a supplier invoice.";

  const { readFile, deleteFile } = await import("./files");
  const buf = await readFile(doc.storageKey);
  const s = await getSettings();
  const register = await allSuppliers(true);
  const from = item.fromAddress;
  const subject = item.subject;
  const fileName = item.fileName ?? doc.fileName;
  const stamp = new Date().toLocaleString();

  const matched = supplierForSender(register, from);
  const supplierName = matched?.name ?? supplierFor(parseSupplierRules(s.mail_supplier_rules ?? ""), from, subject);
  if (looksLikeInvoice({ fileName, mimeType: doc.mimeType, subject, supplier: supplierName })) {
    const filed = await fileInvoice(
      buf,
      { fileName, mimeType: doc.mimeType || "application/pdf", supplier: supplierName, supplierId: matched?.id ?? null, from, subject },
      ctx,
    );
    // Withdraw the misfiled copy. The row goes; the bytes go only if nothing else points at them.
    const others = await db.query.documents.findMany({ where: eq(schema.documents.storageKey, doc.storageKey), columns: { id: true } });
    await db.delete(schema.documents).where(eq(schema.documents.id, doc.id));
    if (others.every((o) => o.id === doc.id)) await deleteFile(doc.storageKey).catch(() => {});
    const where = filingFor(filed.schedule).label;
    const text = filed.needsReview
      ? `Read again ${stamp}: supplier invoice from ${supplierName ?? "a supplier"}, held with the Schedule II records until somebody confirms what it carries.`
      : `Read again ${stamp}: supplier invoice from ${supplierName ?? "a supplier"}, filed under ${where}, kept apart from every other record.`;
    await db.update(schema.inboxItems).set({ documentId: filed.documentId, routedAs: "invoice", routeResult: text, reason: null }).where(eq(schema.inboxItems.id, itemId));
    await audit({ action: "invoice.filed", userId: ctx.userId, userName: ctx.userName, entity: "document", entityId: filed.documentId, details: `${supplierName ?? "supplier"} · ${filed.schedule} · read again from the inbox` });
    return text;
  }

  const r = await importRecognised(buf, fileName, from, subject, s, ctx);
  const text = `Read again ${stamp}: ${r.routeResult ?? (r.routedAs === "unrecognised" ? "still not recognised" : r.routedAs)}`;
  await db.update(schema.inboxItems).set({ routedAs: r.routedAs, routeResult: text }).where(eq(schema.inboxItems.id, itemId));
  await audit({ action: "inbox.reread", userId: ctx.userId, userName: ctx.userName, details: `${fileName}: ${text.slice(0, 200)}` });
  return text;
}

/**
 * Reads again every stored, un-filed line from the given sender addresses.
 *
 * Called when a supplier's addresses are saved, so that setting the address once is the whole
 * job: the invoice that arrived before the address was known is filed the moment the address is,
 * with nobody pressing anything on the Inbox. Only lines that were stored and not already filed as
 * invoices are touched; a bare domain matches the way it does on arrival.
 */
export async function rereadFromSenders(addresses: string[], ctx: { userId: string; userName: string }): Promise<{ read: number; filed: number }> {
  const wanted = addresses.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return { read: 0, filed: 0 };
  const items = await db.query.inboxItems.findMany({ where: eq(schema.inboxItems.status, "stored"), orderBy: (i, { desc }) => [desc(i.receivedAt)], limit: 500 });
  let read = 0;
  let filed = 0;
  for (const it of items) {
    if (!it.documentId || it.routedAs === "invoice") continue;
    const from = it.fromAddress.toLowerCase();
    if (!wanted.some((a) => from.includes(a))) continue;
    try {
      const text = await rereadInboxItem(it.id, ctx);
      read++;
      if (/supplier invoice/i.test(text)) filed++;
    } catch {
      // One line that cannot be re-read must not stop the others.
    }
  }
  return { read, filed };
}
