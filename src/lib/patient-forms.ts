/**
 * The forms a patient signs, and the two notices the pharmacy is required to hand over.
 *
 * These are the back half of the policy manual's appendix — the headings that promised a form and
 * delivered a blank page. They are not records the system generates from data it holds, like the
 * technician list; they are documents the pharmacy prints, fills in by hand at the counter, and
 * files. That is a real distinction and the manual should not pretend otherwise, so each one says
 * plainly what happens to the completed copy.
 *
 * The wording lives here rather than in the pages, so the manual's appendix describes the form
 * the pharmacy actually prints rather than a form somebody imagined, and a change to either shows
 * up as a changed appendix version.
 */

/**
 * The screening questions asked before any dose.
 *
 * Taken from the standard pre-vaccination screening used for all vaccines. A "yes" is not a
 * refusal — it is the point at which the pharmacist decides, which is why the form has a place
 * for that decision rather than only a place for the answers.
 */
export const SCREENING_QUESTIONS = [
  "Are you feeling unwell today?",
  "Do you have an allergy to any medication, food, vaccine component, or latex?",
  "Have you ever had a serious reaction after receiving a vaccine?",
  "Do you have a long-term health problem with heart, lung, kidney or liver disease, asthma, a blood disorder, diabetes, or a neurological condition?",
  "Do you have cancer, leukaemia, HIV/AIDS, or any other immune system problem?",
  "In the past 3 months have you taken medication that weakens the immune system — cortisone, prednisone, other steroids, anti-cancer drugs, or had radiation treatment?",
  "Have you had a seizure, or a brain or nervous system problem?",
  "During the past year have you received a transfusion of blood or blood products, or been given immune globulin or an antiviral drug?",
  "For women: are you pregnant, or is there a chance you could become pregnant in the next month?",
  "Have you received any vaccinations in the past 4 weeks?",
] as const;

/**
 * The Medicare Part D point-of-sale notice.
 *
 * CMS requires a pharmacy to give an enrolled patient this standardised notice whenever a
 * prescription cannot be filled under their Part D plan at the point of sale — it is what tells
 * them a coverage determination exists and how to ask for one. It is a CMS document reproduced,
 * not a document this pharmacy wrote, which is why the pages that print it say so and name the
 * form number.
 */
export const MEDICARE_RIGHTS_NOTICE: { heading: string; body: string[] }[] = [
  {
    heading: "Your Medicare rights",
    body: [
      "You have the right to request a coverage determination from your Medicare drug plan if you disagree with " +
        "information provided by the pharmacy. You also have the right to request a special type of coverage " +
        "determination called an “exception” if you believe:",
      "· you need a drug that is not on your drug plan's list of covered drugs. The list of covered drugs is called a " +
        "“formulary”;",
      "· a coverage rule (such as prior authorization or a quantity limit) should not apply to you for medical " +
        "reasons; or",
      "· you need to take a non-preferred drug and you want the plan to cover the drug at the cost-sharing amount " +
        "that applies to preferred drugs.",
    ],
  },
  {
    heading: "What you need to do",
    body: [
      "You or your prescriber can contact your Medicare drug plan to ask for a coverage determination by calling the " +
        "plan or writing to it. If your health requires it, you can ask the plan for a fast coverage determination.",
      "Your prescriber must provide a supporting statement explaining why you need the drug you are asking for if " +
        "you are asking for an exception.",
      "Refer to your plan materials, or call 1-800-MEDICARE (1-800-633-4227), TTY 1-877-486-2048, 24 hours a day / " +
        "7 days a week, for more information about how to contact your plan.",
    ],
  },
];

/**
 * The acknowledgement a direct treatment provider must make a good faith effort to obtain.
 *
 * 45 CFR 164.520(c)(2)(ii). The rule is about the effort, not the signature: a patient who
 * declines to sign is not a compliance failure, and a form with nowhere to record that they
 * declined turns a lawful outcome into a missing document. So the refusal has a box.
 */
export const PRIVACY_ACKNOWLEDGEMENT_TEXT = [
  "I acknowledge that I have been provided with a copy of this pharmacy's Notice of Privacy Practices, which " +
    "describes how my health information may be used and disclosed and how I can get access to that information.",
  "I understand that the pharmacy may use and disclose my health information to carry out treatment, to obtain " +
    "payment, and for its own health care operations, and that it must obtain my written authorization for most " +
    "other uses.",
  "I understand that I may ask for a copy of the Notice at any time, and that the current version is posted in the " +
    "pharmacy and available on request.",
];

/**
 * The provisions 45 CFR 164.504(e)(2) requires of a business associate contract.
 *
 * Written out as the agreement's own clauses rather than as a checklist, because a checklist is
 * something you tick and a contract is something you sign. Every clause here is one the rule
 * names; the blanks are the parts only the two parties can fill in.
 */
export const BAA_CLAUSES: { heading: string; body: string[] }[] = [
  {
    heading: "1. Definitions",
    body: [
      "Terms used but not otherwise defined in this Agreement have the meaning given to them in the HIPAA Privacy, " +
        "Security, Breach Notification and Enforcement Rules at 45 CFR Parts 160 and 164. “Protected Health " +
        "Information” (PHI) means protected health information created, received, maintained or transmitted by " +
        "Business Associate on behalf of Covered Entity.",
    ],
  },
  {
    heading: "2. Permitted uses and disclosures",
    body: [
      "Business Associate may use or disclose PHI only as necessary to perform the services described in the " +
        "underlying agreement between the parties, as required by law, or as otherwise permitted by this Agreement.",
      "Business Associate may use PHI for its own proper management and administration, or to carry out its legal " +
        "responsibilities. Business Associate may disclose PHI for those purposes only if the disclosure is required " +
        "by law, or if Business Associate obtains reasonable assurances from the recipient that the information will " +
        "remain confidential, will be used or further disclosed only as required by law or for the purpose for which " +
        "it was disclosed, and that the recipient will notify Business Associate of any breach of confidentiality.",
      "Business Associate will not use or disclose PHI in a manner that would violate Subpart E of 45 CFR Part 164 " +
        "if done by Covered Entity.",
    ],
  },
  {
    heading: "3. Safeguards",
    body: [
      "Business Associate will use appropriate safeguards, and comply with Subpart C of 45 CFR Part 164 with respect " +
        "to electronic PHI, to prevent use or disclosure of PHI other than as provided for by this Agreement.",
    ],
  },
  {
    heading: "4. Reporting",
    body: [
      "Business Associate will report to Covered Entity any use or disclosure of PHI not provided for by this " +
        "Agreement of which it becomes aware, including any security incident and any breach of unsecured PHI, " +
        "without unreasonable delay and in no case later than ten (10) calendar days after discovery.",
      "A report of a breach of unsecured PHI will include, to the extent known, the identification of each individual " +
        "whose information has been or is reasonably believed to have been accessed, acquired, used or disclosed, and " +
        "any other information Covered Entity is required to include in its notification to the individual under " +
        "45 CFR 164.404.",
    ],
  },
  {
    heading: "5. Subcontractors",
    body: [
      "Business Associate will ensure that any subcontractor that creates, receives, maintains or transmits PHI on " +
        "its behalf agrees in writing to the same restrictions, conditions and requirements that apply to Business " +
        "Associate under this Agreement.",
    ],
  },
  {
    heading: "6. Individual rights",
    body: [
      "Business Associate will make PHI in a designated record set available to Covered Entity as necessary to " +
        "satisfy Covered Entity's obligations under 45 CFR 164.524 (access), will make any amendment to PHI in a " +
        "designated record set as directed or agreed under 45 CFR 164.526, and will maintain and make available the " +
        "information required to provide an accounting of disclosures under 45 CFR 164.528.",
      "To the extent Business Associate carries out an obligation of Covered Entity under Subpart E of 45 CFR Part " +
        "164, it will comply with the requirements of that Subpart that apply to Covered Entity in performing it.",
    ],
  },
  {
    heading: "7. Availability to the Secretary",
    body: [
      "Business Associate will make its internal practices, books and records relating to the use and disclosure of " +
        "PHI available to the Secretary of Health and Human Services for purposes of determining Covered Entity's " +
        "compliance with the HIPAA Rules.",
    ],
  },
  {
    heading: "8. Term and termination",
    body: [
      "This Agreement takes effect on the date signed below and continues until all PHI held by Business Associate " +
        "has been returned or destroyed, or protections extended under this section.",
      "Covered Entity may terminate this Agreement and the underlying agreement if it determines that Business " +
        "Associate has materially breached this Agreement and the breach is not cured within thirty (30) days of " +
        "written notice.",
      "On termination, Business Associate will return or destroy all PHI it holds, including PHI held by its " +
        "subcontractors, and will retain no copies. Where return or destruction is not feasible, Business Associate " +
        "will extend the protections of this Agreement to that information and limit further uses and disclosures to " +
        "the purposes that make return or destruction infeasible, for as long as it retains the information.",
    ],
  },
  {
    heading: "9. Miscellaneous",
    body: [
      "This Agreement is governed by the laws of the State of Kansas. A reference to a section of the HIPAA Rules " +
        "means that section as in effect or as amended. The parties agree to take such action as is necessary to " +
        "amend this Agreement from time to time to comply with the requirements of the HIPAA Rules.",
    ],
  },
];

/**
 * The Notice of Privacy Practices itself.
 *
 * Not the acknowledgement above — that is the patient's signature saying they were given this, and
 * the two get confused because their names are nearly the same. The pharmacy had the
 * acknowledgement and no Notice, which is a signature for a document that does not exist.
 *
 * 45 CFR 164.520(b)(1) sets out what a notice must contain, and it is a list rather than a style:
 * the header in the exact words the rule prescribes, how protected health information is used and
 * disclosed for treatment, payment and operations, the other uses the law permits without
 * authorisation, that anything else needs written authorisation and may be revoked, each of the
 * individual's rights, the pharmacy's own duties, how to complain both to the pharmacy and to the
 * Secretary, that complaining carries no retaliation, a contact, and an effective date.
 *
 * Written to be handed to a patient at a counter, so short sentences and no defined terms the
 * reader has to hold in their head. It is a starting document and says so: the pharmacy's lawyer
 * or its PSAO should read it before it goes on the wall, because a notice is a promise about what
 * the pharmacy does with people's records and this one was written without being told.
 */
export function noticeOfPrivacyPractices(p: {
  pharmacy: string;
  address: string | null;
  phone: string | null;
  privacyOfficer: string | null;
  effectiveOn: string;
}): { heading: string; sections: { title: string; paragraphs: string[] }[] } {
  const us = p.pharmacy;
  const contact = [p.privacyOfficer, p.phone].filter(Boolean).join(", ") || "the pharmacist-in-charge";

  return {
    heading:
      "THIS NOTICE DESCRIBES HOW MEDICAL INFORMATION ABOUT YOU MAY BE USED AND DISCLOSED AND HOW YOU CAN GET ACCESS " +
      "TO THIS INFORMATION. PLEASE REVIEW IT CAREFULLY.",
    sections: [
      {
        title: "Who this notice covers",
        paragraphs: [
          `${us} keeps a record of the prescriptions we fill for you, the immunizations we give you, and the advice we give you about your medicines. This notice explains what we do with that record and what you can ask us to do with it.`,
          `We are required by law to keep your health information private, to give you this notice, and to follow the terms of the notice that is currently in effect.`,
        ],
      },
      {
        title: "How we use and share your information without asking you first",
        paragraphs: [
          `For your treatment. We use your record to fill your prescriptions safely — to check for interactions, to contact your prescriber with a question, and to give another pharmacy or a hospital your medication history when they are treating you.`,
          `To be paid. We send your prescription details to your insurance plan, to a pharmacy benefit manager, or to whoever else is paying, so that the prescription is covered and we are paid for it.`,
          `To run the pharmacy. We use your record to check our own work, to review a dispensing error under our quality improvement programme, to train our staff, and to meet the requirements of the Kansas Board of Pharmacy and the Drug Enforcement Administration.`,
          `The law also allows or requires us to share information in particular situations without your permission: to report a suspected reaction to a medicine, to report controlled substance dispensing to the Kansas prescription monitoring programme (K-TRACS), to public health authorities including an immunization registry, to health oversight agencies, in response to a court order or a lawful subpoena, to law enforcement in the narrow circumstances the law describes, to a coroner or funeral director, and where necessary to prevent a serious threat to somebody's health or safety.`,
        ],
      },
      {
        title: "When we will ask your permission first",
        paragraphs: [
          `Anything not described above needs your written authorisation. That includes any use of your information for marketing, and any sale of your information. We do not sell your information.`,
          `You can take back an authorisation at any time, in writing. That stops any further use from the day we receive it; it cannot undo what we had already done while it was in force.`,
          `If someone else — a family member, a carer, a neighbour — collects your prescriptions, we may give them what they need to do that, unless you tell us not to.`,
        ],
      },
      {
        title: "Your rights",
        paragraphs: [
          `You can see your record and get a copy of it. Ask us and we will give it to you within thirty days. We may charge a reasonable cost-based fee for copying.`,
          `You can ask us to correct your record if you think it is wrong or incomplete. If we do not agree, we will tell you why in writing and you can add a statement of your own to the record.`,
          `You can ask for a list of the times we have disclosed your information, other than for treatment, payment or running the pharmacy, going back six years.`,
          `You can ask us to limit what we use or share. We do not have to agree, with one exception we must honour: if you pay for a prescription in full yourself, you can tell us not to send it to your health plan, and we will not.`,
          `You can ask us to contact you a particular way, or at a particular address, and we will accommodate any reasonable request.`,
          `You can ask for a paper copy of this notice at any time, even if you agreed to receive it electronically.`,
          `You can name someone to act for you — a person with medical power of attorney, or a legal guardian — and we will treat them as we would treat you, once we have seen the paperwork.`,
        ],
      },
      {
        title: "Our duties",
        paragraphs: [
          `We must keep your health information private, and we must tell you promptly if a breach happens that compromises it.`,
          `We must follow the terms of the notice currently in effect. We can change this notice, and a change applies to information we already hold as well as to information we receive afterwards. The current notice is displayed in the pharmacy and a copy is available on request.`,
        ],
      },
      {
        title: "If you think your privacy has not been respected",
        paragraphs: [
          `Tell us. Contact ${contact}${p.address ? ` at ${p.address}` : ""}. We would rather hear it from you than not hear it.`,
          `You can also complain to the Secretary of the U.S. Department of Health and Human Services, Office for Civil Rights, 200 Independence Avenue SW, Washington DC 20201, by telephone on 1-877-696-6775, or at www.hhs.gov/ocr/privacy/hipaa/complaints.`,
          `You will not be penalised, refused service, or treated any differently for making a complaint.`,
        ],
      },
      {
        title: "Effective date",
        paragraphs: [`This notice takes effect on ${p.effectiveOn} and remains in effect until we replace it.`],
      },
    ],
  };
}
