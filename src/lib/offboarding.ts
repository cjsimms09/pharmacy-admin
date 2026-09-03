import "server-only";
import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayIso } from "./dates";

/**
 * Ending someone's employment without losing their file.
 *
 * Nothing is deleted, ever. The instinct when somebody leaves is to tidy them away, and it is the
 * wrong instinct here: an inspector asking in 2029 about a dispensing error from 2026 does not
 * care that the technician involved moved on in 2027, and neither does a subpoena. What they
 * signed, what they were trained on, and what licence they held on the day are all still the
 * pharmacy's to produce.
 *
 * So an ex-employee is marked ended, on a date, with a reason, and everything attached to them
 * stays exactly where it is and stays retrievable. What ending does change is the future: they
 * stop being counted as staff who owe training, and — the part that actually matters day to day —
 * the site stops emailing them.
 */

export type Retention = {
  credentials: number;
  trainings: number;
  documents: number;
  ceEntries: number;
  signedAttestations: number;
  /** The earliest date everything about this person could be destroyed, and why. */
  keepUntil: string | null;
  reasons: string[];
};

/**
 * How long the file has to be kept, and under which rule.
 *
 * These do not agree with each other, which is the point of listing them rather than picking one:
 * the answer is the latest of them, and a pharmacy that keeps records for the shortest applicable
 * period has usually found the wrong rule.
 */
const RETENTION_RULES: { years: number; why: string }[] = [
  { years: 6, why: "HIPAA requires training records and related documentation to be kept six years — 45 CFR 164.530(j)." },
  { years: 5, why: "Kansas pharmacy records are generally kept five years — K.A.R. 68-7-12 and the CQI five-year rule at K.A.R. 68-19-1." },
  { years: 3, why: "OSHA bloodborne pathogens training records are kept three years from the date of training — 29 CFR 1910.1030(h)(2)(ii)." },
];

/**
 * Hepatitis B vaccination and exposure records are the outlier and are worth saying out loud,
 * because thirty years is not a number anyone guesses.
 */
const MEDICAL_RECORD_RULE =
  "Any hepatitis B vaccination record or exposure incident record for this person must be kept for the duration of " +
  "employment plus thirty years — 29 CFR 1910.1020(d)(1)(i).";

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y + years}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** What is on file for someone, and how long it has to stay there. */
export async function retentionFor(personId: string): Promise<Retention> {
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, personId) });
  const [credentials, trainings, documents, ceEntries, assignments] = await Promise.all([
    db.query.credentials.findMany({ where: eq(schema.credentials.personId, personId) }),
    db.query.trainings.findMany({ where: eq(schema.trainings.personId, personId) }),
    db.query.documents.findMany({ where: eq(schema.documents.personId, personId) }),
    db.query.ceEntries.findMany({ where: eq(schema.ceEntries.personId, personId) }),
    db.query.trainingAssignments.findMany({ where: eq(schema.trainingAssignments.personId, personId) }),
  ]);

  const from = person?.endedOn ?? null;
  const longest = RETENTION_RULES.reduce((a, b) => (a.years >= b.years ? a : b));
  return {
    credentials: credentials.length,
    trainings: trainings.length,
    documents: documents.length,
    ceEntries: ceEntries.length,
    signedAttestations: assignments.filter((a) => a.completedAt).length,
    keepUntil: from ? addYears(from, longest.years) : null,
    reasons: [...RETENTION_RULES.map((r) => r.why), MEDICAL_RECORD_RULE],
  };
}

export type EndResult = {
  name: string;
  /** Outstanding training links cancelled, so nobody's ex-employer keeps emailing them. */
  assignmentsCancelled: number;
  retention: Retention;
};

/**
 * Ends employment.
 *
 * Refuses on the pharmacist-in-charge, deliberately. Kansas requires the pharmacy to have one,
 * and the Board has to be told within the period it allows; a PIC who quietly becomes inactive in
 * the staff list is a registration problem waiting to be discovered by someone else. Name the new
 * PIC first and this stops complaining.
 */
export async function endEmployment(
  personId: string,
  opts: { endedOn?: string; reason?: string },
  user: { id: string; name: string },
): Promise<EndResult> {
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, personId) });
  if (!person) throw new Error("That person is not on file.");
  if (!person.active) throw new Error(`${person.firstName} ${person.lastName} is already recorded as having left.`);
  if (person.isPic) {
    throw new Error(
      "This is the pharmacist-in-charge. Make someone else the PIC first — Kansas requires the pharmacy to have one " +
        "and the Board has to be notified of the change.",
    );
  }

  const endedOn = opts.endedOn?.trim() || todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endedOn)) throw new Error("The end date must be a real date.");
  if (endedOn > todayIso()) throw new Error("The end date cannot be in the future.");
  if (person.hiredOn && endedOn < person.hiredOn) throw new Error("The end date is before the hire date.");

  // Cancel anything outstanding. Reminder emails to a former employee are the one part of this
  // that is actively embarrassing, and they will keep arriving weekly until something stops them.
  const open = await db.query.trainingAssignments.findMany({
    where: and(eq(schema.trainingAssignments.personId, personId), isNull(schema.trainingAssignments.completedAt)),
  });
  for (const a of open) {
    await db.delete(schema.trainingAssignments).where(eq(schema.trainingAssignments.id, a.id));
  }

  await db
    .update(schema.people)
    .set({
      active: false,
      endedOn,
      endedReason: opts.reason?.trim() || null,
      endedBy: user.name,
      administersVaccines: false,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.people.id, personId));

  return {
    name: `${person.firstName} ${person.lastName}`,
    assignmentsCancelled: open.length,
    retention: await retentionFor(personId),
  };
}

/** Somebody came back, or the wrong person was ended. Their whole file is still there. */
export async function reinstate(personId: string, user: { id: string; name: string }): Promise<{ name: string }> {
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, personId) });
  if (!person) throw new Error("That person is not on file.");
  await db
    .update(schema.people)
    .set({
      active: true,
      endedOn: null,
      endedReason: person.endedReason ? `${person.endedReason} (reinstated by ${user.name} on ${todayIso()})` : null,
      endedBy: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.people.id, personId));
  return { name: `${person.firstName} ${person.lastName}` };
}
