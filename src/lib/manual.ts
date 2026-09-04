import "server-only";
import { getSettings } from "./settings";
import { CHECKLIST, ITEM_COUNT } from "./self-inspection-checklist";
import { COURSES } from "./courses";
import { courseVersion } from "./course-packet";
import type { TrainingType } from "@/db/schema";

/**
 * Keeping the policy manual and this site in step.
 *
 * The manual is a Word document that lives on somebody's desktop; this is a running system. Trying
 * to edit the first from the second is a losing game, and trying to keep two prose descriptions of
 * the same procedure identical by hand is how they quietly diverge until an inspector reads both.
 *
 * So the split is by ownership rather than by topic. The manual owns everything about the
 * pharmacy that a program cannot know — hours, staffing, conduct, benefits, the physical premises.
 * This site owns the procedures it actually performs and the forms it actually produces, and
 * prints them as an appendix the manual incorporates by reference. The manual then says "the
 * current version of these is Appendix A, maintained in the Pharmacy Admin desk" and stops trying
 * to describe them.
 *
 * The version is a hash of the appendix content. When a form changes or a procedure is altered
 * here, the version changes, and the site can say plainly that the filed manual is now out of
 * date — which is the only mechanism that actually keeps two documents in step: not discipline,
 * but a thing that notices.
 */

export type ManualForm = {
  name: string;
  /** What it is for, in the manual's voice. */
  purpose: string;
  href: string;
  /** How often it is produced, where that is fixed. */
  cadence: string;
  /**
   * What the form actually captures.
   *
   * The manual has to describe the form the pharmacy uses, not a form somebody imagined. These
   * are the fields on the printed output, so a reader of the manual and a reader of the form are
   * looking at the same document — and when a field is added here, the appendix version changes
   * and the filed manual is flagged as behind.
   */
  fields: string[];
  /** Where a person clicks to get it, written the way it appears on screen. */
  where: string;
  /** The rule it exists to satisfy. */
  authority: string;
};

export type ManualPolicy = {
  key: string;
  title: string;
  /** Manual-ready prose describing what the site actually does — not what it ought to do. */
  text: string[];
  authority: string;
};

/** The forms this site produces, which the manual's appendix should carry instead of promising. */
export const FORMS: ManualForm[] = [
  {
    name: "Pharmacy technician list (Form C-900)",
    purpose: "The list of technicians employed, maintained at all times and available for inspection.",
    href: "/staff/technician-list",
    cadence: "Filed automatically at the end of every month; any past month reproducible exactly as it stood.",
    fields: [
      "Facility name, registration number and address",
      "Each technician's full name and registration number",
      "The date each was added and, for a former technician, the date they left",
      "The month the list represents",
      "Pharmacist-in-charge name and signature",
    ],
    where: "Staff → Technician list",
    authority: "K.S.A. 65-1663(i); K.A.R. 68-5-16.",
  },
  {
    name: "CQI bimonthly summary (Form C-550) and incident evaluation (Form C-650)",
    purpose: "The record of quality-related events, their review and the summary of each period.",
    href: "/cqi",
    cadence: "Summaries every two months, by the fifteenth of February, April, June, August, October and December.",
    fields: [
      "Facility name and registration number",
      "Date the summary was communicated to pharmacy personnel",
      "Method of communication — meeting, email, webinar",
      "Each incident type and the number of each in the period",
      "Corrective action plan and its implementation date",
      "On the C-650: prescription number, date the report was created, date the PIC or designee began the review, name of the reviewer, the analysis and the action taken",
    ],
    where: "CQI program → the period → Print",
    authority: "K.A.R. 68-19-1.",
  },
  {
    name: "Controlled substance inventory (Form C-250)",
    purpose: "The complete count of controlled substances on hand, with each participant named and signed.",
    href: "/inventory",
    cadence: "At least annually, no later than 375 days after the previous one.",
    fields: [
      "Facility name, registration number, DEA number, city, state and ZIP",
      "Date of inventory and whether it was taken before opening or after the close of business",
      "Which schedules and drugs of concern it covers",
      "Every drug, strength, dosage form and exact count",
      "Each participating individual's name, licence or registration number and signature",
    ],
    where: "CS inventories → the inventory → C-250",
    authority: "K.A.R. 68-20-16; 21 CFR 1304.11.",
  },
  {
    name: "Daily pharmacist log statement and signature sheet",
    purpose:
      "The statement pasted into the front of the bound log book, and the ruled sheet on which each pharmacist signs that the day's Schedule III and IV refill information has been reviewed.",
    href: "/inventory/pharmacist-log",
    cadence: "Statement reprinted whenever a new log book is opened; signature sheet monthly.",
    fields: [
      "The statement pasted inside the front cover of the bound log book",
      "One ruled row per day: date, pharmacist signature, printed name, notes",
      "The month the sheet covers",
    ],
    where: "CS inventories → Daily log statement",
    authority: "21 CFR 1306.22(f).",
  },
  {
    name: "Power of attorney for DEA order forms, and notice of revocation",
    purpose: "Authorising a named individual to execute Forms 222 and CSOS orders, and revoking that authority.",
    href: "/inventory/power-of-attorney",
    cadence: "On appointment; the revocation on the day the person leaves.",
    fields: [
      "Registrant name, address and DEA registration number",
      "The individual the authority is granted to",
      "The signature and title of the registrant or authorised officer granting it",
      "Two witness signatures",
      "Date signed",
      "On the revocation: who is being revoked, and the date",
    ],
    where: "CS inventories → Power of attorney",
    authority: "21 CFR 1305.05.",
  },
  {
    name: "Training certificates and the workforce training file",
    purpose:
      "The certificate for each completed training and the whole file — who has done what, the material and version delivered, and how each was evidenced.",
    href: "/compliance/training/records",
    cadence: "Certificate on each completion; the file printable at any time.",
    fields: [
      "Employee name and role",
      "Course title and version, and the material delivered",
      "Date completed and how it was evidenced",
      "Trainer name and qualifications",
      "The regulation the training satisfies",
      "Certificate number",
    ],
    where: "Compliance → Training → Records",
    authority: "45 CFR 164.530(b); 42 CFR 422.503; 29 CFR 1910.1030(g)(2).",
  },
  {
    name: "Policy and procedure acknowledgement",
    purpose: "Each employee's signed acknowledgement that they have read this manual.",
    href: "/compliance/training",
    cadence: "On hire and annually.",
    fields: [
      "Employee name",
      "The version of the manual acknowledged",
      "Date",
      "Signature or the attestation reply on file",
    ],
    where: "Compliance → Training",
    authority: "K.A.R. 68-19-1; 45 CFR 164.530(i).",
  },
  {
    name: "Self-inspection checklist and record",
    purpose:
      "The walkthrough against the criteria an inspector uses, the findings, and the date each was put right.",
    href: "/inspection/walk",
    cadence: "At least annually.",
    fields: [
      "Every checklist item, by section, with the answer given",
      "What was found and the detail of it",
      "What was done about it, and when",
      "Who walked the pharmacy, and the date",
    ],
    where: "Inspection → Walk the pharmacy",
    authority: "K.A.R. 68-7-11.",
  },
  {
    name: "Record of attestations",
    purpose: "Every standing duty confirmed by the pharmacist-in-charge, in the wording agreed to at the time.",
    href: "/compliance/attestations",
    cadence: "Printable at any time; entries as each duty is closed.",
    fields: [
      "Each standing duty, in the wording agreed to at the time",
      "Who attested and on what date",
      "The period the attestation covers",
    ],
    where: "Compliance → Attestations",
    authority: "K.A.R. 68-7-11.",
  },
  {
    name: "Temperature log and monthly review",
    purpose:
      "Refrigerator and room readings, every out-of-range reading with its explanation, and the month signed off.",
    href: "/temps",
    cadence: "Continuous logging; reviewed and signed monthly.",
    fields: [
      "Sensor name and location",
      "Every reading in the month with its date and time",
      "Every out-of-range reading, its duration and the explanation recorded against it",
      "Who reviewed the month, and when",
    ],
    where: "Temperatures → the sensor → the month → Print",
    authority: "K.A.R. 68-7-12; manufacturer storage requirements.",
  },
  {
    name: "Business associate register",
    purpose: "Every outside party with access to protected health information, and the signed agreement permitting it.",
    href: "/agreements",
    cadence: "Reviewed annually.",
    fields: [
      "Each outside party with access to protected health information",
      "What they do and what they see",
      "The signed agreement and its date",
      "When the relationship was last reviewed",
    ],
    where: "Agreements",
    authority: "45 CFR 164.502(e); 164.308(b).",
  },
  {
    name: "Inspection readiness pack",
    purpose:
      "What the pharmacy can produce on request, by inspector, with the state of each record at the time of printing.",
    href: "/inspection",
    cadence: "Printable at any time.",
    fields: [
      "Every record an inspector may ask for, by inspector",
      "Where each one is and its state at the time of printing",
      "Anything outstanding, said plainly rather than omitted",
    ],
    where: "Inspection",
    authority: "K.A.R. 68-7-11; 21 CFR 1304.",
  },
];

/**
 * The sentence a manual heading gets when the form it names is one this system produces.
 *
 * The alternative — pasting a blank copy of the form into the manual — is how a manual ends up
 * describing a version of a form nobody has used for two years, and it is the copy somebody
 * photocopies at the worst possible moment. Naming the form and saying where the current version
 * comes from is both shorter and true for longer.
 */
export function appendixReference(formName: string): string {
  const f = FORMS.find((x) => x.name === formName);
  if (!f) throw new Error("That is not a form this system produces.");
  return (
    `${f.purpose} The current version of this form is produced and maintained in the pharmacy's compliance system ` +
    `and is described at Appendix A.2 of this manual, under "${f.name}". ${f.cadence}\n\n` +
    `No blank copy is filed under this heading. The form is produced by the system on demand and any completed copy, ` +
    `for any past period, is retrievable and available for inspection.`
  );
}

/**
 * What the site actually does, written so it can be dropped into the manual verbatim.
 *
 * Deliberately descriptive rather than aspirational. A manual is a standard the pharmacy wrote for
 * itself and an inspector holds it to that standard — so anything in here that is not genuinely
 * happening is a self-inflicted finding, and the wording is chosen to describe the practice as it
 * exists.
 */
export function policies(pharmacy: string): ManualPolicy[] {
  const courseList = (Object.values(COURSES) as NonNullable<(typeof COURSES)[TrainingType]>[])
    .map((c) => `${c.title} (version ${courseVersion(c)})`)
    .join("; ");

  return [
    {
      key: "temperatures",
      title: "Temperature monitoring and review",
      authority: "CDC Vaccine Storage and Handling Toolkit; USP 1079.",
      text: [
        `Refrigerated and room-temperature storage at ${pharmacy} is monitored continuously by an electronic logging sensor, and readings are collected automatically into the pharmacy's compliance system.`,
        "The acceptable range for each sensor is recorded against that sensor. Any reading outside its range is flagged as an excursion and appears on a single list of excursions awaiting explanation.",
        "Every excursion must have a written explanation stating what happened and what was done about it, including the disposition of any affected stock. A month cannot be signed off while any excursion in it is unexplained.",
        "At the end of each month the pharmacist-in-charge reviews the month and signs it off. The signed month, its readings and its explanations are retained for five years and can be printed on demand.",
      ],
    },
    {
      key: "cqi",
      title: "Continuous quality improvement",
      authority: "K.A.R. 68-19-1.",
      text: [
        "Any quality-related event — a variation from the prescription as written or from accepted practice, whether or not it reached the patient — is reported to the pharmacist on duty as soon as it is noticed and logged the same day.",
        "Review of a reported event begins within seven days and is completed within thirty. A summary is produced every two months, by the fifteenth of February, April, June, August, October and December, including a null report for a period in which nothing was reported.",
        "The programme is non-punitive. Reporting an error, including one's own, is expected and is not a disciplinary matter; concealing one is. Reviews address the system that produced the event rather than the individual involved.",
        "Records are retained for five years.",
      ],
    },
    {
      key: "training",
      title: "Workforce training",
      authority: "45 CFR 164.530(b); 42 CFR 423.504(b)(4)(vi); 29 CFR 1910.1030(g)(2); 29 CFR 1910.1200(h).",
      text: [
        `Training is delivered in-house using material written and maintained by ${pharmacy}, covering this pharmacy's own policies and procedures. The current courses are: ${courseList}.`,
        "Each member of staff receives the material by email with the course attached, works through it, answers a short comprehension check that must be answered correctly in full, and signs electronically. The typed name, the time and the device are recorded together.",
        "A member of staff may instead confirm completion by replying to the training email from their own address; that reply is filed as the attestation and the record states on its face that it was a reply rather than a signed course.",
        "Bloodborne pathogens training additionally offers the opportunity for interactive questions and answers with the pharmacist-in-charge, whose qualifications are recorded on the training record.",
        "A certificate is produced for every completion. Training is repeated annually. Records are retained for six years, and for former staff for the same period.",
      ],
    },
    {
      key: "technician_list",
      title: "Pharmacy technician list",
      authority: "K.S.A. 65-1663(i).",
      text: [
        "A list of the pharmacy technicians employed is maintained at all times and is available for inspection.",
        "A snapshot of the list is filed automatically at the end of every month and retained, so the list as it stood in any past month can be produced exactly rather than reconstructed from current staffing.",
      ],
    },
    {
      key: "exclusion",
      title: "Exclusion screening",
      authority: "42 CFR 1001.1901; OIG Special Advisory Bulletin.",
      text: [
        "All pharmacy staff are screened monthly against the OIG List of Excluded Individuals and Entities and the SAM exclusions list, on hire and monthly thereafter.",
        "The dated result of each screening is filed as the record of that month's check.",
      ],
    },
    {
      key: "baa",
      title: "Business associate agreements",
      authority: "45 CFR 164.502(e).",
      text: [
        "A register is maintained of every outside party with access to protected health information, recording what they do, the date the agreement was signed, the date it runs to, and the signed agreement itself.",
        "The register is reviewed annually. An agreement that is unsigned, unattached or lapsed is treated as an open finding until it is put right.",
      ],
    },
    {
      key: "self_inspection",
      title: "Self-inspection",
      authority: "Not required by rule. It is the practice behind every other answer given to an inspector.",
      text: [
        `${pharmacy} inspects itself at least annually against ${ITEM_COUNT} items covering ${CHECKLIST.map((s) => s.title.toLowerCase()).join(", ")}.`,
        "Each item is recorded as in order, as a finding, or as not applicable to this pharmacy. A finding requires a written note of what was seen.",
        "Findings remain open until somebody records what was done about them and the date. Open findings appear on the pharmacy's daily compliance screen and age until they are closed.",
        "The completed walkthrough, its findings and their corrections are retained and printable.",
      ],
    },
    {
      key: "exposure_control",
      title: "Bloodborne pathogens exposure control plan",
      authority: "29 CFR 1910.1030(c)(1) — the plan must be written, accessible to employees, and reviewed and updated at least annually.",
      text: [
        `Exposure determination. Anyone at ${pharmacy} who administers vaccines, handles sharps, or cleans up blood or other potentially infectious material has reasonably anticipated occupational exposure. This applies to pharmacists and interns who immunize and to any technician assisting at the immunization station. It does not apply to staff whose duties are confined to the register and the front of the shop. Determination is made without regard to personal protective equipment.`,
        "Universal precautions are observed. All human blood and body fluids are treated as infectious; no judgement is made about the risk presented by an individual patient.",
        "Engineering and work practice controls. Safety-engineered needles are used and their safety device is activated immediately. Needles are never recapped, bent, broken, or removed from the syringe by hand. A puncture-resistant, labelled sharps container is kept within arm's reach of the injection area and is replaced at the fill line rather than when full. Hands are washed immediately after gloves are removed and after any contact. Eating, drinking, applying cosmetics and handling contact lenses are prohibited in the immunization area.",
        "Personal protective equipment. Gloves are provided at no cost to the employee and are worn for any anticipated contact with blood, and changed between patients.",
        "Hepatitis B vaccination. The vaccination series is offered free of charge to every employee with occupational exposure, within ten working days of their taking on those duties, at a reasonable time and place. An employee who declines signs the declination statement required by the standard, and may request and receive the series free of charge at any later time. The offer and its outcome are recorded against each employee.",
        "Post-exposure evaluation and follow-up. An exposure incident is reported to the pharmacist-in-charge immediately. The affected area is washed with soap and water, or flushed with water for a splash to the eyes or mouth. The pharmacy arranges a confidential medical evaluation and follow-up at no cost to the employee, including source testing where the law permits, and post-exposure prophylaxis where indicated. The incident is recorded in the sharps injury log and in the employee's confidential medical record.",
        "Housekeeping and regulated waste. Sharps containers are labelled with the biohazard symbol, kept upright and out of public reach, and replaced at the fill line. Blood spills are cleaned wearing gloves and disinfected with an EPA-registered disinfectant effective against HBV and HIV, or freshly diluted bleach. Broken glass is picked up with tongs or a brush and dustpan, never by hand.",
        "Training. Bloodborne pathogens training is given at the time of initial assignment and annually thereafter, including the opportunity for interactive questions and answers with the pharmacist-in-charge, who is named on each training record together with their qualifications. Training records are retained three years and record the date, the content, the trainer and their qualifications, and the names and job titles of those trained.",
        "Records. Employee medical records relating to hepatitis B vaccination and to any exposure incident are kept confidential and retained for the duration of employment plus thirty years.",
        "Review. This plan is reviewed and updated at least annually and whenever new tasks or procedures affect occupational exposure. It is accessible to any employee on request, and forms part of the Policy and Procedure Manual as part of this appendix.",
      ],
    },
    {
      key: "controlled_dispensing",
      title: "Corresponding responsibility and refusal to fill",
      authority: "21 CFR 1306.04(a); K.S.A. 65-4123.",
      text: [
        "A prescription for a controlled substance is only valid if issued for a legitimate medical purpose by a practitioner acting in the usual course of professional practice. The responsibility for that rests with the prescriber, and a corresponding responsibility rests with the pharmacist who fills it.",
        "A pharmacist who cannot resolve a doubt about a controlled substance prescription does not fill it. The pharmacist may decline to fill any prescription where, in their professional judgement, doing so would not be consistent with that responsibility, and no member of staff may commit the pharmacy to filling one.",
        "Circumstances calling for resolution before dispensing include: a prescription outside the prescriber's usual scope or specialty; a patient travelling an unusual distance past other pharmacies; early refills or a pattern of lost or stolen prescriptions; cash payment for a controlled substance by an insured patient; identical drug, strength and quantity across a prescriber's patients; and alterations to quantity, refills or date on a paper prescription.",
        "K-TRACS is consulted where the circumstances call for it. Resolution is by contact with the prescriber, and what was asked and answered is recorded.",
        "A refusal is recorded with the reason. Where a refusal arises from suspected diversion or a forged prescription it is raised with the pharmacist-in-charge, who determines whether it is reportable.",
      ],
    },
    {
      key: "ktracs",
      title: "Prescription monitoring — K-TRACS",
      authority: "K.S.A. 65-1683.",
      text: [
        "Controlled substance dispensings are submitted to K-TRACS at the frequency the programme requires.",
        "The pharmacist-in-charge signs in to K-TRACS each period and reviews the submission status for that period, confirming that all dispensings were submitted and that any error file has been corrected and resubmitted. That confirmation is recorded, dated and attributed, on the pharmacy's compliance register.",
        "K-TRACS is consulted before dispensing where the circumstances set out under corresponding responsibility call for it.",
      ],
    },
    {
      key: "compounding",
      title: "Non-sterile compounding",
      authority: "USP 795; K.A.R. 68-7-12.",
      text: [
        `${pharmacy} performs simple, non-sterile, non-hazardous compounding only, from commercially available ingredients and established formulas, pursuant to patient-specific prescriptions. No sterile compounding and no hazardous drug compounding is performed.`,
        "A compounding record is made for every preparation, recording the formula used, each ingredient with its source, lot number and expiry, the quantity prepared, the person who prepared it, and the pharmacist who checked it. A dispensed compounded preparation without a compounding record behind it is treated as a finding.",
        "Every compounded preparation is assigned a beyond-use date by the applicable USP 795 default for its dosage form, and is labelled with that date. Beyond-use dates are not assigned by estimate.",
        "Compounding is carried out in a defined area kept clean and separate from routine dispensing traffic, using clean equipment dedicated to that purpose. Where a balance is used it is kept within calibration.",
        "The scope, records, dating, equipment and area are checked at each self-inspection.",
      ],
    },
    {
      key: "records",
      title: "Records, retention and backup",
      authority:
        "K.A.R. 68-7-12; K.A.R. 68-19-1; K.A.R. 68-20-16; 45 CFR 164.530(j); 21 CFR 1304.11(a); 29 CFR 1910.1030(h)(2)(ii).",
      text: [
        "Compliance records are held in the pharmacy's own system on pharmacy premises. Backups are taken automatically, verified by re-reading the archive and comparing it record for record against the live data, and an unverifiable archive is deleted rather than kept.",
        "Electronic records satisfy the Board's requirements where a record must be readily retrievable — that is, capable of being separated from all other records and produced within 48 hours of a written request. Continuous quality improvement incident reports, bimonthly summaries and null reports, training records and certificates, temperature logs and monthly reviews, the technician list, the business associate register and the self-inspection record are all kept in this system and are not separately maintained on paper.",
        "Controlled substance inventories are the exception. K.A.R. 68-20-16 requires each inventory to be maintained in legible hard-copy format, and 21 CFR 1304.11(a) requires it to be kept in written, typewritten or printed form at the registered location. Each annual inventory is therefore printed, signed by every individual who took part with their licence or registration number, marked as taken before the opening or after the close of business, and filed on the premises. The copy held in this system is the working record; the signed printed copy is the record of file.",
        "Retention: prescription and controlled substance records five years; HIPAA training and related documentation six years; bloodborne pathogens training records three years from the date of training; hepatitis B vaccination and exposure records for the duration of employment plus thirty years.",
        "Records of former employees are retained for the same periods. Nobody is removed from the record when they leave.",
      ],
    },
  ];
}

/**
 * A short, stable fingerprint of the appendix.
 *
 * Computed from the content so it cannot drift from what the appendix says. When a form is added
 * or a procedure reworded here, this changes — and a filed manual carrying an older version is
 * then demonstrably out of date rather than merely suspected of being so.
 */
export function appendixVersion(policyText: ManualPolicy[]): string {
  const body = [
    // Everything the appendix actually says about a form. Hashing only the name and purpose meant
    // a field added to the C-250 changed the printed manual without changing its version, so a
    // filed copy stayed "current" while no longer describing the form in use — which is the one
    // failure this version number exists to prevent.
    ...FORMS.map((f) => `${f.name}|${f.purpose}|${f.cadence}|${f.where}|${f.authority}|${f.fields.join(";")}`),
    ...policyText.map((p) => `${p.key}|${p.title}|${p.authority}|${p.text.join(" ")}`),
  ].join("~");

  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `A-${h.toString(36).toUpperCase().padStart(7, "0")}`;
}

export async function currentAppendix() {
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const p = policies(pharmacy);
  return {
    pharmacy,
    forms: FORMS,
    policies: p,
    version: appendixVersion(p),
    filedVersion: (s.manual_appendix_filed_version ?? "").trim() || null,
    filedOn: (s.manual_appendix_filed_on ?? "").trim() || null,
  };
}
