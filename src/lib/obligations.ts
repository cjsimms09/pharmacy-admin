import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { CredentialType } from "@/db/schema";
import { newId } from "./crypto";
import { addDays, todayIso } from "./dates";
import type { ObligationCadence, ObligationKind } from "@/db/schema";

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


/**
 * How each duty is closed, and what is recorded when it is.
 *
 * Kept as one table rather than spread through the seeds, because the interesting question about
 * this whole module is "what does the PIC actually have to do", and that should be answerable by
 * reading one screen of code.
 *
 * The attestation wording matters more than it looks. A tick in a box records that someone
 * clicked. A sentence naming the period, the system checked and the result is something an
 * inspector can read three years later and a PIC can stand behind — and it costs the same single
 * click. {period} and {date} are substituted when it is recorded.
 */
export type Closure = {
  kind: ObligationKind;
  /** Only for attest: what is recorded when the PIC confirms. */
  statement?: string;
  /** Only for witnessed: what in the site satisfies it, in words. */
  witness?: string;
  /** How many pieces of evidence a period needs. */
  perPeriod?: number;
  /** Roughly how long it takes, so a PIC can tell a 30-second job from a Sunday afternoon. */
  minutes?: number;
};

export const CLOSURES: Record<string, Closure> = {
  // ── Confirmed by the PIC, done outside the site ──────────────────
  ktracs_submission_check: {
    kind: "attest",
    minutes: 5,
    statement:
      "On {date} I signed in to K-TRACS and reviewed the submission status for {period}. All controlled substance " +
      "dispensings for that period had been submitted, and any error file was corrected and resubmitted.",
  },
  cs_records_review: {
    kind: "attest",
    minutes: 45,
    statement:
      "On {date} I reconciled controlled substance receipts against dispensings for {period}. Invoices, 222 forms and " +
      "CSOS records were compared against the dispensing record, and any difference was investigated and logged.",
  },
  self_inspection: {
    kind: "attest",
    minutes: 90,
    statement:
      "On {date} I walked the pharmacy against the Kansas Board of Pharmacy inspection criteria for {period}. " +
      "Findings were recorded and anything requiring correction was actioned.",
  },
  dscsa_trading_partners: {
    kind: "attest",
    minutes: 20,
    statement:
      "On {date} I confirmed for {period} that every supplier we purchase from is a DSCSA authorized trading partner, " +
      "verified their licence or registration status, and confirmed transaction information is being received and retained.",
  },
  npp_review: {
    kind: "attest",
    minutes: 10,
    statement:
      "On {date} I confirmed for {period} that the Notice of Privacy Practices on display and offered to patients is " +
      "the current version, and that it is posted where patients can see it.",
  },
  emergency_kit_check: {
    kind: "attest",
    minutes: 10,
    statement:
      "On {date} I checked the emergency kit for {period}. Epinephrine was present and in date, and the equipment " +
      "required to manage an adverse reaction was present and usable.",
  },
  records_retention_review: {
    kind: "attest",
    minutes: 30,
    statement:
      "On {date} I reviewed record retention for {period}: prescription records, CQI records, controlled substance " +
      "records and DSCSA transaction records are being kept for their required periods and are retrievable.",
  },
  disaster_plan_review: {
    kind: "attest",
    minutes: 30,
    statement:
      "On {date} I reviewed the emergency and continuity plan for {period}, confirmed contact details and procedures " +
      "are current, and confirmed staff know where to find it.",
  },
  baa_register: {
    kind: "attest",
    minutes: 30,
    statement:
      "On {date} I reviewed the business associate register for {period}. Every vendor with access to protected " +
      "health information has a current signed agreement on file.",
  },
  vaccine_storage_review: {
    kind: "attest",
    minutes: 20,
    statement:
      "On {date} I reviewed vaccine storage for {period}: the data logger is within its calibration period, " +
      "temperature records are complete, and the excursion procedure is current and understood.",
  },
  pic_change_notice: {
    kind: "attest",
    minutes: 15,
    statement:
      "On {date} I notified the Kansas Board of Pharmacy of the change of pharmacist-in-charge, within the period " +
      "the Board allows. The outgoing and incoming pharmacists-in-charge were named, a controlled substance " +
      "inventory was taken at the change, and the pharmacy registration record now shows the correct person.",
  },
  part_d_attestation: {
    kind: "evidence",
    minutes: 15,
  },
  medicaid_revalidation: { kind: "evidence", minutes: 30 },
  hipaa_risk_analysis: { kind: "evidence", minutes: 120 },

  // ── Satisfied by something the site already holds ────────────────
  cs_annual_inventory: { kind: "witnessed", witness: "A controlled substance inventory recorded under CS inventories." },
  technician_list: {
    kind: "witnessed",
    witness: "A list is generated and filed automatically at the end of each month. Nothing to do.",
  },
  cqi_program_document: { kind: "witnessed", witness: "A CQI programme review recorded in the training register." },
  fwa_training: { kind: "witnessed", witness: "Fraud, waste and abuse training recorded for every active member of staff." },
  hipaa_training: { kind: "witnessed", witness: "HIPAA training recorded for every active member of staff." },
  osha_bloodborne: { kind: "witnessed", witness: "Bloodborne pathogens training recorded for every active member of staff." },
  osha_hazcom: { kind: "witnessed", witness: "Hazard communication training recorded for every active member of staff." },
  immunization_protocol_review: {
    kind: "witnessed",
    witness: "A current immunization protocol on file for every immunizer. Upload each one on the person\u2019s page with its expiry; there is no separate training to record.",
  },
  backup_restore_test: { kind: "witnessed", witness: "A backup taken and verified under Settings → Backups." },
  /*
   * One monthly screen, covering both things it actually answers.
   *
   * The pharmacist-in-charge's PSAO runs this every month and sends a report; he reads it and
   * attests here. That single act answers two separate requirements — the OIG and SAM exclusion
   * check under 42 CFR 1001.1901, and the DEA's question about who has access to controlled
   * substances under 21 CFR 1301.90 to 1301.93 and 1301.76(a) — and the wording only claimed the
   * first. So an inspection screen reported the DEA half as untracked and answered from memory,
   * when in fact it was being done monthly and signed for.
   *
   * Naming both in the sentence is what makes the attestation cover both. The record is the
   * sentence, not the row.
   */
  exclusion_screening: {
    kind: "attest",
    minutes: 5,
    statement:
      "On {date} I screened every member of staff against the OIG List of Excluded Individuals and Entities and the " +
      "SAM exclusions list for {period}, and reviewed the screening report provided for that period. No member of " +
      "staff appeared on either list. I also confirmed that no person with access to controlled substances at this " +
      "pharmacy has had an application for DEA registration denied, has had a DEA registration revoked or " +
      "surrendered for cause, or has been convicted of a felony offence relating to controlled substances.",
  },

  // ── Satisfied only by a document arriving ────────────────────────
  temperature_logs: {
    kind: "witnessed",
    witness: "Readings pulled from iMonnit, every excursion explained, and the month signed off under Temperatures.",
  },

  // ── Renewals, driven by an expiry date ───────────────────────────
  ks_pharmacy_registration: { kind: "renewal", minutes: 20 },
  dea_registration: { kind: "renewal", minutes: 30 },
};

/**
 * Renewals whose real date the site already holds.
 *
 * A renewal duty has a deadline, and it is not the end of the year. The Kansas pharmacy
 * registration runs to 30 June; a DEA registration expires on whatever date is printed on the
 * certificate, which is the pharmacy's own and nobody else's. Both are recorded on the licences
 * page — so showing "due Dec 31" because that is when the annual period happens to end is the site
 * ignoring a date it is already holding, and telling the pharmacist something he can see is wrong.
 *
 * The certificate wins where there is one. A date somebody read off their own registration beats
 * any rule about when registrations generally renew.
 */
export const RENEWAL_CREDENTIAL: Record<string, CredentialType> = {
  ks_pharmacy_registration: "pharmacy_registration",
  dea_registration: "dea_registration",
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
    detail: "Generated and filed automatically at the end of every month, recording who was on staff and what their registration said at the time. Nothing to do unless a technician has no registration number recorded.",
    citation: "K.S.A. 65-1663(i)",
    cadence: "monthly",
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
    title: "Screen every employee: OIG and SAM exclusions, and DEA access",
    detail:
      "Two requirements answered by one monthly screen. Anyone excluded from federal health care programs cannot be " +
      "paid, directly or indirectly, by a pharmacy that bills them, and the OIG expects screening on hire and monthly " +
      "thereafter. Separately, the DEA asks who has access to controlled substances and whether any of them has had a " +
      "registration denied or revoked or a controlled substance felony conviction. Where a PSAO runs the screen and " +
      "sends a report, reading that report and attesting here is the record — file the report against the month too.",
    citation: "42 CFR 1001.1901 · OIG Special Advisory Bulletin · 21 CFR 1301.90-1301.93 · 21 CFR 1301.76(a)",
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
    key: "temperature_logs",
    title: "File the refrigerator and freezer temperature logs",
    detail:
      "Readings come from the sensors automatically. A month counts once every out-of-range reading has an explanation " +
      "against it and the month has been signed off — numbers on their own are not a log.",
    citation: "CDC Vaccine Storage and Handling Toolkit · VFC programme requirements",
    cadence: "monthly",
    firstDueInDays: 30,
  },
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
/**
 * Creates any duty the pharmacy does not yet have, and brings the ones it does have up to date.
 *
 * The second half matters as much as the first, and its absence was a real bug: a pharmacy that
 * started using the site before attestation wording existed had duties with no wording, and the
 * confirm button simply did not appear. There was no way to tell from the screen — the duty was
 * listed, it just could not be closed.
 *
 * So every seeded row is refreshed against the current definition on each run: how it is closed,
 * what it says, what is recorded when it is attested. Nothing about the pharmacy's own history is
 * touched — completions, due dates, and whether it has been switched off all stay exactly as
 * they are. Only the definition catches up.
 */
/**
 * Serialises the seeding.
 *
 * The compliance page loads its two data sources together, and both of them ensure the seeds
 * exist. Two concurrent runs each found a duty missing and each inserted it, which is how the
 * temperature log appeared twice with two different descriptions. One promise, shared.
 */
let seeding: Promise<{ created: number; refreshed: number }> | null = null;

export async function ensureObligations() {
  if (seeding) return seeding;
  seeding = seedOnce().finally(() => {
    seeding = null;
  });
  return seeding;
}

async function seedOnce() {
  const existing = await db.query.obligations.findMany();

  // Clean up any duplicate the race already created. The one with history is kept, and any
  // completions filed against the other are moved onto it rather than lost.
  const bySeedKey = new Map<string, typeof existing>();
  for (const o of existing) {
    if (!o.seedKey) continue;
    bySeedKey.set(o.seedKey, [...(bySeedKey.get(o.seedKey) ?? []), o]);
  }
  for (const [key, rows] of bySeedKey) {
    if (rows.length < 2) continue;
    const completions = await db.query.obligationCompletions.findMany();
    const score = (o: (typeof rows)[number]) => completions.filter((c) => c.obligationId === o.id).length;
    const keep = [...rows].sort((a, b) => score(b) - score(a) || a.createdAt.localeCompare(b.createdAt))[0];
    for (const dead of rows.filter((r) => r.id !== keep.id)) {
      await db.update(schema.obligationCompletions).set({ obligationId: keep.id }).where(eq(schema.obligationCompletions.obligationId, dead.id));
      await db.delete(schema.obligations).where(eq(schema.obligations.id, dead.id));
    }
    void key;
  }
  const fresh = await db.query.obligations.findMany();
  const bySeed = new Map(fresh.map((o) => [o.seedKey, o]).filter(([k]) => k) as [string, (typeof fresh)[number]][]);
  const today = todayIso();
  let created = 0;
  let refreshed = 0;

  for (const seed of OBLIGATION_SEEDS) {
    const c = CLOSURES[seed.key] ?? { kind: "attest" as const };
    const current = bySeed.get(seed.key);

    if (!current) {
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
        kind: c.kind,
        expectedPerPeriod: c.perPeriod ?? 1,
        attestationTemplate: c.statement ?? null,
        witnessSource: c.witness ?? null,
        dueOn,
        needsConfirmation: seed.needsConfirmation ?? false,
      });
      created++;
      continue;
    }

    const wanted = {
      title: seed.title,
      detail: seed.detail ?? null,
      citation: seed.citation ?? null,
      cadence: seed.cadence,
      kind: c.kind,
      expectedPerPeriod: c.perPeriod ?? 1,
      attestationTemplate: c.statement ?? null,
      witnessSource: c.witness ?? null,
    };
    const stale = (Object.keys(wanted) as (keyof typeof wanted)[]).some((k) => current[k] !== wanted[k]);
    if (!stale) continue;

    await db.update(schema.obligations).set({ ...wanted, updatedAt: new Date().toISOString() }).where(eq(schema.obligations.id, current.id));
    refreshed++;
  }
  return { created, refreshed };
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
