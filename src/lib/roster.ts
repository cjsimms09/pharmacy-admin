import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayIso, daysBetween } from "./dates";

/**
 * Who is actually here.
 *
 * The distinction this module exists for: a rotation student is present for five weeks and then
 * gone, and both halves of that matter. While they are here they need a licence or intern
 * registration, a CPR card, an immunization certificate and HIPAA training, and an inspector
 * asking about a July incident will ask who was working — so the record has to survive them
 * leaving. After they have gone, chasing them for annual training is noise that trains the PIC
 * to ignore the dashboard, which is the failure this whole site is built to avoid.
 *
 * So presence is a window, not a flag, and everything that chases people asks this module rather
 * than reading `active` and guessing.
 */

export type Presence = "here" | "arriving" | "finished" | "left";

export function presenceOf(
  p: { engagement: string; active: boolean; startsOn: string | null; endsOn: string | null },
  today = todayIso(),
): Presence {
  if (!p.active) return "left";
  if (p.engagement !== "rotation") return "here";
  if (p.startsOn && today < p.startsOn) return "arriving";
  if (p.endsOn && today > p.endsOn) return "finished";
  return "here";
}

/** Everyone the pharmacy should be chasing today. Nobody else appears on a compliance screen. */
export async function onSiteToday() {
  const people = await db.query.people.findMany({
    where: eq(schema.people.active, true),
    orderBy: (p, { asc }) => [asc(p.lastName), asc(p.firstName)],
  });
  return people.filter((p) => presenceOf(p) === "here");
}

/** Everyone on file, whatever their state, for the screens that are about the record. */
export async function everyone() {
  return db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName), asc(p.firstName)] });
}

export type RotationRow = {
  id: string;
  name: string;
  role: string;
  affiliation: string | null;
  startsOn: string | null;
  endsOn: string | null;
  presence: Presence;
  /** Days until they arrive, or until they leave. Negative once past. */
  daysUntilStart: number | null;
  daysLeft: number | null;
  /** What has to be on file before their first shift, and what is missing. */
  missing: string[];
  /** Split, because the two halves are chased in opposite directions. */
  oursToDo: string[];
  toAskFor: string[];
  ready: boolean;
};

/**
 * What a student must have on file before they touch a prescription.
 *
 * Taken from the affiliation agreement rather than guessed at. The agreement makes the school
 * responsible for arranging almost all of this — the intern licence, BLS, immunisations, TB
 * screening, the OIG and SAM exclusion checks, the malpractice cover — and then makes the student
 * responsible for producing it "upon request from Experiential Site". Which means the pharmacy is
 * the party holding nothing at all unless it asks, every time, for every student.
 *
 * The two the pharmacy itself owes are at the end: a site-specific orientation covering HIPAA and
 * this pharmacy's own procedures, and bloodborne pathogens, both of which the agreement puts
 * squarely on the site rather than the school.
 *
 * The exclusion check is the one worth being blunt about. An excluded person working here is the
 * pharmacy's civil monetary penalty for every claim submitted while they were on the bench, not
 * the school's.
 */
const ROTATION_REQUIREMENTS: {
  key: string;
  label: string;
  why: string;
  kind: "credential" | "training";
  type: string;
  /** Who is meant to produce it, so a missing one is chased in the right direction. */
  from: "school" | "student" | "pharmacy";
}[] = [
  {
    key: "registration",
    label: "Kansas intern registration",
    why: "The agreement says a student may not begin until the intern licence is presented to the preceptor.",
    kind: "credential",
    type: "intern_registration",
    from: "student",
  },
  {
    key: "cpr",
    label: "CPR / BLS certification",
    why: "Provided by the school as BLS Healthcare Provider.",
    kind: "credential",
    type: "cpr",
    from: "school",
  },
  {
    key: "immunization_record",
    label: "Immunization record",
    why: "Two MMR, Td/Tdap in date, hepatitis B series with a titer, and varicella immunity.",
    kind: "credential",
    type: "immunization_record",
    from: "student",
  },
  {
    key: "tb",
    label: "TB screening",
    why: "Within the previous year, or documented treatment or a negative chest x-ray.",
    kind: "credential",
    type: "tb_screening",
    from: "student",
  },
  {
    key: "background",
    label: "Background and exclusion checks",
    why: "OIG LEIE, SAM, criminal and sex offender registry. An excluded person working here is this pharmacy's penalty, not the school's.",
    kind: "credential",
    type: "background_check",
    from: "school",
  },
  {
    key: "insurance",
    label: "Professional liability cover",
    why: "$1,000,000 per incident and $3,000,000 aggregate, arranged by the school and shown on request.",
    kind: "credential",
    type: "liability_insurance",
    from: "school",
  },
  {
    key: "hipaa",
    label: "Site-specific HIPAA orientation",
    why: "The agreement puts this on the pharmacy, not the school — our policies, our procedures, our workflow.",
    kind: "training",
    type: "hipaa_privacy_security",
    from: "pharmacy",
  },
  {
    key: "bbp",
    label: "Bloodborne pathogens",
    why: "Ours to deliver for anyone working here with reasonably anticipated exposure.",
    kind: "training",
    type: "osha_bloodborne",
    from: "pharmacy",
  },
];

export async function rotations(): Promise<RotationRow[]> {
  const today = todayIso();
  const [people, creds, trainings] = await Promise.all([
    db.query.people.findMany({ orderBy: (p, { desc }) => [desc(p.startsOn)] }),
    db.query.credentials.findMany(),
    db.query.trainings.findMany(),
  ]);

  return people
    .filter((p) => p.engagement === "rotation")
    .map((p) => {
      const outstanding = ROTATION_REQUIREMENTS.filter((r) => {
        if (r.kind === "credential") {
          const held = creds.find((c) => c.personId === p.id && c.type === r.type);
          if (!held) return true;
          // Lapsing before the rotation ends is the same as not having it: the last week of the
          // placement is still a week of somebody working here without it.
          return Boolean(!held.noExpiry && held.expiresOn && p.endsOn && held.expiresOn < p.endsOn);
        }
        return !trainings.some((t) => t.personId === p.id && t.type === r.type);
      });
      const missing = outstanding.map((r) => r.label);

      return {
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        role: p.role,
        affiliation: p.affiliation,
        startsOn: p.startsOn,
        endsOn: p.endsOn,
        presence: presenceOf(p, today),
        daysUntilStart: p.startsOn ? daysBetween(today, p.startsOn) : null,
        daysLeft: p.endsOn ? daysBetween(today, p.endsOn) : null,
        missing,
        oursToDo: outstanding.filter((r) => r.from === "pharmacy").map((r) => r.label),
        toAskFor: outstanding.filter((r) => r.from !== "pharmacy").map((r) => r.label),
        ready: missing.length === 0,
      };
    });
}

/** The requirement list, for rendering the checklist on a student's own page. */
export function rotationRequirements() {
  return ROTATION_REQUIREMENTS;
}
