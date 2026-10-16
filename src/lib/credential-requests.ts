import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { CREDENTIAL_LABEL } from "./labels";
import { makeReplyCode, normalise } from "./training-replies";
import { sendMail } from "./send-mail";
import { getSettings } from "./settings";
import type { CredentialType } from "@/db/schema";

/**
 * Asking somebody for the certificate the pharmacy is missing, and filing what comes back.
 *
 * The gap was visible on every screen and closing it was entirely manual: email the person, wait,
 * then remember to file whatever arrived against the right person and the right requirement. Every
 * one of those steps is a place it stopped happening, which is why the same gaps sat open for
 * months.
 *
 * The reply is matched on a short code *and* the sender's own address — both, or neither. A code
 * forwarded to somebody else cannot file a certificate under the wrong name, which matters here
 * more than it does for training: this is the document an inspector asks to see.
 */

export const CERT_REPLY_PHRASE = "HERE IS MY CERTIFICATE";

export type OpenRequest = typeof schema.credentialRequests.$inferSelect;

/** What the person is asked to send, in words rather than a field name. */
export function requestSubject(type: CredentialType, pharmacy: string): string {
  return `${pharmacy}: please send your ${CREDENTIAL_LABEL[type]}`;
}

export function requestBody(opts: {
  firstName: string;
  type: CredentialType;
  replyCode: string;
  pharmacy: string;
  picName: string | null;
}): string {
  return [
    `${opts.firstName},`,
    "",
    `The pharmacy does not have a copy of your ${CREDENTIAL_LABEL[opts.type]} on file, and it has to be`,
    "available for inspection.",
    "",
    "Please reply to this email with a photo or scan of it attached. A phone photo is fine as long as",
    "the number and the expiry date are readable.",
    "",
    `Include the words ${CERT_REPLY_PHRASE} and this code: ${opts.replyCode}`,
    "",
    "That is how it gets filed automatically against your record. Reply from this address — a",
    "certificate sent from anywhere else cannot be matched to you and will not be filed.",
    "",
    opts.picName ? `Thanks,\n${opts.picName}\n${opts.pharmacy}` : opts.pharmacy,
  ].join("\n");
}

/**
 * Creates the request and emails it.
 *
 * An outstanding request for the same credential is reused rather than duplicated: a second code
 * for one certificate means two ways to file it and two things to chase.
 */
export async function requestCredential(
  personId: string,
  type: CredentialType,
  user: { name: string },
): Promise<{ ok: boolean; message: string }> {
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, personId) });
  if (!person) return { ok: false, message: "That person no longer exists." };
  if (!person.email) {
    return { ok: false, message: `${person.firstName} has no email address on file, so there is nowhere to send it.` };
  }

  const existing = await db.query.credentialRequests.findFirst({
    where: and(
      eq(schema.credentialRequests.personId, personId),
      eq(schema.credentialRequests.type, type),
      isNull(schema.credentialRequests.fulfilledAt),
      isNull(schema.credentialRequests.cancelledAt),
    ),
  });

  const id = existing?.id ?? newId();
  const replyCode = existing?.replyCode ?? makeReplyCode();
  if (!existing) {
    await db.insert(schema.credentialRequests).values({
      id,
      personId,
      type,
      replyCode,
      requestedOn: todayIso(),
      requestedBy: user.name,
    });
  }

  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "The pharmacy";
  const pic = (await db.query.people.findMany()).find((p) => p.isPic);
  const r = await sendMail(
    person.email,
    requestSubject(type, pharmacy),
    requestBody({
      firstName: person.firstName,
      type,
      replyCode,
      pharmacy,
      picName: pic ? `${pic.firstName} ${pic.lastName}` : null,
    }),
  );

  const now = new Date().toISOString();
  await db
    .update(schema.credentialRequests)
    .set(
      r.ok
        ? { sentAt: now, sendError: null, remindersSent: existing ? (existing.remindersSent ?? 0) + 1 : 0 }
        : { sendError: r.error },
    )
    .where(eq(schema.credentialRequests.id, id));

  return r.ok
    ? {
        ok: true,
        message:
          `Asked ${person.firstName} for their ${CREDENTIAL_LABEL[type]} — accepted for delivery to ${person.email}. ` +
          `They reply with a photo attached and the code ${replyCode}, and it files itself against their record.`,
      }
    : { ok: false, message: `Could not email ${person.firstName}: ${r.error}` };
}

export type CertMatch = { requestId: string; personId: string; personName: string; type: CredentialType };

/**
 * Which outstanding request a reply belongs to.
 *
 * Both halves are required — the code says which request, the address says it was them. A code
 * pasted into an email from somebody else must never file a certificate under the wrong name.
 */
export async function matchCertificateReply(msg: {
  from: string;
  subject: string;
  text: string;
}): Promise<CertMatch[]> {
  const from = msg.from.trim().toLowerCase();
  if (!from) return [];

  const open = await db.query.credentialRequests.findMany({
    where: and(isNull(schema.credentialRequests.fulfilledAt), isNull(schema.credentialRequests.cancelledAt)),
  });
  if (open.length === 0) return [];

  const haystack = normalise(`${msg.subject} ${msg.text}`);
  if (!haystack.includes(normalise(CERT_REPLY_PHRASE))) return [];

  const people = await db.query.people.findMany();
  const out: CertMatch[] = [];
  for (const r of open) {
    if (!haystack.includes(normalise(r.replyCode))) continue;
    const person = people.find((p) => p.id === r.personId);
    if (!person?.email || person.email.trim().toLowerCase() !== from) continue;
    out.push({ requestId: r.id, personId: person.id, personName: `${person.firstName} ${person.lastName}`, type: r.type });
  }
  return out;
}

/**
 * Files what came back.
 *
 * The credential row is created without dates on purpose. An attachment proves the certificate
 * exists; it does not tell the system when it expires, and a made-up expiry date is worse than a
 * missing one — it passes every check while telling you nothing. So the record says a document is
 * on file and the dates are still blank, which is exactly what the PIC then needs to fill in.
 */
export async function fileCertificateReply(
  requestId: string,
  documentId: string,
  user: { name: string },
): Promise<{ personId: string; type: CredentialType }> {
  const req = await db.query.credentialRequests.findFirst({ where: eq(schema.credentialRequests.id, requestId) });
  if (!req) throw new Error("That request no longer exists.");

  const credentialId = newId();
  await db.insert(schema.credentials).values({
    id: credentialId,
    personId: req.personId,
    type: req.type,
    notes: `Sent in by email on ${todayIso()} in reply to a request from ${req.requestedBy ?? "the pharmacy"}. Dates still to be entered.`,
  });
  await db
    .update(schema.documents)
    .set({ personId: req.personId, credentialId, category: "license" })
    .where(eq(schema.documents.id, documentId));
  await db
    .update(schema.credentialRequests)
    .set({ fulfilledAt: new Date().toISOString(), documentId, credentialId })
    .where(eq(schema.credentialRequests.id, requestId));

  void user;
  return { personId: req.personId, type: req.type };
}

/** Requests still outstanding, so the PIC can see who has been asked and who has not replied. */
export async function openRequests(): Promise<OpenRequest[]> {
  return db.query.credentialRequests.findMany({
    where: and(isNull(schema.credentialRequests.fulfilledAt), isNull(schema.credentialRequests.cancelledAt)),
  });
}

/** Requests outstanding against one person, so their own page can say what has been asked for. */
export async function openRequestsFor(personId: string): Promise<OpenRequest[]> {
  return db.query.credentialRequests.findMany({
    where: and(
      eq(schema.credentialRequests.personId, personId),
      isNull(schema.credentialRequests.fulfilledAt),
      isNull(schema.credentialRequests.cancelledAt),
    ),
  });
}

/**
 * Closes any outstanding request once the credential arrives by another route.
 *
 * People hand the card over at the counter as often as they email it. If the request stays open
 * after that, the site keeps saying it is waiting on something it already has — and a chase list
 * that asks for things already on file is one nobody reads twice. Called wherever a credential is
 * recorded, so the loop closes however it was actually closed.
 */
export async function resolveOpenRequests(personId: string, type: CredentialType): Promise<void> {
  await db
    .update(schema.credentialRequests)
    .set({ cancelledAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.credentialRequests.personId, personId),
        eq(schema.credentialRequests.type, type),
        isNull(schema.credentialRequests.fulfilledAt),
        isNull(schema.credentialRequests.cancelledAt),
      ),
    );
}

/** Stops chasing one request, without recording a credential that does not exist. */
export async function cancelRequest(id: string): Promise<void> {
  await db
    .update(schema.credentialRequests)
    .set({ cancelledAt: new Date().toISOString() })
    .where(eq(schema.credentialRequests.id, id));
}
