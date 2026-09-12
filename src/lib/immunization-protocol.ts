import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSettings } from "./settings";

/**
 * The physician-signed protocol each immunizer works under.
 *
 * Kansas does not let a pharmacist immunize on their own authority: K.S.A. 65-1635a has them act
 * as the agent of an authorising physician, under a written protocol that physician signs. Without
 * a current signed copy there is no authority to give a single dose — which is why the dashboard
 * chases it, and why producing one had to stop being a matter of finding last year's Word file on
 * somebody's desktop.
 *
 * The wording is the pharmacy's own existing protocol, reproduced rather than reinvented: it is a
 * document a physician has already read and signed, and rewriting it would mean asking them to
 * read a new one. What this adds is that the pharmacy's details, the immunizer's name and their
 * qualifications are filled in from the record instead of typed, so the copy that goes to the
 * physician cannot disagree with the copy the site is tracking.
 */

export const PROTOCOL_VACCINES = [
  ["Pneumonia (Pneumovax/Prevnar)", "Meningitis (Menomune, Menactra, Menveo)", "Japanese Encephalitis (Ixiaro/JE-Vax)"],
  ["Influenza Vaccine, inactive (IIV)", "Typhoid (Typhim-Vi, Vivotif)", "Cholera (Vaxchora)"],
  ["HPV (Gardasil)", "Tetanus (Tdap/Td)", "Rabies (RabAvert, Imovax)"],
  ["Shingles (Shingrix/Zostavax)", "Influenza Vaccine, live (LIV)", "Polio"],
  ["Hepatitis A (Havrix/Twinrix)", "MMR", "COVID"],
  ["Hepatitis B (Engerix/Twinrix)", "Varicella (Varivax)", "RSV"],
  ["Meningococcal (conjugate/Serogroup B)", "Yellow Fever (YF-Vax)", ""],
] as const;

export const EMERGENCY_STEPS = [
  "Call 911.",
  "Administer either 0.3mL of Epinephrine (or 0.15mL if under 66 lbs.) 1mg/mL (1:1000) subcutaneously into the upper arm and massage the area, OR the contents of an EpiPen Auto-Injector (0.3mL of 1:1000 Epinephrine) into the anterolateral aspect of the thigh. Doses of epinephrine may be repeated once after 5 minutes if necessary.",
  "Monitor the patient closely until EMS arrives.",
  "Keep the patient in a supine position unless the patient is having difficulty breathing.",
  "Elevate the patient's head and upper body if difficulty breathing is noted.",
  "Maintain airway and perform CPR as indicated.",
  "Monitor vital signs.",
] as const;

export type ProtocolSubject = {
  personId: string;
  name: string;
  /** "Pharmacist", "Pharmacy intern", "Pharmacy technician" — how the protocol refers to them. */
  role: string;
  /** Their licence or registration number, where one is on file. */
  licence: string | null;
  /** Their immunization training certificate, where one is on file. */
  immunizationTraining: string | null;
  /** CPR certification, which the statute requires them to hold. */
  cpr: { number: string | null; expiresOn: string | null } | null;
  /** A protocol already on file for this person, so the page can say what it is replacing. */
  existing: { signedOn: string | null; expiresOn: string | null } | null;
  /** Whether their record says they administer vaccines at all. */
  administersVaccines: boolean;
};

export type ProtocolContext = {
  pharmacy: string;
  address: string | null;
  physician: string | null;
  subject: ProtocolSubject;
  /** What the pharmacy's protocol says about its own term. */
  termYears: number;
};

const ROLE_WORD: Record<string, string> = {
  pharmacist: "Pharmacist",
  intern: "Pharmacy intern",
  technician: "Pharmacy technician",
  other: "Pharmacy personnel",
};

export async function protocolFor(personId: string): Promise<ProtocolContext | null> {
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, personId) });
  if (!person) return null;
  const [s, creds] = await Promise.all([
    getSettings(),
    db.query.credentials.findMany({ where: eq(schema.credentials.personId, personId) }),
  ]);

  const newest = (type: string) =>
    creds
      .filter((c) => c.type === type)
      .sort((a, b) => (b.expiresOn ?? b.issuedOn ?? "").localeCompare(a.expiresOn ?? a.issuedOn ?? ""))[0];

  const licenceRow =
    newest(person.role === "pharmacist" ? "pharmacist_license" : person.role === "technician" ? "technician_registration" : "intern_registration");
  const cprRow = newest("cpr");
  const trainingRow = newest("immunization_training");
  const protocolRow = newest("immunization_protocol");

  return {
    pharmacy: s.pharmacy_name || "This pharmacy",
    address:
      [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
        .filter(Boolean)
        .join(" · ") || null,
    physician: s.protocol_physician_name?.trim() || null,
    termYears: 2,
    subject: {
      personId,
      name: `${person.firstName} ${person.lastName}`,
      role: ROLE_WORD[person.role] ?? "Pharmacy personnel",
      licence: licenceRow?.number ?? null,
      immunizationTraining: trainingRow?.number ?? trainingRow?.issuer ?? null,
      cpr: cprRow ? { number: cprRow.number, expiresOn: cprRow.expiresOn } : null,
      existing: protocolRow ? { signedOn: protocolRow.issuedOn, expiresOn: protocolRow.expiresOn } : null,
      administersVaccines: person.administersVaccines,
    },
  };
}

/**
 * What is missing before this is worth sending to a physician.
 *
 * The statute conditions the authority on training and a current CPR certificate, so a protocol
 * signed for somebody who holds neither is a document that authorises nothing. Better to say so on
 * the page than to have it signed and filed and discovered later.
 */
export function protocolGaps(c: ProtocolContext): string[] {
  const out: string[] = [];
  if (!c.subject.administersVaccines) {
    out.push(
      `${c.subject.name}'s record does not say they administer vaccines, so nothing will track this protocol's expiry. Tick it on their page.`,
    );
  }
  if (!c.physician) out.push("No authorising physician is recorded — set one under Settings so it prints on the form.");
  if (!c.subject.licence) out.push(`No licence or registration number is on file for ${c.subject.name}.`);
  if (!c.subject.immunizationTraining) {
    out.push("No immunization training certificate is on file, which K.S.A. 65-1635a requires before administering.");
  }
  if (!c.subject.cpr) out.push("No CPR certification is on file, which the statute also requires.");
  else if (c.subject.cpr.expiresOn && c.subject.cpr.expiresOn < new Date().toISOString().slice(0, 10)) {
    out.push(`Their CPR certification expired on ${c.subject.cpr.expiresOn}.`);
  }
  return out;
}

/**
 * The protocol's own words, once, in order.
 *
 * The document is printed for a physician to sign, read on screen by the person who has to work
 * to it, and attached to the email that asks them to. Three renderings of one document is three
 * chances for them to disagree, and the one that matters — what somebody actually read before
 * signing that they had read it — is the one nobody would notice had drifted. So the wording
 * lives here and every rendering walks this list.
 */
export type ProtocolBlock =
  | { kind: "para"; text: string }
  | { kind: "statute"; heading: string; text: string }
  | { kind: "vaccines" }
  | { kind: "heading"; text: string }
  | { kind: "emergency" };

export function protocolBody(c: ProtocolContext): ProtocolBlock[] {
  return [
    {
      kind: "para",
      text:
        "The Pharmacist, Pharmacy Intern, or Pharmacy Technician acting as an agent for the undersigned physician, " +
        "according to and in compliance with Statute 65-1635a of the Kansas State Pharmacy Practice Act and all " +
        "revisions thereof, may administer the immunizations (vaccines) listed below.",
    },
    {
      kind: "statute",
      heading:
        "65-1635a. Administration of vaccine; education and reporting requirements; delegation of authority " +
        "prohibited; “pharmacist” defined.",
      text:
        "(a) A pharmacist or a pharmacy student, intern or pharmacy technician who is 18 years of age or older and " +
        "working under the direct supervision and control of a pharmacist may administer influenza vaccine to a person " +
        "six years of age or older and may administer vaccine, other than influenza vaccine, to a person 12 years of " +
        "age or older pursuant to a vaccination protocol if the pharmacist, pharmacy student, intern or pharmacy " +
        "technician has successfully completed a course of study and training, approved by the accreditation council " +
        "for pharmacy or the board, in vaccination storage, protocols, injection technique, emergency procedures and " +
        "recordkeeping and has taken a course in cardiopulmonary resuscitation (CPR) and has a current CPR certificate " +
        "when administering vaccines. A pharmacist, pharmacy student, intern or pharmacy technician who successfully " +
        "completes such a course of study and training shall maintain proof of completion and, upon request, provide a " +
        "copy of such proof to the board.",
    },
    {
      kind: "para",
      text:
        "The pharmacist, pharmacy intern, or pharmacy technician, possessing a certificate of training in Pharmacy " +
        "Based Immunization Delivery, current BLS Healthcare CPR Certification, and, if applicable, pharmacist " +
        "professional liability insurance coverage may administer influenza vaccine to persons 6 years of age or " +
        "older and the following immunizations (vaccines) to persons 12 years of age or older, consistent with the " +
        "FDA approved indications and contraindications and/or recommended in current guideline from the Advisory " +
        "Committee on Immunizations Practices (ACIP) of the U.S Centers for Disease Control & Prevention (CDC), and " +
        "other competent authorities:",
    },
    { kind: "vaccines" },
    {
      kind: "para",
      text:
        "Pursuant to statute 65-1635a, pharmacy technician or interns certified in Pharmacy Based Immunization " +
        "Delivery carrying liability insurance coverage and current CPR certification may administer vaccinations " +
        "under the direct supervision of the afore mentioned licensed pharmacist.",
    },
    {
      kind: "para",
      text:
        `${c.pharmacy} will maintain records of all immunizations administered, immunization training, and CPR ` +
        "Certifications for a minimum of 5 years and shall be made available at the request of the board of pharmacy. " +
        "Before immunization, vaccine candidates will be screened regarding previous adverse events following " +
        "immunizations, food or drug allergies, current health, immunosuppression status, pregnancy, and underlying " +
        "diseases. All vaccine candidates will be provided with a current Vaccine Information Statement (VIS). If a " +
        `primary care provider (PCP) is provided to ${c.pharmacy} by the vaccinated patient, ${c.pharmacy} will notify ` +
        "or make an attempt to notify the PCP of the vaccine(s) administered. If no PCP is provided by the patient the " +
        "administration record will be sent to the protocol physician. The pharmacist shall report administration of " +
        "all vaccinations to the Kansas Immunization Registry in compliance with K.S.A 65-1635a for reporting " +
        "vaccinations. Any clinically significant adverse events following an immunization shall be reported to the " +
        "Vaccine Adverse Events Reporting System (VAERS), even if unclear whether the event was caused by the vaccine.",
    },
    { kind: "heading", text: "Emergency Protocol:" },
    { kind: "para", text: "If an allergic reaction to a vaccine occurs, this pharmacist is authorized to;" },
    { kind: "emergency" },
    {
      kind: "para",
      text:
        `As the authorizing physician, I will maintain a valid Yellow-Fever stamp registered to ${c.pharmacy} and ` +
        "review the activities of the pharmacist administering vaccines under this protocol on a yearly basis. This " +
        `protocol shall be valid for ${c.termYears} years or such time preceding ${c.termYears} years that it is ` +
        "revoked in writing. I, the authorizing physician, hereby authorize the pharmacist, pharmacy intern, or " +
        "pharmacy technician to administer vaccinations in accordance with this protocol.",
    },
  ];
}
