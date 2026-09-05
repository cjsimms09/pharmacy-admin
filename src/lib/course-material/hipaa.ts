import type { Course } from "./types";

/**
 * HIPAA privacy and security, for a retail pharmacy counter.
 *
 * Written against the pharmacy's own practice rather than the regulation's table of contents. The
 * test applied to every paragraph was whether somebody could act differently on Monday because
 * they read it. A summary of the Privacy Rule fails that test; "the fact that a person is a
 * patient here at all is itself protected" passes it.
 */
export const hipaa: Course = {
  type: "hipaa_privacy_security",
  title: "HIPAA privacy and security",
  authority:
    "45 CFR 164.530(b)(1) — workforce training on the covered entity's privacy policies and procedures; " +
    "45 CFR 164.308(a)(5) — security awareness and training.",
  intro:
    "This is training on how this pharmacy handles patient information. It is not a general lecture on privacy — " +
    "everything in it describes what you are expected to do here, at this counter, on these computers. Work " +
    "through it once properly. It is the single subject in this pharmacy where an honest mistake made in a hurry " +
    "can cost a patient their privacy, cost you your job, and cost the pharmacy a great deal of money.",
  objectives: [
    "Recognise protected health information in the forms it actually takes in a pharmacy, including the ones that do not look like records.",
    "Decide, at the counter, what may be said to whom — and know which situations stop and go to the pharmacist-in-charge.",
    "Apply the minimum necessary rule to your own access, and understand that every lookup is logged.",
    "Handle faxes, email, phones, screens and paper so that a disclosure does not happen by accident.",
    "Answer a patient who asks to see their record, correct it, be contacted differently, or keep a prescription from their plan.",
    "Recognise a breach and report it immediately, and know that reporting one is expected rather than punished.",
  ],
  seeAlso: [
    "Chapter: Patient privacy and HIPAA, in this pharmacy's policy and procedure manual.",
    "The pharmacy's Notice of Privacy Practices, on the site under Forms.",
  ],
  references: [
    "45 CFR Part 160 and Part 164 (the Privacy, Security and Breach Notification Rules).",
    "45 CFR 164.502, 164.506, 164.508, 164.510, 164.512 — permitted and required uses and disclosures.",
    "45 CFR 164.520, 164.522, 164.524, 164.526, 164.528 — the Notice, restrictions, and patients' rights.",
    "45 CFR 164.308, 164.310, 164.312 — the administrative, physical and technical safeguards.",
    "45 CFR 164.400–414 — breach notification.",
    "42 U.S.C. 1320d-5 and 1320d-6 — civil and criminal penalties.",
  ],
  sections: [
    {
      heading: "What this covers, and why it applies to you personally",
      body: [
        "This pharmacy is a covered entity under HIPAA. That means the Privacy Rule, the Security Rule and the Breach Notification Rule apply to everything done here with patient information — by the pharmacist, by technicians, by the delivery driver, by students, and by anyone who is on the schedule for a single afternoon.",
        "HIPAA sets a floor, not a ceiling. Where Kansas law, a plan contract, or this pharmacy's own policy is stricter, the stricter rule is the one you follow. Nothing in this training permits something the pharmacy's own manual forbids.",
        "The obligation is personal as well as institutional. Civil penalties fall on the pharmacy; the criminal provision at 42 U.S.C. 1320d-6 falls on the individual who knowingly obtains or discloses information, and rises to ten years where it was done for personal gain or to cause harm. People have gone to prison for looking up records they had no business opening.",
        "Two things follow from that. First, 'my manager told me to' is not a defence for an obviously improper disclosure. Second, if you are unsure, stopping to ask is always the right answer, and no one here will be annoyed with you for asking.",
      ],
      takeaways: [
        "HIPAA applies to everyone working here, on any shift, in any role.",
        "Where another rule is stricter, follow the stricter one.",
        "Penalties reach individuals, not only the business.",
      ],
    },
    {
      heading: "What counts as protected health information",
      body: [
        "Protected health information — PHI — is any information that identifies a patient and relates to their health, their care, or payment for their care. In a pharmacy that is almost everything you touch.",
        "Names, addresses, dates of birth, phone numbers, prescription numbers, drug names, diagnoses, insurance and Medicaid numbers, and the labels on the bags in the will-call bin are all PHI. So is a signature log, a delivery list, and a fax cover sheet.",
        "It is still PHI when it is spoken rather than written, and when it is on a screen rather than on paper. The rules cover information in any form: oral, paper, electronic, photographic.",
        "The single most commonly missed one: the fact that a person is a patient here at all is itself protected. Confirming that someone has a prescription waiting — to a spouse, a parent of an adult child, a police officer without a warrant, or a neighbour who is 'just picking it up' — is a disclosure, whether or not you say what the drug is.",
        "Information that has been properly de-identified is no longer PHI, but de-identification is a technical exercise done under 45 CFR 164.514, not something achieved by leaving the name off. A prescription with the name removed but the address, date of birth and drug still on it identifies the patient to anybody who knows them.",
      ],
      takeaways: [
        "Almost everything at this counter is PHI, in any form, including speech.",
        "That a person is a patient here is itself protected.",
        "Crossing off the name does not de-identify anything.",
      ],
    },
    {
      heading: "Minimum necessary",
      body: [
        "Use or share the least information needed to do the job in front of you. This applies inside the pharmacy as much as outside it.",
        "In practice: do not look up a record you have no business reason to look at. Not a family member's, not a neighbour's, not a celebrity's, not your own — curiosity is the most common cause of a HIPAA firing in retail pharmacy, and every lookup is logged with your user name and the time.",
        "Access being technically available to you is not permission. The dispensing system gives you the ability to open any profile because it cannot know in advance which patient will walk in; deciding which ones you have a reason to open is your job, not the software's.",
        "Looking up your own record is still a lookup without a business reason. Ask for a copy the way any patient would; that request is free and takes a minute.",
        "The minimum necessary rule does not apply to disclosures to the prescriber for treatment, to the patient themselves, to HHS for an investigation, where the patient has authorized it, or where a disclosure is required by law.",
      ],
      takeaways: [
        "Access is not permission. Have a business reason before you open a profile.",
        "Every lookup is logged against your name.",
        "Minimum necessary does not restrict treatment disclosures or the patient's own copy.",
      ],
    },
    {
      heading: "When you may share without asking",
      body: [
        "Treatment, payment and health care operations. Calling a prescriber about a therapy question, billing a plan, and a partner pharmacy transferring a prescription are all permitted without an authorization — 45 CFR 164.506.",
        "A person picking up on the patient's behalf may be given the prescription if, in your professional judgement, the patient would not object — 45 CFR 164.510(b). That is a judgement, not a formality. If something feels wrong about it, it is reasonable to ask, and it is reasonable to say the patient will need to collect it themselves.",
        "A personal representative — a parent of a minor, a guardian, an agent under a healthcare power of attorney, an executor — stands in the patient's shoes and is treated as the patient. Ask for the document where you have not seen it before, and get the pharmacist-in-charge if it is not clear-cut. A parent is not automatically the personal representative of a minor for every prescription; Kansas allows minors to consent to some care on their own, and where the minor consented, the parent may not be entitled to the record.",
        "Public health reporting, reporting suspected abuse or neglect, reporting an adverse event to the FDA, and reporting to an immunization registry are permitted disclosures under 45 CFR 164.512. Submitting dispensing data to K-TRACS is required by Kansas law, and the data in K-TRACS is itself confidential — a K-TRACS lookup is subject to the same 'business reason' test as any other.",
        "Law enforcement requests are not automatic and are the most common place a pharmacy gets this wrong. Take the officer's name, agency and contact details, do not hand over records or confirm anything on the spot, and get the pharmacist-in-charge. A subpoena, warrant, court order or DEA administrative subpoena is handled by the PIC, not at the counter. Being polite and being compliant are the same thing here: 'I'll get the pharmacist for you' is the complete answer.",
        "In an emergency — a patient unconscious, a poison control call, a prescriber needing history to treat someone right now — treatment disclosures are permitted. Do not let a privacy rule stop care.",
      ],
      takeaways: [
        "Treatment, payment and operations need no authorization.",
        "Personal representative: check the document, and check whether the minor consented themselves.",
        "Law enforcement: take their details, disclose nothing, get the PIC.",
      ],
    },
    {
      heading: "When written authorization is required",
      body: [
        "Nearly everything outside treatment, payment and operations needs the patient's written authorization under 45 CFR 164.508: marketing, the sale of information, most requests from employers, most requests from attorneys, and disclosures to a life insurer.",
        "Psychotherapy notes need an authorization in almost every case. A pharmacy rarely holds them, but a request that arrives asking for 'the complete file' may sweep them in, which is one reason those requests go to the pharmacist-in-charge.",
        "An authorization has to be specific: who is disclosing, who is receiving, what information, for what purpose, and an expiry. A signed blank form is not an authorization. A patient may revoke one in writing at any time.",
        "Refill reminders and communications about a drug the patient is already taking are not marketing, provided any payment received is reasonably related to the cost of making them. Anything that looks like the pharmacy being paid to promote a product goes to the pharmacist-in-charge before it goes to a patient.",
      ],
      takeaways: [
        "Outside treatment, payment and operations, get a written authorization.",
        "An authorization names the parties, the information, the purpose and an expiry.",
        "Anything resembling paid promotion stops with the PIC.",
      ],
    },
    {
      heading: "Talking about patients",
      body: [
        "Counsel where you cannot be overheard from the line. Lower your voice at the register. Do not discuss a patient in the aisle, the break room, the parking lot, or anywhere a third party is standing.",
        "Incidental disclosure — a person in line hearing a name called — is tolerated by the rule where reasonable safeguards are in place. That tolerance runs out quickly. Calling out a drug name, or discussing a patient's condition at volume, is not incidental.",
        "On the phone, confirm who you are speaking to before you say anything identifying. Leaving a voicemail: name the pharmacy and ask for a call back. Do not name the drug.",
        "Never post about a patient, a prescription, or anything that happened at the counter on social media — not anonymously, not in a private group, not 'without any names'. Details a stranger cannot identify are routinely identifiable to the patient's own family, and this is how most pharmacy privacy cases start.",
        "This applies to the funny story as much as the angry one. It applies to a photograph of the counter with a label visible in the corner. It applies to a group chat with people who also work in healthcare.",
        "These obligations do not end when your shift does, and they do not end when your employment here does.",
      ],
      takeaways: [
        "Confirm who you are speaking to before saying anything identifying.",
        "Voicemail: pharmacy name and a call-back, never the drug.",
        "Nothing about work goes on social media, in any form, ever.",
      ],
    },
    {
      heading: "Keeping information secure",
      body: [
        "Your login is yours. Do not share a password and do not work under somebody else's login — a record of who did what is worthless if two people use one account, and that record is what protects you when something is questioned.",
        "Lock the screen when you step away. A workstation showing a patient profile, facing the counter, unattended, is a disclosure waiting to happen. On Windows this is the Windows key and L, and it takes less than a second.",
        "Position screens so they cannot be read from the customer side. Turn a monitor rather than trusting the angle.",
        "Do not email PHI to an outside address unless the pharmacist-in-charge has told you that route is set up to be secure. Do not put PHI in a text message. Do not use a personal email account for anything to do with work.",
        "Do not take photographs of prescriptions, screens or labels on a personal phone, including to send to a prescriber or to another pharmacy. Use the pharmacy's own fax or system.",
        "Do not plug a personal USB drive into a pharmacy computer, and do not install software. Most ransomware arrives either as an attachment somebody opened or through something somebody plugged in.",
        "Treat an unexpected email asking you to log in somewhere, confirm a payment, or open an invoice as hostile until proven otherwise, even when it appears to come from a supplier or from the owner. Check by phone using a number you already have. Reporting a suspicious message costs nothing; a pharmacy locked out of its dispensing system on a Monday morning costs everything.",
        "Paper with PHI on it goes in the shred bin, never the trash. That includes labels, rejected claims printouts, sticky notes with a patient's name, and returned-to-stock labels.",
      ],
      takeaways: [
        "One login per person, locked whenever you walk away.",
        "No PHI by personal email, text or phone camera. No personal USB drives.",
        "Unexpected login or payment emails are hostile until verified by phone.",
      ],
    },
    {
      heading: "Faxes, will-call and the bag handed to the wrong person",
      body: [
        "Check the number before you send a fax and use the pharmacy's cover sheet. A misdirected fax is a reportable breach and is entirely avoidable. Where a number is used often, use the stored entry rather than typing it.",
        "The will-call bin is a filing system full of PHI facing the public. Keep it out of the customer's line of sight, and never let a patient look through it themselves.",
        "Handing the wrong bag to the wrong person is the most common breach in retail pharmacy, and it is a breach even when the person hands it straight back — they have seen a name, an address and a drug. Confirm two identifiers, out loud, every time: the name and the date of birth or the address. Every time, including for the patient you have known for fifteen years, because the exception you make for them is the habit that fails on a busy Friday.",
        "If two patients share a surname, or a name is close to another, expect the error rather than hoping it does not happen. Slow down and check the address.",
        "Delivery is the same rule at a doorstep. The driver confirms the name before handing anything over, does not leave a package with a neighbour, and does not discuss what is in the bag.",
      ],
      takeaways: [
        "Two identifiers, spoken aloud, at every hand-off — no exceptions for regulars.",
        "Check the fax number, use the cover sheet.",
        "A bag handed over and handed straight back is still a breach; report it.",
      ],
    },
    {
      heading: "What patients are entitled to",
      body: [
        "Patients may see and get a copy of their own records — 45 CFR 164.524. The pharmacy has thirty days, extendable once by a further thirty with a written explanation. A reasonable, cost-based fee may be charged for a copy; the patient cannot be charged for the search. Requests come to the pharmacist-in-charge.",
        "They may ask for a correction — 45 CFR 164.526. The pharmacy has sixty days. Where the pharmacy disagrees, the patient may file a statement of disagreement, which goes on the record alongside it.",
        "They may ask for an accounting of certain disclosures over the previous six years — 45 CFR 164.528. Treatment, payment and operations disclosures are not in it, which is most of what a pharmacy does, but the request is still handled properly rather than waved away.",
        "They may ask us to communicate with them a particular way — a different phone number, a different address, no voicemail — 45 CFR 164.522(b). Reasonable requests are accommodated, and the patient does not have to explain why.",
        "They may ask for a restriction on sharing. Most of these are optional. There is one we must honour: if a patient pays in full out of pocket and asks us not to tell their health plan, we have to comply — 45 CFR 164.522(a)(1)(vi). Do not run the claim first and apologise afterwards; once it is submitted it cannot be recalled from the plan's records.",
        "The Notice of Privacy Practices is displayed in the pharmacy and given to patients. If someone asks for it, give them one; if you cannot find one, tell the pharmacist-in-charge. A patient may also complain to us or directly to the Office for Civil Rights, and nobody may be treated differently for having complained.",
      ],
      takeaways: [
        "Access requests: thirty days, and they go to the PIC.",
        "Cash in full plus a request not to tell the plan is mandatory — do not bill first.",
        "Complaining to us or to OCR is a right; retaliation is prohibited.",
      ],
    },
    {
      heading: "Vendors, and the people we send information to",
      body: [
        "A business associate is an outside party that handles PHI on the pharmacy's behalf: the software vendor, the billing service, the PSAO, a delivery contractor, the shredding company, an IT support firm.",
        "Every one of them needs a signed business associate agreement before information moves. That is the pharmacist-in-charge's job, but it becomes yours the moment somebody asks you to send them a file.",
        "So the rule at your level is simple: if a company you do not recognise asks for patient information — by phone, by email, or in person — you do not send it. You take their details and pass it to the pharmacist-in-charge. That is true even when they say a contract is already in place, and especially when they are in a hurry.",
      ],
      takeaways: [
        "Outside parties handling PHI need a signed agreement first.",
        "An unfamiliar company asking for data gets their details taken, nothing sent.",
        "Urgency is a warning sign, not a reason to skip the check.",
      ],
    },
    {
      heading: "When something goes wrong",
      body: [
        "A breach is any acquisition, access, use or disclosure not permitted by the rules — the wrong bag handed to the wrong person, a prescription faxed to the wrong number, an email sent to the wrong patient, a laptop or phone lost, paperwork left on the counter, a record opened without a reason.",
        "Report it to the pharmacist-in-charge immediately. Not at the end of the shift, not tomorrow. The pharmacy's legal deadline starts running from discovery, and the assessment of whether it is reportable is not yours to make alone.",
        "What happens next is a documented four-factor assessment under 45 CFR 164.402: what information was involved, who received it, whether it was actually acquired or viewed, and how far the risk has been reduced. An impermissible disclosure is presumed to be a breach unless that assessment shows a low probability that the information was compromised. That assessment is written down whichever way it comes out.",
        "Where it is a breach, the patient is notified without unreasonable delay and no later than sixty days from discovery. HHS is notified as well — immediately for a breach affecting five hundred or more people, and annually for smaller ones. Kansas has its own security breach notification law on top of that. All of it is the pharmacist-in-charge's job; none of it can start until you say something.",
        "Reporting a breach — including one you caused — is what you are supposed to do, and this pharmacy does not retaliate for it. Concealing one is a far more serious matter than causing one, and it is the thing that turns a manageable incident into a case.",
        "The same is true of a near miss. If you nearly handed over the wrong bag, say so. That is the report that stops it happening for real next month.",
      ],
      takeaways: [
        "Report immediately — the legal clock starts at discovery.",
        "Every impermissible disclosure is presumed a breach until assessed in writing.",
        "Reporting is protected. Concealing is the serious offence.",
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
      why: "45 CFR 164.522(a)(1)(vi) makes that one restriction mandatory. Most requested restrictions are optional; this one is not. It also has to be honoured before the claim goes out, because a submitted claim cannot be recalled.",
    },
    {
      q: "A police officer comes to the counter and asks you to confirm whether a named person filled a prescription here. What do you do?",
      options: [
        "Confirm it, because law enforcement is exempt from HIPAA",
        "Confirm it only if he shows a badge",
        "Take his name, agency and contact details, disclose nothing, and get the pharmacist-in-charge",
        "Refuse and ask him to leave",
      ],
      answer: 2,
      why: "Law enforcement disclosures are narrow and conditional, and they are not decided at the counter. Taking his details and getting the PIC is both compliant and courteous — it is not a refusal.",
    },
    {
      q: "You handed a bag to the wrong customer, who looked at the label and immediately handed it back. Is that a breach to report?",
      options: [
        "No, because nothing left the pharmacy",
        "No, because they gave it straight back",
        "Yes — report it, because they saw a name, an address and a drug",
        "Only if the patient finds out",
      ],
      answer: 2,
      why: "An impermissible disclosure happened the moment they read the label, and it is presumed to be a breach until a documented assessment says otherwise. Handing it back limits the harm; it does not undo the disclosure.",
    },
    {
      q: "A company you have not heard of calls, says it works with the pharmacy's billing, and asks you to email a list of patients. What do you do?",
      options: [
        "Send it, since billing is a permitted purpose",
        "Send it if they can name the pharmacy's software",
        "Take their details and pass it to the pharmacist-in-charge; send nothing",
        "Ask them to send the request in writing, then email the list",
      ],
      answer: 2,
      why: "Outside parties handling PHI need a signed business associate agreement, and that is the PIC's decision, not the caller's. Urgency and inside knowledge are exactly what a pretext call sounds like.",
    },
    {
      q: "You need to send a photo of a prescription to a prescriber's office quickly. What is acceptable?",
      options: [
        "Photograph it on your phone and text it",
        "Photograph it on your phone and email it from your personal account",
        "Use the pharmacy's fax or system; do not photograph it on a personal phone",
        "Any of these, as long as you delete the photo afterwards",
      ],
      answer: 2,
      why: "PHI does not go onto personal devices or personal accounts. Deleting it afterwards does not undo the copy, the backup, or the cloud sync that happened in between.",
    },
    {
      q: "A patient asks for a copy of their own dispensing history. What is the position?",
      options: [
        "They are not entitled to it; it is the pharmacy's record",
        "They are entitled to it — the request goes to the pharmacist-in-charge, and the pharmacy has thirty days",
        "They must ask their prescriber instead",
        "Only with a written authorization from their plan",
      ],
      answer: 1,
      why: "45 CFR 164.524 gives patients a right of access to their own records, generally within thirty days. A reasonable cost-based copying fee is permitted; charging for the search is not.",
    },
    {
      q: "When do your confidentiality obligations end?",
      options: [
        "At the end of each shift",
        "When you leave this job",
        "After six years",
        "They do not — they continue after your employment here ends",
      ],
      answer: 3,
      why: "The duty attaches to the information, not to the shift or the job. Discussing a former employer's patients is as much a violation as discussing a current one's.",
    },
  ],
};
