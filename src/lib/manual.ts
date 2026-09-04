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
  },
  {
    name: "CQI bimonthly summary (Form C-550) and incident evaluation (Form C-650)",
    purpose: "The record of quality-related events, their review and the summary of each period.",
    href: "/cqi",
    cadence: "Summaries every two months, by the fifteenth of February, April, June, August, October and December.",
  },
  {
    name: "Controlled substance inventory (Form C-250)",
    purpose: "The complete count of controlled substances on hand, with each participant named and signed.",
    href: "/inventory",
    cadence: "At least annually, no later than 375 days after the previous one.",
  },
  {
    name: "Daily pharmacist log statement and signature sheet",
    purpose:
      "The statement pasted into the front of the bound log book, and the ruled sheet on which each pharmacist signs that the day's Schedule III and IV refill information has been reviewed.",
    href: "/inventory/pharmacist-log",
    cadence: "Statement reprinted whenever a new log book is opened; signature sheet monthly.",
  },
  {
    name: "Power of attorney for DEA order forms, and notice of revocation",
    purpose: "Authorising a named individual to execute Forms 222 and CSOS orders, and revoking that authority.",
    href: "/inventory/power-of-attorney",
    cadence: "On appointment; the revocation on the day the person leaves.",
  },
  {
    name: "Training certificates and the workforce training file",
    purpose:
      "The certificate for each completed training and the whole file — who has done what, the material and version delivered, and how each was evidenced.",
    href: "/compliance/training/records",
    cadence: "Certificate on each completion; the file printable at any time.",
  },
  {
    name: "Policy and procedure acknowledgement",
    purpose: "Each employee's signed acknowledgement that they have read this manual.",
    href: "/compliance/training",
    cadence: "On hire and annually.",
  },
  {
    name: "Self-inspection checklist and record",
    purpose:
      "The walkthrough against the criteria an inspector uses, the findings, and the date each was put right.",
    href: "/inspection/walk",
    cadence: "At least annually.",
  },
  {
    name: "Record of attestations",
    purpose: "Every standing duty confirmed by the pharmacist-in-charge, in the wording agreed to at the time.",
    href: "/compliance/attestations",
    cadence: "Printable at any time; entries as each duty is closed.",
  },
  {
    name: "Temperature log and monthly review",
    purpose:
      "Refrigerator and room readings, every out-of-range reading with its explanation, and the month signed off.",
    href: "/temps",
    cadence: "Continuous logging; reviewed and signed monthly.",
  },
  {
    name: "Business associate register",
    purpose: "Every outside party with access to protected health information, and the signed agreement permitting it.",
    href: "/agreements",
    cadence: "Reviewed annually.",
  },
  {
    name: "Inspection readiness pack",
    purpose:
      "What the pharmacy can produce on request, by inspector, with the state of each record at the time of printing.",
    href: "/inspection",
    cadence: "Printable at any time.",
  },
];

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
      key: "records",
      title: "Records, retention and backup",
      authority: "K.A.R. 68-7-12; 45 CFR 164.530(j); 21 CFR 1304; 29 CFR 1910.1030(h)(2)(ii).",
      text: [
        "Compliance records are held in the pharmacy's own system on pharmacy premises. Backups are taken automatically, verified by re-reading the archive and comparing it record for record against the live data, and an unverifiable archive is deleted rather than kept.",
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
    ...FORMS.map((f) => `${f.name}|${f.purpose}|${f.cadence}`),
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
