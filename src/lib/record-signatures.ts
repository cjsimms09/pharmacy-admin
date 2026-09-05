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
  /**
   * Whether the wording is supplied per signature rather than fixed here.
   *
   * True for exactly one kind: a compliance attestation, whose sentence names the duty, the period
   * and what was actually checked — "on 3 September I signed in to K-TRACS and reviewed the
   * submission status for August". That sentence is the evidence, and it cannot be written in
   * advance because the period is part of it. Everything else has fixed wording on purpose, so it
   * is written once by somebody thinking about what it commits the pharmacy to.
   */
  dynamic?: boolean;
};

/**
 * Every record that can be signed here, with the words that are signed.
 *
 * Kept in one place so that a statement is written once, by somebody thinking about what it
 * commits the pharmacy to, rather than typed into a page by somebody thinking about layout.
 */
export const SIGNABLE: Record<string, Signable> = {
  /**
   * A compliance duty, attested for a period.
   *
   * These were being recorded with the statement, the date and the signed-in user's name — real
   * evidence, and better than a tick — but not as a signature in the sense the rest of this system
   * means it. There was no deliberate act of signing and no typed name, so an attestation was
   * weaker than the temperature log sitting next to it, which is the wrong way round: the
   * attestation is often the *only* evidence a duty done outside this system was done at all.
   */
  obligation_attestation: {
    kind: "obligation_attestation",
    label: "Compliance attestation",
    statement: "",
    dynamic: true,
    roles: ["owner", "manager"],
  },
  /**
   * The trainer's half of a training attested by email.
   *
   * Dynamic because the sentence names the person, both dates and what was actually gone through
   * — "Nicole confirmed by email on 3 September that she had read the material; on 8 September I
   * went through it with her and answered her questions". That sentence is the evidence and it
   * cannot be written in advance.
   *
   * It is a signature rather than a button because the record it completes has to stand next to
   * the employee's own. Theirs is made by replying from their address with the code issued to
   * them; this one is made by ticking to sign and typing a name. Both are electronic signatures
   * under 15 U.S.C. 7006(5) and K.S.A. 16-1602, and the certificate prints them as such.
   */
  training_qa_attestation: {
    kind: "training_qa_attestation",
    label: "Trainer's attestation of questions and answers",
    statement: "",
    dynamic: true,
    roles: ["owner", "manager"],
  },
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

/**
 * Every standing signature on a record, newest first.
 *
 * A record that legitimately changes collects a chain of certifications rather than one, and the
 * chain is worth printing: "certified 4 February, re-certified 11 March" says the file was kept
 * under certification the whole time. One latest signature on its own cannot say that.
 */
export async function signaturesFor(kind: string, recordKey: string): Promise<RecordSignature[]> {
  const rows = await db.query.recordSignatures.findMany({
    where: and(
      eq(schema.recordSignatures.kind, kind),
      eq(schema.recordSignatures.recordKey, recordKey),
      isNull(schema.recordSignatures.revokedAt),
    ),
  });
  return rows.sort((a, b) => b.signedAt.localeCompare(a.signedAt));
}

export type SignInput = {
  kind: string;
  recordKey: string;
  /** Only for a dynamic kind: the exact wording being signed. Stored verbatim. */
  statement?: string;
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

  // What is actually being signed. A dynamic kind supplies its own sentence; every other kind
  // uses the wording written once, above, and may not substitute anything for it.
  const wording = spec.dynamic ? (input.statement ?? "").trim() : spec.statement;
  if (!wording) throw new Error("Nothing was recorded — an attestation with no statement is not evidence.");

  /*
   * Signing the same thing twice is refused. Signing it again after it changed is the point.
   *
   * The first version of this refused any second signature outright, and that turned out to be
   * wrong in the way that matters: these records move. Somebody finishes a training in March and
   * the file certified in February no longer says what is true. The old rule left exactly one way
   * out — withdraw the February signature — which throws away a true certification of a real
   * version in order to make a new one, and leaves the year looking as though nobody signed it
   * until March.
   *
   * So the rule is about the *version*, not the record. A record bound to its content may be
   * signed again whenever that content has moved on; each signature stands against the version it
   * was made on, and they accumulate rather than replace. Signing an identical version is still
   * refused, because two signatures on one unchanged document invite the question of which counts.
   */
  const already = await signatureFor(input.kind, input.recordKey);
  const again = mayCertifyAgain(already, input.content);
  if (!again.ok) throw new Error(again.why);

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
    statement: wording,
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

/**
 * Whether a record that already carries a signature may be signed again.
 *
 * The first version of this refused outright, and that turned out to be wrong in the way that
 * matters: these records move. Somebody finishes a training in March and the file certified in
 * February no longer says what is true. The old rule left exactly one way out — withdraw the
 * February signature — which throws away a true certification of a real version in order to make a
 * new one, and leaves the year looking as though nobody certified anything until March.
 *
 * So the rule is about the *version*, not the record. A record bound to its content may be signed
 * again once that content has moved on; each signature stands against the version it was made on,
 * and they accumulate rather than replace. Two refusals remain. Signing an identical version is
 * refused, because two signatures on one unchanged document invite the question of which counts.
 * And a record that was never bound to its content cannot prove it changed, so it still has to be
 * withdrawn first rather than quietly collecting signatures nobody can tell apart.
 */
export function mayCertifyAgain(
  existing: RecordSignature | null,
  content: string | undefined,
): { ok: true } | { ok: false; why: string } {
  if (!existing) return { ok: true };
  if (!content || !existing.contentHash) {
    return {
      ok: false,
      why:
        `This record was already signed by ${existing.signedName}. Withdraw that signature first if it needs to ` +
        `change.`,
    };
  }
  if (!contentChanged(existing, content)) {
    return {
      ok: false,
      why:
        `This is the same version ${existing.signedName} already signed on ` +
        `${new Date(existing.signedAt).toLocaleDateString()}. Nothing has changed since, so there is nothing to ` +
        `certify again.`,
    };
  }
  return { ok: true };
}

/** True when the record has changed since it was signed, so the page can say so plainly. */
export function contentChanged(sig: RecordSignature | null, content: string | undefined): boolean {
  if (!sig?.contentHash || !content) return false;
  return sig.contentHash !== fingerprint(content);
}

/**
 * Whether the workforce training record needs signing, and why.
 *
 * The question asked was whether this is a monthly job. It is not, and nothing in the rules sets a
 * cadence for it at all — the pharmacy is required to *document* training (45 CFR 164.530(j)(1)(ii)
 * for HIPAA, 29 CFR 1910.1030(h)(2) for bloodborne) and those records exist whether or not anybody
 * certifies them. Signing turns a printout of a database into a certified record, which is what
 * makes it worth handing over.
 *
 * So there are exactly two moments worth signing: when the year's file is complete, and when
 * something has changed since the last signature. The second is the one that was invisible. The
 * page said so if you opened it, and nothing anywhere said to open it — so a certified record
 * quietly stopped matching what it certified, which is worse than never having signed it.
 */
export type TrainingFileSignatureState = {
  recordKey: string;
  signed: boolean;
  signedOn: string | null;
  signedName: string | null;
  /** Signed, but people or completions have changed since. */
  changed: boolean;
  completions: number;
};

export async function trainingFileSignature(): Promise<TrainingFileSignatureState> {
  const { trainingFile } = await import("./training-records");
  const file = await trainingFile();
  const recordKey = `${file.preparedOn.slice(0, 4)}-current`;
  const signature = await signatureFor("training_file", recordKey);

  // The same string the page binds the signature to. Kept in step deliberately: two different
  // ideas of "what was signed" would make the whole mechanism lie.
  const content = file.people
    .map((p) => `${p.name}|${p.lines.map((l) => `${l.type}:${l.completedOn ?? ""}`).join(",")}`)
    .join("\n");

  return {
    recordKey,
    signed: Boolean(signature),
    signedOn: signature?.signedAt?.slice(0, 10) ?? null,
    signedName: signature?.signedName ?? null,
    changed: contentChanged(signature, content),
    completions: file.people.reduce((n, p) => n + p.lines.length, 0),
  };
}
