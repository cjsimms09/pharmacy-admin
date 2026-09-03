import type { TrainingType } from "@/db/schema";

/**
 * The training itself, written out.
 *
 * Until now the site could record that somebody had done their annual training and could email
 * them a link to somebody else's website. Both of those depend on a course existing somewhere
 * else, and the free ones move, expire or quietly turn into a sales page. A pharmacy that cannot
 * produce the material its staff were trained on has training records rather than training.
 *
 * So the material lives here, in the repository, versioned with the rest of the site, and is
 * read on the same page the person signs. Three consequences worth stating:
 *
 *   It is in-house training, and that is a legitimate thing to be. HIPAA requires training on
 *   the covered entity's own policies and procedures — 45 CFR 164.530(b)(1) — and names no
 *   accreditor. OSHA requires the content at 1910.1030(g)(2)(vii) and 1910.1200(h) and names no
 *   accreditor either. Nothing here is CE and nothing here claims to be.
 *
 *   Bloodborne pathogens training additionally requires an opportunity for interactive questions
 *   and answers with a person knowledgeable in the subject. A web page cannot be that person, so
 *   the page names the pharmacist-in-charge and the attestation records that the opportunity was
 *   given. Leaving that out would be the difference between training that satisfies the standard
 *   and training that merely looks like it does.
 *
 *   A Part D plan or PSAO may insist on its own FWA module. Where it does, that module is the
 *   one to use and this becomes the general compliance training that sits alongside it. The
 *   course says so rather than letting a pharmacy assume it is covered.
 *
 * Each course ends with questions that have to be answered correctly. A record that says someone
 * read a page is weaker than one that says they demonstrated they understood it, and the extra
 * cost to the person is about ninety seconds.
 */

export type Section = { heading: string; body: string[] };

export type Question = {
  q: string;
  options: string[];
  /** Index into options. */
  answer: number;
  /** Shown when they get it wrong, because the wrong answer is the teachable moment. */
  why: string;
};

export type Course = {
  type: TrainingType;
  title: string;
  /** Honest estimate of reading time, so nobody is told fifteen minutes and given ninety seconds. */
  minutes: number;
  /** The rule this exists to satisfy, in one line, for the certificate and for the sceptic. */
  authority: string;
  intro: string;
  sections: Section[];
  questions: Question[];
  /** Set where the standard requires something a web page cannot provide on its own. */
  liveQuestionsRequired?: boolean;
};

export const COURSES: Partial<Record<TrainingType, Course>> = {
  // ────────────────────────────────────────────────────────────────
  hipaa_privacy_security: {
    type: "hipaa_privacy_security",
    title: "HIPAA privacy and security",
    minutes: 15,
    authority:
      "45 CFR 164.530(b)(1) — workforce training on the covered entity's privacy policies and procedures; " +
      "45 CFR 164.308(a)(5) — security awareness training.",
    intro:
      "This is training on how this pharmacy handles patient information. It is not a general lecture on privacy — " +
      "everything in it describes what you are expected to do here, at this counter, on these computers.",
    sections: [
      {
        heading: "What counts as protected health information",
        body: [
          "Protected health information — PHI — is any information that identifies a patient and relates to their health, their care, or payment for their care. In a pharmacy that is almost everything you touch.",
          "Names, addresses, dates of birth, phone numbers, prescription numbers, drug names, diagnoses, insurance and Medicaid numbers, and the labels on the bags in the will-call bin are all PHI. So is a signature log, a delivery list, and a fax cover sheet.",
          "The single most commonly missed one: the fact that a person is a patient here at all is itself protected. Confirming that someone has a prescription waiting — to a spouse, a parent of an adult child, a police officer without a warrant, or a neighbour who is 'just picking it up' — is a disclosure, whether or not you say what the drug is.",
        ],
      },
      {
        heading: "Minimum necessary",
        body: [
          "Use or share the least information needed to do the job in front of you. This applies inside the pharmacy as much as outside it.",
          "In practice: do not look up a record you have no business reason to look at. Not a family member's, not a neighbour's, not a celebrity's, not your own — curiosity is the most common cause of a HIPAA firing in retail pharmacy, and every lookup is logged.",
          "The minimum necessary rule does not apply to disclosures to the prescriber for treatment, to the patient themselves, or where the patient has authorized it.",
        ],
      },
      {
        heading: "When you may share without asking",
        body: [
          "Treatment, payment and health care operations. Calling a prescriber about a therapy question, billing a plan, and a partner pharmacy transferring a prescription are all permitted without an authorization.",
          "Nearly everything else needs the patient's written authorization: marketing, selling information, and most requests from employers or attorneys.",
          "A person picking up on the patient's behalf may be given the prescription if, in your professional judgement, the patient would not object. That is a judgement, not a formality — if something feels wrong about it, it is reasonable to ask.",
          "Law enforcement requests are not automatic. Take the officer's details, do not hand over records on the spot, and get the pharmacist-in-charge. A subpoena, warrant or court order is handled by the PIC.",
        ],
      },
      {
        heading: "Talking about patients",
        body: [
          "Counsel where you cannot be overheard from the line. Lower your voice at the register. Do not discuss a patient in the aisle, the break room, the parking lot, or anywhere a third party is standing.",
          "On the phone, confirm who you are speaking to before you say anything identifying. Leaving a voicemail: name the pharmacy and ask for a call back. Do not name the drug.",
          "Never post about a patient, a prescription, or anything that happened at the counter on social media — not anonymously, not in a private group, not 'without any names'. Details a stranger cannot identify are routinely identifiable to the patient's own family, and this is how most pharmacy privacy cases start.",
        ],
      },
      {
        heading: "Keeping information secure",
        body: [
          "Your login is yours. Do not share a password and do not work under somebody else's login — a record of who did what is worthless if two people use one account, and that record is what protects you when something is questioned.",
          "Lock the screen when you step away. A workstation showing a patient profile, facing the counter, unattended, is a disclosure waiting to happen.",
          "Check the number before you send a fax and use the pharmacy's cover sheet. A misdirected fax is a reportable breach and is entirely avoidable.",
          "Do not email PHI to an outside address unless the pharmacist-in-charge has told you that route is set up to be secure. Do not put PHI in a text message.",
          "Paper with PHI on it goes in the shred bin, never the trash. That includes labels, rejected claims printouts, sticky notes with a patient's name, and returned-to-stock labels.",
          "Do not take photographs of prescriptions, screens or labels on a personal phone.",
        ],
      },
      {
        heading: "What patients are entitled to",
        body: [
          "Patients may see and get a copy of their own records, ask for a correction, ask for an accounting of certain disclosures, ask us to communicate with them a particular way, and ask for a restriction on sharing.",
          "There is one restriction we must honour: if a patient pays in full out of pocket and asks us not to tell their health plan, we have to comply — 45 CFR 164.522(a)(1)(vi).",
          "The Notice of Privacy Practices is displayed in the pharmacy and given to patients. If someone asks for it, give them one; if you cannot find one, tell the pharmacist-in-charge.",
        ],
      },
      {
        heading: "When something goes wrong",
        body: [
          "A breach is any acquisition, access, use or disclosure not permitted by the rules — the wrong bag handed to the wrong person, a prescription faxed to the wrong number, an email sent to the wrong patient, a laptop or phone lost, paperwork left on the counter.",
          "Report it to the pharmacist-in-charge immediately. Not at the end of the shift, not tomorrow. The pharmacy has a legal deadline that starts running from discovery, and the assessment of whether it is reportable is not yours to make alone.",
          "Reporting a breach — including one you caused — is what you are supposed to do, and this pharmacy does not retaliate for it. Concealing one is a far more serious matter than causing one.",
          "These obligations continue after your employment here ends.",
        ],
      },
    ],
    questions: [
      {
        q: "A patient's adult son comes in and asks whether his mother's prescription is ready. What may you tell him?",
        options: [
          "Confirm it is ready, since he is family",
          "Nothing about whether she is a patient here unless you can reasonably judge she would not object to him collecting it",
          "Confirm it is ready but not what the drug is",
          "Anything, as long as he shows ID",
        ],
        answer: 1,
        why: "The fact that someone is a patient here is itself protected. A person collecting on a patient's behalf may be given the prescription where your professional judgement is that the patient would not object — being a relative does not by itself settle that.",
      },
      {
        q: "You are curious about a prescription for someone you know socially. What does the minimum necessary rule mean here?",
        options: [
          "Looking is fine as long as you do not tell anyone",
          "Looking is fine because you work here and have access",
          "Do not open the record — you have no business reason, and every lookup is logged",
          "Ask a colleague to look it up instead",
        ],
        answer: 2,
        why: "Access is not permission. Looking at a record without a business reason is the most common cause of a privacy firing in retail pharmacy, and the audit log shows who opened what.",
      },
      {
        q: "You realise a prescription was faxed to the wrong number. What do you do?",
        options: [
          "Nothing, if the number looks like a business",
          "Tell the pharmacist-in-charge immediately",
          "Wait to see whether anyone calls about it",
          "Note it and mention it at the end of the week",
        ],
        answer: 1,
        why: "A misdirected fax is a potential breach and the pharmacy's legal clock starts from discovery. It is reported immediately, and reporting is not held against you.",
      },
      {
        q: "A patient pays cash in full and asks that their plan not be told about the prescription. What is the pharmacy's obligation?",
        options: [
          "We may agree but do not have to",
          "We must comply — a restriction on disclosure to a plan for a service paid in full out of pocket has to be honoured",
          "We must still submit the claim",
          "Only the pharmacist may agree to it",
        ],
        answer: 1,
        why: "45 CFR 164.522(a)(1)(vi) makes that one restriction mandatory. Most requested restrictions are optional; this one is not.",
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  fwa_general_compliance: {
    type: "fwa_general_compliance",
    title: "Fraud, waste and abuse, and general compliance",
    minutes: 15,
    authority:
      "42 CFR 422.503(b)(4)(vi) and 423.504(b)(4)(vi) — compliance and FWA training for entities providing " +
      "benefits to Medicare enrollees. Note: a Part D plan or PSAO may require its own FWA module in addition.",
    intro:
      "This covers what fraud, waste and abuse look like in a pharmacy, the laws behind them, and exactly how to " +
      "raise something you are worried about. If a plan or PSAO also sends you their own FWA module, do that one " +
      "as well — it does not replace this and this does not replace it.",
    sections: [
      {
        heading: "The three words, and the difference between them",
        body: [
          "Fraud is knowingly submitting, or causing to be submitted, a false claim to get a payment you are not entitled to. It requires intent.",
          "Waste is overuse or careless use of resources that costs the programme money without intent to deceive — auto-refilling medication the patient never collects, or dispensing quantities nobody needs.",
          "Abuse sits between them: practices inconsistent with sound fiscal or professional standards that result in unnecessary cost, without the intent that makes it fraud.",
          "You do not have to decide which one you are looking at before reporting it. That is the compliance officer's job.",
        ],
      },
      {
        heading: "What it looks like at this counter",
        body: [
          "Billing for a prescription that was never picked up and not reversing it after the return-to-stock period.",
          "Billing a brand and dispensing a generic, or billing a quantity larger than what went in the bottle.",
          "Refilling automatically without the patient asking, and billing for it.",
          "Entering a DAW code that is not true, or a days supply chosen to make a claim pay rather than to describe the prescription.",
          "Splitting a prescription into multiple fills to collect multiple dispensing fees.",
          "Waiving copays routinely as an inducement, or offering gifts to bring prescriptions in. A one-off waiver for genuine financial hardship, documented, is a different thing.",
          "Accepting anything of value in return for referrals — that is the Anti-Kickback Statute, and it runs in both directions.",
          "Forged or altered prescriptions, and prescriptions from a prescriber you have reason to believe is not treating the patient.",
        ],
      },
      {
        heading: "The laws behind it",
        body: [
          "The False Claims Act (31 USC 3729) covers knowingly submitting a false claim. Penalties are per claim and include treble damages. 'Knowingly' includes deliberate ignorance and reckless disregard — not knowing because you did not want to know is not a defence.",
          "The reverse false claim matters here more than most people expect: keeping an overpayment you know about is itself a violation. Identified overpayments have to be reported and returned within 60 days.",
          "The Anti-Kickback Statute (42 USC 1320a-7b(b)) is criminal, and both sides of the arrangement commit the offence.",
          "Civil monetary penalties apply to inducements offered to beneficiaries.",
          "Exclusion: a person on the OIG exclusion list may not work in any capacity for an entity that bills federal health care programmes. This pharmacy checks the list, which is why nobody is hired or kept on without that check.",
        ],
      },
      {
        heading: "Getting the claim right",
        body: [
          "Most FWA findings in a small pharmacy are not schemes; they are claims that do not match the paperwork. An audit compares the claim against the hard copy, so the two have to agree.",
          "Days supply must reflect the directions. Quantity must reflect what was dispensed. The prescriber on the claim must be the prescriber who wrote it. Origin code must reflect how the prescription actually arrived.",
          "If a claim was submitted and the prescription is returned to stock, the claim gets reversed. That is the single most common recoupment in an audit and it is entirely within our control.",
        ],
      },
      {
        heading: "Reporting, and what happens to you if you do",
        body: [
          "Raise it with the pharmacist-in-charge. If the concern is about the pharmacist-in-charge, or you would rather not raise it here, you may report directly to the plan, to the Medicare Drug Integrity Contractor, or to the OIG hotline at 1-800-HHS-TIPS.",
          "You may report anonymously.",
          "Retaliation against someone who reports a concern in good faith is prohibited by law and by this pharmacy. Being wrong about a concern raised in good faith is not a disciplinary matter — staying quiet about one is.",
          "You are not expected to investigate. Report what you saw.",
        ],
      },
      {
        heading: "What a compliance programme is made of",
        body: [
          "Written standards and procedures. A compliance officer — here, the pharmacist-in-charge. Training, which is what this is. A way to raise concerns without fear. Monitoring and auditing. Enforcement through consistent discipline. And prompt correction of anything found.",
          "The last one is the part that gets pharmacies into trouble: finding a problem and not fixing it is worse than not having looked, because now it is knowing.",
        ],
      },
    ],
    questions: [
      {
        q: "A prescription was billed, never collected, and has been returned to stock. What has to happen?",
        options: [
          "Nothing — the plan will work it out",
          "The claim is reversed",
          "Bill it again when they come back",
          "Note it and reverse it at month end",
        ],
        answer: 1,
        why: "An unreversed claim for a prescription that went back on the shelf is a false claim, and it is the single most common recoupment in a pharmacy audit.",
      },
      {
        q: "You realise the pharmacy has been overpaid on a set of claims. What is the obligation?",
        options: [
          "Keep it unless the plan asks",
          "Report and return the overpayment — knowingly keeping it is itself a False Claims Act violation, with a 60-day clock",
          "Offset it against future underpayments",
          "Wait for the annual audit",
        ],
        answer: 1,
        why: "This is the reverse false claim. Once an overpayment is identified it must be reported and returned within 60 days; keeping it is a violation in its own right.",
      },
      {
        q: "You have a concern about something a colleague is doing but you are not certain it is wrong. What should you do?",
        options: [
          "Investigate until you are certain, then report",
          "Say nothing unless you are sure",
          "Report what you saw — you are not expected to investigate, and good-faith reports cannot be retaliated against",
          "Discuss it with the other staff first",
        ],
        answer: 2,
        why: "Reporting is the duty; investigating is not. Retaliation for a good-faith report is prohibited by law, and being wrong in good faith is not a disciplinary matter.",
      },
      {
        q: "Why does this pharmacy check the OIG exclusion list?",
        options: [
          "It is a licensing requirement in Kansas",
          "Because a person on the exclusion list may not work in any capacity for an entity that bills federal health care programmes",
          "To verify professional credentials",
          "It is optional but good practice",
        ],
        answer: 1,
        why: "Employing an excluded person exposes the pharmacy to civil monetary penalties for every claim submitted while they were employed, in any role.",
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  osha_bloodborne: {
    type: "osha_bloodborne",
    title: "Bloodborne pathogens",
    minutes: 12,
    authority: "29 CFR 1910.1030(g)(2) — annual bloodborne pathogens training, with the exposure control plan available.",
    liveQuestionsRequired: true,
    intro:
      "This pharmacy administers vaccines and handles sharps, so there is reasonably anticipated exposure to blood " +
      "and other potentially infectious material. This training is required annually and within a year of the last one.",
    sections: [
      {
        heading: "What you could be exposed to, and how",
        body: [
          "Hepatitis B, hepatitis C and HIV are the three the standard is written around. Hepatitis B survives on surfaces for up to a week and is the most transmissible of the three.",
          "In this pharmacy the realistic routes are a needlestick while immunizing, contact with blood at the injection site, a sharps container that has been overfilled or handled carelessly, and cleaning up after a patient who has fainted or bled.",
        ],
      },
      {
        heading: "Universal precautions",
        body: [
          "Treat all human blood and body fluids as if they are infectious. There is no version of this where you decide a particular patient is low risk — that judgement is not reliable and is not permitted.",
        ],
      },
      {
        heading: "Controls, in the order they matter",
        body: [
          "Engineering controls first: safety-engineered needles with the sheath or retraction actually used, and a puncture-resistant, labelled sharps container within arm's reach of where you inject.",
          "Never recap a needle. Never bend, break or remove a needle by hand. Activate the safety device immediately and drop the whole unit in the container.",
          "Sharps containers are replaced at the fill line, not when they will not take any more. Overfilled containers are how needlesticks happen to the person changing them.",
          "Work practice: wash hands immediately after removing gloves and after any contact. Do not eat, drink, apply cosmetics or handle contact lenses in the immunization area.",
          "Personal protective equipment: gloves for any contact with blood, and they are provided at no cost to you. Change them between patients.",
        ],
      },
      {
        heading: "Hepatitis B vaccination",
        body: [
          "The pharmacy offers the hepatitis B vaccine series free of charge to everyone with occupational exposure, within ten working days of taking on those duties.",
          "You may decline. If you do, you sign the declination form the standard requires, and you may change your mind and have the series at any later time, still free of charge.",
        ],
      },
      {
        heading: "If you are exposed",
        body: [
          "Wash the area with soap and water immediately. Flush a splash to the eyes or mouth with water.",
          "Report it to the pharmacist-in-charge at once — before the end of the shift, not at the end of the week. Post-exposure prophylaxis is time-critical and for HIV is most effective within hours.",
          "The pharmacy arranges a confidential medical evaluation at no cost to you, including testing of the source individual where the law allows and follow-up testing and counselling.",
          "The incident is recorded in the sharps injury log and in your confidential medical record, which is kept for the duration of your employment plus thirty years.",
        ],
      },
      {
        heading: "Labels, spills and the plan",
        body: [
          "Biohazard labels are orange-red with the biohazard symbol and go on sharps containers and any container of regulated waste.",
          "For a blood spill: gloves on, absorb, clean, then disinfect with an EPA-registered disinfectant effective against HBV and HIV, or freshly diluted bleach. Pick up broken glass with tongs or a brush and dustpan — never with your hands, gloved or not.",
          "The written exposure control plan is kept in the pharmacy and you may read it at any time. Ask the pharmacist-in-charge and it will be handed to you.",
        ],
      },
    ],
    questions: [
      {
        q: "You have just given a vaccine. What happens to the needle?",
        options: [
          "Recap it carefully using one hand, then bin it",
          "Activate the safety device and put the whole unit straight into the sharps container without recapping",
          "Remove the needle from the syringe and bin them separately",
          "Bend it so it cannot be reused",
        ],
        answer: 1,
        why: "Recapping, bending, breaking and removing needles by hand are all prohibited. The safety device is activated immediately and the whole unit goes into the container.",
      },
      {
        q: "A colleague sustains a needlestick. When must it be reported?",
        options: [
          "Immediately",
          "By the end of the shift",
          "Within 24 hours",
          "At the next staff meeting",
        ],
        answer: 0,
        why: "Post-exposure prophylaxis is time-critical — for HIV it is most effective within hours. Immediately means immediately.",
      },
      {
        q: "Who pays for the hepatitis B vaccine series and any post-exposure evaluation?",
        options: [
          "The employee, through insurance",
          "The employer, at no cost to the employee",
          "It is split",
          "The employee, who is then reimbursed",
        ],
        answer: 1,
        why: "The standard requires both to be provided at no cost to the employee, at a reasonable time and place.",
      },
      {
        q: "What do universal precautions mean in practice?",
        options: [
          "Take extra care with patients known to be high risk",
          "Treat all human blood and body fluids as if they are infectious",
          "Wear gloves whenever you feel it is warranted",
          "Ask about infection status before immunizing",
        ],
        answer: 1,
        why: "The whole point is that risk cannot be judged from the patient. Everything is treated as infectious.",
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  osha_hazard_communication: {
    type: "osha_hazard_communication",
    title: "Hazard communication",
    minutes: 8,
    authority: "29 CFR 1910.1200(h) — information and training on hazardous chemicals in the work area.",
    intro:
      "There are hazardous chemicals in this pharmacy. Not many, and none exotic, but the standard applies and the " +
      "two things it really asks of you are that you can read a label and can find a safety data sheet.",
    sections: [
      {
        heading: "What is here",
        body: [
          "Cleaning and disinfecting products, isopropyl alcohol, bleach, hand sanitiser in bulk, printer and copier toners, and compressed gases if any are kept.",
          "Hazardous drugs are handled under their own procedures. If this pharmacy handles any drug on the NIOSH hazardous drug list, the pharmacist-in-charge will tell you which and what is required — do not assume from the label alone.",
        ],
      },
      {
        heading: "Reading a label",
        body: [
          "Every shipped container carries a product identifier, a signal word — 'Danger' is more severe than 'Warning' — hazard statements, precautionary statements, pictograms, and the supplier's details.",
          "The pictograms worth knowing here: the flame for flammables, the corrosion symbol for things that burn skin or eyes, the exclamation mark for irritants, and the health hazard symbol for longer-term effects.",
          "If you pour a chemical into another container and it will not be used up by you on that shift, label it. An unlabelled spray bottle is the classic hazard communication finding and it is thirty seconds to prevent.",
        ],
      },
      {
        heading: "Safety data sheets",
        body: [
          "There is a safety data sheet for every hazardous chemical kept here, and you are entitled to see any of them at any time.",
          "They are in a known place in this pharmacy. If you do not know where, ask now rather than during an incident. Section 4 is first aid and section 8 is the protection required — those are the two you will want in a hurry.",
        ],
      },
      {
        heading: "If something spills or splashes",
        body: [
          "Small, familiar and safe to handle: gloves on, clean up, ventilate.",
          "Anything else — an unknown chemical, a large volume, fumes, or any splash to eyes or skin — get away from it, tell the pharmacist-in-charge, flush the affected area with water for fifteen minutes, and follow the safety data sheet.",
          "Report every exposure, however minor it seems.",
        ],
      },
    ],
    questions: [
      {
        q: "You decant a cleaning chemical into a spray bottle you will keep behind the counter. What is required?",
        options: [
          "Nothing, it stays in the pharmacy",
          "Label it with the product identifier and its hazards",
          "Only label it if it is corrosive",
          "Write the date on it",
        ],
        answer: 1,
        why: "A secondary container that outlives the shift and the person who filled it has to be labelled. An unlabelled spray bottle is the standard finding.",
      },
      {
        q: "Which signal word indicates the more severe hazard?",
        options: ["Warning", "Caution", "Danger", "Notice"],
        answer: 2,
        why: "Under GHS there are two signal words: Danger for the more severe hazards and Warning for the less severe.",
      },
      {
        q: "Where do you find the first aid measures for a chemical kept here?",
        options: [
          "Section 4 of its safety data sheet",
          "On the shipping carton",
          "From the manufacturer's website only",
          "There is no standard place",
        ],
        answer: 0,
        why: "Safety data sheets have sixteen standard sections. Section 4 is first aid and section 8 is exposure controls and personal protection.",
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  controlled_substance_diversion: {
    type: "controlled_substance_diversion",
    title: "Controlled substance diversion awareness",
    minutes: 10,
    authority:
      "Not a standalone Kansas or federal training mandate. It is the first thing asked about after a loss, and " +
      "21 CFR 1301.71 requires effective controls against diversion — which means the people at the counter knowing what to look for.",
    intro:
      "Diversion in a pharmacy is usually not dramatic. It is small, patient, and done by someone trusted. This is " +
      "about noticing it early, in all three of the places it comes from.",
    sections: [
      {
        heading: "From inside",
        body: [
          "The signs are behavioural before they are numerical: volunteering for the count, resisting anyone else counting, wanting to work alone, coming in on days off, unexplained absences, being present for every waste, appearance or performance changes.",
          "And numerical: recurring short counts on one drug, one shift or one person; wastes that are always undocumented or always witnessed by the same person; returned-to-stock quantities that do not match; adjustments made after hours.",
          "Nobody wastes a controlled substance alone. Nobody counts a controlled substance alone. Those two rules exist to protect the honest person as much as to catch the dishonest one.",
        ],
      },
      {
        heading: "From prescribers",
        body: [
          "Prescriptions well outside a prescriber's specialty. The same drug, strength and quantity for every patient. Patients travelling long distances past other pharmacies. Cash payment for controlled substances when the patient has insurance. Numbers of controlled prescriptions from one prescriber that do not fit their practice.",
          "A pharmacist has a corresponding responsibility to ensure a controlled substance prescription is issued for a legitimate medical purpose — 21 CFR 1306.04. Filling one you have real doubts about is the pharmacist's liability, not the prescriber's alone.",
        ],
      },
      {
        heading: "From patients",
        body: [
          "Early refills, lost or stolen prescriptions repeatedly, multiple prescribers and pharmacies, altered quantities or refills on a paper prescription, forged prescriptions on stolen pads, pressure and urgency at the counter, and specifying a brand or an exact colour of tablet.",
          "K-TRACS is the check. Use it — that is what it is for.",
          "Aggression is a reason to step away and get the pharmacist, not a reason to fill something to end the conversation.",
        ],
      },
      {
        heading: "What to do",
        body: [
          "Tell the pharmacist-in-charge. That is the whole of your obligation — you are not asked to investigate, confront anyone, or be certain.",
          "If the concern is about the pharmacist-in-charge, contact the Kansas Board of Pharmacy directly.",
          "A significant loss or theft of controlled substances goes to the DEA on Form 106 and to the Board. That is the PIC's job, and it is a job that cannot start until somebody says something.",
          "Raising a concern in good faith about a colleague is not disloyalty. Diversion by a colleague usually ends in their overdose or their prosecution, and it is caught early by people who said something early.",
        ],
      },
    ],
    questions: [
      {
        q: "Which of these is the strongest early indicator of internal diversion?",
        options: [
          "A single short count on a busy day",
          "A pattern of short counts on one drug, tied to one person or shift, with wastes that are always undocumented",
          "A technician who works quickly",
          "A pharmacist who asks for a recount",
        ],
        answer: 1,
        why: "One discrepancy is an error. A pattern that follows a drug, a shift or a person is the thing to raise.",
      },
      {
        q: "A prescription for a controlled substance looks legitimate but something about the patient's story does not fit. What is the right step?",
        options: [
          "Fill it — the prescriber is responsible",
          "Refuse and say nothing further",
          "Raise it with the pharmacist and check K-TRACS before dispensing",
          "Fill it and note your concern afterwards",
        ],
        answer: 2,
        why: "The pharmacist has a corresponding responsibility under 21 CFR 1306.04. K-TRACS exists for exactly this, and the check happens before dispensing, not after.",
      },
      {
        q: "You suspect a colleague is diverting. What are you expected to do?",
        options: [
          "Gather evidence first so you are certain",
          "Speak to the colleague privately",
          "Tell the pharmacist-in-charge — you are not expected to investigate or be certain",
          "Wait to see whether it happens again",
        ],
        answer: 2,
        why: "Reporting is the duty; investigating is not, and confronting someone can destroy evidence and put you at risk.",
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────
  cqi_program_review: {
    type: "cqi_program_review",
    title: "The pharmacy's continuous quality improvement programme",
    minutes: 8,
    authority: "K.A.R. 68-19-1 — every Kansas pharmacy must have a continuous quality improvement programme.",
    intro:
      "Kansas requires this pharmacy to run a CQI programme, and requires everyone working here to understand it. " +
      "The short version: when something goes wrong, we write it down and fix the system, and nobody is punished " +
      "for reporting.",
    sections: [
      {
        heading: "What has to be reported",
        body: [
          "A quality-related event is any variation from the prescription as written or from accepted practice — whether or not it reached the patient, and whether or not anyone was harmed.",
          "That includes wrong drug, wrong strength, wrong quantity, wrong directions, wrong patient, a missed clinical issue such as an interaction or allergy, and a delay that mattered.",
          "It includes near misses caught at the final check. Those are the most valuable reports we get, because the system failed and the last defence held — and next time it might not.",
        ],
      },
      {
        heading: "How, and how quickly",
        body: [
          "Tell the pharmacist on duty as soon as you notice, and log it here the same day while you still remember the detail.",
          "Write what happened, not who to blame. 'The 5 mg and 50 mg bottles are next to each other and look alike' is useful. 'I was careless' is not — it gives us nothing to change.",
          "Under K.A.R. 68-19-1 a report is reviewed beginning within seven days and the review is completed within thirty. A summary is produced every two months, by the fifteenth of February, April, June, August, October and December, and the records are kept for five years. The site handles the timing; your part is the report.",
        ],
      },
      {
        heading: "Non-punitive means non-punitive",
        body: [
          "Reporting an error you made is not a disciplinary matter here. It is what is expected of you, and it is the only way the pharmacy finds out about the things that are about to go wrong for somebody else.",
          "The purpose is to change the system — the layout, the labelling, the workflow, the point at which a check happens — because systems are what produce errors and can be changed. Blaming a person changes nothing and buys silence.",
          "The one thing that is a serious matter is concealing an error.",
        ],
      },
    ],
    questions: [
      {
        q: "A wrong strength was caught at the final check and never left the pharmacy. Is it reported?",
        options: [
          "No — no harm, no report",
          "Yes — near misses are reported, and are among the most valuable reports",
          "Only if it happens again",
          "Only if the patient was waiting",
        ],
        answer: 1,
        why: "A near miss means the system failed and the last line of defence held. That is precisely what a CQI programme exists to learn from.",
      },
      {
        q: "What happens to you if you report an error you made yourself?",
        options: [
          "It is recorded against you",
          "Nothing — reporting is expected, and the programme is non-punitive. Concealing an error is the serious matter",
          "It depends whether the patient was harmed",
          "You are retrained",
        ],
        answer: 1,
        why: "A punitive programme produces silence and no data. Concealment, not error, is what is treated seriously.",
      },
      {
        q: "How soon must the review of a reported event begin under K.A.R. 68-19-1?",
        options: ["Within 24 hours", "Within seven days", "Within thirty days", "Before the next summary"],
        answer: 1,
        why: "Review begins within seven days and is completed within thirty; summaries are produced every two months.",
      },
    ],
  },
};

export function courseFor(type: TrainingType): Course | null {
  return COURSES[type] ?? null;
}

/** Total questions in a course, for wording like "4 of 4". */
export function questionCount(type: TrainingType): number {
  return COURSES[type]?.questions.length ?? 0;
}
