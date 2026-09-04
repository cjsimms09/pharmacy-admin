import "server-only";
import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId, randomToken } from "./crypto";
import { todayIso, daysBetween, fmt } from "./dates";
import { addMonths, TRAINING_CADENCE } from "./due";
import { TRAINING_LABEL } from "./labels";
import { courseFor } from "./courses";
import { makeReplyCode } from "./training-replies";
import { packetText, packetFileName, courseVersion } from "./course-packet";
import { subjectFor, textFor, htmlFor, type EmailContext } from "./training-email";
import { getSettings, setSetting } from "./settings";
import { sendMail } from "./send-mail";
import type { TrainingType } from "@/db/schema";

/**
 * Assigning training and getting a defensible record back.
 *
 * The gap this fills is the whole difference between tracking training and having it. The site
 * could record that somebody completed FWA training; it had no way for them to actually do it,
 * and no evidence beyond the PIC's word that they had.
 *
 * Three things make the resulting record hold up.
 *
 * The person signs, not the PIC. A record created by the manager on someone else's behalf is
 * an assertion; one created by the person themselves is evidence.
 *
 * The wording is stored per assignment. If the statement template changes in a later release it
 * must not retroactively alter what somebody agreed to a year ago.
 *
 * What is captured is what makes an electronic signature valid under the ESIGN Act and the
 * Kansas UETA — intent to sign, the signature attached to the record it concerns, and the record
 * retained and reproducible. Time, address and the exact text are all kept.
 */

/** What each training asks the person to attest to. */
export const STATEMENTS: Partial<Record<TrainingType, string>> = {
  fwa_general_compliance:
    "I confirm that I have completed the fraud, waste and abuse and general compliance training assigned to me. " +
    "I understand my obligation to report suspected fraud, waste or abuse, that I may do so without fear of " +
    "retaliation, and that I know how to raise a concern at this pharmacy.",
  hipaa_privacy_security:
    "I confirm that I have completed the HIPAA privacy and security training assigned to me. I understand that " +
    "protected health information may only be used or disclosed as permitted, that I must report any suspected " +
    "breach immediately, and that these obligations continue after my employment ends.",
  osha_bloodborne:
    "I confirm that I have completed the bloodborne pathogens training assigned to me. I understand the exposure " +
    "risks in this pharmacy, the precautions required of me, and exactly what to do and who to tell if I am exposed.",
  osha_hazard_communication:
    "I confirm that I have completed the hazard communication training assigned to me. I know which hazardous " +
    "chemicals are kept here, where the safety data sheets are, and how to read a label. I understand that a " +
    "container I fill and leave behind has to be labelled, what to do if something spills or splashes on me, and " +
    "that I am to report every exposure however minor it seems.",
  controlled_substance_diversion:
    "I confirm that I have completed the controlled substance diversion awareness training assigned to me. I " +
    "understand the signs of diversion, my duty to report anything I suspect, and how to report it.",
  policy_manual_acknowledgement:
    "I confirm that I have read the policy and procedure manual of this pharmacy. I understand that I am expected to " +
    "work in accordance with it, that it covers my conduct as well as my duties, and that where something is not " +
    "covered I am expected to ask rather than to decide alone. I understand this acknowledgement is retained in my " +
    "employee file.",
  cqi_program_review:
    "I confirm that I have read the pharmacy's written continuous quality improvement programme. I understand how " +
    "to report a quality-related event, that reporting is expected of me rather than held against me, and that the " +
    "purpose is to improve the system rather than to assign blame.",
  immunization_protocol_review:
    "I confirm that I have read the immunization protocols under which I administer vaccines. I understand the " +
    "screening required before a dose, the doses, routes and sites for each vaccine I give, and exactly what to do " +
    "if a patient has an adverse reaction, including when to use epinephrine and when to call for help.",
};

/**
 * Where the material for each training lives.
 *
 * Held as a setting rather than hard-coded, for a reason worth stating: a link that has gone
 * stale is worse than no link. CMS reorganises its training pages, a PSAO moves its portal, and
 * a course that quietly 404s in a compliance email produces staff who cannot do the training and
 * a PIC who does not find out until someone asks. The pharmacy pastes what it actually uses, and
 * owns it.
 *
 * One line per training: the type, then "=", then the address.
 */
export function parseMaterials(raw: string): Partial<Record<TrainingType, string>> {
  const out: Partial<Record<TrainingType, string>> = {};
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const key = t.slice(0, i).trim() as TrainingType;
    const url = t.slice(i + 1).trim();
    if (key && /^https?:\/\//i.test(url)) out[key] = url;
  }
  return out;
}

export async function materialFor(type: TrainingType): Promise<string | null> {
  const s = await getSettings();
  return parseMaterials(s.training_materials ?? "")[type] ?? null;
}

export type AssignResult = { assigned: number; emailed: number; problems: string[]; delivered: string[] };

/** Creates assignments and emails the links. */
export async function assignTraining(
  personIds: string[],
  type: TrainingType,
  opts: { dueOn?: string; materialUrl?: string | null; materialDocumentId?: string | null; email?: boolean },
  user: { id: string; name: string },
): Promise<AssignResult> {
  const people = await db.query.people.findMany();
  const statement = STATEMENTS[type];
  if (!statement) throw new Error(`No attestation wording is defined for ${TRAINING_LABEL[type]}.`);

  const today = todayIso();
  const dueOn = opts.dueOn || addMonths(today, 1);
  const out: AssignResult = { assigned: 0, emailed: 0, problems: [], delivered: [] };

  for (const id of personIds) {
    const person = people.find((p) => p.id === id);
    if (!person) continue;

    // An outstanding assignment for the same training is reused rather than duplicated —
    // sending someone two links for one requirement is how they end up doing neither.
    const existing = await db.query.trainingAssignments.findFirst({
      where: and(eq(schema.trainingAssignments.personId, id), eq(schema.trainingAssignments.type, type), isNull(schema.trainingAssignments.completedAt)),
    });
    const assignmentId = existing?.id ?? newId();
    if (!existing) {
      await db.insert(schema.trainingAssignments).values({
        id: assignmentId,
        personId: id,
        type,
        token: randomToken(24),
        replyCode: makeReplyCode(),
        assignedOn: today,
        dueOn,
        // The link given for this run, else whatever the pharmacy has set as its standard.
        materialUrl: opts.materialUrl ?? (await materialFor(type)),
        materialDocumentId: opts.materialDocumentId ?? null,
        statement,
        createdBy: user.name,
      });
      out.assigned++;
    }

  }

  // One email per person, covering everything they owe. Three emails for three trainings is how
  // all three get ignored, and it is the complaint every member of staff has about compliance
  // software. Assigning several trainings at once therefore creates them all first and sends
  // once — pass email: false and call sendOutstanding yourself when doing that.
  if (opts.email !== false) {
    const sent = await sendOutstanding(personIds);
    out.emailed = sent.emailed;
    out.problems.push(...sent.problems);
    out.delivered.push(...sent.delivered);
  }
  return out;
}

export type SendResult = {
  emailed: number;
  problems: string[];
  /** Who each message was addressed to — accepted for delivery, which is not the same as arrived. */
  delivered: string[];
};

/**
 * Emails each person everything they currently owe, in one message.
 *
 * Safe to run again: it reuses the assignment that already exists, so re-sending does not create
 * a second link or a second reply code, and does not reset anything the person has already done.
 */
export async function sendOutstanding(personIds?: string[]): Promise<SendResult> {
  const out: SendResult = { emailed: 0, problems: [], delivered: [] };
  const open = await db.query.trainingAssignments.findMany({ where: isNull(schema.trainingAssignments.completedAt) });
  const people = await db.query.people.findMany();

  const byPerson = new Map<string, typeof open>();
  for (const a of open) {
    if (personIds && !personIds.includes(a.personId)) continue;
    byPerson.set(a.personId, [...(byPerson.get(a.personId) ?? []), a]);
  }

  for (const [personId, items] of byPerson) {
    const person = people.find((p) => p.id === personId);
    if (!person) continue;
    if (!person.email) {
      out.problems.push(`${person.firstName} ${person.lastName} has no email address on file.`);
      continue;
    }
    const r = await emailPerson(person, items);
    const now = new Date().toISOString();
    for (const a of items) {
      const course = courseFor(a.type);
      await db
        .update(schema.trainingAssignments)
        .set(
          r.ok
            ? {
                sentAt: now,
                sendError: null,
                // What was actually delivered, and when. The certificate names this version, so
                // a course edited later cannot retroactively claim to be the one they sat.
                materialVersion: course ? courseVersion(course) : null,
                materialSentAt: course ? now : null,
              }
            : { sendError: r.error },
        )
        .where(eq(schema.trainingAssignments.id, a.id));
    }
    if (r.ok) {
      out.emailed++;
      // Named, always. The commonest reason an email "sends" and never arrives is that the address
      // on file is wrong — a typo, or a placeholder nobody replaced — and seeing it written out is
      // the entire diagnosis.
      /*
       * The message id, kept and shown.
       *
       * When a message is accepted and then never appears, this id is the only thread anyone can
       * pull: it is in the sending account's Sent folder and in the receiving domain's mail logs,
       * so whoever runs that domain can trace exactly where it went — delivered, quarantined, or
       * dropped. Without it the conversation is "it says it sent" against "I never got it", which
       * nobody can resolve.
       */
      out.delivered.push(
        `${person.firstName} ${person.lastName} <${person.email}>` +
          (r.messageId ? ` — message id ${r.messageId}` : ""),
      );
      // Delivered, but not intact. Silently dropping the course packet would leave the pharmacy
      // believing it had emailed the training material when it had emailed a link to it.
      if (r.degraded) out.problems.push(`${person.firstName}: ${r.degraded}`);
    } else {
      out.problems.push(`Could not email ${person.firstName}: ${r.error}`);
    }
  }
  return out;
}

/**
 * The email itself.
 *
 * Two ways to complete are offered, in the order of how good the resulting record is. The link is
 * first because it produces the stronger evidence — a typed signature, a timestamp, a device, and
 * a comprehension check that had to be passed. The reply is second because people reply to
 * emails, and a system that only works when everyone behaves as it prefers does not work.
 *
 * The material travels with it. An email linking to a course proves the pharmacy asked; an email
 * carrying the course proves the pharmacy provided it, and only the second is training.
 */
async function emailPerson(
  person: { firstName: string; lastName: string; email: string | null },
  items: { type: TrainingType; token: string; replyCode: string | null; dueOn: string; materialDocumentId?: string | null }[],
  opts: { reminder?: boolean } = {},
) {
  const s = await getSettings();
  const pharmacy = (s.pharmacy_name || "the pharmacy").trim();
  const address =
    [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
      .filter(Boolean)
      .join(" · ") || null;
  const pic = (await db.query.people.findMany()).find((p) => p.isPic);

  const ctx: EmailContext = {
    firstName: person.firstName,
    pharmacy,
    address,
    phone: s.pharmacy_phone || null,
    picName: pic ? `${pic.firstName} ${pic.lastName}` : null,
    today: todayIso(),
    reminder: Boolean(opts.reminder),
    items: await Promise.all(
      items.map(async (i) => {
        const course = courseFor(i.type);
        return {
          type: i.type,
          title: course?.title ?? TRAINING_LABEL[i.type],
          minutes: course?.minutes ?? null,
          dueOn: i.dueOn,
          url: await linkFor(i.token),
          replyCode: i.replyCode,
        };
      }),
    ),
  };

  /*
   * Attachments are opt-in, and off by default.
   *
   * A bare message arrived and the same message carrying seven text files and a Word document did
   * not — accepted by the sending server, then dropped somewhere downstream, with no bounce and
   * nothing in any log. That is the difference between a test email that works and a training
   * email that vanishes, and it is not a difference worth keeping: the course is one click away in
   * the body of the email, so the attachment adds very little and can cost the entire message.
   *
   * A pharmacy that wants the packet attached, and whose mail survives it, can turn it back on.
   */
  const attach = s.training_attach_material === "yes";
  const attachments: { filename: string; content: string | Buffer; contentType?: string }[] = !attach
    ? []
    : items
        .map((i) => courseFor(i.type))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((course) => ({
          filename: packetFileName(course),
          content: packetText(course, pharmacy),
          contentType: "text/plain; charset=utf-8",
        }));

  // Where the assignment carries a document from the vault — a policy manual, a signed protocol —
  // the document itself goes with the email. A link to it is a link somebody has to be on the
  // pharmacy network to open, and "we sent them a link" is a weaker sentence than "we sent them
  // the manual" in every conversation where it matters.
  const docIds = attach ? ([...new Set(items.map((i) => i.materialDocumentId).filter(Boolean))] as string[]) : [];
  for (const id of docIds) {
    try {
      const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, id) });
      if (!doc) continue;
      const { readFile } = await import("./files");
      const content = await readFile(doc.storageKey);
      if (content.byteLength > 15 * 1024 * 1024) continue; // too big to email; the link still works
      attachments.push({ filename: doc.fileName, content, contentType: doc.mimeType });
    } catch {
      // A missing file must not stop the training being sent. The link in the email still works.
    }
  }

  return sendMail(person.email!, subjectFor(ctx), textFor(ctx), attachments, htmlFor(ctx));
}

/**
 * The address staff will actually be able to reach.
 *
 * The site runs on a computer in the pharmacy, so a link is only useful on the same network
 * unless an address has been configured. Rather than send a link that silently fails, this uses
 * whatever the pharmacy set under Settings → Network.
 */
export async function linkFor(token: string): Promise<string> {
  const s = await getSettings();
  const base = (s.public_base_url || "").trim().replace(/\/$/, "");
  return `${base || "http://localhost:3000"}/t/${token}`;
}

/**
 * Reminders: one a week while anything is outstanding, then the PIC is told rather than the person.
 *
 * Grouped per person for the same reason the first email is: somebody with three trainings open
 * should get one reminder a week, not three, and three is how a reminder becomes something the
 * mail client filters.
 */
export async function sendReminders(): Promise<{ reminded: number; escalated: string[] }> {
  const today = todayIso();
  const open = await db.query.trainingAssignments.findMany({ where: isNull(schema.trainingAssignments.completedAt) });
  const people = await db.query.people.findMany();
  let reminded = 0;
  const escalated: string[] = [];

  const byPerson = new Map<string, typeof open>();
  for (const a of open) byPerson.set(a.personId, [...(byPerson.get(a.personId) ?? []), a]);

  for (const [personId, items] of byPerson) {
    const person = people.find((p) => p.id === personId);
    if (!person?.email) continue;

    // Four reminders is enough. Past that it is a management problem rather than a mail problem,
    // and the PIC needs to know rather than the person getting another copy.
    const spent = items.filter((a) => daysBetween(a.dueOn, today) > 0 && a.remindersSent >= 4);
    for (const a of spent) {
      escalated.push(`${person.firstName} ${person.lastName} — ${TRAINING_LABEL[a.type]}, ${daysBetween(a.dueOn, today)} days late`);
    }
    const chase = items.filter((a) => !spent.includes(a));
    if (chase.length === 0) continue;

    // A week since the last reminder for any of them. Sending one email means one clock.
    const lastAt = chase.map((a) => a.lastReminderAt).filter(Boolean).sort().pop();
    if (lastAt && daysBetween(lastAt.slice(0, 10), today) < 7) continue;

    const r = await emailPerson(person, chase, { reminder: true });
    if (r.ok) {
      const now = new Date().toISOString();
      for (const a of chase) {
        await db
          .update(schema.trainingAssignments)
          .set({ remindersSent: a.remindersSent + 1, lastReminderAt: now })
          .where(eq(schema.trainingAssignments.id, a.id));
      }
      reminded++;
    }
  }

  if (escalated.length > 0) await tellThePic(escalated);
  await setSetting("training_reminders_last", new Date().toISOString());
  return { reminded, escalated };
}

/** Once the reminders are spent, the PIC hears about it instead. */
async function tellThePic(escalated: string[]) {
  const people = await db.query.people.findMany();
  const pic = people.find((p) => p.isPic);
  if (!pic?.email) return;
  await sendMail(
    pic.email,
    `${escalated.length} training${escalated.length === 1 ? "" : "s"} still outstanding after four reminders`,
    [
      "These have been chased weekly and are still not done. Reminders have stopped, because at this",
      "point another email is not what is missing.",
      "",
      ...escalated.map((e) => `— ${e}`),
      "",
      "You can record that you delivered the training yourself from the training screen, which is a",
      "real record and says plainly that it was you rather than them who signed.",
    ].join("\n"),
  );
}

/**
 * A member of staff completing their training and signing for it.
 *
 * The comprehension check is graded before anything is written. A wrong answer is not a failure
 * to be recorded — it is a page to send them back to, with the reason. Nothing is stored until
 * every answer is right, so there is no such thing here as a training record with a failed quiz
 * behind it, and no incentive for anyone to guess their way past one.
 */
export type SignInput = {
  signedName: string;
  /** One answer index per question, in order. Null where nothing was chosen. */
  answers: (number | null)[];
  /** Only asked where the standard requires it — bloodborne pathogens. */
  liveQuestions: boolean;
};

export type SignResult =
  | { ok: true; label: string; trainingId: string }
  | { ok: false; error: string; wrong?: { index: number; why: string }[] };

export async function completeAssignment(
  token: string,
  input: SignInput,
  meta: { ip: string | null; agent: string | null },
): Promise<SignResult> {
  const a = await db.query.trainingAssignments.findFirst({ where: eq(schema.trainingAssignments.token, token) });
  if (!a) return { ok: false, error: "This link is not valid." };
  if (a.completedAt) return { ok: false, error: "This has already been signed." };

  const course = courseFor(a.type);
  const signedName = input.signedName.trim();

  const wrong: { index: number; why: string }[] = [];
  if (course) {
    course.questions.forEach((q, i) => {
      if (input.answers[i] !== q.answer) wrong.push({ index: i, why: q.why });
    });
    if (wrong.length > 0) {
      return {
        ok: false,
        error:
          wrong.length === course.questions.length
            ? "None of those were right. Have another look — the reason is under each one."
            : `${wrong.length} of ${course.questions.length} were not right. The reason is under each one — have another go.`,
        wrong,
      };
    }
    if (course.liveQuestionsRequired && !input.liveQuestions) {
      return {
        ok: false,
        error:
          "Tick the box confirming you were offered the chance to ask questions. The bloodborne pathogens standard " +
          "requires it and the record does not count without it.",
      };
    }
  }

  // Last, because being told your name is too short after answering everything correctly is
  // irritating, and being told it before you have started is worse.
  if (signedName.length < 3) return { ok: false, error: "Please type your full name." };

  const today = todayIso();
  const months = TRAINING_CADENCE[a.type]?.months;
  const trainingId = newId();
  await db.insert(schema.trainings).values({
    id: trainingId,
    personId: a.personId,
    type: a.type,
    completedOn: today,
    cycleYear: Number(today.slice(0, 4)),
    expiresOn: months ? addMonths(today, months) : null,
    provider: course ? "The pharmacy's own course, signed online" : "Signed online",
    minutes: course?.minutes ?? null,
    notes: a.statement,
    createdBy: signedName,
  });
  await db
    .update(schema.trainingAssignments)
    .set({
      completedAt: new Date().toISOString(),
      signedName,
      signedIp: meta.ip,
      signedAgent: meta.agent,
      trainingId,
      completedVia: "signed",
      quizCorrect: course ? course.questions.length : null,
      quizTotal: course ? course.questions.length : null,
      liveQuestionsAcknowledged: Boolean(course?.liveQuestionsRequired && input.liveQuestions),
    })
    .where(eq(schema.trainingAssignments.id, a.id));

  return { ok: true, label: TRAINING_LABEL[a.type], trainingId };
}

/**
 * The pharmacist-in-charge recording training they delivered themselves.
 *
 * Most training in a small pharmacy happens in the room: the PIC walks everyone through it on a
 * quiet afternoon. Insisting on individual links for that would mean either sending links nobody
 * needs or, more likely, the training happening and never being recorded at all.
 *
 * So this records it, and is careful to record what actually happened. The statement names the
 * PIC as the person attesting, names who was trained, and says plainly that they did not sign
 * individually. An inspector can then tell the two kinds of record apart at a glance, which is
 * the point — a PIC attestation is real evidence and weaker evidence, and dressing it up as the
 * stronger kind is how a whole file stops being believed.
 */
export async function recordGroupTraining(
  personIds: string[],
  type: TrainingType,
  user: { id: string; name: string },
  opts: { completedOn?: string; how?: string } = {},
): Promise<{ recorded: number; names: string[] }> {
  const people = (await db.query.people.findMany()).filter((p) => personIds.includes(p.id));
  if (people.length === 0) throw new Error("Nobody was selected.");

  const on = opts.completedOn || todayIso();
  const names = people.map((p) => `${p.firstName} ${p.lastName}`);
  const months = TRAINING_CADENCE[type]?.months;
  const course = courseFor(type);
  const how = (opts.how ?? "").trim();

  const statement =
    `On ${fmt(on)} I, ${user.name}, delivered ${TRAINING_LABEL[type].toLowerCase()} to ${names.join(", ")} ` +
    `and confirmed that each of them understood it.` +
    (how ? ` ${how}` : "") +
    ` Recorded by me as pharmacist-in-charge; they did not sign individually.`;

  for (const p of people) {
    const trainingId = newId();
    await db.insert(schema.trainings).values({
      id: trainingId,
      personId: p.id,
      type,
      completedOn: on,
      cycleYear: Number(on.slice(0, 4)),
      expiresOn: months ? addMonths(on, months) : null,
      provider: "In-house, attested by the PIC",
      minutes: course?.minutes ?? null,
      notes: statement,
      createdBy: user.name,
    });
    // Close any outstanding link for the same thing, so nobody is chased for training they
    // have already sat through in the room.
    const open = await db.query.trainingAssignments.findFirst({
      where: and(
        eq(schema.trainingAssignments.personId, p.id),
        eq(schema.trainingAssignments.type, type),
        isNull(schema.trainingAssignments.completedAt),
      ),
    });
    if (open) {
      await db
        .update(schema.trainingAssignments)
        .set({ completedAt: new Date().toISOString(), signedName: null, trainingId, completedVia: "pic_recorded" })
        .where(eq(schema.trainingAssignments.id, open.id));
    }
  }
  return { recorded: people.length, names };
}

export async function assignmentByToken(token: string) {
  const a = await db.query.trainingAssignments.findFirst({ where: eq(schema.trainingAssignments.token, token) });
  if (!a) return null;
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, a.personId) });
  return { assignment: a, person };
}

export async function openAssignments() {
  const rows = await db.query.trainingAssignments.findMany({ orderBy: (a, { asc }) => [asc(a.dueOn)] });
  const people = await db.query.people.findMany();
  return rows.map((a) => ({ ...a, person: people.find((p) => p.id === a.personId) ?? null }));
}
