import type { Course } from "./types";

/**
 * Fraud, waste and abuse, and the compliance programme it sits inside.
 *
 * The temptation with this subject is to teach the statutes. Almost nothing a small pharmacy is
 * actually pulled up on is a scheme; it is a claim that does not match the hard copy, or an
 * overpayment nobody got round to returning. So the statutes are here, briefly and accurately,
 * and the weight of the course is on the twenty things that go wrong at this counter.
 */
export const fwa: Course = {
  type: "fwa_general_compliance",
  title: "Fraud, waste and abuse, and general compliance",
  authority:
    "42 CFR 422.503(b)(4)(vi) and 423.504(b)(4)(vi) — compliance and FWA training for entities providing " +
    "benefits to Medicare enrollees. Note: a Part D plan or PSAO may require its own FWA module in addition.",
  whoMayTeach:
    "42 CFR 423.504(b)(4)(vi)(C) requires the training and names no qualification for the trainer. A pharmacy " +
    "enrolled in Medicare Part A or B, or accredited as a DMEPOS supplier, is deemed to have met the fraud, waste " +
    "and abuse training requirement by virtue of that enrolment — but the general compliance obligation remains, " +
    "and a plan or PSAO may still require its own module. This is in-house training and is not continuing education.",
  intro:
    "This covers what fraud, waste and abuse look like in a pharmacy, the laws behind them, and exactly how to " +
    "raise something you are worried about. If a plan or PSAO also sends you their own FWA module, do that one " +
    "as well — it does not replace this and this does not replace it.",
  objectives: [
    "Tell fraud, waste and abuse apart, and know that you do not have to before reporting something.",
    "Recognise the specific claim errors that a pharmacy audit looks for, and prevent them at the point of entry.",
    "State what has to happen when the pharmacy is overpaid, and within what time.",
    "Explain why the pharmacy screens everybody against the federal exclusion lists every month.",
    "Raise a concern — here, or outside the pharmacy — and know what protects you when you do.",
  ],
  seeAlso: [
    "Chapter: Compliance programme and fraud, waste and abuse, in this pharmacy's policy and procedure manual.",
    "The monthly exclusion screening attestation, on the site under Compliance.",
  ],
  references: [
    "31 U.S.C. 3729–3733 — the False Claims Act.",
    "42 U.S.C. 1320a-7b(b) — the Anti-Kickback Statute.",
    "42 U.S.C. 1320a-7a — civil monetary penalties, including beneficiary inducement.",
    "42 CFR 1001.1901(b) — the effect of exclusion on payment.",
    "42 CFR 423.504(b)(4)(vi) — Part D compliance programme requirements.",
    "Social Security Act § 1128J(d) — the sixty-day overpayment rule.",
  ],
  sections: [
    {
      heading: "The three words, and the difference between them",
      body: [
        "Fraud is knowingly submitting, or causing to be submitted, a false claim to get a payment you are not entitled to. It requires intent.",
        "Waste is overuse or careless use of resources that costs the programme money without intent to deceive — auto-refilling medication the patient never collects, or dispensing quantities nobody needs.",
        "Abuse sits between them: practices inconsistent with sound fiscal or professional standards that result in unnecessary cost, without the intent that makes it fraud.",
        "You do not have to decide which one you are looking at before reporting it. That is the compliance officer's job. Reporting the wrong category is not a mistake; staying quiet because you could not decide is.",
      ],
      takeaways: [
        "Fraud needs intent; waste and abuse do not.",
        "Categorising it is not your job. Reporting it is.",
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
        "Billing for a compound at a rate that assumes ingredients that were not used, or that does not reflect what was actually compounded.",
        "Waiving copays routinely as an inducement, or offering gifts to bring prescriptions in. A one-off waiver for genuine financial hardship, documented, is a different thing.",
        "Accepting anything of value in return for referrals — that is the Anti-Kickback Statute, and it runs in both directions. Free lunches, a rent arrangement below market, or a payment for each patient sent over are all within it.",
        "Forged or altered prescriptions, and prescriptions from a prescriber you have reason to believe is not treating the patient.",
        "Billing for a vaccine that was not given, or under a different administration code than the one that describes what happened.",
      ],
      takeaways: [
        "Most of the list is a claim that does not match the paperwork.",
        "A routine copay waiver is an inducement; a documented hardship waiver is not.",
        "Kickbacks are criminal for both the giver and the receiver.",
      ],
    },
    {
      heading: "The laws behind it",
      body: [
        "The False Claims Act (31 U.S.C. 3729) covers knowingly submitting a false claim. Penalties are per claim and include treble damages. 'Knowingly' includes deliberate ignorance and reckless disregard — not knowing because you did not want to know is not a defence.",
        "The reverse false claim matters here more than most people expect: keeping an overpayment you know about is itself a violation. Identified overpayments have to be reported and returned within sixty days.",
        "The Anti-Kickback Statute (42 U.S.C. 1320a-7b(b)) is criminal, and both sides of the arrangement commit the offence. A claim that results from a kickback is also a false claim.",
        "Civil monetary penalties apply to inducements offered to beneficiaries — anything of more than nominal value offered to a Medicare or Medicaid patient that is likely to influence where they fill.",
        "Exclusion: a person on the OIG exclusion list may not work in any capacity for an entity that bills federal health care programmes — 42 CFR 1001.1901(b). It is not limited to clinical roles: a delivery driver, a bookkeeper or a cleaner is caught by it too. This pharmacy screens the OIG LEIE and the federal SAM list every month, which is why nobody is hired or kept on without that check.",
        "The Part D rules also require the pharmacy to have a compliance programme at all — not just to avoid fraud, but to have written standards, training, a way to raise concerns, monitoring, and prompt correction.",
      ],
      takeaways: [
        "Reckless disregard counts as knowing.",
        "An identified overpayment must be returned within sixty days.",
        "Exclusion screening covers every role, not just clinical ones.",
      ],
    },
    {
      heading: "Getting the claim right",
      body: [
        "Most FWA findings in a small pharmacy are not schemes; they are claims that do not match the paperwork. An audit compares the claim against the hard copy, so the two have to agree.",
        "Days supply must reflect the directions. Quantity must reflect what was dispensed. The prescriber on the claim must be the prescriber who wrote it, with their own NPI rather than a supervising physician's. Origin code must reflect how the prescription actually arrived.",
        "'As directed' on an inhaler or an insulin pen is where days supply goes wrong most often. Where the directions do not support a calculation, get the clarification and write it on the hard copy — an audit will ask for exactly that note.",
        "A prescription needs everything on its face that the law requires before it is a valid prescription: the patient, the drug, strength, quantity, directions, the date, the prescriber's details and, for controlled substances, the rest of what 21 CFR 1306 requires. A claim on an incomplete prescription is a recoupment waiting to happen even where the dispensing was clinically right.",
        "If a claim was submitted and the prescription is returned to stock, the claim gets reversed. That is the single most common recoupment in an audit and it is entirely within our control.",
        "Keep the signature log, the delivery record and the hard copy such that they can be produced together. An audit that cannot see proof of receipt treats the claim as unsupported no matter how correct it was.",
      ],
      takeaways: [
        "The claim and the hard copy have to say the same thing.",
        "Clarify 'as directed' and write the clarification on the hard copy.",
        "Returned to stock means reversed, every time.",
      ],
    },
    {
      heading: "Reporting, and what happens to you if you do",
      body: [
        "Raise it with the pharmacist-in-charge. If the concern is about the pharmacist-in-charge, or you would rather not raise it here, you may report directly to the plan, to the Medicare Drug Integrity Contractor, or to the OIG hotline at 1-800-HHS-TIPS.",
        "You may report anonymously.",
        "Retaliation against someone who reports a concern in good faith is prohibited by law and by this pharmacy. Being wrong about a concern raised in good faith is not a disciplinary matter — staying quiet about one is.",
        "You are not expected to investigate. Report what you saw. Do not confront the person, do not gather evidence, and do not discuss it with the rest of the staff first — that is how a straightforward concern becomes an argument about who said what.",
      ],
      takeaways: [
        "Report to the PIC, or outside the pharmacy, or anonymously.",
        "Do not investigate, confront, or discuss it around the shop.",
        "Good-faith reporting is protected. Silence is not.",
      ],
    },
    {
      heading: "What a compliance programme is made of",
      body: [
        "Written standards and procedures. A compliance officer — here, the pharmacist-in-charge. Training, which is what this is. A way to raise concerns without fear. Monitoring and auditing. Enforcement through consistent discipline. And prompt correction of anything found.",
        "The last one is the part that gets pharmacies into trouble: finding a problem and not fixing it is worse than not having looked, because now it is knowing.",
        "The monitoring half is not abstract. This pharmacy screens everybody against the exclusion lists monthly, reviews its own claims, keeps a controlled substance discrepancy log, and runs a self-inspection. Those records are what a compliance programme actually consists of; the policy document only describes them.",
      ],
      takeaways: [
        "Seven elements: standards, an officer, training, a channel, monitoring, enforcement, correction.",
        "Finding a problem and not fixing it is worse than not looking.",
      ],
    },
    {
      heading: "What an audit actually does, and how to survive one",
      body: [
        "A pharmacy audit is not an investigation into whether you are honest. It is a comparison of a list of claims against the paper behind them, done by somebody who was not there, months later, with no ability to ask what you meant. Everything in this section follows from that.",
        "There are three kinds. A desk audit asks for documents by mail or portal for a list of claims. An on-site audit sends somebody to the pharmacy, usually with a few days' notice and a list. An investigative audit follows a specific allegation and behaves differently — that one goes straight to the pharmacist-in-charge and, usually, to a lawyer.",
        "What they ask for is always the same set: the hard copy or the electronic prescription, the signature log or delivery proof, the wholesaler invoices showing you bought enough of the product to have dispensed it, and any clarification notes.",
        "The invoice check surprises people. If you billed 300 tablets of something over six months and your invoices show you bought 200, the difference is recouped regardless of what the prescriptions say. That is why receiving and filing invoices properly is an audit control and not just bookkeeping.",
        "Respond by the deadline, keep a complete copy of everything sent, and never alter a document after the fact. Adding a missing quantity to a hard copy in the same pen you have in your hand converts a recoupment into an allegation of fraud. If something is missing, it is missing; say so.",
        "Appeal findings you disagree with, in time, with the evidence attached. Most plans have a short appeal window and most pharmacies miss it. A finding not appealed is a finding accepted.",
      ],
      takeaways: [
        "They compare claims to paper, months later, unable to ask what you meant.",
        "Invoices are audited too: bill more than you bought and the difference comes back.",
        "Never alter a document afterwards. Missing is recoverable; altered is not.",
      ],
    },
    {
      heading: "The paperwork that decides the audit, at the moment it is created",
      body: [
        "Almost every recoupment traces back to something that took ten seconds at the time and could not be fixed afterwards.",
        "The hard copy is complete. Patient, drug, strength, quantity, directions, date, prescriber, and for a controlled substance everything 21 CFR 1306 requires. A prescription missing a quantity is not a valid prescription, whatever was dispensed.",
        "Clarifications are written on the prescription, with the date, who was spoken to, and what they said. A verbal clarification that lives in somebody's memory is worth nothing four months later.",
        "The days supply describes the prescription rather than the claim. This is the single most audited field and the one most often wrong on inhalers, insulins, eye drops, topicals and anything written 'as directed'.",
        "The origin code says how the prescription actually arrived — written, telephone, electronic, fax. It is a field people set once and stop thinking about, and it is compared against the record.",
        "The prescriber on the claim is the prescriber who wrote it, with their own NPI. Not the supervising physician, not the practice.",
        "Proof of receipt exists: a signature, a delivery record, a shipping confirmation. An audit that cannot see the patient got it treats the claim as unsupported, and being certain they collected it is not evidence.",
        "Refill-too-soon overrides, prior authorisations and DAW codes have a reason recorded. A code entered to make a claim pay is the definition of a false claim, whatever the clinical merits.",
      ],
      takeaways: [
        "Write the clarification on the hard copy, with the date and who said it.",
        "Days supply describes the prescription, not the claim.",
        "Proof of receipt is part of the claim. No signature, no support.",
      ],
    },
    {
      heading: "Where the money comes from, and why the rules are what they are",
      body: [
        "It helps to know whose money this is. Part D is federal money administered by plans; Medicaid is federal and state money administered by KanCare's managed care organisations; commercial plans are the employer's money. The False Claims Act and the exclusion rules attach to the federal ones, which is why an ordinary billing error in a Medicare claim carries consequences a commercial billing error does not.",
        "The pharmacy's contracts sit between it and the plans, usually through a PSAO. Those contracts carry the audit rights, the appeal windows, the reversal windows and the recoupment terms. They are not optional reading and they are not the same across plans.",
        "That is also where the compliance obligations reach you: a Part D sponsor is required to make sure its downstream entities — that is us — train their staff, screen against the exclusion lists, and have a way for people to report concerns. A plan asking for evidence of this pharmacy's compliance programme is exercising a right it already has.",
        "None of that changes what any of it asks of you. Bill what was dispensed, to the patient it was dispensed to, on the prescription that was written, and say something when it does not look right.",
      ],
      takeaways: [
        "Federal money is why an error can become a False Claims Act matter.",
        "The PSAO contracts carry the audit rights and the appeal windows.",
        "A plan can require evidence of this pharmacy's compliance programme.",
      ],
    },
  ],
  questions: [
    {
      q: "An audit finds you billed 300 tablets over six months but the wholesaler invoices show 200 purchased. What happens?",
      options: [
        "Nothing, if every prescription is on file",
        "The difference is recouped regardless of the prescriptions",
        "The plan asks for an explanation and usually accepts it",
        "Only the claims without signatures are recouped",
      ],
      answer: 1,
      why: "Invoice reconciliation is a standard part of an audit. You cannot have dispensed what you never bought, and the prescriptions do not answer that question.",
    },
    {
      q: "Preparing an audit response, you notice a hard copy is missing the quantity. What do you do?",
      options: [
        "Write it in — you know what was dispensed",
        "Ask the prescriber to write it in now",
        "Send it as it is and say the clarification was not documented",
        "Leave that claim out of the response",
      ],
      answer: 2,
      why: "Altering a document after the fact turns a recoupment into an allegation of fraud, and it is the one mistake that cannot be undone. Missing is survivable.",
    },
    {
      q: "A finding you believe is wrong arrives with a 30-day appeal window and you are busy. What is the consequence of letting it pass?",
      options: [
        "None — you can appeal at the next audit",
        "A finding not appealed in time is a finding accepted",
        "The plan will re-open it automatically",
        "It only matters for large amounts",
      ],
      answer: 1,
      why: "Most appeal windows are short and most pharmacies miss them. The evidence you would have used is usually already on file, which makes it a particularly expensive thing to lose by default.",
    },

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
        "Report and return the overpayment — knowingly keeping it is itself a False Claims Act violation, with a sixty-day clock",
        "Offset it against future underpayments",
        "Wait for the annual audit",
      ],
      answer: 1,
      why: "This is the reverse false claim. Once an overpayment is identified it must be reported and returned within sixty days; keeping it is a violation in its own right.",
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
      q: "Why does this pharmacy check the OIG exclusion list every month?",
      options: [
        "It is a licensing requirement in Kansas",
        "Because a person on the exclusion list may not work in any capacity for an entity that bills federal health care programmes",
        "To verify professional credentials",
        "It is optional but good practice",
      ],
      answer: 1,
      why: "Employing an excluded person exposes the pharmacy to civil monetary penalties for every claim submitted while they were employed, in any role — including non-clinical ones.",
    },
    {
      q: "The directions on an inhaler read 'use as directed' and the software will not calculate a days supply. What is the right move?",
      options: [
        "Enter thirty days, because that is usual",
        "Enter whatever days supply lets the claim pay",
        "Get a clarification from the prescriber and write it on the hard copy",
        "Leave the field blank",
      ],
      answer: 2,
      why: "Days supply has to describe the prescription, not the claim. An audit asks to see the clarification, so it has to be on the hard copy rather than in somebody's memory.",
    },
    {
      q: "A drug representative offers to buy lunch for the pharmacy every week if you keep their product in stock and suggest it. What is that?",
      options: [
        "Normal business courtesy",
        "Acceptable if the product is clinically appropriate",
        "Potentially a kickback — anything of value exchanged for referrals or recommendations, and both sides commit the offence",
        "Acceptable if the value is under fifty dollars",
      ],
      answer: 2,
      why: "The Anti-Kickback Statute is criminal and catches anything of value offered to induce referrals or recommendations. There is no small-value exemption at the counter — bring it to the pharmacist-in-charge.",
    },
    {
      q: "Which of these is 'waste' rather than 'fraud'?",
      options: [
        "Billing a brand and dispensing a generic",
        "Auto-refilling a medication the patient never collects",
        "Entering a false DAW code",
        "Splitting a prescription to collect two dispensing fees",
      ],
      answer: 1,
      why: "Waste is cost without intent to deceive. The other three involve a claim that is knowingly untrue, which is fraud — but you are not asked to make that call before reporting anything.",
    },
  ],
};
