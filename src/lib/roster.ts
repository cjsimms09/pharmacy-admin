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
  ready: boolean;
};

/**
 * What a student must have on file before they touch a prescription.
 *
 * Deliberately shorter than the staff list. A five-week student does not owe a full annual
 * training cycle, and pretending otherwise means nobody completes any of it. These four are what
 * the Board and HIPAA actually require of someone working here, however briefly.
 */
const ROTATION_REQUIREMENTS: { key: string; label: string; kind: "credential" | "training"; type: string }[] = [
  { key: "registration", label: "Kansas intern registration", kind: "credential", type: "intern_registration" },
  { key: "cpr", label: "CPR certification", kind: "credential", type: "cpr" },
  { key: "immunization", label: "Immunization training certificate", kind: "credential", type: "immunization_training" },
  { key: "hipaa", label: "HIPAA training", kind: "training", type: "hipaa_privacy_security" },
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
      const missing = ROTATION_REQUIREMENTS.filter((r) => {
        if (r.kind === "credential") {
          const held = creds.find((c) => c.personId === p.id && c.type === r.type);
          if (!held) return true;
          // Expired before they even start is the same as not having it.
          return Boolean(held.expiresOn && p.endsOn && held.expiresOn < p.endsOn && !held.noExpiry);
        }
        return !trainings.some((t) => t.personId === p.id && t.type === r.type);
      }).map((r) => r.label);

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
        ready: missing.length === 0,
      };
    });
}

/** The requirement list, for rendering the checklist on a student's own page. */
export function rotationRequirements() {
  return ROTATION_REQUIREMENTS;
}
