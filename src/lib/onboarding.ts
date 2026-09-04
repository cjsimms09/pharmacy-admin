import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { TRAINING_CADENCE } from "./due";
import { CREDENTIAL_LABEL, TRAINING_LABEL } from "./labels";
import { todayIso, daysBetween } from "./dates";
import type { CredentialType, TrainingType } from "@/db/schema";

/**
 * Everything a new employee has to complete, in one list.
 *
 * On the day somebody starts, what is actually required of them is scattered: a registration
 * number to record, a licence to photograph, six trainings to send, a hepatitis B offer to
 * document, an acknowledgement of the manual, and a technician list that has to be right by the
 * end of the month. None of that is difficult; all of it is easy to half-do, and a half-done new
 * starter is invisible until an inspector counts the training file and finds five certificates
 * for six people.
 *
 * So it is one list, per person, that knows what applies to their role and can tell what is
 * already done from the records rather than from a tick somebody remembered to make. A checklist
 * that has to be maintained by hand is a second thing to forget.
 */

export type PackItem = {
  key: string;
  group: "identity" | "credential" | "training" | "record";
  label: string;
  /** Why it is required, in the words that would answer an inspector. */
  why: string;
  done: boolean;
  /** What is on file, when something is. */
  detail?: string;
  credentialType?: CredentialType;
  trainingType?: TrainingType;
  href?: string;
};

export type Pack = {
  person: typeof schema.people.$inferSelect;
  items: PackItem[];
  done: number;
  total: number;
  daysSinceStart: number | null;
};

/**
 * The date this person started, whichever kind of person they are.
 *
 * Employed staff have a hire date; a student on rotation has a window they are present for. Those
 * are different columns for good reasons, and reading only one of them meant an employee with a
 * hire date recorded showed "no start date" and never appeared in the list of unfinished new
 * starters at all — the feature silently excluding the people it exists for.
 */
export function startedOn(person: { engagement: string; hiredOn: string | null; startsOn: string | null }): string | null {
  return person.engagement === "rotation" ? (person.startsOn ?? person.hiredOn) : (person.hiredOn ?? person.startsOn);
}

/** The licence or registration this person cannot work without. */
export function licenceFor(role: string): CredentialType {
  return role === "pharmacist" ? "pharmacist_license" : role === "technician" ? "technician_registration" : "intern_registration";
}

/** Which trainings a new starter owes on day one, given what they will be doing. */
export function trainingsFor(person: { administersVaccines: boolean }): TrainingType[] {
  return (Object.keys(TRAINING_CADENCE) as TrainingType[]).filter(
    (t) => t !== "immunization_protocol_review" || person.administersVaccines,
  );
}

/** Which documents have to be collected, given the role. */
export function credentialsFor(person: { role: string; administersVaccines: boolean }): CredentialType[] {
  const out: CredentialType[] = [licenceFor(person.role)];
  if (person.administersVaccines) out.push("cpr", "immunization_training", "immunization_protocol");
  return out;
}

export async function newHirePack(personId: string): Promise<Pack | null> {
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, personId) });
  if (!person) return null;

  const [creds, trainings, assignments, docs] = await Promise.all([
    db.query.credentials.findMany({ where: eq(schema.credentials.personId, personId) }),
    db.query.trainings.findMany({ where: eq(schema.trainings.personId, personId) }),
    db.query.trainingAssignments.findMany({ where: eq(schema.trainingAssignments.personId, personId) }),
    db.query.documents.findMany({ where: eq(schema.documents.personId, personId) }),
  ]);

  const items: PackItem[] = [];

  // ── Who they are ──
  items.push({
    key: "email",
    group: "identity",
    label: "An email address on file",
    why: "Training is sent by email and the attestation comes back the same way. Without one, none of the rest can start.",
    done: !!person.email,
    detail: person.email ?? undefined,
    href: `/staff/${personId}`,
  });
  const started = startedOn(person);
  items.push({
    key: "start",
    group: "identity",
    label: person.engagement === "rotation" ? "Rotation dates recorded" : "Hire date recorded",
    why: "The technician list and the training file both date from it, and an inspector asks when somebody started.",
    done: !!started,
    detail: started ?? undefined,
    href: `/staff/${personId}`,
  });

  // ── What they have to bring ──
  for (const type of credentialsFor(person)) {
    const held = creds.filter((c) => c.type === type).sort((a, b) => (b.expiresOn ?? "").localeCompare(a.expiresOn ?? ""))[0];
    const attached = held ? docs.some((d) => d.credentialId === held.id) : false;
    items.push({
      key: `cred-${type}`,
      group: "credential",
      label: CREDENTIAL_LABEL[type],
      why: WHY_CREDENTIAL[type] ?? "Required to be held and available for inspection.",
      done: !!held && attached,
      detail: held ? (attached ? `on file${held.expiresOn ? `, expires ${held.expiresOn}` : ""}` : "recorded, but the document itself is not attached") : undefined,
      credentialType: type,
      href: `/staff/${personId}#credential-form`,
    });
  }

  // ── What they have to complete ──
  for (const type of trainingsFor(person)) {
    const completed = trainings.some((t) => t.type === type && t.completedOn);
    const assigned = assignments.find((a) => a.type === type && !a.completedAt);
    items.push({
      key: `training-${type}`,
      group: "training",
      label: TRAINING_LABEL[type],
      why: TRAINING_CADENCE[type]?.why ?? "Required of everyone here.",
      done: completed,
      detail: completed
        ? "completed"
        : assigned?.sentAt
          ? `sent ${assigned.sentAt.slice(0, 10)}, not yet returned`
          : assigned
            ? "assigned, not yet sent"
            : undefined,
      trainingType: type,
      href: "/compliance/training",
    });
  }

  // ── What the pharmacy has to do about them ──
  const hepB = creds.some((c) => c.type === "hepatitis_b");
  items.push({
    key: "hep-b",
    group: "record",
    label: "Hepatitis B: offered, and accepted or declined in writing",
    why: "29 CFR 1910.1030(f)(2) requires the vaccine be offered within ten working days of the start of exposure, and a signed declination kept if it is refused.",
    done: hepB,
    href: "/staff/hepatitis-b",
  });
  if (person.role === "technician") {
    items.push({
      key: "tech-list",
      group: "record",
      label: "Added to the technician list",
      why: "K.S.A. 65-1663(i) requires a current list of technicians employed, available for inspection. This site files it at the end of each month.",
      done: !!started,
      detail: "Filed automatically once the start date is recorded",
      href: "/staff/technician-list",
    });
  }

  const done = items.filter((i) => i.done).length;
  return {
    person,
    items,
    done,
    total: items.length,
    daysSinceStart: started ? daysBetween(started, todayIso()) : null,
  };
}

const WHY_CREDENTIAL: Partial<Record<CredentialType, string>> = {
  pharmacist_license: "Nobody may practise without a current Kansas licence, and the certificate has to be available for inspection.",
  technician_registration: "K.A.R. 68-5-16 requires registration before a technician performs any task, not after.",
  intern_registration: "An intern must be registered with the Board before working under a pharmacist's supervision.",
  cpr: "Required of every immunizer, and the first thing asked for after an adverse reaction.",
  immunization_training: "ACPE-accredited immunization training is a condition of administering vaccines under K.S.A. 65-1635a.",
  immunization_protocol: "The physician-signed protocol each immunizer works under. Without it there is no authority to administer.",
};

/**
 * Anybody who started recently and has not finished.
 *
 * A new starter is only interesting for as long as their pack is open. Ninety days is long enough
 * that nothing is missed and short enough that the list does not become a second staff page.
 */
export async function openPacks(): Promise<{ id: string; name: string; role: string; done: number; total: number; startsOn: string | null }[]> {
  const people = await db.query.people.findMany();
  const today = todayIso();
  const recent = people.filter((p) => {
    if (!p.active) return false;
    const from = startedOn(p);
    // No start date at all is itself an unfinished pack, so those stay in rather than falling out.
    if (!from) return true;
    const age = daysBetween(from, today);
    return age <= 90 && age >= -30;
  });
  const out = [];
  for (const p of recent) {
    const pack = await newHirePack(p.id);
    if (!pack || pack.done === pack.total) continue;
    out.push({ id: p.id, name: `${p.firstName} ${p.lastName}`, role: p.role, done: pack.done, total: pack.total, startsOn: startedOn(p) });
  }
  return out.sort((a, b) => (a.startsOn ?? "").localeCompare(b.startsOn ?? ""));
}
