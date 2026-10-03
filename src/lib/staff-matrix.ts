import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { onSiteToday } from "./roster";
import { todayIso, daysBetween } from "./dates";
import { addMonths, TRAINING_CADENCE, nextTrainingDue } from "./due";
import { TRAINING_SHORT } from "./labels";
import { openRequests } from "./credential-requests";
import type { CredentialType, TrainingType } from "@/db/schema";

/**
 * Who is missing what, as a grid.
 *
 * The list of overdue things answers "what is late". It does not answer the question a PIC is
 * actually asked — by an inspector, by a corporate auditor, by their own conscience on a Sunday —
 * which is "is my staff covered". That question is per person and per requirement at the same
 * time, and a list can only ever show one of those two axes. A grid shows both, and the empty
 * cell is the finding.
 *
 * Everything not yet due reads as covered here. This board is about gaps, not about deadlines:
 * a licence expiring in five weeks is not a gap, and colouring it as one is what taught everyone
 * to stop looking at the board.
 */

export type CellState = "ok" | "soon" | "late" | "missing" | "na";

export type Cell = {
  state: CellState;
  /** What shows in the cell — a date, or a word where there is no date. */
  label: string;
  /** The whole story, on hover. */
  title: string;
  /**
   * For a training column: what can be done about it from right here.
   *
   * The grid is where the gap is seen, so the grid is where it should be closed. Sending someone
   * to another screen to act on something they are already looking at is the friction that turns
   * a thirty-second job into one that waits a fortnight — and it is why the same gaps kept
   * reappearing week after week.
   */
  /**
   * Where the evidence behind this cell lives.
   *
   * A grid that shows a training as done and cannot show you the certificate is a grid you have to
   * leave in order to trust it — and an inspector asking "show me" is the only reason the grid
   * exists. A completed training goes to its certificate; a credential goes to the record it was
   * read from.
   */
  href?: string;
  action?: {
    trainingType: TrainingType;
    personId: string;
    /** Set once a link has gone out and is still outstanding. */
    sentOn: string | null;
    reminders: number;
    sendError: string | null;
  };
  /**
   * For a credential column with nothing on file: ask the person for it from here.
   *
   * Same reasoning as the training action above, and the same gap it closes. Emailing somebody
   * for their CPhT card, waiting, then remembering to file what came back against the right
   * requirement is four steps, and the board that shows the gap should be able to start it.
   */
  credentialAction?: {
    credentialType: CredentialType;
    personId: string;
    /** Whether they have already been asked and have not replied. */
    askedOn: string | null;
    hasEmail: boolean;
  };
};

export type MatrixColumn = {
  key: string;
  /** Column heading — short, because there are ten of them. */
  short: string;
  /** What it actually is. */
  label: string;
  group: "credential" | "training";
};

export type MatrixRow = {
  id: string;
  name: string;
  role: string;
  isPic: boolean;
  cells: Record<string, Cell>;
  /** Gaps on this person: nothing on file, or lapsed. */
  gaps: number;
};

export type StaffMatrix = {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  /** People with nothing missing and nothing lapsed. */
  covered: number;
  /** Cells that are missing or lapsed, across everyone. */
  gaps: number;
};

/** Warning before a date counts as close. Renewing a licence takes longer than sitting a module. */
const SOON_CREDENTIAL = 60;
const SOON_TRAINING = 30;

const CREDENTIAL_COLUMNS: {
  key: string;
  type: CredentialType;
  short: string;
  label: string;
  immunizersOnly?: boolean;
  techniciansOnly?: boolean;
}[] = [
  { key: "license", type: "pharmacist_license", short: "Licence", label: "Kansas licence or registration" },
  // The CPhT is a technician's credential and nobody else's, so it reads as not applicable for
  // everyone else rather than as a gap that can never be closed.
  {
    key: "cpht",
    type: "technician_certification",
    short: "CPhT",
    label: "CPhT certification (PTCB / NHA)",
    techniciansOnly: true,
  },
  { key: "cpr", type: "cpr", short: "CPR", label: "CPR certification", immunizersOnly: true },
  { key: "imm_training", type: "immunization_training", short: "Imm trng", label: "Immunization training", immunizersOnly: true },
  { key: "imm_protocol", type: "immunization_protocol", short: "Protocol", label: "Signed immunization protocol", immunizersOnly: true },
];

const TRAINING_COLUMNS: { key: string; type: TrainingType; short: string; techniciansOnly?: boolean }[] = [
  { key: "hipaa", type: "hipaa_privacy_security", short: TRAINING_SHORT.hipaa_privacy_security },
  { key: "fwa", type: "fwa_general_compliance", short: TRAINING_SHORT.fwa_general_compliance },
  { key: "bbp", type: "osha_bloodborne", short: TRAINING_SHORT.osha_bloodborne },
  { key: "hazcom", type: "osha_hazard_communication", short: TRAINING_SHORT.osha_hazard_communication },
  { key: "diversion", type: "controlled_substance_diversion", short: TRAINING_SHORT.controlled_substance_diversion },
  { key: "cqi", type: "cqi_program_review", short: TRAINING_SHORT.cqi_program_review },
  { key: "manual", type: "policy_manual_acknowledgement", short: TRAINING_SHORT.policy_manual_acknowledgement },
  /*
   * The technician course, which is the pharmacist-in-charge's own obligation under K.A.R. 68-5-15.
   *
   * It was a training type, it had a course written for it and it was on the due list — and it was
   * missing from this table, which is the one the PIC actually reads. So the single training with a
   * hard legal deadline attached to it, a hundred and eighty days from hire, was the one thing the
   * compliance matrix could not show. Technicians only: the regulation says nothing about
   * pharmacists or interns, and chasing them for it would be noise.
   */
  { key: "tech_training", type: "technician_initial_training", short: TRAINING_SHORT.technician_initial_training, techniciansOnly: true },
];

export function matrixColumns(): MatrixColumn[] {
  return [
    ...CREDENTIAL_COLUMNS.map((c) => ({ key: c.key, short: c.short, label: c.label, group: "credential" as const })),
    ...TRAINING_COLUMNS.map((c) => ({
      key: c.key,
      short: c.short,
      label: TRAINING_CADENCE[c.type]?.what ?? c.short,
      group: "training" as const,
    })),
  ];
}

/** The licence type a role must hold. */
function licenseTypeFor(role: string): CredentialType {
  return role === "pharmacist" ? "pharmacist_license" : role === "technician" ? "technician_registration" : "intern_registration";
}

function dated(iso: string | null, soonDays: number, what: string): Cell {
  if (!iso) return { state: "ok", label: "no expiry", title: `${what} is on file and does not expire.` };
  const d = daysBetween(todayIso(), iso);
  if (d < 0) return { state: "late", label: `${Math.abs(d)}d late`, title: `${what} expired on ${iso}.` };
  if (d <= soonDays) return { state: "soon", label: iso.slice(5), title: `${what} expires on ${iso} — ${d} days.` };
  return { state: "ok", label: iso.slice(5), title: `${what} is current until ${iso}.` };
}

export async function staffMatrix(): Promise<StaffMatrix> {
  const [people, creds, trainings, assignments, requests] = await Promise.all([
    onSiteToday(),
    db.query.credentials.findMany(),
    db.query.trainings.findMany(),
    db.query.trainingAssignments.findMany(),
    openRequests(),
  ]);
  const open = assignments.filter((a) => !a.completedAt);

  const columns = matrixColumns();
  const rows: MatrixRow[] = people.map((p) => {
    const mine = creds.filter((c) => c.personId === p.id);
    const cells: Record<string, Cell> = {};

    for (const col of CREDENTIAL_COLUMNS) {
      if (col.immunizersOnly && !p.administersVaccines) {
        cells[col.key] = { state: "na", label: "—", title: `${p.firstName} does not administer vaccines, so this is not required.` };
        continue;
      }
      if (col.techniciansOnly && p.role !== "technician") {
        cells[col.key] = { state: "na", label: "—", title: `${col.label} applies to technicians only.` };
        continue;
      }
      const type = col.key === "license" ? licenseTypeFor(p.role) : col.type;
      const held = mine
        .filter((c) => c.type === type)
        .sort((a, b) => (b.expiresOn ?? "9999").localeCompare(a.expiresOn ?? "9999"))[0];

      const askAction = {
        credentialType: type,
        personId: p.id,
        askedOn: requests.find((r) => r.personId === p.id && r.type === type)?.sentAt?.slice(0, 10) ?? null,
        hasEmail: Boolean(p.email),
      };

      if (!held) {
        cells[col.key] = {
          state: "missing",
          label: "none",
          title: `No ${col.label.toLowerCase()} is on file for ${p.firstName}.`,
          credentialAction: askAction,
        };
        continue;
      }
      if (held.noExpiry) {
        cells[col.key] = { state: "ok", label: "no expiry", title: `${col.label} is on file and recorded as not expiring.` };
        continue;
      }
      if (!held.expiresOn) {
        // On file, but nothing can tell you when it lapses. That passes a date check while being
        // the least compliant state there is, so it is shown as a gap rather than as covered.
        cells[col.key] = {
          state: "missing",
          label: "no date",
          title: `${col.label} is on file for ${p.firstName} but carries no expiry date, so nothing can tell you when it lapses.`,
          href: `/staff/${p.id}#credential-form`,
        };
        continue;
      }
      const cell = dated(held.expiresOn, SOON_CREDENTIAL, col.label);
      cells[col.key] = {
        ...cell,
        href: `/staff/${p.id}#credential-form`,
        // Lapsed is as good as absent for asking purposes: the pharmacy needs the new card, and
        // the request is the same email either way.
        credentialAction: cell.state === "late" ? askAction : undefined,
      };
    }

    for (const col of TRAINING_COLUMNS) {
      if (col.techniciansOnly && p.role !== "technician") {
        cells[col.key] = { state: "na", label: "—", title: `${col.short} applies to technicians only.` };
        continue;
      }
      const cadence = TRAINING_CADENCE[col.type];
      const last = trainings
        .filter((t) => t.personId === p.id && t.type === col.type)
        .sort((a, b) => b.completedOn.localeCompare(a.completedOn))[0];

      const sent = open.find((a) => a.personId === p.id && a.type === col.type);
      const action = {
        trainingType: col.type,
        personId: p.id,
        sentOn: sent?.sentAt?.slice(0, 10) ?? null,
        reminders: sent?.remindersSent ?? 0,
        sendError: sent?.sendError ?? null,
      };

      if (!last) {
        cells[col.key] = {
          state: "missing",
          label: "never",
          title: `${p.firstName} has never completed ${col.short}.`,
          action,
        };
        continue;
      }
      /*
       * The third and fourth copies of this rule, and both had it wrong.
       *
       * A course completed once carries no expiry, and its cadence is `months: 0`. So this read
       * `addMonths(completedOn, 0)` — the completion date itself — which is a truthy string, so the
       * "does not repeat" branch immediately below never fired and the course was late from the
       * moment it was done. One technician showed 1,084 days late for a course finished in 2023,
       * on the dashboard, on /staff, in the gaps count and in the self-inspection — while the one
       * screen that can actually send the training said "done".
       *
       * `nextTrainingDue` is the authority and says so in its own comment. There is one rule.
       */
      const due = nextTrainingDue(col.type, { completedOn: last.completedOn, expiresOn: last.expiresOn });
      if (!due) {
        cells[col.key] = {
          state: "ok",
          label: last.completedOn.slice(2, 7),
          title: `Completed ${last.completedOn}. This one does not repeat. Opens the certificate.`,
          href: `/certificates/${last.id}`,
        };
        continue;
      }
      const cell = dated(due, SOON_TRAINING, col.short);
      cells[col.key] = {
        ...cell,
        title: `${cell.title} Last completed ${last.completedOn}. Opens the certificate.`,
        href: `/certificates/${last.id}`,
        // Only offer to send it where there is something to send. A current training does not
        // need a button, and a row of buttons that mostly do nothing is how a row of buttons
        // stops being read.
        action: cell.state === "ok" ? undefined : action,
      };
    }

    const gaps = columns.filter((c) => cells[c.key].state === "missing" || cells[c.key].state === "late").length;
    return { id: p.id, name: `${p.firstName} ${p.lastName}`, role: p.role, isPic: p.isPic, cells, gaps };
  });

  return {
    columns,
    rows,
    covered: rows.filter((r) => r.gaps === 0).length,
    gaps: rows.reduce((n, r) => n + r.gaps, 0),
  };
}
