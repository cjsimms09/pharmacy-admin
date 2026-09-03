import "server-only";
import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId, randomToken } from "./crypto";
import { todayIso, daysBetween, fmt } from "./dates";
import { addMonths, TRAINING_CADENCE } from "./due";
import { TRAINING_LABEL } from "./labels";
import { getSettings } from "./settings";
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
    "chemicals are kept here, where the safety data sheets are, and how to read a label.",
  controlled_substance_diversion:
    "I confirm that I have completed the controlled substance diversion awareness training assigned to me. I " +
    "understand the signs of diversion, my duty to report anything I suspect, and how to report it.",
  cqi_program_review:
    "I confirm that I have read the pharmacy's written continuous quality improvement programme. I understand how " +
    "to report a quality-related event, that reporting is expected of me rather than held against me, and that the " +
    "purpose is to improve the system rather than to assign blame.",
  immunization_protocol_review:
    "I confirm that I have read the immunization protocols under which I administer vaccines. I understand the " +
    "screening required before a dose, the doses, routes and sites for each vaccine I give, and exactly what to do " +
    "if a patient has an adverse reaction, including when to use epinephrine and when to call for help.",
};

export type AssignResult = { assigned: number; emailed: number; problems: string[] };

/** Creates assignments and emails the links. */
export async function assignTraining(
  personIds: string[],
  type: TrainingType,
  opts: { dueOn?: string; materialUrl?: string | null },
  user: { id: string; name: string },
): Promise<AssignResult> {
  const people = await db.query.people.findMany();
  const statement = STATEMENTS[type];
  if (!statement) throw new Error(`No attestation wording is defined for ${TRAINING_LABEL[type]}.`);

  const today = todayIso();
  const dueOn = opts.dueOn || addMonths(today, 1);
  const out: AssignResult = { assigned: 0, emailed: 0, problems: [] };

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
        assignedOn: today,
        dueOn,
        materialUrl: opts.materialUrl ?? null,
        statement,
        createdBy: user.name,
      });
      out.assigned++;
    }

    const row = await db.query.trainingAssignments.findFirst({ where: eq(schema.trainingAssignments.id, assignmentId) });
    if (!row) continue;

    if (!person.email) {
      out.problems.push(`${person.firstName} ${person.lastName} has no email address on file.`);
      continue;
    }
    const sent = await email(row.token, person.email, `${person.firstName} ${person.lastName}`, type, dueOn);
    if (sent.ok) {
      await db.update(schema.trainingAssignments).set({ sentAt: new Date().toISOString(), sendError: null }).where(eq(schema.trainingAssignments.id, assignmentId));
      out.emailed++;
    } else {
      await db.update(schema.trainingAssignments).set({ sendError: sent.error }).where(eq(schema.trainingAssignments.id, assignmentId));
      out.problems.push(`Could not email ${person.firstName}: ${sent.error}`);
    }
  }
  return out;
}

async function email(token: string, to: string, name: string, type: TrainingType, dueOn: string) {
  const s = await getSettings();
  const base = (s.pharmacy_name || "the pharmacy").trim();
  const url = await linkFor(token);
  return sendMail(
    to,
    `${TRAINING_LABEL[type]} — due ${fmt(dueOn)}`,
    [
      `${name},`,
      "",
      `Your annual ${TRAINING_LABEL[type].toLowerCase()} is due by ${fmt(dueOn)}.`,
      "",
      "Open this link, work through it, and sign at the bottom. It takes a few minutes and you do",
      "not need a password:",
      "",
      url,
      "",
      "The link is personal to you — please do not forward it.",
      "",
      base,
    ].join("\n"),
  );
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

/** Reminders: one a week while it is outstanding, then the PIC is told rather than the person. */
export async function sendReminders(): Promise<{ reminded: number; escalated: string[] }> {
  const today = todayIso();
  const open = await db.query.trainingAssignments.findMany({ where: isNull(schema.trainingAssignments.completedAt) });
  const people = await db.query.people.findMany();
  let reminded = 0;
  const escalated: string[] = [];

  for (const a of open) {
    const person = people.find((p) => p.id === a.personId);
    if (!person?.email) continue;
    const since = a.lastReminderAt ? daysBetween(a.lastReminderAt.slice(0, 10), today) : 99;
    if (since < 7) continue;

    const late = daysBetween(a.dueOn, today);
    // Four reminders is enough. Past that it is a management problem, not a mail problem, and
    // the PIC needs to know rather than the inbox getting another copy.
    if (late > 0 && a.remindersSent >= 4) {
      escalated.push(`${person.firstName} ${person.lastName} — ${TRAINING_LABEL[a.type]}, ${late} days late`);
      continue;
    }
    const url = await linkFor(a.token);
    const r = await sendMail(
      person.email,
      late > 0 ? `Overdue: ${TRAINING_LABEL[a.type]}` : `Reminder: ${TRAINING_LABEL[a.type]}`,
      [
        `${person.firstName},`,
        "",
        late > 0
          ? `Your ${TRAINING_LABEL[a.type].toLowerCase()} was due on ${fmt(a.dueOn)} and is ${late} days overdue.`
          : `Your ${TRAINING_LABEL[a.type].toLowerCase()} is due by ${fmt(a.dueOn)}.`,
        "",
        url,
      ].join("\n"),
    );
    if (r.ok) {
      await db
        .update(schema.trainingAssignments)
        .set({ remindersSent: a.remindersSent + 1, lastReminderAt: new Date().toISOString() })
        .where(eq(schema.trainingAssignments.id, a.id));
      reminded++;
    }
  }
  return { reminded, escalated };
}

/**
 * Records a completion from the person themselves.
 *
 * Writes the training row the register reads, so a self-signed completion and one entered by the
 * PIC are the same kind of record downstream — the difference is in the evidence attached, not
 * in whether it counts.
 */
export async function completeAssignment(
  token: string,
  signedName: string,
  meta: { ip: string | null; agent: string | null },
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const a = await db.query.trainingAssignments.findFirst({ where: eq(schema.trainingAssignments.token, token) });
  if (!a) return { ok: false, error: "This link is not valid." };
  if (a.completedAt) return { ok: false, error: "This has already been signed." };
  if (signedName.trim().length < 3) return { ok: false, error: "Please type your full name." };

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
    provider: "Signed online",
    notes: a.statement,
    createdBy: signedName.trim(),
  });
  await db
    .update(schema.trainingAssignments)
    .set({
      completedAt: new Date().toISOString(),
      signedName: signedName.trim(),
      signedIp: meta.ip,
      signedAgent: meta.agent,
      trainingId,
    })
    .where(eq(schema.trainingAssignments.id, a.id));

  return { ok: true, label: TRAINING_LABEL[a.type] };
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
