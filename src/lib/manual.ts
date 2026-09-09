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
  /**
   * The other names this form goes by, so a manual heading can be matched to it.
   *
   * A pharmacist looked at a heading called "Medication Incident Form", read a dropdown offering
   * "CQI bimonthly summary (Form C-550) and incident evaluation (Form C-650)", and reasonably
   * concluded the site could not do it. It could — under a name only the Board uses. The formal
   * name is right on a printed form and wrong in a picker, and rather than choose, both are kept.
   */
  aliases?: string[];
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
    aliases: ["technician list", "pharmacy technician list", "technician register"],
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
    aliases: ["medication incident", "incident form", "incident report", "quality related event", "medication error", "cqi"],
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
    aliases: ["controlled substance inventory", "biennial inventory", "annual inventory", "c-250"],
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
    aliases: ["daily pharmacist log", "pharmacist log", "refill statement"],
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
    aliases: ["power of attorney", "poa", "form 222"],
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
    aliases: ["technician training", "training certificate", "workforce training", "staff training"],
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
    aliases: ["policy and procedure acknowledgement", "policy acknowledgement", "manual acknowledgement", "employee acknowledgement"],
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
    aliases: ["business associate register", "ba register"],
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
  {
    name: "Immunization protocol, signed by the authorising physician",
    purpose:
      "The written protocol under which a named pharmacist, intern or technician administers vaccines as the agent of the authorising physician.",
    href: "/staff",
    cadence: "Produced per person, populated from their record, and valid for two years from signature.",
    fields: [
      "The pharmacy, its address and the authorising physician",
      "The individual authorised, their role, licence or registration number",
      "Their immunization training certificate and CPR certification, with its expiry",
      "The vaccines covered and the ages they may be given to",
      "The emergency anaphylaxis protocol, including epinephrine dosing",
      "Signature and date blocks for the physician and the individual",
    ],
    where: "Staff -> the person -> Immunization protocol",
    authority: "K.S.A. 65-1635a.",
    aliases: ["vaccine protocol", "immunization protocol", "immunisation protocol", "protocol physician"],
  },
  {
    name: "Vaccine screening, consent and administration record",
    purpose:
      "The screening questions asked before a dose, the patient's consent, and what was actually administered, on one sheet.",
    href: "/forms/vaccine-administration",
    cadence: "Printed blank and completed at the point of vaccination; filed in the patient's record.",
    fields: [
      "Patient, date of birth, address and primary care provider",
      "The standard pre-vaccination screening questions and the answers given",
      "The pharmacist's decision where any answer was yes or unsure",
      "Consent, including that the VIS was given and the registry will be told",
      "Vaccine, manufacturer, lot, expiry, dose, route, site, VIS date and time",
      "Who administered it, their signature and registration number",
      "What to do if a reaction occurs, and a place to record one",
    ],
    where: "Records -> Forms -> Vaccine administration record",
    authority: "K.S.A. 65-1635a; 42 U.S.C. 300aa-26 (VIS).",
    aliases: ["vaccine administration record", "immunization record", "var", "vaccine record"],
  },
  {
    name: "Policy and procedure manual acknowledgement",
    purpose:
      "The staff member's signature confirming they have been given, and have read, this pharmacy's policy and procedure manual in a stated revision.",
    href: "/forms/policy-acknowledgement",
    cadence:
      "Signed by every member of staff on joining, and again when the manual is revised in a way that changes what they are expected to do. Normally done from the emailed link; this is the paper version.",
    fields: [
      "The revision of the manual being acknowledged, and the date it was last edited",
      "The chapters the manual contained at that revision",
      "That the person has read it and had the chance to ask questions",
      "That the policies apply to their work and may be enforced",
      "Signature, printed name, job title and date",
      "The pharmacist-in-charge's signature where it was gone through with them",
    ],
    where: "Records -> Forms -> Policy manual acknowledgement",
    authority:
      "45 CFR 164.530(b)(1) and (e)(1), documented under 164.530(j)(1)(ii); 29 CFR 1910.1030(g)(2); K.A.R. 68-19-1.",
    aliases: [
      "policy acknowledgement",
      "p&p acknowledgement",
      "manual acknowledgement",
      "policy manual signature",
      "staff acknowledgement",
      "handbook acknowledgement",
    ],
  },
  {
    name: "Notice of Privacy Practices",
    purpose:
      "The notice itself — what this pharmacy does with a patient's health information, what they can ask of it, and how to complain. Not the acknowledgement, which is the signature saying they were given this.",
    href: "/forms/privacy-notice",
    cadence: "Displayed in the pharmacy, given to each patient at first service, and reissued whenever it is materially changed.",
    fields: [
      "The header in the words 45 CFR 164.520(b)(1)(i) prescribes",
      "How information is used for treatment, payment and running the pharmacy",
      "The disclosures the law permits or requires without authorisation, including K-TRACS and the immunization registry",
      "That anything else needs written authorisation, which may be revoked",
      "Each of the patient's rights, including the restriction a pharmacy must honour when a prescription is paid for in full",
      "The pharmacy's own duties, including breach notification",
      "How to complain to the pharmacy and to the Secretary, and that complaining carries no retaliation",
      "The effective date",
    ],
    where: "Records -> Forms -> Notice of Privacy Practices",
    authority: "45 CFR 164.520(a), (b)(1) and (c)(3).",
    aliases: ["npp", "notice of privacy practices", "privacy notice", "hipaa notice", "privacy practices"],
  },
  {
    name: "Acknowledgement of receipt of the Notice of Privacy Practices",
    purpose:
      "The patient's acknowledgement that they were given the pharmacy's privacy notice — or, where it was not obtained, the record of the effort made.",
    href: "/forms/privacy-acknowledgement",
    cadence: "Printed blank, signed at first service, filed in the patient's record and kept six years.",
    fields: [
      "What the patient is acknowledging, in the notice's own terms",
      "Patient or personal representative signature, printed name and date",
      "Where a representative signs: their relationship and authority",
      "Where it was not obtained: which of the recognised reasons applied",
      "The staff member's account of the effort made, signed and dated",
    ],
    where: "Records -> Forms -> Privacy acknowledgement",
    authority: "45 CFR 164.520(c)(2)(ii); 45 CFR 164.530(j).",
    aliases: ["hipaa form", "privacy practices", "notice of privacy practices", "npp", "hipaa acknowledgement"],
  },
  {
    name: "Medicare Prescription Drug Coverage and Your Rights (Form CMS-10147)",
    purpose:
      "CMS's standardised point-of-sale notice, given to a Part D patient whenever their prescription cannot be filled under their plan.",
    href: "/forms/medicare-rights",
    cadence: "Printed and handed over at the point of sale; also displayed in the pharmacy.",
    fields: [
      "The patient's right to request a coverage determination or an exception",
      "The three grounds on which an exception may be requested",
      "How to contact the plan, and how to ask for a fast decision",
      "The Medicare helpline and TTY numbers",
      "This pharmacy's name and phone number",
    ],
    where: "Records -> Forms -> Medicare rights notice",
    authority: "42 CFR 423.562(a)(3); CMS Medicare Prescription Drug Benefit Manual.",
    aliases: [
      "medicare prescription drug coverage and your rights",
      "medicare rights",
      "part d notice",
      "cms-10147",
    ],
  },
  {
    name: "Business associate agreement",
    purpose:
      "The contract required before anyone outside the pharmacy handles protected health information on its behalf.",
    href: "/forms/business-associate-agreement",
    cadence: "Printed and signed in duplicate when a business associate is engaged; recorded in the register.",
    fields: [
      "The parties, and the service the business associate performs",
      "Permitted uses and disclosures, and the prohibition on any other",
      "Safeguards, including the Security Rule obligations for electronic information",
      "Reporting of any impermissible use, security incident or breach, within ten days",
      "Flow-down to subcontractors",
      "Individual rights: access, amendment and accounting of disclosures",
      "Availability of records to the Secretary",
      "Term, termination for breach, and return or destruction of information",
      "Signature blocks for both parties",
    ],
    where: "Records -> Forms -> Business associate agreement",
    authority: "45 CFR 164.504(e); 45 CFR 164.308(b).",
    aliases: ["business associate agreement", "baa", "business associate contract"],
  },
];

/**
 * Which form a manual heading is probably naming.
 *
 * The picker used to be twelve formal names and no help, and a pharmacist looking at a heading
 * called "Medication Incident Form" scanned it, saw "CQI bimonthly summary (Form C-550) and
 * incident evaluation (Form C-650)", and concluded the site could not do it. It could. The Board's
 * name for a form and the name the pharmacy's own manual uses for the same form are different
 * words for one document, and asking somebody to make that translation twelve times is how a
 * working feature reads as a broken one.
 *
 * Matching is deliberately conservative — a whole alias has to appear in the heading, or the
 * heading in the alias. A confident wrong suggestion is worse than none here, because what it
 * writes is a statement in a document an inspector holds the pharmacy to.
 */
export function suggestForm(headingTitle: string): ManualForm | null {
  const h = headingTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!h) return null;
  let best: { form: ManualForm; score: number } | null = null;
  for (const f of FORMS) {
    for (const raw of [f.name, ...(f.aliases ?? [])]) {
      const a = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!a) continue;
      // Length is the score: "incident" matching inside a longer alias is a weaker signal than
      // "medication incident" matching, and the longest agreement should win.
      const hit = h.includes(a) || (a.includes(h) && h.length >= 6);
      if (hit && (!best || a.length > best.score)) best = { form: f, score: a.length };
    }
  }
  return best?.form ?? null;
}

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
      key: "supplier_invoices",
      title: "Supplier invoices and the separation of controlled substance records",
      authority: "21 CFR 1304.04(a), (h)(1) and (h)(2); 21 CFR 1300.01(b); 21 CFR 1304.22(c); K.A.R. 68-7-11.",
      text: [
        `Invoices from ${pharmacy}'s wholesalers are delivered by email to the pharmacy's own mailbox and are filed automatically by the compliance system. Each invoice is read on arrival to establish which controlled substance schedules, if any, it carries, and is filed accordingly before it is stored anywhere.`,
        "Invoices carrying any Schedule II line are maintained separately from all other records of the registrant, as 21 CFR 1304.04(h)(1) requires. The separation is made in three ways: the record is held under a category used by no other document, the file itself is written to a directory containing only Schedule II records, and the pharmacy can list Schedule II invoices for any period on their own without any other record appearing in the result.",
        "Invoices carrying only Schedule III, IV or V lines are maintained separately as well, which satisfies 21 CFR 1304.04(h)(2) by the stricter of the two routes it allows. Invoices carrying no controlled substances are kept as ordinary business records.",
        "Where the reading of an invoice is not certain — a partial scan, an unrendered page, a line that cannot be resolved — the invoice is filed with the Schedule II records and appears in a list awaiting confirmation by the pharmacist-in-charge. It is never filed as non-controlled on an uncertain reading, because the only error that breaks the separation requirement is a Schedule II record placed among the others.",
        "The pharmacist-in-charge may confirm or correct the schedule of any invoice at any time; the record retains how the original determination was made, who changed it and when.",
        "These invoices are kept as electronic records and no parallel paper file is maintained. An invoice a wholesaler sends by email is itself an electronic record: the PDF the pharmacy receives is the original, and there is no paper copy of it in existence to file. 21 CFR 1304.04(a) requires such a record to be maintained at the registered location and kept available for inspection, which it is — the record is held on the pharmacy's own computer inside the pharmacy, not on a third party's system, and can be displayed or printed on request during an inspection.",
        "The records are readily retrievable within the meaning of 21 CFR 1300.01(b), which defines the term as records kept in a manner allowing them to be separated out from all other records in a reasonable time. Any invoice can be found by supplier, by date, by invoice number or by amount, and the Schedule II invoices can be listed alone, in seconds and without any other record appearing in the result.",
        "Where an invoice arrives on paper rather than by email, the paper is the original record and is kept. Scanning it into this system produces an image of the record and not the record itself, and nothing in 21 CFR part 1304 permits the original to be destroyed on the strength of that image.",
        `The record of what was received, which 21 CFR 1304.22(c) requires to show the date and quantity received and, for Schedule II, the number of commercial containers, is made as each order is checked in. Where ${pharmacy} confirms receipt in the wholesaler's own ordering system, that system holds the receipt record and its history is producible at the pharmacy during an inspection; where receipt is confirmed here instead, it is recorded against the invoice with the date, the name of whoever checked it in, and a note of anything short or damaged.`,
        "Invoices are retained for five years, which exceeds the two years required by 21 CFR 1304.04(a), and are included in the pharmacy's daily verified backup. Every invoice remains available for inspection at the registered location.",
      ],
    },
    {
      key: "temperatures",
      title: "Temperature monitoring and review",
      authority: "CDC Vaccine Storage and Handling Toolkit; USP 1079.",
      text: [
        /*
         * "Continuously" was the word here and it is not what this pharmacy does.
         *
         * The owner, asked: one data logger, four readings a day, records kept. Four readings a day
         * is a defensible practice and continuous monitoring is a different and larger promise —
         * and a manual is a standard the pharmacy is held to, so claiming the larger one turns a
         * sound practice into a finding against itself. The number is stated rather than described,
         * because "regularly" would leave an inspector to decide what regular means.
         */
        `Refrigerated and room-temperature storage at ${pharmacy} is monitored by an electronic data logger, which records four readings a day. Readings are collected automatically into the pharmacy's compliance system; no reading is transcribed by hand.`,
        "The acceptable range for each logger is recorded against it. Any reading outside that range is flagged as an excursion and appears on a single list of excursions awaiting explanation.",
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
    /*
     * The Notice, described where the reviewer will see it.
     *
     * It is already in Appendix A as a form this site produces, which tells a reader it exists. It
     * was not in this list, which is what the audit is given as "what the compliance system
     * already does" — so nothing could check the manual's own privacy section against it. A manual
     * that describes a different notice from the one the pharmacy hands out is exactly the kind of
     * conflict this audit exists to find, and it could not see one half of it.
     */
    {
      key: "npp",
      title: "Notice of Privacy Practices",
      authority: "45 CFR 164.520(a), (b)(1) and (c)(3); 45 CFR 164.520(c)(2)(ii) for the acknowledgement.",
      text: [
        `${pharmacy} maintains a Notice of Privacy Practices carrying every element 45 CFR 164.520(b)(1) requires: the prescribed header, the uses and disclosures made for treatment, payment and health care operations, the disclosures permitted or required without authorisation, that any other use requires written authorisation which may be revoked, each of the individual's rights, the pharmacy's own duties including breach notification, how to complain to the pharmacy and to the Secretary, that complaining carries no retaliation, a contact, and an effective date.`,
        "The Notice is displayed where patients can see it, given at first service, and produced from the compliance system so that the copy on the wall and the copy on file are the same document.",
        "A patient's acknowledgement of receipt is recorded on a separate form, which also records the effort made and the reason where an acknowledgement was not obtained — the rule asks for a good faith effort, not for a signature every time.",
        "Where the Notice is materially changed, the revised version is displayed and made available, and it applies to information already held as well as to information received afterwards.",
      ],
    },
    {
      key: "baa",
      title: "Business associate agreements",
      authority: "45 CFR 164.502(e); 45 CFR 164.504(e).",
      text: [
        "A register is maintained of every outside party with access to protected health information, recording what they do, the date the agreement was signed, the date it runs to, and the signed agreement itself.",
        /*
         * Said because it is true and was not always.
         *
         * The manual promised business associate agreements with nothing behind the heading — a
         * document stating the pharmacy has them, and no agreement to sign. The form exists now, so
         * the manual names where it is rather than promising one in the abstract. A heading with no
         * document behind it is the shape of finding this audit exists to remove.
         */
        `${pharmacy} produces the agreement itself, at Forms → Business associate agreement, carrying every clause 45 CFR 164.504(e) requires. Who the parties are and what the service is are left blank, because those are the only parts that make it this pharmacy's agreement rather than a specimen. No outside party need supply their own.`,
        "The agreement is signed before the party is given access, and the signed copy is attached to its entry on the register. Anyone outside the pharmacy who handles prescriptions or patient information is a business associate — a delivery driver, a courier, a billing service, an IT contractor. A carrier that only moves a sealed package, such as the United States Postal Service, is not.",
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
        "Hepatitis B vaccination. The vaccination series is offered free of charge to every employee with occupational exposure, within ten working days of their taking on those duties, at a reasonable time and place. An employee who declines signs the declination statement required by the standard, and may request and receive the series free of charge at any later time. The signed offer or declination is filed in the employee's personnel record.",
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
        /*
         * "Within 48 hours" was here and no rule requires it.
         *
         * The owner's objection, and it was the right one: "we shouldn't be restricting ourselves
         * further than law requires." Neither Kansas nor the DEA sets a clock. 21 CFR 1300.01
         * defines readily retrievable as separable from other records in a reasonable time;
         * K.A.R. 68-20-16 requires records readily retrievable and kept five years at the pharmacy,
         * and the Board glosses the phrase as separated out quickly and easily during an
         * inspection. No hours anywhere. So the manual states none — a deadline nobody imposed is
         * one the pharmacy can miss for no reason, and this one appeared in three places at two
         * different numbers.
         */
        "Electronic records satisfy the Board's requirements where a record must be readily retrievable — that is, capable of being separated out from all other records quickly and easily during an inspection. Records are produced on request while the inspector is here, and records in archived storage are retrieved promptly. Neither the Board nor the DEA sets a number of hours, and this manual does not state one. Continuous quality improvement incident reports, bimonthly summaries and null reports, training records and certificates, temperature logs and monthly reviews, the technician list, the business associate register and the self-inspection record are all kept in this system and are not separately maintained on paper.",
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
