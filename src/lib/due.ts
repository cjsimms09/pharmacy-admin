import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayIso, daysBetween } from "./dates";
import { CREDENTIAL_LABEL, TRAINING_LABEL, PERSON_ROLE_LABEL } from "./labels";
import type { CredentialType, TrainingType } from "@/db/schema";

/**
 * Everything the pharmacy owes, in one list.
 *
 * Compliance was spread across three shapes that behave identically from where the PIC stands: a
 * credential that expires, a training that lapses, and a recurring duty that falls due. Keeping
 * them apart meant three places to look and three chances to miss something. The only question
 * that matters is "what needs doing, and how late is it" — so that is the only question this
 * answers.
 *
 * Each item carries what to do about it and where to go, because a list that says "OSHA
 * bloodborne — overdue" and nothing else still leaves the work of remembering what that means.
 *
 * Recurring pharmacy duties are deliberately not here. They are period-shaped rather than
 * date-shaped — a monthly duty is not "due in 14 days", it is either covered for the month or it
 * is not — and compliance-status.ts is the one thing that decides that. Having both answer the
 * question is what put the temperature log on the dashboard as "due in 12 days" while the
 * compliance screen, correctly, said nothing was outstanding at all.
 */

export type DueKind = "credential" | "training";

export type DueItem = {
  id: string;
  kind: DueKind;
  /** What is due. */
  title: string;
  /** Who it attaches to, when it attaches to a person. */
  personName: string | null;
  personId: string | null;
  /** The rule behind it, where there is one. */
  citation: string | null;
  dueOn: string | null;
  /** Negative when overdue. Null when nothing has established a date. */
  daysLeft: number | null;
  severity: "overdue" | "due_soon" | "upcoming" | "no_date";
  /** What to actually do, in a sentence. */
  action: string;
  href: string;
  /** Set on a training row, so it can be assigned straight from the list. */
  trainingType?: TrainingType;
  personIds?: string[];
};

/** How much warning each kind of thing needs. A licence renewal takes longer than a training. */
const HORIZON: Record<DueKind, number> = { credential: 60, training: 30 };

function severityOf(daysLeft: number | null, kind: DueKind): DueItem["severity"] {
  if (daysLeft === null) return "no_date";
  if (daysLeft < 0) return "overdue";
  if (daysLeft <= HORIZON[kind]) return "due_soon";
  return "upcoming";
}

/**
 * Trainings that must be repeated, and how often.
 *
 * Anything not listed here is recorded but not chased — a one-off certificate does not lapse and
 * a reminder about it is noise that trains people to ignore the list.
 */
export const TRAINING_CADENCE: Partial<Record<TrainingType, { months: number; why: string; what: string }>> = {
  fwa_general_compliance: {
    months: 12,
    why: "Annual, required of everyone who touches a Medicare or Medicaid claim.",
    what: "Fraud, waste and abuse plus general compliance. What counts as fraud, the duty to report it, and that reporting it cannot be held against you.",
  },
  hipaa_privacy_security: {
    months: 12,
    why: "Annual refresher, plus on hire and whenever the workflow changes.",
    what: "Patient privacy: what may be said, to whom, and what to do the moment something is disclosed that should not have been.",
  },
  osha_bloodborne: {
    months: 12,
    why: "Annual, required wherever there is reasonably anticipated exposure.",
    what: "Needlestick and blood exposure: the precautions, and exactly what to do and who to tell if someone is exposed.",
  },
  osha_hazard_communication: {
    months: 12,
    why: "On hire and whenever a new hazard is introduced; reviewed annually.",
    what: "The hazardous chemicals kept here, where the safety data sheets are, and how to read a label.",
  },
  controlled_substance_diversion: {
    months: 12,
    why: "Annual awareness training for everyone handling controlled substances.",
    what: "Spotting diversion — by staff, prescribers or patients — and how to raise it. Not a legal requirement in Kansas, but the first thing asked about after a loss.",
  },
  cqi_program_review: {
    months: 12,
    why: "The written CQI programme is read and signed off annually.",
    what: "Everyone reads the pharmacy's written quality programme and confirms they know how to report an error and that reporting is expected of them.",
  },
};

/** Credentials that are only required of some people, and the condition that makes them required. */
function credentialApplies(type: CredentialType, person: { administersVaccines: boolean }): boolean {
  if (type === "cpr" || type === "immunization_training" || type === "immunization_protocol") {
    return person.administersVaccines;
  }
  return true;
}

/**
 * Builds the list.
 *
 * Includes three things that are easy to leave out and are exactly what gets missed: a required
 * credential that has no record at all, a required training nobody has ever completed, and a
 * record that exists but carries no expiry date. All three are surfaced rather than passing as
 * satisfied, because an absent record looks identical to a compliant one if you only check dates.
 */
export async function dueList(opts: { horizonDays?: number } = {}): Promise<DueItem[]> {
  const today = todayIso();
  const [people, creds, trainings] = await Promise.all([
    db.query.people.findMany({ where: eq(schema.people.active, true) }),
    db.query.credentials.findMany(),
    db.query.trainings.findMany(),
  ]);

  const items: DueItem[] = [];
  const push = (i: Omit<DueItem, "daysLeft" | "severity">) => {
    const daysLeft = i.dueOn ? daysBetween(today, i.dueOn) : null;
    items.push({ ...i, daysLeft, severity: severityOf(daysLeft, i.kind) });
  };

  // ── Credentials ──
  for (const p of people) {
    const name = `${p.firstName} ${p.lastName}`;
    const mine = creds.filter((c) => c.personId === p.id);

    // The licence or registration this person must hold to work at all.
    const licenseType: CredentialType =
      p.role === "pharmacist" ? "pharmacist_license" : p.role === "technician" ? "technician_registration" : "intern_registration";
    const required: CredentialType[] = [licenseType];
    if (p.administersVaccines) required.push("cpr", "immunization_training", "immunization_protocol");

    for (const type of required) {
      if (!credentialApplies(type, p)) continue;
      const held = mine.filter((c) => c.type === type).sort((a, b) => (b.expiresOn ?? "").localeCompare(a.expiresOn ?? ""))[0];
      const label = CREDENTIAL_LABEL[type];
      if (!held) {
        push({
          id: `cred-missing-${p.id}-${type}`,
          kind: "credential",
          title: `${label} — nothing on file`,
          personName: name,
          personId: p.id,
          citation: null,
          dueOn: null,
          action: `No ${label.toLowerCase()} is recorded for ${name}. Upload it, or mark them as not administering vaccines if that is why.`,
          href: `/staff/${p.id}`,
        });
        continue;
      }
      // Said to have no expiry: a decision, and the end of the matter.
      if (held.noExpiry) continue;

      if (!held.expiresOn) {
        // A certificate of this kind genuinely does not lapse, so silence is right even when
        // nobody said so explicitly.
        if (type === "immunization_training") continue;
        push({
          id: `cred-nodate-${held.id}`,
          kind: "credential",
          title: `${label} — no expiry recorded`,
          personName: name,
          personId: p.id,
          citation: null,
          dueOn: null,
          action: `${name}'s ${label.toLowerCase()} is on file but carries no expiry date, so nothing can tell you when it lapses. Add the date, or tick "this does not expire" on it.`,
          href: `/staff/${p.id}`,
        });
        continue;
      }
      push({
        id: `cred-${held.id}`,
        kind: "credential",
        title: `${label} — ${name}`,
        personName: name,
        personId: p.id,
        citation: null,
        dueOn: held.expiresOn,
        action: `Renew and upload the new ${label.toLowerCase()}.`,
        href: `/staff/${p.id}`,
      });
    }

  }

  // ── Trainings ────────────────────────────────────────────────────
  //
  // One row per requirement, not one per person. Four technicians missing the same training is
  // one thing to arrange, and listing it four times with no button on any of them is how a
  // screen stops being read. The people are carried on the item so it can be assigned to all of
  // them in a single click.
  for (const [type, cadence] of Object.entries(TRAINING_CADENCE) as [TrainingType, { months: number; why: string; what: string }][]) {
    const applies = people.filter((p) => type !== "immunization_protocol_review" || p.administersVaccines);
    if (applies.length === 0) continue;
    const label = TRAINING_LABEL[type];

    const outstanding: { person: (typeof people)[number]; due: string | null; last: string | null }[] = [];
    for (const p of applies) {
      const last = trainings
        .filter((t) => t.personId === p.id && t.type === type)
        .sort((a, b) => b.completedOn.localeCompare(a.completedOn))[0];
      if (!last) {
        outstanding.push({ person: p, due: null, last: null });
        continue;
      }
      const due = last.expiresOn ?? addMonths(last.completedOn, cadence.months);
      if (daysBetween(today, due) <= HORIZON.training) outstanding.push({ person: p, due, last: last.completedOn });
    }
    if (outstanding.length === 0) continue;

    const never = outstanding.filter((o) => o.due === null);
    // The soonest deadline among those that have one drives the whole row.
    const dated = outstanding.map((o) => o.due).filter(Boolean).sort() as string[];
    const names = outstanding.map((o) => `${o.person.firstName} ${o.person.lastName}`);

    push({
      id: `train-${type}`,
      kind: "training",
      title: `${label} — ${outstanding.length === applies.length ? "everyone" : names.join(", ")}`,
      personName: null,
      personId: null,
      trainingType: type,
      personIds: outstanding.map((o) => o.person.id),
      citation: cadence.what,
      dueOn: dated[0] ?? null,
      action:
        never.length === outstanding.length
          ? `Never recorded for ${names.length === 1 ? names[0] : `${names.length} people`}. Assign it and each gets a link to complete and sign.`
          : `Due again for ${names.join(", ")}. Assign it and each gets a link to complete and sign.`,
      href: `/compliance/training`,
    });
  }

  // ── Pharmacy-level credentials (no person attached) ──
  for (const c of creds.filter((c) => !c.personId && c.expiresOn)) {
    push({
      id: `cred-${c.id}`,
      kind: "credential",
      title: `${CREDENTIAL_LABEL[c.type]}${c.number ? ` (${c.number})` : ""}`,
      personName: null,
      personId: null,
      citation: null,
      dueOn: c.expiresOn,
      action: `Renew and file the replacement.`,
      href: `/documents`,
    });
  }

  const horizon = opts.horizonDays ?? 365;
  return items
    .filter((i) => i.severity !== "upcoming" || (i.daysLeft ?? 0) <= horizon)
    .sort((a, b) => {
      const rank = { overdue: 0, due_soon: 1, no_date: 2, upcoming: 3 } as const;
      if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
      if (a.daysLeft === null) return b.daysLeft === null ? a.title.localeCompare(b.title) : 1;
      if (b.daysLeft === null) return -1;
      return a.daysLeft - b.daysLeft;
    });
}

/** Adds whole months, clamping to the end of a shorter month. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The counts the dashboard leads with. */
export async function dueSummary() {
  const items = await dueList({ horizonDays: 90 });
  return {
    overdue: items.filter((i) => i.severity === "overdue"),
    dueSoon: items.filter((i) => i.severity === "due_soon"),
    noDate: items.filter((i) => i.severity === "no_date"),
    all: items,
  };
}

export { PERSON_ROLE_LABEL };
