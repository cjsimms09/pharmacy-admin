import type { Course } from "./types";

/**
 * Controlled substance diversion, from all three directions it comes from.
 *
 * No standard mandates this course, which is exactly why it is worth writing carefully: it is the
 * first thing asked about after a loss, and 21 CFR 1301.71 requires effective controls against
 * diversion — controls that live in what the people at the counter notice, not in a policy.
 */
export const diversion: Course = {
  type: "controlled_substance_diversion",
  title: "Controlled substance diversion awareness",
  authority:
    "Not a standalone Kansas or federal training mandate. It is the first thing asked about after a loss, and " +
    "21 CFR 1301.71 requires effective controls against diversion — which means the people at the counter " +
    "knowing what to look for.",
  whoMayTeach:
    "No federal or Kansas rule mandates this training, so nothing specifies who may give it. It exists because " +
    "21 CFR 1301.71 requires effective controls against diversion and those controls live in what the people at " +
    "the counter notice. Delivered in-house by the pharmacist-in-charge; not continuing education.",
  intro:
    "Diversion in a pharmacy is usually not dramatic. It is small, patient, and done by someone trusted. This is " +
    "about noticing it early, in all three of the places it comes from — inside the pharmacy, from prescribers, " +
    "and from patients — and about what you are and are not expected to do next.",
  objectives: [
    "Recognise the behavioural and numerical signs of internal diversion.",
    "Recognise prescribing patterns and patient presentations that warrant a closer look.",
    "State the pharmacist's corresponding responsibility and where K-TRACS fits.",
    "Handle a suspicious or aggressive interaction at the counter safely.",
    "Know exactly who to tell, and that you are not expected to investigate or be certain.",
  ],
  seeAlso: [
    "Chapter: Controlled substances, in this pharmacy's policy and procedure manual.",
    "The controlled substance discrepancy log, on the site under Compliance.",
  ],
  references: [
    "21 CFR 1301.71 — physical security controls, including effective controls against diversion.",
    "21 CFR 1301.76 — employees who may not have access to controlled substances, and reporting theft or loss.",
    "21 CFR 1301.90–1301.93 — employee screening, the security awareness statement, and reporting drug diversion.",
    "21 CFR 1306.04 — corresponding responsibility for the validity of a controlled substance prescription.",
    "21 CFR 1304.11 and 1304.21 — inventory and records of receipt and disposition.",
    "K.S.A. 65-1643 and the Kansas Board of Pharmacy regulations on controlled substances; K-TRACS.",
  ],
  sections: [
    {
      heading: "Why this is everybody's job",
      body: [
        "The DEA requires a registrant to maintain effective controls against diversion. What that means in practice is not a safe and a camera; it is a set of habits — nobody counts alone, nobody wastes alone, discrepancies get logged the day they appear, and people say something when a pattern starts to form.",
        "It is also personal. 21 CFR 1301.91 states plainly that reporting drug diversion is the responsibility of every employee, and that an employee who becomes aware of diversion and does not report it may be considered to have failed in that responsibility.",
        "A diverting colleague almost always ends badly — an overdose, a prosecution, a career gone. The people who get caught early are the ones somebody spoke up about early. Saying something is not disloyalty; it is very often the only thing that helps them.",
      ],
      takeaways: [
        "Effective controls are habits, not hardware.",
        "Reporting diversion is every employee's stated responsibility under the DEA's rules.",
      ],
    },
    {
      heading: "From inside",
      body: [
        "The signs are behavioural before they are numerical: volunteering for the count, resisting anyone else counting, wanting to work alone, coming in on days off, unexplained absences, being present for every waste, appearance or performance changes, wearing long sleeves in summer, frequent bathroom breaks straight after handling stock.",
        "And numerical: recurring short counts on one drug, one shift or one person; wastes that are always undocumented or always witnessed by the same person; returned-to-stock quantities that do not match; adjustments made after hours; a perpetual inventory that is only ever corrected downward.",
        "Also worth noticing: prescriptions filled for staff or their family members that nobody else handled, refills run early for a colleague, and paperwork that is always tidied up by the same person.",
        "Nobody wastes a controlled substance alone. Nobody counts a controlled substance alone. Those two rules exist to protect the honest person as much as to catch the dishonest one — being the only person who touched a bottle that came up short is a bad position to be in even when you did nothing.",
        "One short count is an error. A pattern that follows a drug, a shift or a person is the thing to raise, and you raise the pattern rather than waiting for proof.",
      ],
      takeaways: [
        "Behaviour changes usually show before the numbers do.",
        "Never count or waste alone — it protects you as much as the stock.",
        "Report the pattern, not the proof.",
      ],
    },
    {
      heading: "From prescribers",
      body: [
        "Prescriptions well outside a prescriber's specialty. The same drug, strength and quantity for every patient. Patients travelling long distances past other pharmacies. Cash payment for controlled substances when the patient has insurance. Numbers of controlled prescriptions from one prescriber that do not fit their practice. A prescriber whose patients all arrive on the same day, or in groups.",
        "Combinations that are a known street request — an opioid with a benzodiazepine and a muscle relaxant is the classic — and prescriptions written for the maximum quantity every time regardless of the patient.",
        "A pharmacist has a corresponding responsibility to ensure a controlled substance prescription is issued for a legitimate medical purpose by a practitioner acting in the usual course of professional practice — 21 CFR 1306.04. Filling one you have real doubts about is the pharmacist's liability, not the prescriber's alone.",
        "Resolving a doubt means doing something and writing down what you did: calling the prescriber, checking K-TRACS, asking the patient about their treatment. A note on the hard copy saying what was checked and what the answer was is what turns a judgement call into a defensible one.",
        "Refusing to fill is a legitimate outcome. So is filling after the doubt is resolved. What is not legitimate is filling with the doubt unresolved because the queue is long.",
      ],
      takeaways: [
        "Corresponding responsibility means the pharmacist is on the hook too.",
        "Resolve the doubt and write down how — the note is the defence.",
        "Refusing is allowed; filling around an unresolved doubt is not.",
      ],
    },
    {
      heading: "From patients",
      body: [
        "Early refills, lost or stolen prescriptions repeatedly, multiple prescribers and pharmacies, altered quantities or refills on a paper prescription, forged prescriptions on stolen pads, pressure and urgency at the counter, and specifying a brand or an exact colour of tablet.",
        "On a paper prescription look at the whole thing, not the drug line: a quantity written in one hand and a number in another, a refill count squeezed in, ink that does not match, a prescriber's address that is not local, a DEA number that does not check out, a date that has been changed.",
        "K-TRACS is the check. Use it — that is what it is for, and the data in it is confidential and subject to the same business-reason test as any other patient record.",
        "None of these signs is proof of anything, and plenty of people with a genuine need present in exactly these ways. The point is to look properly, not to decide.",
        "Aggression is a reason to step away and get the pharmacist, not a reason to fill something to end the conversation. Do not argue at the counter, do not accuse anyone of forgery to their face, and do not follow anyone out to the car park to get a licence plate. If a prescription is a forgery and the person leaves without it, that is a good outcome — note the description afterwards and tell the pharmacist-in-charge.",
      ],
      takeaways: [
        "Read the whole prescription, not just the drug line.",
        "Check K-TRACS before dispensing, not after.",
        "Step away from aggression. Never confront, never follow anyone.",
      ],
    },
    {
      heading: "What to do",
      body: [
        "Tell the pharmacist-in-charge. That is the whole of your obligation — you are not asked to investigate, confront anyone, or be certain.",
        "Do not discuss a suspicion with the rest of the staff first. It is unfair to the person if you are wrong, and if you are right it is how evidence disappears.",
        "If the concern is about the pharmacist-in-charge, contact the Kansas Board of Pharmacy directly, or the DEA field office. You do not need permission to do that and there is no route through this pharmacy that can stop you.",
        "A significant loss or theft of controlled substances goes to the DEA on Form 106 and to the Board. Deciding whether a loss is significant, and filing it, is the PIC's job — but it is a job that cannot start until somebody says something.",
        "Where the loss involves a colleague, there will also be a decision about their access under 21 CFR 1301.76(a), which prohibits a registrant from allowing access to controlled substances to certain people. That is handled by the PIC.",
        "Raising a concern in good faith is protected here. Being wrong in good faith is not a disciplinary matter; staying quiet about something you saw is.",
      ],
      takeaways: [
        "Tell the PIC. Do not investigate, confront, or discuss it around the shop.",
        "Concern about the PIC goes straight to the Board or the DEA.",
        "A loss report cannot start until somebody speaks.",
      ],
    },
    {
      heading: "What the records are supposed to show",
      body: [
        "Diversion is found in the gap between what the records say should be on the shelf and what is on it. That only works if the records are complete, which makes the paperwork part of the control rather than an administrative chore.",
        "Every controlled substance that comes in has an invoice, and 21 CFR 1304.04 requires those records to be kept for at least two years federally and five under Kansas law, with Schedule II records maintained separately from everything else. This site files them by schedule for exactly that reason.",
        "Every controlled substance that goes out is on a prescription record. Every one that is destroyed, returned or transferred has its own document — a DEA Form 222 or CSOS order for a Schedule II transfer, a reverse distributor's receipt for a destruction, a Form 41 for an on-site destruction.",
        "The inventory ties the two together. A biennial inventory is the federal minimum; Kansas requires one at least annually and within 375 days of the last. What the count is for is not the number itself but the comparison: receipts, minus dispensings, minus documented removals, should equal the count. Where it does not, that difference is the whole subject of this course.",
        "A perpetual inventory on the fast-moving items is the single most effective internal control a small pharmacy can run, because it shortens the time between a loss and the moment somebody notices from a year to a day. A loss found a year later is almost never attributable to anybody.",
        "Every discrepancy gets logged on this site the day it appears, with what was checked and what the explanation turned out to be. Most are counting or entry errors and the log will say so. The value is in the ones that are not, and in the pattern that only exists because the small ones were written down.",
      ],
      takeaways: [
        "Receipts minus dispensings minus documented removals should equal the count.",
        "A perpetual count on fast movers turns a year's delay into a day's.",
        "Log every discrepancy the day it appears, including the ones that turn out to be nothing.",
      ],
    },
    {
      heading: "The physical controls, and why each one exists",
      body: [
        "21 CFR 1301.71 requires effective controls against diversion, and 1301.75 sets out how controlled substances are stored: Schedule II in a securely locked, substantially constructed cabinet, or dispersed through the stock in a way that obstructs theft. Whichever this pharmacy does, do it the same way every day — a cabinet left open 'just while I finish' is the whole control gone.",
        "Keys and codes are personal. Do not share them, do not write them down, do not let somebody use yours because theirs is not working. The point of a code is to say who; a shared code says nobody.",
        "Deliveries are checked in against the invoice by a second person where possible, immediately, before the box leaves the counter. A shortage found at the point of receipt is the supplier's problem. The same shortage found next week is the pharmacy's.",
        "Waste, returns and destruction are witnessed and documented at the time. An undocumented waste is indistinguishable from a diversion, which is why the rule protects the honest person more than it catches the dishonest one.",
        "Access after hours, alarm codes, and who has a key are the pharmacist-in-charge's to manage. 21 CFR 1301.76(a) requires the registrant not to allow access to controlled substances to somebody convicted of a felony offence relating to controlled substances, or who has had an application denied or a registration revoked or surrendered for cause — which is why employment screening happens before somebody is given a key, not afterwards.",
      ],
      takeaways: [
        "Store it the same way every day. A cabinet left open is the control gone.",
        "Keys and codes are personal — a shared code identifies nobody.",
        "Check deliveries in against the invoice immediately, and witness every waste.",
      ],
    },
    {
      heading: "When somebody is caught, and what happens next",
      body: [
        "A significant loss or theft goes to the DEA on Form 106 and to the Kansas Board of Pharmacy. Significance is judged on the schedule and quantity, whether it is a candidate for abuse, whether it is part of a pattern, and whether it was a break-in or an inside loss. That judgement is the pharmacist-in-charge's, made in writing, and a decision that a loss was not significant is documented as carefully as a decision that it was.",
        "Where a colleague is involved, they are removed from access immediately. That is not a punishment and not a finding of guilt; it is what 1301.76(a) and simple prudence both require while the facts are established.",
        "There is a Kansas impaired-practitioner programme, and diversion by a healthcare worker is very often addiction rather than dealing. Reporting it early is what makes a route into treatment possible; reporting it late usually means it has already ended some other way. That is the honest reason to say something the first week rather than the fifth.",
        "You will not be told what happens next. Personnel matters and Board proceedings are confidential, and hearing nothing does not mean nothing was done. The one thing you should hear is a thank-you.",
      ],
      takeaways: [
        "A significant loss goes to the DEA on Form 106 and to the Board; the judgement is written down either way.",
        "Access is removed immediately, which is prudence rather than a verdict.",
        "Early reporting is what makes treatment possible. Hearing nothing back does not mean nothing happened.",
      ],
    },
  ],
  questions: [
    {
      q: "What is a perpetual inventory on fast-moving controlled substances actually for?",
      options: [
        "Satisfying the annual inventory requirement",
        "Shortening the time between a loss and somebody noticing, from a year to a day",
        "Ordering more accurately",
        "Nothing; the annual count covers it",
      ],
      answer: 1,
      why: "A loss found a year later is almost never attributable to anybody. The count itself is not the control — the speed of noticing is.",
    },
    {
      q: "A colleague's login is not working and they ask to use yours to record a controlled substance count. What do you do?",
      options: [
        "Let them, since you are standing there",
        "Let them and mention it later",
        "Refuse — a shared code identifies nobody, and the record is what protects you both",
        "Let them if you watch what they enter",
      ],
      answer: 2,
      why: "The point of a code is to say who did it. Once two people have used one, the record cannot exonerate either of them.",
    },
    {
      q: "A delivery of a Schedule II product is one bottle short of the invoice. When does this need to be found?",
      options: [
        "Whenever the discrepancy log is next reviewed",
        "At the annual inventory",
        "Immediately, at the point of receipt, before the box leaves the counter",
        "Within 30 days",
      ],
      answer: 2,
      why: "A shortage found at receipt is the supplier's problem. The same shortage found next week is the pharmacy's, and nobody can say where it went.",
    },

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
    {
      q: "Why does this pharmacy require two people for every controlled substance count and every waste?",
      options: [
        "It is faster",
        "Because it protects the honest person as much as it deters the dishonest one",
        "Only because the software asks for it",
        "It is required for Schedule II only",
      ],
      answer: 1,
      why: "Being the only person who handled a bottle that later comes up short is a bad position to be in even when you did nothing wrong. A witness is a protection, not an accusation.",
    },
    {
      q: "A patient becomes aggressive when told a controlled prescription cannot be filled today. What do you do?",
      options: [
        "Fill it to defuse the situation",
        "Argue the point until they understand",
        "Step away, get the pharmacist, and do not confront or follow anyone",
        "Take a photo of them for the file",
      ],
      answer: 2,
      why: "Nothing about a difficult conversation changes what may lawfully be dispensed, and nothing about a suspected forgery is worth your safety. Note the details afterwards and tell the pharmacist-in-charge.",
    },
    {
      q: "Your concern is about the pharmacist-in-charge himself. Where does it go?",
      options: [
        "Nowhere — there is no route",
        "To the owner only",
        "Directly to the Kansas Board of Pharmacy or the DEA field office",
        "To the other technicians first, to see whether they agree",
      ],
      answer: 2,
      why: "You may report outside the pharmacy and you do not need anyone's permission. No internal process can stop that route, and that is deliberate.",
    },
  ],
};
