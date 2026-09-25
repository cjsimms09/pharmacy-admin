import type { Course } from "./types";

/**
 * The pharmacy's continuous quality improvement programme.
 *
 * Kansas requires the programme and requires everyone here to understand it. The failure mode is
 * a course that describes a policy nobody then uses, so this is written around the two questions
 * a person at the bench actually has: does this count as something to report, and what happens to
 * me if I report it.
 */
export const cqi: Course = {
  type: "cqi_program_review",
  title: "The pharmacy's continuous quality improvement programme",
  authority: "K.A.R. 68-19-1 — every Kansas pharmacy must have a continuous quality improvement programme.",
  whoMayTeach:
    "K.A.R. 68-19-1 requires the pharmacy to have a continuous quality improvement programme and to ensure its " +
    "personnel understand it. The pharmacist-in-charge is responsible for the programme, which makes him the right " +
    "person to deliver this. No qualification is specified and this is not continuing education.",
  intro:
    "Kansas requires this pharmacy to run a CQI programme, and requires everyone working here to understand it. " +
    "The short version: when something goes wrong, we write it down and fix the system, and nobody is punished " +
    "for reporting. The longer version is below, and the part worth reading twice is what counts as reportable.",
  objectives: [
    "Recognise a quality-related event, including the near misses that never reached a patient.",
    "Report one in a way that is useful — describing the system rather than the person.",
    "State the timings Kansas sets for review, completion, summaries and record retention.",
    "Explain why the programme is non-punitive, and what the one genuinely serious offence is.",
  ],
  seeAlso: [
    "Chapter: Continuous quality improvement, in this pharmacy's policy and procedure manual.",
    "The CQI log and the two-monthly summaries, on the site under Compliance.",
  ],
  references: [
    "K.A.R. 68-19-1 — continuous quality improvement programme requirements for Kansas pharmacies.",
    "K.S.A. 65-1663 — Board of Pharmacy authority over pharmacy practice.",
  ],
  sections: [
    {
      heading: "What has to be reported",
      body: [
        "A quality-related event is any variation from the prescription as written or from accepted practice — whether or not it reached the patient, and whether or not anyone was harmed.",
        "That includes wrong drug, wrong strength, wrong quantity, wrong directions, wrong patient, a missed clinical issue such as an interaction, a duplication or an allergy, a labelling error, and a delay that mattered.",
        "It includes near misses caught at the final check. Those are the most valuable reports we get, because the system failed and the last defence held — and next time it might not.",
        "It includes events where the fault lay outside the pharmacy: an illegible or ambiguous prescription, a prescriber's error we caught, a wholesaler shipping the wrong strength. Those are system facts too, and they change what we do.",
        "If you are unsure whether something counts, report it. A report that turns out to be nothing costs five minutes; the alternative is a system that only hears about the events somebody was confident enough to escalate.",
      ],
      takeaways: [
        "Any variation from the prescription or from accepted practice, harm or not.",
        "Near misses count and are the most useful reports we get.",
        "Unsure? Report it.",
      ],
    },
    {
      heading: "How, and how quickly",
      body: [
        "Tell the pharmacist on duty as soon as you notice, and log it here the same day while you still remember the detail. Detail decays within hours — which bottle was where, who was on the phone, what the screen showed.",
        "Write what happened, not who to blame. 'The 5 mg and 50 mg bottles are next to each other and look alike' is useful. 'I was careless' is not — it gives us nothing to change.",
        "Include the things that feel like excuses, because they are data: it was the busiest hour, two people were out, the printer had jammed, the phone rang three times. Those are the conditions the next error will happen under.",
        "Under K.A.R. 68-19-1 a report is reviewed beginning within seven days and the review is completed within thirty. A summary is produced every two months, by the fifteenth of February, April, June, August, October and December, and the records are kept for five years. The site handles the timing; your part is the report.",
        "Where a patient was affected, the clinical response comes first — contact the patient, contact the prescriber, deal with the harm. The report follows; it does not compete with the care.",
      ],
      takeaways: [
        "Same day, while the detail is still there.",
        "Describe the system and the conditions, not the person.",
        "Review starts within seven days, completes within thirty, summaries every two months, records kept five years.",
      ],
    },
    {
      heading: "What happens to a report",
      body: [
        "It is reviewed for what in the system allowed it: look-alike packaging, a shelf arrangement, an ambiguous direction, a workflow that puts the check in the wrong place, an interruption at the wrong moment, a staffing level.",
        "A change is decided, made, and written down — and then looked at again later to see whether it worked. A corrective action nobody checked is a note, not a correction.",
        "The two-monthly summary looks across events for patterns that no single report shows. Three near misses on the same two drugs in four months is a finding that none of the three reports contains on its own.",
        "Everybody working here is asked to consider the summary. That is not a formality: the people at the bench are the ones who know whether the change actually helped or just added a step.",
      ],
      takeaways: [
        "The review looks for the system cause, not the person.",
        "A change that nobody checked afterwards is not a correction.",
        "Patterns show in the summary that no single report reveals.",
      ],
    },
    {
      heading: "Non-punitive means non-punitive",
      body: [
        "Reporting an error you made is not a disciplinary matter here. It is what is expected of you, and it is the only way the pharmacy finds out about the things that are about to go wrong for somebody else.",
        "The purpose is to change the system — the layout, the labelling, the workflow, the point at which a check happens — because systems are what produce errors and can be changed. Blaming a person changes nothing and buys silence.",
        "The one thing that is a serious matter is concealing an error. That is true whether it is yours or somebody else's, and it is the thing that turns an incident into a case.",
      ],
      takeaways: [
        "Reporting your own error is expected, not punished.",
        "Systems produce errors; systems are what get changed.",
        "Concealment is the serious offence.",
      ],
    },
    {
      heading: "Why a system view, and not a careful-person view",
      body: [
        "The instinct after an error is to find who made it and ask them to be more careful. It is a natural instinct and it is the least effective thing a pharmacy can do, for a reason worth understanding rather than taking on trust: the person who made the error was already trying to be careful. Telling them to try harder changes nothing about the conditions that produced it, and it teaches everybody watching that the cost of a report is being blamed.",
        "Errors come from conditions. Look-alike packaging. Two strengths of the same drug next to each other on the shelf. A direction that reads one way at speed and another way slowly. A check that happens before the step it is meant to catch. An interruption at the exact moment somebody is counting. A workflow that is fine at four prescriptions an hour and fails at forty.",
        "Every one of those can be changed this afternoon. None of them requires anybody to become a different person. That is the whole argument for a system view, and it is why the reporting form asks what happened rather than who did it.",
        "There is one place a person does come into it: a pattern. Where the same error keeps happening to the same person and the system change has not helped, that is a training question or a fitness question, and it is the pharmacist-in-charge's to handle. It is not what the CQI programme is for, and it is not what a single report triggers.",
      ],
      takeaways: [
        "The person was already trying to be careful. Telling them to try harder changes nothing.",
        "Conditions produce errors, and conditions can be changed today.",
        "A pattern involving one person is a separate conversation, not a CQI finding.",
      ],
    },
    {
      heading: "The errors this pharmacy actually sees",
      body: [
        "Wrong drug. Almost always a look-alike or sound-alike pair, or two products adjacent on the shelf. Amlodipine and amiodarone. Hydralazine and hydroxyzine. Metoprolol succinate and tartrate. The countermeasure is physical — separate them, use shelf talkers, use tall-man lettering — because attention is not a countermeasure.",
        "Wrong strength. The commonest of all, and usually two strengths of the same drug stocked next to each other. If a report names a pair, the pair gets separated.",
        "Wrong quantity. Often a days-supply or package-size confusion rather than a miscount, so the report should say which.",
        "Wrong directions. Frequently an ambiguous prescription that was interpreted rather than clarified. Report the prescription as well as the error — a prescriber who writes ambiguously will do it again next week.",
        "Wrong patient. Two patients with the same or similar surname, or a bag handed over without confirming two identifiers. This one is both a dispensing error and a privacy breach, and it is reported under both.",
        "A missed clinical issue. An interaction, a duplication, an allergy on file that the alert fired for and somebody clicked past. Alert fatigue is a system finding, not a personal failing, and it is worth reporting precisely because the fix is to reduce the noise rather than to click more carefully.",
        "A delay that mattered. An out-of-stock nobody chased, a prior authorisation that sat, a transfer that did not happen. Harm from a medication not taken is as real as harm from the wrong one, and it is under-reported everywhere.",
      ],
      takeaways: [
        "Wrong strength is the most common, and the fix is physical separation.",
        "Wrong patient is a dispensing error and a privacy breach; report both.",
        "A delay is an error. Not taking the drug harms people too.",
      ],
    },
    {
      heading: "Writing a report somebody can act on",
      body: [
        "Say what was supposed to happen, what actually happened, and where the two diverged. Three sentences is usually enough.",
        "Name the products in full, with strengths. 'The 5 mg and the 50 mg' is actionable; 'the wrong strength' is not.",
        "Say where it was caught and by what — the final check, the patient at the counter, a phone call two days later. Where it was caught tells you which defence held and which did not.",
        "Say what the conditions were. Time of day, how busy, who was on, what else was happening. This is not an excuse and it is not treated as one; it is the pattern data, and three reports that all say 'the last hour before close' are a staffing finding that no single report contains.",
        "Say what was done immediately — the patient contacted, the prescriber called, the product retrieved, the label reprinted. The immediate response is part of the record and is often the part an inspector asks about.",
        "Do not write who to blame, and do not write 'I was careless'. Neither gives anybody something to change.",
      ],
      takeaways: [
        "Name products and strengths in full.",
        "Say where it was caught — that names the defence that held.",
        "Conditions are data, not excuses.",
      ],
    },
    {
      heading: "What the law here actually requires",
      body: [
        "K.A.R. 68-19-1 requires every Kansas pharmacy to have a continuous quality improvement programme. The parts that bind: the programme is written; quality-related events are documented; review of a documented event begins within seven days and is completed within thirty; a summary is produced at least every two months; records are kept five years; and the staff are informed about the programme.",
        "The summary is due by the fifteenth of February, April, June, August, October and December, covering the two months before it. The site produces it and tracks the deadline; the reports in it are the part that has to come from people.",
        "Kansas also protects these records. The programme's documents and proceedings are confidential quality-assurance material and are not the same thing as the dispensing record. That protection is part of why the programme can be candid — and part of why what is written in a CQI report should be the analysis, while the clinical facts belong in the patient's record.",
        "Everyone working here has to be informed about the programme, which is what this course is. Signing it is the evidence that the requirement was met for you.",
      ],
      takeaways: [
        "Review begins in seven days, completes in thirty, summary every two months, records five years.",
        "Summaries are due by the 15th of February, April, June, August, October and December.",
        "The CQI file is confidential quality-assurance material and is not the dispensing record.",
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
      why: "Review begins within seven days and is completed within thirty; summaries are produced every two months and records are kept for five years.",
    },
    {
      q: "Which description is more useful in a report?",
      options: [
        "'I was rushing and grabbed the wrong bottle'",
        "'The 5 mg and 50 mg bottles are adjacent and the labels differ only in the number'",
        "'Human error'",
        "'It will not happen again'",
      ],
      answer: 1,
      why: "The second one names something that can be changed this afternoon. The others describe a person's state of mind, which nobody can act on.",
    },
    {
      q: "Two strengths of the same drug are stocked side by side and a wrong-strength error is reported. What is the useful outcome?",
      options: [
        "The person who picked it is asked to slow down",
        "The two products are physically separated and the change is checked later to see whether it worked",
        "A note is added to the file",
        "Everybody is reminded to be careful",
      ],
      answer: 1,
      why: "Attention is not a countermeasure; separation is. And a corrective action nobody checked afterwards is a note, not a correction.",
    },
    {
      q: "You clicked past an interaction alert because most of them are irrelevant, and this one was not. Should that be reported?",
      options: [
        "No — it would look bad",
        "No — alert fatigue is not a real problem",
        "Yes — alert fatigue is a system finding, and the fix is to reduce the noise",
        "Only if the patient was harmed",
      ],
      answer: 2,
      why: "This is one of the most valuable reports a pharmacy can get, and it is almost never made, because it feels like confessing. The fix is fewer and better alerts, which nobody can make without knowing.",
    },
    {
      q: "How often is the CQI summary produced, and by when?",
      options: [
        "Monthly, by the end of the month",
        "Every two months, by the fifteenth of February, April, June, August, October and December",
        "Quarterly",
        "Annually",
      ],
      answer: 1,
      why: "Every two months. The site tracks the deadline and drafts the summary; the reports that go into it have to come from people.",
    },
    {
      q: "A patient was given the wrong directions and has already taken two doses. What comes first?",
      options: [
        "Logging the event",
        "The clinical response — contact the patient and the prescriber and deal with the harm; the report follows",
        "Telling the rest of the staff",
        "Waiting for the pharmacist-in-charge to return",
      ],
      answer: 1,
      why: "Care first, always. The report matters and it follows; it never competes with looking after the patient.",
    },
  ],
};
