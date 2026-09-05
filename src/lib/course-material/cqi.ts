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
