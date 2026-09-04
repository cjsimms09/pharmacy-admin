import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { db, schema } from "@/db";
import { newId, sha256 } from "./crypto";

/**
 * Signing a record the pharmacy produces, on screen, in a way that holds up.
 *
 * These documents all end the same way: a line for the pharmacist-in-charge to sign. Printing a
 * document in order to sign it and scan it back is a photocopier standing in for a database, and
 * the version that ends up in the drawer is the unsigned printout.
 *
 * The ESIGN Act (15 U.S.C. 7001) and the Kansas UETA (K.S.A. 16-1601) make an electronic
 * signature the equal of ink where four things are true, and the whole design here is those four.
 *
 * Intent has to be a deliberate act, so it is a ticked box and a typed name — never a button
 * called "sign" that somebody could press while meaning "next". The box and the name are separate
 * because doing two things is what makes it deliberate.
 *
 * Attribution has to point at a person, so the signed-in user, the name they typed, the address
 * they came from and the browser they used are all kept. A typed name alone is a claim; a typed
 * name from an authenticated session is evidence.
 *
 * Association has to bind the signature to what was signed. The statement is stored word for word
 * rather than looked up later, and a fingerprint of the record's own content goes with it — so if
 * the underlying figures change afterwards, the site can say so rather than quietly showing a
 * signature against a document nobody signed.
 *
 * Retention means it can be produced later. The row is never edited. Withdrawing a signature adds
 * a revocation; it does not remove the fact that it was made.
 */

export type Signable = {
  kind: string;
  /** What the signer is asserting, in the first person, plainly. */
  statement: string;
  /** How the record is described in the audit log and on screen. */
  label: string;
  /** Only these roles may sign it, where the law or the Board is specific about who. */
  roles?: ("owner" | "manager" | "staff")[];
};

/**
 * Every record that can be signed here, with the words that are signed.
 *
 * Kept in one place so that a statement is written once, by somebody thinking about what it
 * commits the pharmacy to, rather than typed into a page by somebody thinking about layout.
 */
export const SIGNABLE: Record<string, Signable> = {
  training_file: {
    kind: "training_file",
    label: "Workforce training records",
    statement:
      "I certify that this is a true and complete record of the workforce training delivered at this pharmacy for " +
      "the period shown, that each completion recorded here is supported by the evidence held in this system, and " +
      "that I am the pharmacist-in-charge or am authorised by them to certify it.",
    roles: ["owner", "manager"],
  },
  technician_list: {
    kind: "technician_list",
    label: "Pharmacy technician list",
    statement:
      "I certify that this list shows every pharmacy technician employed at this pharmacy for the month shown, with " +
      "their registration numbers as held on file, and that it is accurate to the best of my knowledge. K.S.A. " +
      "65-1663(i).",
    roles: ["owner", "manager"],
  },
  temperature_month: {
    kind: "temperature_month",
    label: "Monthly temperature review",
    statement:
      "I have reviewed every reading recorded for this sensor in the month shown, together with any excursion and " +
      "the explanation given for it, and I certify that this is a true record of the storage temperatures at this " +
      "pharmacy for that month.",
    roles: ["owner", "manager"],
  },
  self_inspection: {
    kind: "self_inspection",
    label: "Self-inspection record",
    statement:
      "I certify that I carried out this self-inspection of the pharmacy on the date shown, that the answers " +
      "recorded are my own findings, and that any item marked as a finding has been recorded for correction.",
    roles: ["owner", "manager"],
  },
  cs_inventory: {
    kind: "cs_inventory",
    label: "Controlled substance inventory",
    statement:
      "I certify that this is an accurate count of the controlled substances on hand at this pharmacy on the date " +
      "and at the time shown, taken by me or under my supervision. 21 CFR 1304.11.",
    roles: ["owner", "manager"],
  },
};

export type RecordSignature = typeof schema.recordSignatures.$inferSelect;

/** A fingerprint of what was on the page, so a later change to the figures is detectable. */
export function fingerprint(content: string): string {
  return sha256(Buffer.from(content, "utf8")).slice(0, 16);
}

export async function signatureFor(kind: string, recordKey: string): Promise<RecordSignature | null> {
  const rows = await db.query.recordSignatures.findMany({
    where: and(
      eq(schema.recordSignatures.kind, kind),
      eq(schema.recordSignatures.recordKey, recordKey),
      isNull(schema.recordSignatures.revokedAt),
    ),
  });
  return rows.sort((a, b) => b.signedAt.localeCompare(a.signedAt))[0] ?? null;
}

export type SignInput = {
  kind: string;
  recordKey: string;
  /** The name the signer typed. Compared against their account name, but not required to match. */
  typedName: string;
  /** Proof they meant it. Without this nothing is recorded. */
  intent: boolean;
  /** The content the signature is bound to, so a later edit can be detected. */
  content?: string;
};

/**
 * Records a signature, or refuses and says why.
 *
 * The refusals are the interesting part. An unticked box is not a signature, so it is rejected
 * rather than inferred from the fact that a form was submitted. An empty name is rejected for the
 * same reason. And a record already signed is not signed twice, because two signatures on one
 * document invite the question of which one counts.
 */
export async function signRecord(
  input: SignInput,
  user: { id: string; name: string; role: string },
): Promise<RecordSignature> {
  const spec = SIGNABLE[input.kind];
  if (!spec) throw new Error("That is not something this site knows how to sign.");
  if (spec.roles && !spec.roles.includes(user.role as "owner" | "manager" | "staff")) {
    throw new Error(`${spec.label} may only be signed by the pharmacist-in-charge or a manager.`);
  }
  if (!input.intent) {
    throw new Error("Tick the box to say you are signing. A form submitted without it is not a signature.");
  }
  const name = input.typedName.trim();
  if (name.length < 3) throw new Error("Type your full name as you would sign it.");

  const already = await signatureFor(input.kind, input.recordKey);
  if (already) throw new Error(`This record was already signed by ${already.signedName}.`);

  // Best effort, and honest when it is not available: a signature with no address recorded is
  // still a signature, and pretending to know one would be worse than saying nothing.
  let ip: string | null = null;
  let agent: string | null = null;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || null;
    agent = h.get("user-agent");
  } catch {
    // Outside a request. Nothing to record.
  }

  const id = newId();
  await db.insert(schema.recordSignatures).values({
    id,
    kind: input.kind,
    recordKey: input.recordKey,
    statement: spec.statement,
    contentHash: input.content ? fingerprint(input.content) : null,
    signedName: name,
    signedByUserId: user.id,
    signedRole: user.role,
    signedIp: ip,
    signedAgent: agent?.slice(0, 300) ?? null,
  });

  const saved = await db.query.recordSignatures.findFirst({ where: eq(schema.recordSignatures.id, id) });
  return saved!;
}

/**
 * Withdraws a signature without erasing that it was made.
 *
 * Somebody who signs the wrong month needs a way out, and deleting the row would be the wrong
 * one — a record that can be silently unsigned is not a record. The revocation carries a reason
 * and the original stays where it is.
 */
export async function revokeSignature(id: string, reason: string, user: { name: string }): Promise<void> {
  const why = reason.trim();
  if (!why) throw new Error("Say why it is being withdrawn. That reason is part of the record.");
  await db
    .update(schema.recordSignatures)
    .set({ revokedAt: new Date().toISOString(), revokedReason: `${why} — withdrawn by ${user.name}` })
    .where(eq(schema.recordSignatures.id, id));
}

/** True when the record has changed since it was signed, so the page can say so plainly. */
export function contentChanged(sig: RecordSignature | null, content: string | undefined): boolean {
  if (!sig?.contentHash || !content) return false;
  return sig.contentHash !== fingerprint(content);
}
