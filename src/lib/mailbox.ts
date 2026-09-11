import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { eq, like } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSettings, setSetting } from "./settings";
import { decryptText, encryptText, newId } from "./crypto";
import { storeFile, ALLOWED_MIME, MAX_FILE_BYTES } from "./files";
import { classify, parseSupplierRules, supplierFor, unknownSenderInvoiceReason, type RouteKind } from "./autoroute";
import { importClaims } from "./claims";
import { importPioneerCatalog } from "./suppliers";
import { importRxTransactions, describeTransactionImport } from "./claims";
import { describeFileName } from "./pioneer-catalog";
import { acceptableAttachment } from "./autoroute";
import { importSupplierCatalog } from "./suppliers";
import { allSuppliers, supplierForSender } from "./suppliers-registry";
import { loadNadacFiles, nadacDir } from "./nadac";
import { gateFile } from "./phi-gate";
import { pdfText } from "./pdf-text";
import { audit } from "./audit";
import { matchTrainingReplies, completeByEmailReply } from "./training-replies";
import { matchCertificateReply, fileCertificateReply } from "./credential-requests";
import { isBounce, parseBounce, describeBounce } from "./bounces";
import { looksLikeInvoice, classifySupplierDocument, fileInvoice, filingFor, looksLikeInvoiceFromUnknownSender, classifyInvoiceText } from "./invoices";

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

  /*
   * Anything the ceiling turned away comes back first, before new mail is even fetched.
   *
   * The loop this closes: the cost ceiling is reached, a report that arrives every day is filed
   * unread, the pharmacist raises the ceiling — and nothing brings the held reports back, because
   * the sweep only ever looks at unread mail and that message was read days ago. Doing it here
   * means raising the ceiling is the whole of the fix, and nobody has to remember which reports
   * were held.
   */
  try {
    const held = await retryHeldByBudget({ userId: ctx.userId ?? "mailbox-sweep", userName: ctx.userName ?? "Automatic check" });
    result.imported += held.loaded;
    if (held.retried > 0 && held.loaded === 0 && held.stillHeld > 0) {
      result.errors.push(`${held.stillHeld} report${held.stillHeld === 1 ? "" : "s"} held by the monthly ceiling could still not be read.`);
    }
  } catch (e) {
    result.errors.push(`Could not retry the reports held by the ceiling: ${e instanceof Error ? e.message : String(e)}`);
  }

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
              routedAs: "bounce",
              routeResult: "A message this mailbox sent came back.",
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
                  /*
                   * A reply about training is a training reply, attachment or not. It was read and
                   * understood; what is missing is the certificate, and the row says so. Leaving
                   * `routedAs` empty made it read as a file nobody could recognise.
                   */
                  routedAs: "training_reply",
                  routeResult: `Read, but nothing was attached — the request is still open.`,
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
                routedAs: "certificate",
                routeResult: `Filed — ${filed.join("; ")}.`,
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
              /*
               * Say what it was handled as, not only that something happened.
               *
               * This recorded a perfectly good outcome in `reason` — seven attestations closed, the
               * reply filed as the evidence — and left `routedAs` empty. The inbox reads an empty
               * `routedAs` as "filed, not recognised", so six replies that had been handled exactly
               * right sat on the owner's needs-you list, and they were the whole of that list.
               *
               * It is the third time today the same shape has turned up: work that succeeded and a
               * record of it that said otherwise. Invoices marked unrecognised after being filed, an
               * invoice reporting no item lines over fifty-seven stored rows, and this.
               */
              await db.insert(schema.inboxItems).values({
                id: newId(),
                messageId,
                receivedAt,
                fromAddress: from,
                subject,
                status: "stored",
                routedAs: "training_reply",
                routeResult: `${closed.join("; ")}. The reply itself is filed as the evidence.`,
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
              /* A decision, not a failure to understand: the sender is not one this mailbox reads. */
              routedAs: "not_for_filing",
              routeResult: "Sender is not on the allowed list, so it was left unread.",
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
              /*
               * Looked at and deliberately passed over — a postage receipt, a note with nothing on
               * it. That is an answer, and it is not "this file was not recognised". Two Endicia
               * purchase confirmations sat on his needs-you list for three days on the strength of
               * that one empty field.
               */
              routedAs: "not_for_filing",
              routeResult: declined.length ? "Nothing on it was a type this reads." : "Nothing was attached.",
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
              await db.insert(schema.inboxItems).values({ id: itemId, messageId: `${messageId}#${fileName}`, receivedAt, fromAddress: from, subject, fileName, status: "rejected", routedAs: "rejected", routeResult: "Larger than 20 MB, so it was not stored.", reason: "Attachment is larger than 20 MB." });
              result.rejected++;
              continue;
            }
            const gate = gateFile(fileName, buf);
            if (!gate.ok) {
              await db.insert(schema.inboxItems).values({ id: itemId, messageId: `${messageId}#${fileName}`, receivedAt, fromAddress: from, subject, fileName, status: "rejected", routedAs: "rejected", routeResult: gate.reason, reason: gate.reason, scanned: true });
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
            /*
             * The document's own words, where it is a PDF and they can be read.
             *
             * Read once, here, because two decisions below need them: whether this is really an
             * invoice, and if not, what else it is.
             */
            const pdfWords = (() => {
              if (!/\.pdf$/i.test(fileName) && att.contentType !== "application/pdf") return null;
              try {
                return pdfText(buf);
              } catch {
                return null;
              }
            })();
            if (
              looksLikeInvoice({
                fileName,
                mimeType: att.contentType ?? "",
                subject,
                supplier: supplierName,
                text: pdfWords,
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
                  /*
                   * Say what it was filed as, not only that something happened.
                   *
                   * This wrote a perfectly good outcome into `reason` — "Supplier invoice, filed under
                   * Schedule II, kept apart from every other record" — and left `routedAs` empty. The
                   * inbox reads an empty `routedAs` as "not recognised", so seven McKesson invoices that
                   * had been read, classified and filed at twenty to four this morning sat on his
                   * needs-you list saying the file was not recognised:
                   *
                   * > "its still not recognizing invoices that get emailed form mckesson. in inbox saying
                   * > file not recognized"
                   *
                   * It is the third time this exact shape has appeared — the handled training replies,
                   * the ParMed invoice that went on saying its lines could not be read, and now this.
                   * Work that succeeded, and a record of it that said otherwise.
                   */
                  routedAs: "invoice",
                  routeResult: filed.needsReview
                    ? `Filed with the Schedule II records until you confirm what it carries.`
                    : `Filed under ${where}.`,
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

            /*
             * What a supplier sent that is not an invoice, filed as what it is.
             *
             * A statement of account and a rebate breakdown were both landing under "report", the
             * heading for everything the site has no better word for — which is how a statement
             * came to be filed as an invoice in the first place and then had nowhere to go when it
             * was taken back out. Naming it costs nothing and means the Documents list can be
             * asked for the account statements without anybody remembering the file name.
             */
            const supplierKind = supplierName ? classifySupplierDocument(pdfWords, fileName, subject).kind : "unknown";
            const asStatement = supplierKind === "statement" || supplierKind === "rebate_report" || supplierKind === "credit_memo";

            /*
             * A supplier invoice from an address nobody has registered.
             *
             * `looksLikeInvoice` begins `if (!opts.supplier) return false`, so a PDF from a sender
             * the register cannot place can never be filed as an invoice however plainly the page
             * says INVOICE. McKesson's own register row has no sending address on it at all, so a
             * McKesson invoice arriving this afternoon would fall into the general vault as
             * "report" — the pharmacy would go on believing its purchase records were complete,
             * every figure built on invoice lines would be short without saying so, and a supplier
             * invoice would be sitting among ordinary documents, which is the outcome
             * 21 CFR 1304.04(h)(1) does not allow.
             *
             * So it is raised rather than filed. The predicate is session 2's and is deliberately
             * narrow: the document's own words must classify as an invoice — two or more lines each
             * carrying an NDC and a price — and a scan with no text layer answers false. The
             * subject line is not evidence here, because it was written by whoever sent the email
             * and the whole question is that we do not know who that is.
             *
             * Nothing is filed as an invoice on the strength of this. An unknown sender is exactly
             * when a person should decide, and the control to say who it is already exists on the
             * line: naming them writes the address onto the register, and the next one files
             * itself.
             */
            const unknownSenderInvoice = looksLikeInvoiceFromUnknownSender({
              fileName,
              mimeType: att.contentType || "",
              subject,
              supplier: supplierName,
              text: pdfWords,
            });
            const printedSupplier = unknownSenderInvoice && pdfWords ? classifyInvoiceText(pdfWords).supplier : null;
            const kindWord =
              supplierKind === "rebate_report" ? "rebate breakdown" : supplierKind === "credit_memo" ? "credit memo" : "statement of account";

            const file = new File([new Uint8Array(buf)], fileName, { type: att.contentType || "application/octet-stream" });
            const stored = await storeFile(file, { allowReportTypes: true });
            const docId = newId();
            await db.insert(schema.documents).values({
              id: docId,
              category: asStatement ? "supplier_statement" : "report",
              title: asStatement ? `${supplierName} ${kindWord}${subject ? ` — ${subject}` : ""}` : subject || fileName,
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
            /*
             * "unrecognised" is the honest starting point: the reader has looked and not yet placed it.
             * It was null, which the inbox reads the same way but which also covers "nobody said" — and
             * that ambiguity is what turned three kinds of successful filing into a failure on screen.
             */
            let routedAs = "unrecognised";
            let routeResult: string | null = null;
            if ((s.mail_auto_import ?? "").toLowerCase() !== "yes") {
              // Filed, and the line says why it went no further — otherwise a scheduled report that
              // arrives with the switch off looks identical to one that arrived and failed.
              routeResult = "Filed only: automatic loading is switched off under Settings → Email.";
            } else {
              const r = await importRecognised(buf, fileName, from, subject, s, ctx, { documentId: docId, supplierId: matched?.id ?? null, supplierName: supplierName ?? null });
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
              reason:
                gate.note ??
                (asStatement
                  ? `Not an invoice: a ${kindWord} from ${supplierName}, filed under supplier statements. It records no goods received, so it is kept out of the invoice files.`
                  : unknownSenderInvoice
                    ? unknownSenderInvoiceReason(from, printedSupplier)
                    : null),
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
/**
 * A file somebody dropped on the site, put through exactly the path an emailed one takes.
 *
 * The drop zone sent everything to Claude to be classified, which is right for a licence
 * photographed on a phone and wrong for a report whose first line is its own title. A claims file
 * dropped there was read as an unrecognised document and filed — so the same file loaded itself
 * when it arrived by email and did nothing when it was dragged onto the page, which is exactly the
 * sort of inconsistency that makes somebody stop trusting a tool.
 *
 * The deterministic reader goes first because it is free and certain. Anything it does not know is
 * still Claude's to read.
 */
export async function importDropped(
  buf: Buffer,
  fileName: string,
  ctx: { userId?: string | null; userName?: string | null },
  documentId?: string | null,
  /*
   * What a person says this is, overriding what the recogniser made of it.
   *
   * The owner: "I NEED TO BE ABLE TO MAKE SURE IT DID THE RIGHT THING WITH THE DOCUMENT AND NEED TO
   * BE ABLE TO FIX ANY ISSUES WITH HOW IT WAS RECEIVED OR SORTED." Until now a wrong decision was a
   * dead end — the line explained itself and there was nothing to press. This is what makes the
   * Inbox's re-route possible: the same loading path the sweep uses, told the answer rather than
   * asked for one.
   *
   * Absent, everything behaves exactly as before. Present, the recogniser is not consulted at all,
   * because the whole point is that a person is overruling it.
   */
  forceKind?: RouteKind,
): Promise<{ recognised: boolean; routedAs: string; routeResult: string | null; imported: boolean }> {
  const cls = forceKind ? { kind: forceKind, why: "", headers: [] } : classify(fileName, buf);
  if (cls.kind === "unrecognised") return { recognised: false, routedAs: cls.kind, routeResult: cls.why, imported: false };
  const s = await getSettings();
  const r = await importRecognised(buf, fileName, "", fileName, s, ctx, { documentId: documentId ?? null }, forceKind);
  return { recognised: true, ...r };
}

async function importRecognised(
  buf: Buffer,
  fileName: string,
  from: string,
  subject: string,
  s: Awaited<ReturnType<typeof getSettings>>,
  ctx: { userId?: string | null; userName?: string | null },
  /*
   * The document already filed for these bytes, and the supplier who sent them.
   *
   * Both were missing, and both mattered. Without the document id a rebate report was filed with
   * its ladder and no page behind it — the supplier's own screen then said "the report itself was
   * not kept". Without the supplier the ladder went to whichever row matched /mckesson/i.
   */
  filed?: { documentId?: string | null; supplierId?: string | null; supplierName?: string | null },
  /** Set where a person has overruled the recogniser from the Inbox. See `importDropped`. */
  forceKind?: RouteKind,
): Promise<{ routedAs: string; routeResult: string | null; imported: boolean }> {
  /* Who, if anybody, has claimed this sender as their own. */
  const vendorBill = async (addr: string) => {
    const { vendors, vendorForSender } = await import("./expenses");
    return vendorForSender(addr, await vendors());
  };

  // A person's answer if there is one, the recogniser's otherwise. See `importDropped`.
  const cls = forceKind ? { kind: forceKind, why: "", headers: [] } : classify(fileName, buf);
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
      // A file over the threshold — the twelve-month history — imports in a process of its own so
      // the sweep, and the site, keep answering; the daily file imports inline as before.
      const { importClaimsFile } = await import("./claims-import-job");
      const outcome = await importClaimsFile({ buf, fileName, user: { id: ctx.userId ?? "mailbox-sweep", name: ctx.userName ?? "Automatic check" } });
      if (outcome.apart) {
        routeResult = outcome.message;
        imported = outcome.started;
      } else {
        routeResult = describeTransactionImport(outcome.report);
        if (outcome.report.claimsAdded || outcome.report.reversed) imported = true;
      }
    } else if (await vendorBill(from)) {
      /*
       * A bill from somebody the pharmacy has told us about.
       *
       * Checked before the generic readers, because a Stamps.com PDF has a header row about as much
       * as a wholesaler catalogue does and would otherwise land in "unrecognised". The rule is the
       * vendor's own sender address, so the pharmacist says "bills from here are postage" once.
       *
       * Filed as a draft with no amount. Reading a total off an arbitrary vendor's PDF is a guess
       * with a number attached, and a guess that walks straight into the month's profit is worse
       * than no figure — so it waits for somebody to agree with it.
       */
      const v = (await vendorBill(from))!;
      const { saveExpense } = await import("./expenses");
      await saveExpense({
        vendorId: v.id,
        categoryId: v.categoryId,
        // The day it arrived, until somebody reads the bill and says otherwise.
        invoiceDate: new Date().toISOString().slice(0, 10),
        amountCents: v.typicalCents ?? 1,
        description: subject || fileName,
        documentId: filed?.documentId ?? null,
        status: "draft",
        source: "email",
        createdBy: ctx.userName ?? "mailbox-sweep",
      });
      routeResult = `A bill from ${v.name}, filed as a draft under ${v.categoryId ? "its usual category" : "no category yet"}. Nothing counts on the month until somebody confirms the amount — reading a total off a PDF is a guess with a number attached.`;
      imported = true;
    } else if (cls.kind === "rxrescue_credit") {
      /*
       * Top-off money applied to the fills it names. Idempotent on the memo's own transaction ids,
       * because an emailed memo gets forwarded and swept more than once, and money applied twice to
       * a claim is not something anybody re-checks.
       */
      const { importRxRescueCredit } = await import("./claim-payments");
      const r = await importRxRescueCredit(buf, fileName, { name: ctx.userName ?? "mailbox-sweep" });
      /*
       * What the memo settled, what is genuinely new money, and whether the rule that separates
       * them still holds — said every time, because a rule nobody re-tests is a rule that will be
       * wrong silently.
       */
      const bits = [
        r.applied
          ? `${money(r.totalCents)} of RxRescue credit applied across ${r.applied} line${r.applied === 1 ? "" : "s"}${r.memoId ? ` (memo ${r.memoId})` : ""}. Only the top-off part moves a margin — the copay assistance settles what the claim was already adjudicated for, so counting all of it would book that money twice.`
          : "No new credit lines on this memo.",
        r.check
          ? r.check.decisive === 0
            ? "Nothing on this memo could re-test that: every line with a claim to compare has a zero top-off, where the assistance and the whole credit are the same number and agree with either reading."
            : r.check.verdict === "the top-off is new money"
              ? `${r.check.decisive} line${r.check.decisive === 1 ? "" : "s"} could settle it, and confirmed it: the claim carried the assistance alone.`
              : null
          : null,
        r.matched < r.applied ? `${r.applied - r.matched} name a prescription this site has not loaded yet; they attach themselves when it arrives.` : null,
        r.alreadyHeld ? `${r.alreadyHeld} were already applied from an earlier copy of this memo.` : null,
        ...r.problems,
      ].filter(Boolean);
      routeResult = bits.join(" ");
      if (r.applied) imported = true;
    } else if (cls.kind === "on_hand") {
      /*
       * The day's shelf, filed against the date it counts rather than the date it arrived.
       *
       * A snapshot, not a ledger: the same day sent twice is the same shelf, so it replaces. The
       * date is read off the file where it prints one; where it does not, nothing is filed, because
       * a count dated a day out misplaces a whole day of dispensing and would then recommend
       * sending back stock that has already gone.
       */
      const { fileOnHand } = await import("./shelf");
      const r = await fileOnHand(buf, fileName, { userId: ctx.userId ?? "mailbox-sweep" }, { documentId: filed?.documentId ?? null });
      if (r.ok) {
        routeResult =
          `${r.items.toLocaleString()} items counted on ${r.countedOn}` +
          (r.replaced ? ", replacing the earlier upload for that day" : "") +
          (r.unmappedColumns.length ? `. Columns not used: ${r.unmappedColumns.join(", ")}` : "") +
          ".";
        imported = true;
      } else {
        routeResult = `Recognised as an inventory count but nothing was filed: ${r.why}`;
      }
    } else if (cls.kind === "payer_payments") {
      /*
       * Banked in the month it was deposited, once per payment.
       *
       * The report is a date range and a date range gets re-run — the same week with a day added,
       * or last month forwarded again — so each payment is keyed on the payer's own payment number
       * and a payment already held adds nothing. Without that this file would inflate revenue every
       * time it landed, which on the cash account is the error that matters most.
       */
      const { importPayerPayments } = await import("./payer-payments-store");
      const r = await importPayerPayments(buf.toString("utf8"), {
        userId: ctx.userId ?? null,
        userName: "mailbox sweep",
        fileName,
        documentId: filed?.documentId ?? null,
      });
      if (r.ok) {
        routeResult =
          r.banked === 0
            ? `No new payments: ${r.alreadyHeld > 0 ? `all ${r.alreadyHeld} were already banked` : "the report covered a period with no deposits"}.`
            : `${money(r.bankedCents)} banked across ${r.banked} payment${r.banked === 1 ? "" : "s"}` +
              `${r.from ? `, ${r.from} to ${r.to}` : ""}` +
              `${r.alreadyHeld ? `; ${r.alreadyHeld} already held` : ""}` +
              `${r.skipped.length ? `; ${r.skipped.length} row${r.skipped.length === 1 ? "" : "s"} not read` : ""}.`;
        imported = r.banked > 0;
      } else {
        routeResult = `Recognised as a payer payment report but nothing was banked: ${r.why}`;
      }
    } else if (cls.kind === "accrual_sales") {
      /*
       * Recognised, kept, and honestly described as not yet counted.
       *
       * The alternative — filing it silently among the documents — is how a report somebody goes to
       * the trouble of sending every month gets assumed to be feeding a figure it is not feeding.
       */
      /*
       * A month's takings, filed against the month rather than added to it.
       *
       * The same month re-run after a correction is still one month; appending it would report the
       * pharmacy as having taken twice what it did, which is the worst arithmetic error available.
       */
      const { fileSystemSales } = await import("./sales-store");
      const r = await fileSystemSales(buf, fileName, ctx.userId ?? "mailbox-sweep", filed?.documentId ?? null);
      routeResult = r.problems.length
        ? `Recognised as the System Sales Summary but nothing was filed: ${r.problems.join(" ")}`
        : `${r.month}: ${money(r.totalCents ?? 0)} taken in total, retail and prescriptions together${r.replaced ? " — replacing the copy already held for that month" : ""}.`;
      if (r.problems.length === 0) imported = true;
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
    } else if (cls.kind === "rebate_report") {
      // The tier ladder and the month's achieved rate, filed without anybody typing either — with
      // the report kept beside it so the bands can be checked against the page they came from.
      const { fileRebateReport } = await import("./rebate-report-store");
      const { pdfText } = await import("./pdf-text");
      const r = await fileRebateReport(
        pdfText(buf),
        { documentId: filed?.documentId ?? null, supplierId: filed?.supplierId ?? null },
        { name: ctx.userName ?? "Automatic check" },
      );
      routeResult = r.message;
      imported = r.stored;
    } else if (cls.kind === "purchase_drilldown") {
      /*
       * Where the compliance ratio stands today.
       *
       * This arrives every day and it is the figure that prices an order: the band it falls in
       * sets the discount on every contract generic. Read on arrival so the answer is already
       * right the first time anybody asks it, rather than a month behind.
       */
      const { filePurchaseDrillDown } = await import("./purchase-ratio");
      /*
       * Read from the document's own text first, and only ask for judgement if that fails.
       *
       * This report decides what a generic costs, and it arrives every morning. Sending it to a
       * model made it cost money, need a key, and — the morning this was written — stop being read
       * at all, because the month's spending ceiling had been reached. The layout is regular and
       * the report checks its own arithmetic, so none of that is necessary.
       */
      const { readDrillDown } = await import("./drill-down-read");
      const direct = readDrillDown(buf);
      if (direct.months.length > 0 && direct.problems.length === 0) {
        const current = direct.months[0];
        const r = await filePurchaseDrillDown(
          {
            generatedOn: direct.generatedOn,
            currentMonth: current.month,
            currentGcrPercent: current.gcrPercent,
            currentOsRxPercent: current.osRxPercent,
            currentOsGxPercent: current.osGxPercent,
            scrubbed: direct.scrubbed,
            exclusions: direct.exclusions,
            months: direct.months.map((m) => ({
              month: m.month,
              gcrPercent: m.gcrPercent,
              osRxPercent: m.osRxPercent,
              netPurchasesCents: m.netPurchasesCents,
            })),
          },
          { documentId: filed?.documentId ?? null, supplierId: filed?.supplierId ?? null },
        );
        routeResult =
          `${r.message} Read from the report itself — no judgement needed, so this cannot be stopped by the cost ceiling.` +
          (direct.scrubbed === true
            ? ` Its exclusions are ${direct.exclusions}, which is McKesson's own scrub, so this ratio picks the rebate band.`
            : direct.scrubbed === false
              ? ` Its exclusions are ${direct.exclusions} — narrower than McKesson settles on, so this is a position and the statement still picks the band.`
              : " It does not print its exclusions, so it is held as a position only.");
        imported = r.stored;
      } else {
        const { readPurchaseDrillDown } = await import("./ai");
        const read = await readPurchaseDrillDown(buf, { userId: ctx.userId ?? "mailbox-sweep", userName: ctx.userName ?? "Automatic check" });
        const r = await filePurchaseDrillDown(read, { documentId: filed?.documentId ?? null, supplierId: filed?.supplierId ?? null });
        routeResult =
          `${r.message} The layout could not be read directly (${direct.problems.join(" ") || "no month rows found"}), so it was read by Claude.` +
          (read.unclear.length ? ` Left unsettled: ${read.unclear.join("; ")}` : "");
        imported = r.stored;
      }
    } else if (cls.kind === "return_policy") {
      /*
       * A returned goods policy, read against the supplier who sent it.
       *
       * It proposes; it never stores. A return window decides whether a bottle goes back or into
       * the bin, and the terms are set from the supplier's own page once somebody has checked each
       * figure against the sentence it was read from. The PDF is kept either way.
       */
      if (!filed?.supplierId) {
        routeResult =
          "Recognised as a returned goods policy, but the address it came from is not on any supplier's record, so there is " +
          "nobody to file it against. Add the address under Suppliers and press Read again.";
      } else {
        const { readReturnPolicy } = await import("./ai");
        const read = await readReturnPolicy(buf, filed.supplierName ?? "this supplier", {
          userId: ctx.userId ?? "mailbox-sweep",
          userName: ctx.userName ?? "Automatic check",
        });
        await setSetting(
          "returns_policy_draft",
          JSON.stringify({ ...read, supplierId: filed.supplierId, fileName, readAt: new Date().toISOString(), documentId: filed.documentId ?? null }),
        );
        const steps = read.creditStepsFromInvoice.length;
        routeResult =
          `Read as ${filed.supplierName ?? "the supplier"}'s returned goods policy. ` +
          (steps
            ? `${steps} credit step${steps === 1 ? "" : "s"} from the invoice date, ${read.nonReturnable.length} things they will not take back. `
            : "") +
          "Nothing is stored yet — open the supplier's terms page, check each figure against the sentence it came from, and save.";
        imported = true;
      }
    } else if (cls.kind === "remittance_835") {
      // A remittance, from the SFTP mailbox or an email: read through the 835 reader, which stores
      // nothing from a file whose claim lines do not add up to its own total (claim-payments.ts).
      const { importRemittance } = await import("./claim-payments");
      const r = await importRemittance(buf.toString("utf8"), fileName, { name: ctx.userName ?? "Automatic check", id: ctx.userId ?? undefined }, { bank: true, documentId: filed?.documentId ?? null });
      const gate = r.problems.find((p) => /does not balance/i.test(p));
      routeResult = gate
        ? `Held, nothing stored: ${gate}`
        : `${r.payer ?? "Remittance"}${r.paidOn ? ` paid ${r.paidOn}` : ""}: ${r.payments} payments (${money(r.amountCents)}) — ${r.matched} matched to a claim, ${r.unmatched} held unmatched${r.paidAReversedFill ? `, ${r.paidAReversedFill} paid against a fill this pharmacy had reversed` : ""}, ${r.alreadyHeld} already held${r.banked ? ", banked" : ""}${r.problems.length ? `; ${r.problems.slice(0, 2).join("; ")}` : ""}`;
      imported = !gate && r.payments > 0;
    } else if (cls.kind === "copay_remit") {
      /*
       * A copay-voucher remittance, from the SFTP host or from an email. The same treatment as an
       * 835 and for the same reason: the reader stores nothing from a statement whose rows do not
       * add to the total it prints, or that prints no total at all to add to.
       */
      const { importCopayRemit } = await import("./copay-remit-store");
      const c = await importCopayRemit(buf.toString("utf8"), fileName, { name: ctx.userName ?? "Automatic check", id: ctx.userId ?? undefined }, { bank: true, documentId: filed?.documentId ?? null });
      const held = c.problems.find((p) => /^Held, nothing stored/i.test(p));
      routeResult = held
        ? held
        : `${c.payer}${c.paidOn ? ` paid ${c.paidOn}` : ""}: ${c.payments} payment${c.payments === 1 ? "" : "s"} (${money(c.amountCents)}) — ${c.matched} settled a claim, ${c.beforeTheStart} for fills before this site's records begin, ${c.unmatched} held unmatched, ${c.alreadyHeld} already held${c.reversedPairs ? `, ${c.reversedPairs} paid and reversed` : ""}${c.banked ? ", banked" : ""}`;
      imported = !held && c.payments > 0;
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
    const first = e instanceof Error ? e.message.split("\n")[0] : String(e);
    /*
     * A refusal on cost is not a failure to read, and must not be filed as one.
     *
     * The document is fine, the reader is fine, and the only thing wrong is that the month's
     * ceiling has been reached. Marked so it can be found again: raising the ceiling should bring
     * back everything it turned away, without the pharmacist having to remember which reports
     * those were. A daily report — the Purchase Drill Down that prices every order — is exactly
     * the one nobody would notice had quietly stopped arriving.
     */
    const { AiCapReachedError } = await import("./ai");
    routeResult =
      e instanceof AiCapReachedError
        ? `${BUDGET_MARK} ${first} The file is kept and will be read on the next check once the ceiling allows it.`
        : `Filed, but could not be loaded: ${first}`;
  }
  return { routedAs: cls.kind, routeResult, imported };
}

/**
 * How a "we did not read this because of the ceiling" line is recognised again later.
 *
 * A marker rather than a search for the wording, so rephrasing the sentence somebody reads cannot
 * quietly break the retry that depends on it.
 */
export const BUDGET_MARK = "[held: monthly ceiling]";

/**
 * Re-reads everything the cost ceiling turned away, once it no longer does.
 *
 * Run at the start of every sweep, so the loop closes itself: the ceiling is raised, the next
 * check picks up the reports that were held, and nothing depends on anybody remembering which
 * ones they were. Returns silently when the ceiling is still reached — retrying then would only
 * rewrite the same line with the same reason.
 */
export async function retryHeldByBudget(ctx: { userId: string; userName: string }): Promise<{ retried: number; loaded: number; stillHeld: number }> {
  const { monthlyCap } = await import("./ai-spend");
  const limit = await monthlyCap().catch(() => null);
  if (!limit || limit.over) return { retried: 0, loaded: 0, stillHeld: 0 };

  const held = await db.query.inboxItems.findMany({
    where: like(schema.inboxItems.routeResult, `${BUDGET_MARK}%`),
  });
  let loaded = 0;
  let stillHeld = 0;
  for (const item of held) {
    try {
      const text = await rereadInboxItem(item.id, ctx);
      if (text.includes(BUDGET_MARK)) stillHeld++;
      else loaded++;
    } catch {
      // One document that will not read again must not stop the others.
      stillHeld++;
    }
  }
  return { retried: held.length, loaded, stillHeld };
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
  /*
   * The document's own words, on this path too.
   *
   * Reading again used to ask only the file name and the subject, so every guard that depends on
   * what the document actually says was skipped here — and this is the path a pharmacist presses
   * after adding a supplier's address, which is exactly when a statement of account gets filed as
   * an invoice.
   */
  const words = (() => {
    if (!/\.pdf$/i.test(fileName) && doc.mimeType !== "application/pdf") return null;
    try {
      return pdfText(buf);
    } catch {
      return null;
    }
  })();
  const kind = supplierName ? classifySupplierDocument(words, fileName, subject) : { kind: "unknown" as const, why: "" };
  if (kind.kind === "statement" || kind.kind === "rebate_report" || kind.kind === "credit_memo") {
    const word = kind.kind === "rebate_report" ? "rebate breakdown" : kind.kind === "credit_memo" ? "credit memo" : "statement of account";
    await db
      .update(schema.documents)
      .set({ category: "supplier_statement", title: `${supplierName} ${word}${subject ? ` — ${subject}` : ""}` })
      .where(eq(schema.documents.id, doc.id));
    const text = `Read again ${stamp}: this is a ${word} from ${supplierName}, not an invoice. ${kind.why} Filed under supplier statements.`;
    await db.update(schema.inboxItems).set({ routedAs: "supplier_statement", routeResult: text, reason: null }).where(eq(schema.inboxItems.id, itemId));
    await audit({ action: "inbox.reread", userId: ctx.userId, userName: ctx.userName, entity: "document", entityId: doc.id, details: text.slice(0, 200) });
    return text;
  }
  if (looksLikeInvoice({ fileName, mimeType: doc.mimeType, subject, supplier: supplierName, text: words })) {
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

  const r = await importRecognised(buf, fileName, from, subject, s, ctx, { documentId: doc.id, supplierId: matched?.id ?? null, supplierName: supplierName ?? null });
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
