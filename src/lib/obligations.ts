import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { addDays, todayIso } from "./dates";
import type { ObligationCadence } from "@/db/schema";

/**
 * The standing duties of a pharmacist-in-charge in Kansas, plus the federal ones that come with
 * billing Medicare and Medicaid and employing people.
 *
 * These are seeded once and then belong to the pharmacy: the PIC can edit the wording, move the due
 * date, or switch one off. Anything that depends on services this pharmacy may not offer
 * (compounding, shipping out of state, immunizing) is seeded with needsConfirmation so it appears as
 * a question rather than as a missed deadline.
 *
 * Citations are given so an inspector's question can be answered from the screen. Where a detail
 * varies by pharmacy or is set by a contract rather than a rule, the entry says so instead of
 * asserting a deadline.
 */
export type ObligationSeed = {
  key: string;
  title: string;
  detail: string;
  citation: string;
  cadence: ObligationCadence;
  /** Month/day the duty falls on, when the rule fixes one. */
  fixedDate?: { month: number; day: number };
  /** Otherwise, days from first setup until the first one is due. */
  firstDueInDays?: number;
  needsConfirmation?: boolean;
};

export const OBLIGATION_SEEDS: ObligationSeed[] = [
  // ── Kansas Board of Pharmacy ──────────────────────────────────────
  {
    key: "ks_pharmacy_registration",
    title: "Renew the Kansas pharmacy registration",
    detail: "Pharmacy registrations run to 30 June and are renewed annually. Renew online and file the new certificate here; the certificate must be displayed in the pharmacy.",
    citation: "K.S.A. 65-1643 · Kansas Board of Pharmacy",
    cadence: "annual",
    fixedDate: { month: 6, day: 30 },
  },
  {
    key: "cqi_program_document",
    title: "Review the written CQI program description",
    detail: "K.A.R. 68-19-1 requires the CQI program to be written, not only performed. Read the program description, update it if the workflow changed, and sign it. The bimonthly summaries are the evidence the program runs; this document is the evidence it exists.",
    citation: "K.A.R. 68-19-1(a)",
    cadence: "annual",
    firstDueInDays: 30,
  },
  {
    key: "technician_list",
    title: "Refresh and file the pharmacy technician list (Form C-900)",
    detail: "The PIC maintains a current list of every registered technician working at the pharmacy and produces it on inspection. Print it from Staff → Technician list after any hire or departure.",
    citation: "K.S.A. 65-1663(i)",
    cadence: "quarterly",
    firstDueInDays: 14,
  },
  {
    key: "cs_annual_inventory",
    title: "Take the annual controlled substance inventory",
    detail: "Kansas requires an inventory of all controlled substances at least annually and no more than 375 days after the previous one. Record it under CS inventories and print the C-250 cover sheet. Also satisfies the DEA biennial inventory when taken in the right year.",
    citation: "K.A.R. 68-20-16 · 21 CFR 1304.11",
    cadence: "annual",
    firstDueInDays: 60,
  },
  {
    key: "pic_change_notice",
    title: "Notify the Board when the pharmacist-in-charge changes",
    detail: "A change of PIC must be reported to the Board, and an inventory taken by the outgoing and incoming PIC. Keep this switched on as a reminder of the duty; complete it when it happens.",
    citation: "K.S.A. 65-1643 · K.A.R. 68-20-16",
    cadence: "as_needed",
  },
  {
    key: "ktracs_submission_check",
    title: "Check K-TRACS submissions and clear any error file",
    detail: "Controlled substance dispensings are reported to the Kansas prescription monitoring program. Confirm every day's file was accepted and that nothing sat in an error report. Gaps are found on inspection, not by the system that created them.",
    citation: "K.S.A. 65-1683 · K-TRACS",
    cadence: "monthly",
    firstDueInDays: 7,
  },
  {
    key: "self_inspection",
    title: "Walk the pharmacy against the Board's inspection checklist",
    detail: "Not a filing — an hour spent finding what an inspector would find. Reference labels, expired stock, the display of registrations, the CQI file, sink and equipment, security of controlled substances. Record what was corrected.",
    citation: "Good practice · Kansas Board of Pharmacy inspection criteria",
    cadence: "annual",
    firstDueInDays: 45,
  },

  // ── Controlled substances, federal ────────────────────────────────
  {
    key: "dea_registration",
    title: "Renew the DEA registration",
    detail: "DEA pharmacy registrations run three years. File the new certificate here when it arrives; it must be kept at the registered location.",
    citation: "21 CFR 1301.13",
    cadence: "triennial",
    firstDueInDays: 90,
  },
  {
    key: "cs_records_review",
    title: "Reconcile controlled substance receipts against dispensings",
    detail: "Match what came in (222 forms / CSOS orders and invoices) against what went out. Differences that cannot be explained belong in the discrepancy log, and a significant loss requires DEA Form 106 and notice to the Board.",
    citation: "21 CFR 1304.04 · 21 CFR 1301.76(b)",
    cadence: "quarterly",
    firstDueInDays: 30,
  },
  {
    key: "dscsa_trading_partners",
    title: "Confirm every supplier is an authorized trading partner and transaction records are retained",
    detail: "Under the Drug Supply Chain Security Act a pharmacy may only buy from licensed trading partners, must be able to produce transaction information for any product, and must keep those records six years. Check each supplier's licence status and that the records are reaching your file.",
    citation: "21 U.S.C. 360eee-1 (DSCSA)",
    cadence: "annual",
    firstDueInDays: 60,
  },

  // ── Billing federal programs ──────────────────────────────────────
  {
    key: "fwa_training",
    title: "Complete fraud, waste and abuse plus general compliance training for every employee",
    detail: "Required annually of everyone who supports Medicare Part D, and within 90 days of hire. Records are kept ten years. Track it per person under Staff → Training; this entry is the yearly prompt to close out anyone missing.",
    citation: "42 CFR 423.504(b)(4)(vi)(C)",
    cadence: "annual",
    fixedDate: { month: 12, day: 31 },
  },
  {
    key: "exclusion_screening",
    title: "Screen every employee against the OIG exclusion list and SAM",
    detail: "Anyone excluded from federal health care programs cannot be paid, directly or indirectly, by a pharmacy that bills them. The OIG expects screening on hire and monthly thereafter. The LEIE is a free download; keep the dated result as the record.",
    citation: "42 CFR 1001.1901 · OIG Special Advisory Bulletin",
    cadence: "monthly",
    firstDueInDays: 7,
  },
  {
    key: "medicaid_revalidation",
    title: "Revalidate Medicaid (KMAP) enrolment",
    detail: "State Medicaid enrolment is revalidated on a cycle, generally five years. Missing it stops payment rather than generating a warning.",
    citation: "42 CFR 424.515 · KMAP",
    cadence: "annual",
    firstDueInDays: 90,
    needsConfirmation: true,
  },
  {
    key: "part_d_attestation",
    title: "Return the annual Part D / PSAO compliance attestation",
    detail: "Plans and PSAOs collect an annual attestation covering compliance training, exclusion screening and licensure. The date is set by the contract, not by a rule — set the due date to match yours.",
    citation: "Plan or PSAO contract",
    cadence: "annual",
    firstDueInDays: 60,
    needsConfirmation: true,
  },

  // ── HIPAA ─────────────────────────────────────────────────────────
  {
    key: "hipaa_risk_analysis",
    title: "Carry out the HIPAA security risk analysis",
    detail: "A written, accurate assessment of the risks to electronic protected health information, and what is being done about them. It is the first thing asked for after a breach or in an audit, and the most common finding is that it was never done.",
    citation: "45 CFR 164.308(a)(1)(ii)(A)",
    cadence: "annual",
    firstDueInDays: 60,
  },
  {
    key: "hipaa_training",
    title: "Train the workforce on HIPAA privacy and security",
    detail: "Required for each new member of the workforce and periodically thereafter. Recorded per person under Staff → Training.",
    citation: "45 CFR 164.530(b) · 164.308(a)(5)",
    cadence: "annual",
    firstDueInDays: 45,
  },
  {
    key: "baa_register",
    title: "Review business associate agreements",
    detail: "Anyone handling protected health information on the pharmacy's behalf — software, billing, shredding, IT support, reconciliation services — needs a signed agreement on file. Check the list against who you actually use now.",
    citation: "45 CFR 164.502(e) · 164.308(b)",
    cadence: "annual",
    firstDueInDays: 75,
  },
  {
    key: "npp_review",
    title: "Check the Notice of Privacy Practices is current and posted",
    detail: "The notice must be displayed in the pharmacy, available on request, and on the website if there is one. Review the wording when practices change.",
    citation: "45 CFR 164.520",
    cadence: "annual",
    firstDueInDays: 90,
  },

  // ── Workplace ─────────────────────────────────────────────────────
  {
    key: "osha_bloodborne",
    title: "Bloodborne pathogens training and exposure control plan review",
    detail: "Required annually where staff may be exposed to blood — which includes giving injections. The exposure control plan is reviewed and updated at the same time.",
    citation: "29 CFR 1910.1030",
    cadence: "annual",
    firstDueInDays: 45,
    needsConfirmation: true,
  },
  {
    key: "osha_hazcom",
    title: "Hazard communication: chemical list, safety data sheets and training",
    detail: "The pharmacy keeps a list of hazardous chemicals used on site and the matching safety data sheets, and trains staff on them.",
    citation: "29 CFR 1910.1200",
    cadence: "annual",
    firstDueInDays: 90,
  },

  // ── Cold chain and immunizing ─────────────────────────────────────
  {
    key: "vaccine_storage_review",
    title: "Review vaccine storage: logger calibration, temperature records and the excursion plan",
    detail: "Certified data logger with a current calibration certificate, temperature recorded as the programme requires, and a written plan for what happens when a reading falls out of range. Applies if you stock vaccines.",
    citation: "CDC Vaccine Storage and Handling Toolkit · VFC programme",
    cadence: "annual",
    firstDueInDays: 30,
    needsConfirmation: true,
  },
  {
    key: "immunization_protocol_review",
    title: "Review and re-sign the immunization protocols",
    detail: "Protocols authorising vaccine administration are reviewed and signed on the cycle the protocol itself sets. Check each pharmacist's training and CPR card at the same time.",
    citation: "K.S.A. 65-1635a",
    cadence: "annual",
    firstDueInDays: 60,
    needsConfirmation: true,
  },
  {
    key: "emergency_kit_check",
    title: "Check the emergency kit: epinephrine in date, equipment present",
    detail: "Where injections are given, the pharmacy keeps epinephrine and the means to use it. Expiry dates move faster than anyone expects.",
    citation: "Standard of practice for administering vaccines",
    cadence: "quarterly",
    firstDueInDays: 14,
    needsConfirmation: true,
  },

  // ── Records and continuity ────────────────────────────────────────
  {
    key: "backup_restore_test",
    title: "Test that a backup actually restores",
    detail: "Take the most recent backup of the dispensing system and this desk, restore it somewhere safe, and confirm the data is there. A backup that has never been restored is a hope, not a plan.",
    citation: "45 CFR 164.308(a)(7) contingency plan",
    cadence: "quarterly",
    firstDueInDays: 30,
  },
  {
    key: "records_retention_review",
    title: "Check records retention: prescriptions, CQI, controlled substances",
    detail: "Prescription and controlled substance records are kept five years in Kansas; CQI records five years; Part D compliance training records ten years; DSCSA transaction records six years. Confirm nothing was destroyed early and that older files are still readable.",
    citation: "K.A.R. 68-7-11 · K.A.R. 68-19-1(e) · 42 CFR 423.504 · DSCSA",
    cadence: "annual",
    firstDueInDays: 120,
  },
  {
    key: "disaster_plan_review",
    title: "Review the emergency and continuity plan",
    detail: "What happens to prescriptions, refrigerated stock and controlled substances in a power failure, a storm or a closure. Includes who has keys and who can be reached.",
    citation: "Good practice · 45 CFR 164.308(a)(7)",
    cadence: "annual",
    firstDueInDays: 120,
  },
];

const MONTHS_BY_CADENCE: Record<ObligationCadence, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
  biennial: 24,
  triennial: 36,
  as_needed: 0,
};

/** The next occurrence after a completion. Fixed-date duties land on the same day next cycle. */
export function nextDueAfter(cadence: ObligationCadence, completedOn: string, fixed?: { month: number; day: number } | null): string | null {
  if (cadence === "as_needed") return null;
  if (fixed) {
    const y = Number(completedOn.slice(0, 4));
    const thisYear = `${y}-${String(fixed.month).padStart(2, "0")}-${String(fixed.day).padStart(2, "0")}`;
    const step = cadence === "biennial" ? 2 : cadence === "triennial" ? 3 : 1;
    return completedOn < thisYear ? thisYear : `${y + step}-${String(fixed.month).padStart(2, "0")}-${String(fixed.day).padStart(2, "0")}`;
  }
  const months = MONTHS_BY_CADENCE[cadence];
  const [y, m, d] = completedOn.split("-").map(Number);
  const dt = new Date(y, m - 1 + months, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Creates any seeded obligation that isn't on file yet. Safe to call on every page load. */
export async function ensureObligations() {
  const existing = await db.query.obligations.findMany();
  const have = new Set(existing.map((o) => o.seedKey).filter(Boolean));
  const missing = OBLIGATION_SEEDS.filter((s) => !have.has(s.key));
  if (missing.length === 0) return { created: 0 };
  const today = todayIso();
  for (const seed of missing) {
    const dueOn =
      seed.cadence === "as_needed"
        ? null
        : seed.fixedDate
          ? firstFixedDue(today, seed.fixedDate)
          : addDays(today, seed.firstDueInDays ?? 30);
    await db.insert(schema.obligations).values({
      id: newId(),
      seedKey: seed.key,
      title: seed.title,
      detail: seed.detail,
      citation: seed.citation,
      cadence: seed.cadence,
      dueOn,
      needsConfirmation: seed.needsConfirmation ?? false,
    });
  }
  return { created: missing.length };
}

function firstFixedDue(today: string, fixed: { month: number; day: number }): string {
  const y = Number(today.slice(0, 4));
  const thisYear = `${y}-${String(fixed.month).padStart(2, "0")}-${String(fixed.day).padStart(2, "0")}`;
  return today <= thisYear ? thisYear : `${y + 1}-${String(fixed.month).padStart(2, "0")}-${String(fixed.day).padStart(2, "0")}`;
}

export function seedFor(key: string | null): ObligationSeed | undefined {
  return key ? OBLIGATION_SEEDS.find((s) => s.key === key) : undefined;
}

/** Obligations with their status, soonest first. */
export async function obligationsWithStatus() {
  const rows = await db.query.obligations.findMany({ orderBy: (o, { asc }) => [asc(o.dueOn)] });
  const today = todayIso();
  return rows
    .filter((o) => o.active)
    .map((o) => ({
      obligation: o,
      overdue: Boolean(o.dueOn && o.dueOn < today),
      seed: seedFor(o.seedKey),
    }));
}

export async function completeObligation(id: string, completedOn: string, completedBy: string, notes: string | null, documentId: string | null) {
  const o = await db.query.obligations.findFirst({ where: eq(schema.obligations.id, id) });
  if (!o) throw new Error("Obligation not found.");
  const seed = seedFor(o.seedKey);
  await db.insert(schema.obligationCompletions).values({ id: newId(), obligationId: id, completedOn, completedBy, notes, documentId });
  await db
    .update(schema.obligations)
    .set({
      lastCompletedOn: completedOn,
      lastCompletedBy: completedBy,
      lastNotes: notes,
      documentId,
      dueOn: nextDueAfter(o.cadence, completedOn, seed?.fixedDate ?? null),
      needsConfirmation: false,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.obligations.id, id));
}
