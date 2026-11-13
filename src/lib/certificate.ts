import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { sha256 } from "./crypto";
import { TRAINING_LABEL, PERSON_ROLE_LABEL } from "./labels";
import { getSettings } from "./settings";
import { courseFor } from "./courses";
import { trainer } from "./training-records";
import { courseVersion } from "./course-packet";

/**
 * The certificate.
 *
 * Deliberately not a stored file. The instinct is to generate a PDF at the moment of completion
 * and file it away, and it is the wrong instinct: a blob in a folder can drift from the record it
 * claims to represent, and nobody ever notices which of the two is wrong. Here the certificate is
 * produced from the record every time it is asked for, so it is always exactly what the register
 * says and cannot quietly disagree with it. The evidence is the signed attestation and the
 * training row; the certificate is a view of them, printable, at a permanent address.
 *
 * The verification code is the mechanism that makes that honest. It is a hash of the fields on
 * the face of the certificate, recomputed on every render — so a printed copy whose code no
 * longer matches the live page is a copy of something that has since been altered, and that is
 * visible rather than deniable.
 *
 * What is on it is what an auditor asks for and no more: who, what, when, under what authority,
 * how it was delivered, and how the pharmacy knows they understood it.
 */

export type CertificateData = {
  number: string;
  verification: string;
  personName: string;
  personRole: string;
  courseTitle: string;
  authority: string | null;
  minutes: number | null;
  completedOn: string;
  expiresOn: string | null;
  /** How it was delivered — the two kinds of record are not equal and the certificate says which. */
  how: string;
  /** "4 of 4 questions answered correctly", where there was a check. */
  quiz: string | null;
  liveQuestions: string | null;
  /** What material was delivered, which version, and when it was sent. */
  material: string | null;
  statement: string | null;
  signedName: string | null;
  signedAt: string | null;
  provider: string | null;
  pharmacy: {
    name: string;
    address: string;
    registration: string | null;
    phone: string | null;
    /** The pharmacy's own mark, where one has been uploaded. */
    logoUrl: string | null;
  };
  issuedBy: string;
  /**
   * What makes the person who delivered it qualified to.
   *
   * 29 CFR 1910.1030(h)(2)(i)(C) requires the bloodborne training record to name the trainer's
   * qualifications, not merely the trainer. Three of the four required elements were already on
   * this certificate; this was the missing one, and its absence would have been a citation on an
   * otherwise complete file.
   */
  trainerQualifications: string | null;
  /**
   * The signatures on the record, printed as signatures.
   *
   * A training attested by email and completed by the trainer has two of them, made in different
   * ways by different people, and until now the certificate described both in prose. Prose is not
   * a signature. Under 15 U.S.C. 7006(5) an electronic signature is any symbol or process attached
   * to or logically associated with a record and adopted with intent to sign — a reply sent from
   * a person's own address, quoting the phrase they were asked to send and the code issued to them
   * for that training, is exactly that; so is the trainer ticking to sign and typing their name.
   * K.S.A. 16-1609 then lets the signature be attributed to the person by any manner, including
   * the efficacy of the security procedure used, which is what the code and the address are.
   *
   * So both are set out as signature blocks, each with the wording adopted, the method by which
   * it was made, when, and what attributes it to that person. That is more than a wet signature
   * carries, and it is the difference between a document that survives being read closely and one
   * that has to be explained.
   */
  signatures: CertSignature[];
};

export type CertSignature = {
  /** "The employee" or "The trainer" — whose signature this is and what it covers. */
  role: string;
  who: string;
  /** The exact wording adopted, stored at the time rather than reconstructed. */
  statement: string;
  /** How the signature was made, in evidence terms rather than in software terms. */
  method: string;
  at: string | null;
  /** What ties it to that person — the address, the code, the device, the account. */
  attribution: string[];
};

const fold = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" | ");

export async function certificateFor(trainingId: string): Promise<CertificateData | null> {
  const t = await db.query.trainings.findFirst({ where: eq(schema.trainings.id, trainingId) });
  if (!t) return null;
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, t.personId) });
  if (!person) return null;

  const assignment = await db.query.trainingAssignments.findFirst({
    where: eq(schema.trainingAssignments.trainingId, trainingId),
  });
  const s = await getSettings();
  const course = courseFor(t.type);
  const pic = (await db.query.people.findMany()).find((p) => p.isPic);
  const who = await trainer();

  const address = [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
    .filter(Boolean)
    .join(" · ");

  // Signed by the person themselves, or recorded by the pharmacist-in-charge. An inspector can
  // tell those two apart at a glance and should be able to — dressing the weaker one up as the
  // stronger is how a whole training file stops being believed.
  const byReply = assignment?.completedVia === "email_reply";
  const signedOnline = Boolean(assignment?.completedAt && assignment.signedName && !byReply);
  const how = byReply
    ? `Confirmed by the person named in a reply sent from their own email address on ` +
      `${assignment!.completedAt!.slice(0, 10)}, stating that they had been given and had read the material. ` +
      `The reply is retained with this record.`
    : signedOnline
      ? "Completed and signed by the person named, using a personal link sent to them."
      : t.provider === "Signed online"
        ? "Completed and signed by the person named."
        : `Delivered by the pharmacy and recorded by ${t.createdBy}. The person named did not sign individually.`;

  const quiz =
    assignment?.quizCorrect != null && assignment.quizTotal
      ? `${assignment.quizCorrect} of ${assignment.quizTotal} comprehension questions answered correctly.`
      : null;

  /*
   * The interactive half, stated for what it actually is.
   *
   * Three different things can be true here and they are not equal, so the certificate says which
   * one. The person ticking a box to say the opportunity was offered is the weakest. The trainer
   * attesting, on a named date, that they went through it and answered questions is the strongest
   * and is the one 29 CFR 1910.1030(g)(2)(vii)(N) actually describes. Nothing at all is the third,
   * and it is printed rather than left off, because a certificate that is silent about a required
   * element reads as though the element was met.
   */
  const liveQuestions = !course?.liveQuestionsRequired
    ? null
    : assignment?.qaAttestedOn
      ? `On ${assignment.qaAttestedOn}, ${assignment.qaAttestedBy ?? "the pharmacist-in-charge"} attested that the ` +
        `material was gone through with the person named and their questions answered, as ` +
        `29 CFR 1910.1030(g)(2)(vii)(N) requires.` +
        (assignment.qaNote ? ` ${assignment.qaNote}` : "")
      : assignment?.liveQuestionsAcknowledged
        ? `The opportunity for interactive questions and answers with ${pic ? `${pic.firstName} ${pic.lastName}` : "the pharmacist-in-charge"} was offered and acknowledged, as 29 CFR 1910.1030(g)(2)(vii) requires.`
        : "No acknowledgement of the required opportunity for interactive questions and answers is on this record.";

  const material = course
    ? assignment?.materialVersion
      ? `${course.title}, material version ${assignment.materialVersion}` +
        (assignment.materialSentAt ? `, sent to the person on ${assignment.materialSentAt.slice(0, 10)}.` : ".") +
        (assignment.materialVersion !== courseVersion(course)
          ? " The course has been revised since; this certificate names the version actually delivered."
          : "")
      : `${course.title}, material version ${courseVersion(course)}.`
    : null;

  const number = `${(s.pharmacy_ncpdp || "PHM").trim()}-${t.completedOn.slice(0, 4)}-${trainingId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

  const face = fold(
    number,
    material,
    who.qualifications,
    `${person.firstName} ${person.lastName}`,
    TRAINING_LABEL[t.type],
    t.completedOn,
    t.expiresOn,
    how,
    quiz,
    assignment?.signedName,
    assignment?.completedAt,
    assignment?.qaAttestedOn,
    assignment?.qaAttestedBy,
    assignment?.qaSignatureId,
    t.notes,
  );

  /*
   * The two halves, as signatures.
   *
   * Order matters: the employee's first, because it is the one that says the training happened to
   * them. The trainer's completes it.
   */
  const signatures: CertSignature[] = [];
  if (assignment?.completedAt && assignment.completedVia !== "pic_recorded") {
    const { REPLY_PHRASE } = await import("./training-replies");
    const byReply2 = assignment.completedVia === "email_reply";
    signatures.push({
      role: "The employee, that they were given the material and read it",
      who: assignment.signedName || `${person.firstName} ${person.lastName}`,
      statement: assignment.statement,
      method: byReply2
        ? `Reply sent by email from the person's own address containing the words "${REPLY_PHRASE}" and the reply ` +
          `code issued to them for this training. Adopted with intent to sign under 15 U.S.C. 7006(5).`
        : "Typed name and submission on this pharmacy's training page, after every comprehension question was " +
          "answered correctly.",
      at: assignment.completedAt,
      attribution: [
        byReply2 && assignment.replyFromAddress
          ? `Sent from ${assignment.replyFromAddress}, the address held for this person on the pharmacy's staff record.`
          : null,
        byReply2 && assignment.replyCode
          ? `Carried reply code ${assignment.replyCode}, issued to this person for this training and no other.`
          : null,
        byReply2 && assignment.replyDocumentId ? "The reply itself is retained with this record." : null,
        !byReply2 && assignment.signedIp ? `Signed from ${assignment.signedIp}.` : null,
        !byReply2 && assignment.signedAgent ? `Device: ${assignment.signedAgent.slice(0, 120)}` : null,
        assignment.quizTotal
          ? `${assignment.quizCorrect} of ${assignment.quizTotal} comprehension questions answered correctly.`
          : null,
      ].filter((x): x is string => Boolean(x)),
    });
  }
  if (assignment?.qaSignatureId) {
    const sig = await db.query.recordSignatures.findFirst({
      where: eq(schema.recordSignatures.id, assignment.qaSignatureId),
    });
    if (sig) {
      signatures.push({
        role: "The trainer, that the questions and answers happened",
        who: sig.signedName,
        statement: sig.statement,
        method:
          "Signed on this pharmacy's system: the statement agreed to, a box ticked to signify intent, and a name " +
          "typed as it would be signed.",
        at: sig.signedAt,
        attribution: [
          sig.signedRole ? `Signed by the ${sig.signedRole} account for ${sig.signedName}.` : null,
          sig.signedIp ? `Signed from ${sig.signedIp}.` : null,
          sig.revokedAt ? `WITHDRAWN on ${sig.revokedAt.slice(0, 10)}: ${sig.revokedReason ?? ""}` : null,
        ].filter((x): x is string => Boolean(x)),
      });
    }
  }

  return {
    number,
    verification: sha256(Buffer.from(face, "utf8")).slice(0, 12).toUpperCase(),
    personName: `${person.firstName} ${person.lastName}`,
    personRole: PERSON_ROLE_LABEL[person.role],
    courseTitle: course?.title ?? TRAINING_LABEL[t.type],
    authority: course?.authority ?? null,
    minutes: t.minutes ?? course?.minutes ?? null,
    completedOn: t.completedOn,
    expiresOn: t.expiresOn,
    how,
    quiz,
    liveQuestions,
    material,
    statement: assignment?.statement ?? t.notes ?? null,
    signedName: assignment?.signedName ?? null,
    signedAt: assignment?.completedAt ?? null,
    provider: t.provider,
    pharmacy: {
      name: s.pharmacy_name || "This pharmacy",
      address,
      registration: s.pharmacy_registration_number || null,
      phone: s.pharmacy_phone || null,
      logoUrl: (await (await import("./branding")).logo())?.url ?? null,
    },
    issuedBy: pic ? `${pic.firstName} ${pic.lastName}, Pharmacist-in-Charge` : "The pharmacist-in-charge",
    trainerQualifications: who.qualifications,
    signatures,
  };
}

/** The certificate for an assignment, by its token — what the person themselves can reach. */
export async function certificateForToken(token: string): Promise<CertificateData | null> {
  const a = await db.query.trainingAssignments.findFirst({ where: eq(schema.trainingAssignments.token, token) });
  if (!a?.trainingId) return null;
  return certificateFor(a.trainingId);
}
