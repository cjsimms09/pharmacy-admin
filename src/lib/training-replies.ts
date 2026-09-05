import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import type { TrainingType } from "@/db/schema";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { addMonths, TRAINING_CADENCE } from "./due";
import { TRAINING_LABEL } from "./labels";
import { courseFor } from "./courses";

/**
 * Accepting an emailed reply as the attestation.
 *
 * People reply to emails. They do not reliably click links, and a compliance system that only
 * works when everybody behaves the way it prefers is a compliance system that does not work. So
 * a reply counts — and the record says, on its face, that it was a reply.
 *
 * That last part is the whole design. A signed page carries a typed name, a timestamp, the
 * device, and a comprehension check that had to be passed. An emailed reply carries a From
 * header, which is asserted by the sender's mail system and not proven, and no evidence the
 * material was read. Both are worth having. Recording the second as though it were the first is
 * how an entire training file stops being believed the moment one record is examined closely.
 *
 * Two things have to line up before a reply is accepted: the reply code that was put in the
 * subject line of that person's own email, and the sending address matching the address the
 * pharmacy holds for them. Either alone is not enough — a code can be forwarded, and an address
 * on its own cannot say which of three outstanding trainings is being confirmed.
 */

/** Short, unambiguous, and readable over the phone: no O/0 or I/1 confusion. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeReplyCode(): string {
  let out = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/** The words staff are asked to send back. Matched loosely — people add "Thanks!" and a signature. */
export const REPLY_PHRASE = "I COMPLETED THIS";

/** Shared with the certificate-request matcher, so both compare codes the same way. */
export const normalise = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export type ReplyMatch = {
  assignmentId: string;
  personId: string;
  personName: string;
  type: string;
  label: string;
};

/**
 * Finds every assignment an inbound message is confirming.
 *
 * Plural because one email now covers everything a person owes, so one reply may legitimately
 * close three trainings — and quoting the original, which every mail client does, is what puts
 * all three codes in the reply.
 *
 * It returns nothing rather than guessing. A message quoting a code but sent from somewhere
 * else, or one from the right person with no code at all, is left alone: it lands in the inbox
 * as an ordinary message and a human decides. Closing a training on a guess is worse than not
 * closing it, because nobody goes back to check the ones that closed themselves.
 */
export async function matchTrainingReplies(msg: {
  from: string;
  subject: string;
  text: string;
}): Promise<ReplyMatch[]> {
  const from = msg.from.trim().toLowerCase();
  if (!from) return [];

  const open = await db.query.trainingAssignments.findMany({
    where: isNull(schema.trainingAssignments.completedAt),
  });
  if (open.length === 0) return [];

  const people = await db.query.people.findMany();
  const haystack = normalise(`${msg.subject} ${msg.text}`);
  if (!haystack.includes(normalise(REPLY_PHRASE))) return [];

  const out: ReplyMatch[] = [];
  for (const a of open) {
    if (!a.replyCode) continue;
    if (!haystack.includes(normalise(a.replyCode))) continue;
    const person = people.find((p) => p.id === a.personId);
    // The code says which assignment; the address says it was them. Both, or neither.
    if (!person?.email || person.email.trim().toLowerCase() !== from) continue;
    out.push({
      assignmentId: a.id,
      personId: person.id,
      personName: `${person.firstName} ${person.lastName}`,
      type: a.type,
      label: TRAINING_LABEL[a.type],
    });
  }
  return out;
}

/**
 * Records the completion and files the reply itself.
 *
 * The email is stored verbatim as the evidence. An attestation whose only trace is a row in a
 * database saying an email arrived is not evidence of anything; the message, with its headers and
 * its date, is.
 */
export async function completeByEmailReply(
  assignmentId: string,
  reply: { from: string; subject: string; text: string; receivedAt: string; raw: string },
): Promise<{ trainingId: string | null; label: string; personName: string; insufficient: boolean }> {
  const a = await db.query.trainingAssignments.findFirst({ where: eq(schema.trainingAssignments.id, assignmentId) });
  if (!a) throw new Error("That assignment no longer exists.");
  if (a.completedAt) throw new Error("That assignment is already complete.");
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, a.personId) });
  if (!person) throw new Error("That person is no longer on file.");

  const { storeRawText } = await import("./files");
  const stored = await storeRawText(reply.raw);
  const docId = newId();
  await db.insert(schema.documents).values({
    id: docId,
    category: "training_record",
    title: `${TRAINING_LABEL[a.type]} — emailed attestation from ${person.firstName} ${person.lastName}`,
    fileName: `training-reply-${a.replyCode ?? assignmentId.slice(0, 8)}.txt`,
    mimeType: "text/plain",
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    personId: person.id,
    effectiveOn: reply.receivedAt.slice(0, 10),
    notes: `Reply received ${reply.receivedAt} from ${reply.from}. Subject: ${reply.subject}`,
    uploadedBy: "Mailbox sweep",
  });

  const today = todayIso();
  const months = TRAINING_CADENCE[a.type]?.months;
  const course = courseFor(a.type);

  /*
   * A reply is a person saying they did it. For most trainings that is the record; for one it is
   * not enough, and pretending otherwise is the weakest thing this system could do.
   *
   * 29 CFR 1910.1030(g)(2)(vii)(N) requires an opportunity for interactive questions and answers
   * with a person knowledgeable in the subject. An email saying "read it, done" evidences neither
   * that nor comprehension — and it was being accepted as a complete bloodborne pathogens record,
   * marked current, and counted as covered on every screen. That is a training file that looks
   * satisfied and would not survive being read.
   *
   * So the reply is kept — it is real evidence that the material reached them and that they say
   * they read it, and losing it would be worse — but it does not close the training. They still
   * owe the course with its questions, or a session with the pharmacist-in-charge, which is what
   * the standard actually asks for. Which means the reminders keep coming, correctly.
   */
  /*
   * Two halves, and the reply is one of them.
   *
   * 29 CFR 1910.1030(g)(2)(vii)(N) wants an opportunity for interactive questions and answers with
   * somebody knowledgeable. The reply evidences that the material reached this person and that
   * they read it; it cannot evidence a conversation. The pharmacist-in-charge can, and does — so
   * the record is completed by both, not by refusing one.
   *
   * The person is finished at this point and is told so. What is outstanding is the trainer's
   * attestation, which is the pharmacy's to make, so the chasing stops pointing at them.
   */
  if (course?.liveQuestionsRequired) {
    await db
      .update(schema.trainingAssignments)
      .set({
        completedAt: reply.receivedAt,
        signedName: `${person.firstName} ${person.lastName}`,
        completedVia: "email_reply",
        replyDocumentId: docId,
        replyFromAddress: reply.from,
      })
      .where(eq(schema.trainingAssignments.id, a.id));
    await acknowledgePartly(person, a.token, TRAINING_LABEL[a.type]);
    return {
      trainingId: null,
      label: TRAINING_LABEL[a.type],
      personName: `${person.firstName} ${person.lastName}`,
      insufficient: true,
    };
  }

  const trainingId = newId();
  await db.insert(schema.trainings).values({
    id: trainingId,
    personId: a.personId,
    type: a.type,
    completedOn: reply.receivedAt.slice(0, 10),
    cycleYear: Number(reply.receivedAt.slice(0, 4)),
    expiresOn: months ? addMonths(reply.receivedAt.slice(0, 10), months) : null,
    provider: "Confirmed by email reply",
    minutes: course?.minutes ?? null,
    documentId: docId,
    notes: a.statement,
    createdBy: `${person.firstName} ${person.lastName} (by email)`,
  });

  await db
    .update(schema.trainingAssignments)
    .set({
      completedAt: reply.receivedAt,
      signedName: `${person.firstName} ${person.lastName}`,
      trainingId,
      completedVia: "email_reply",
      replyDocumentId: docId,
      replyFromAddress: reply.from,
    })
    .where(eq(schema.trainingAssignments.id, a.id));

  await acknowledge(person, a.token, TRAINING_LABEL[a.type]);

  return {
    trainingId,
    label: TRAINING_LABEL[a.type],
    personName: `${person.firstName} ${person.lastName}`,
    insufficient: false,
  };
}

/**
 * Tells the person their reply landed, and gives them their certificate.
 *
 * Without this they reply into silence. Silence after a compliance instruction is read as "that
 * probably did not work", and the next thing that happens is either a second reply or — far more
 * likely — nothing at all next year, because the process felt like shouting into a void. It costs
 * one email to close the loop, and it hands them proof they can keep, which is the difference
 * between something done to staff and something staff can point at.
 *
 * Never allowed to fail the completion. The record is already written and correct; a mail server
 * being down must not undo it.
 */
async function acknowledge(
  person: { firstName: string; lastName: string; email: string | null },
  token: string,
  label: string,
): Promise<void> {
  if (!person.email) return;
  try {
    const { sendMail } = await import("./send-mail");
    const { linkFor } = await import("./training-assignments");
    const { getSettings } = await import("./settings");
    const s = await getSettings();
    const url = `${await linkFor(token)}/certificate`;
    await sendMail(
      person.email,
      `Recorded: ${label}`,
      [
        `${person.firstName},`,
        "",
        `Your reply came through and your ${label.toLowerCase()} is recorded. There is nothing else`,
        "for you to do.",
        "",
        "Your certificate is here, and this address keeps working — print it or save it:",
        "",
        url,
        "",
        `${s.pharmacy_name || "The pharmacy"}`,
      ].join("\n"),
    );
  } catch {
    // Deliberately silent. The training is recorded either way, and an acknowledgement that
    // could not be sent is not a reason to lose it.
  }
}

/**
 * Tells somebody their reply landed and what is still outstanding.
 *
 * A reply into silence is read as "that probably did not work". A reply answered with "recorded,
 * nothing else to do" when there *is* something else to do is worse — it is the pharmacy telling
 * a member of staff they are finished when they are not, and it is the pharmacy's problem when an
 * inspector finds the gap, not theirs.
 *
 * So this thanks them, says the material reached them and is on file, and says plainly what still
 * has to happen and why the rule asks for it.
 */
async function acknowledgePartly(
  person: { firstName: string; lastName: string; email: string | null },
  token: string,
  label: string,
): Promise<void> {
  if (!person.email) return;
  try {
    const { sendMail } = await import("./send-mail");
    const { linkFor } = await import("./training-assignments");
    const { getSettings } = await import("./settings");
    const s = await getSettings();
    await sendMail(
      person.email,
      `Received — one thing still to do: ${label}`,
      [
        `${person.firstName},`,
        "",
        `Thank you — your reply is on file, and it records that you were sent the ${label.toLowerCase()}`,
        "material and have read it.",
        "",
        "Nothing else is needed from you.",
        "",
        "One thing still has to happen at this end. The bloodborne pathogens standard asks for a",
        "chance to ask questions of somebody who knows the subject, and an email cannot show that",
        "a conversation happened. So the pharmacist-in-charge will have a few minutes with you",
        "about it and record that — if he has not already.",
        "",
        "If anything in the material was unclear, that is the moment to say so.",
        "",
        `${s.pharmacy_name || "The pharmacy"}`,
        `Reference: ${token.slice(0, 8)}`,
      ].join("\n"),
    );
  } catch {
    // Silent by design: the reply is on file either way.
  }
}

/**
 * The trainer's half: that the questions and answers actually happened.
 *
 * Recorded for several people at once, because that is how it happens — the pharmacist-in-charge
 * goes through it on a quiet afternoon with whoever is in, not person by person on separate days.
 *
 * This is what completes a training attested by email. The person's reply says the material
 * reached them and they read it; this says a knowledgeable person went through it and answered
 * their questions, which is what 29 CFR 1910.1030(g)(2)(vii)(N) asks for and what an email cannot
 * carry. The statement stored against each person names both halves and both dates, so the record
 * says what happened rather than implying it.
 */
export async function attestQuestionsAndAnswers(
  assignmentIds: string[],
  input: { on: string; note: string },
  user: { id: string; name: string },
): Promise<{ completed: number; names: string[] }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.on)) throw new Error("Give the date you went through it with them.");
  if (assignmentIds.length === 0) throw new Error("Nobody was selected.");

  const names: string[] = [];
  let completed = 0;

  for (const id of assignmentIds) {
    const a = await db.query.trainingAssignments.findFirst({ where: eq(schema.trainingAssignments.id, id) });
    if (!a || !a.completedAt || a.qaAttestedOn) continue;
    const person = await db.query.people.findFirst({ where: eq(schema.people.id, a.personId) });
    if (!person) continue;

    const course = courseFor(a.type);
    const months = TRAINING_CADENCE[a.type]?.months;
    const on = a.completedAt.slice(0, 10);
    const trainingId = newId();

    const statement =
      `${person.firstName} ${person.lastName} confirmed by email on ${on}, from their own address, that they had ` +
      `been given and had read the ${TRAINING_LABEL[a.type].toLowerCase()} material. On ${input.on} I went through ` +
      `it with them and answered their questions, as 29 CFR 1910.1030(g)(2)(vii)(N) requires.` +
      (input.note.trim() ? ` ${input.note.trim()}` : "") +
      ` Attested by ${user.name}.`;

    await db.insert(schema.trainings).values({
      id: trainingId,
      personId: a.personId,
      type: a.type,
      completedOn: input.on,
      cycleYear: Number(input.on.slice(0, 4)),
      expiresOn: months ? addMonths(input.on, months) : null,
      provider: "Read by the employee, then gone through with the pharmacist-in-charge",
      minutes: course?.minutes ?? null,
      documentId: a.replyDocumentId ?? null,
      notes: statement,
      createdBy: user.name,
    });

    await db
      .update(schema.trainingAssignments)
      .set({ trainingId, qaAttestedOn: input.on, qaAttestedBy: user.name, qaNote: input.note.trim() || null })
      .where(eq(schema.trainingAssignments.id, id));

    names.push(`${person.firstName} ${person.lastName}`);
    completed++;
  }

  return { completed, names };
}

/** Replies waiting on the trainer's half, so the pharmacist-in-charge can see the queue. */
export async function awaitingQuestionsAndAnswers(): Promise<
  { assignmentId: string; personId: string; name: string; type: TrainingType; repliedOn: string }[]
> {
  const rows = await db.query.trainingAssignments.findMany({
    where: and(isNotNull(schema.trainingAssignments.completedAt), isNull(schema.trainingAssignments.qaAttestedOn)),
  });
  const out: { assignmentId: string; personId: string; name: string; type: TrainingType; repliedOn: string }[] = [];
  for (const a of rows) {
    if (a.trainingId) continue; // already a complete record by some other route
    if (!courseFor(a.type)?.liveQuestionsRequired) continue;
    const person = await db.query.people.findFirst({ where: eq(schema.people.id, a.personId) });
    if (!person) continue;
    out.push({
      assignmentId: a.id,
      personId: a.personId,
      name: `${person.firstName} ${person.lastName}`,
      type: a.type,
      repliedOn: a.completedAt!.slice(0, 10),
    });
  }
  return out;
}
