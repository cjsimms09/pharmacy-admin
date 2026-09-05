import type { Course } from "./types";

/**
 * Bloodborne pathogens, annually, for a pharmacy that immunizes.
 *
 * This is the one course where the standard tells you what the content has to contain — 29 CFR
 * 1910.1030(g)(2)(vii) lists fourteen elements, (A) through (N) — so the sections below are laid
 * out to cover all of them and the last one, the opportunity for interactive questions and
 * answers, is the reason this course cannot be finished by reading alone.
 */
export const bloodborne: Course = {
  type: "osha_bloodborne",
  title: "Bloodborne pathogens",
  authority:
    "29 CFR 1910.1030(g)(2) — annual bloodborne pathogens training, covering the elements at (g)(2)(vii)(A)–(N), " +
    "with the exposure control plan accessible to every employee.",
  liveQuestionsRequired: true,
  intro:
    "This pharmacy administers vaccines and handles sharps, so there is reasonably anticipated exposure to blood " +
    "and other potentially infectious material. This training is required annually and within a year of the last " +
    "one, and again whenever a task or procedure changes in a way that affects exposure. Reading it is most of it; " +
    "the standard also requires an opportunity to ask questions of somebody knowledgeable in the subject, which is " +
    "why the pharmacist-in-charge will go through it with you and record that he did.",
  objectives: [
    "Name the bloodborne diseases the standard is written around and how transmission happens in a pharmacy.",
    "Apply universal precautions without making a judgement about any individual patient.",
    "Use engineering and work practice controls correctly — above all, never recapping a needle.",
    "State your rights around the hepatitis B vaccine, including declining it and changing your mind later.",
    "Do the right things, in the right order, in the first ten minutes after an exposure incident.",
    "Recognise biohazard labelling, clean a blood spill safely, and find the written exposure control plan.",
  ],
  seeAlso: [
    "The pharmacy's written exposure control plan, reviewed annually — ask the pharmacist-in-charge and it will be handed to you.",
    "The sharps injury log.",
  ],
  references: [
    "29 CFR 1910.1030 — the bloodborne pathogens standard in full.",
    "29 CFR 1910.1030(c)(1) — the exposure control plan and its annual review.",
    "29 CFR 1910.1030(f) — hepatitis B vaccination and post-exposure evaluation and follow-up.",
    "29 CFR 1910.1030(g)(2)(vii)(A)–(N) — the required contents of this training.",
    "29 CFR 1910.1030(h) — records, including the thirty-year retention of medical records.",
  ],
  sections: [
    {
      heading: "Why this applies here, and what the standard is",
      body: [
        "The bloodborne pathogens standard applies to any employee who can reasonably be anticipated to come into contact with blood or other potentially infectious material as part of their job. In this pharmacy that is anybody who immunizes, anybody who handles or changes a sharps container, and anybody who might clean up after a patient who faints or bleeds at the counter.",
        "'Reasonably anticipated' does not mean it has happened. It means it could, in the ordinary course of the work. You do not get to opt out of the training by intending to be careful.",
        "The pharmacy has a written exposure control plan that identifies those jobs and tasks, and it is reviewed and updated at least annually. You may read it at any time and a copy will be given to you within fifteen working days of asking.",
        "This training happens at the time you are assigned to a task with exposure, before you start doing it, and every year after that. It happens again if a procedure changes.",
      ],
      takeaways: [
        "It applies to immunizers, to anyone handling sharps, and to anyone cleaning up blood.",
        "There is a written plan and you can read it whenever you like.",
        "Training goes before the task, then every year.",
      ],
    },
    {
      heading: "What you could be exposed to, and how",
      body: [
        "Hepatitis B, hepatitis C and HIV are the three the standard is written around.",
        "Hepatitis B is the most transmissible of the three by a wide margin and can survive in dried blood on a surface for at least a week. It is also the one there is a vaccine for, which is why the vaccine section below matters as much as the technique section.",
        "Hepatitis C has no vaccine. Most people infected have no symptoms for years, which is why an exposure is evaluated and followed up rather than watched.",
        "HIV is the least transmissible of the three by needlestick, and post-exposure prophylaxis is highly effective when started quickly — which is the entire reason for the word 'immediately' in the reporting section.",
        "'Other potentially infectious material' is a defined term and includes semen, vaginal secretions, cerebrospinal, synovial, pleural, pericardial, peritoneal and amniotic fluid, any body fluid visibly contaminated with blood, and any unfixed human tissue. In a pharmacy the realistic ones are blood and anything visibly contaminated with it.",
        "In this pharmacy the realistic routes are a needlestick while immunizing, contact with blood at the injection site, a sharps container that has been overfilled or handled carelessly, and cleaning up after a patient who has fainted or bled.",
        "Intact skin is a good barrier. The routes that matter are a puncture, a splash to the eyes, nose or mouth, and contact with skin that is broken, chapped or has dermatitis.",
      ],
      takeaways: [
        "Hepatitis B, hepatitis C and HIV. B is the most transmissible and the one with a vaccine.",
        "Exposure means a puncture, a splash to mucous membrane, or contact with broken skin.",
        "Hepatitis B survives on a dry surface for at least a week.",
      ],
    },
    {
      heading: "Universal precautions",
      body: [
        "Treat all human blood and body fluids as if they are infectious. There is no version of this where you decide a particular patient is low risk — that judgement is not reliable and is not permitted.",
        "This is not a comment on any patient. It is an admission about how bad everybody is at guessing, including clinicians, and about the fact that most people carrying hepatitis C do not know it.",
      ],
      takeaways: ["Everything is treated as infectious. No exceptions and no risk-rating of patients."],
    },
    {
      heading: "Controls, in the order they matter",
      body: [
        "Engineering controls first, because they work whether or not anybody is paying attention: safety-engineered needles with the sheath or retraction actually used, and a puncture-resistant, closable, leak-proof, labelled sharps container within arm's reach of where you inject.",
        "Never recap a needle. Never bend, break or remove a needle by hand. Activate the safety device immediately and drop the whole unit in the container. Recapping is the cause of a large share of all needlesticks and there is no situation at this counter that requires it.",
        "Sharps containers are replaced at the fill line, not when they will not take any more. Never push anything down into a container and never reach into one. Overfilled containers are how needlesticks happen to the person changing them.",
        "Containers are kept upright, close to where they are used, and are closed before they are moved.",
        "Work practice controls: wash hands immediately after removing gloves and after any contact. Do not eat, drink, smoke, apply cosmetics or lip balm, or handle contact lenses in the immunization area or anywhere blood might be. Do not keep food or drink where blood or other potentially infectious material is kept.",
        "Personal protective equipment: gloves for any contact with blood, and they are provided at no cost to you, in a size that fits, including a non-latex alternative if you need one. Change them between patients and after any contamination, and never wash and reuse them.",
        "Gloves are the usual PPE here. Eye protection and a gown are for splash risk, which is rare at this counter but is the pharmacist-in-charge's call, not a matter of personal preference.",
        "If a piece of PPE is missing, in the wrong size, or damaged, say so and it will be replaced. Working without it because none was to hand is not an acceptable outcome and you will not be blamed for stopping.",
      ],
      takeaways: [
        "Never recap, bend, break or hand-remove a needle.",
        "Sharps container within reach, replaced at the fill line, never reached into.",
        "Gloves are free, fitted, single-use, and you may stop and ask if there are none.",
      ],
    },
    {
      heading: "Hepatitis B vaccination",
      body: [
        "The pharmacy offers the hepatitis B vaccine series free of charge to everyone with occupational exposure, within ten working days of taking on those duties, at a reasonable time and place, and after this training.",
        "It is given under the supervision of a licensed healthcare professional, and antibody testing is available where it is recommended.",
        "You may decline. If you do, you sign the declination form the standard sets out word for word, and it goes in your file. Declining costs you nothing and is nobody's business but yours.",
        "You may change your mind and have the series at any later time while you are still in a job with exposure, still free of charge. People do change their minds — usually after an exposure incident makes it real — and the standard is written to make that easy.",
      ],
      takeaways: [
        "Free, offered within ten working days of taking on the duties.",
        "You may decline in writing, and you may change your mind later at no cost.",
      ],
    },
    {
      heading: "If you are exposed",
      body: [
        "Wash the area with soap and water immediately. Flush a splash to the eyes, nose or mouth with water or saline for several minutes. Do not squeeze the wound, do not scrub it, and do not apply bleach or any other caustic to it.",
        "Report it to the pharmacist-in-charge at once — before the end of the shift, not at the end of the week, and not after you have finished with the patient in front of you if somebody else can take over. Post-exposure prophylaxis is time-critical and for HIV is most effective within hours.",
        "The pharmacy arranges a confidential medical evaluation at no cost to you, immediately. The evaluating healthcare professional gets a written description of what you were doing, the route of exposure, the circumstances, and the source individual's status if it is known.",
        "The source individual's blood is tested for hepatitis B, hepatitis C and HIV where the law allows and consent is obtained. You are told the result, and you are told about the confidentiality rules that attach to it.",
        "Your own blood is collected and tested as soon as feasible with your consent. If you consent to the collection but not to HIV testing at that moment, the sample is held for at least ninety days so you can change your mind.",
        "You receive post-exposure prophylaxis where it is medically indicated, counselling, and evaluation of any illness that follows. The evaluating professional's written opinion goes to the pharmacy within fifteen days and is limited to whether the hepatitis B vaccine is indicated and whether you have been told what you need to know — no other medical finding is shared with the employer.",
        "The incident is recorded in the sharps injury log, which is kept without your name in it: the device involved, the department and how it happened, so that the same device does not injure the next person.",
        "Your confidential medical record is kept for the duration of your employment plus thirty years.",
      ],
      takeaways: [
        "Wash or flush, then report immediately — hours matter.",
        "Evaluation, testing, prophylaxis and follow-up are all free and confidential.",
        "The employer learns only whether the vaccine is indicated and that you were informed.",
      ],
    },
    {
      heading: "Labels, waste and spills",
      body: [
        "Biohazard labels are fluorescent orange or orange-red with the biohazard symbol in a contrasting colour, and go on sharps containers, refrigerators holding potentially infectious material, and any container of regulated waste. Red bags or red containers may be used instead of a label.",
        "Regulated waste means liquid or semi-liquid blood, items that would release blood if compressed, items caked with dried blood, contaminated sharps, and pathological waste. A bandage with a spot of blood on it is not regulated waste; the sharps that drew it are.",
        "Contaminated sharps go in the sharps container, not the trash, not the sink, and never in a bag.",
        "For a blood spill: gloves on, absorb with paper towels, clean the area, then disinfect with an EPA-registered disinfectant effective against HBV and HIV, or freshly diluted household bleach. Give the disinfectant its contact time — wiping it straight off does nothing.",
        "Pick up broken glass with tongs, forceps or a brush and dustpan — never with your hands, gloved or not.",
        "Bag the waste, remove your gloves without touching the outside of them, and wash your hands.",
        "The written exposure control plan is kept in the pharmacy and you may read it at any time. Ask the pharmacist-in-charge and it will be handed to you.",
      ],
      takeaways: [
        "Orange-red biohazard label or a red container; sharps never go in a bag.",
        "Absorb, clean, disinfect — and let the disinfectant sit for its contact time.",
        "Broken glass with tongs or a dustpan, never by hand.",
      ],
    },
    {
      heading: "The part a web page cannot do",
      body: [
        "The standard requires an opportunity for interactive questions and answers with a person knowledgeable in the subject — 29 CFR 1910.1030(g)(2)(vii)(N). A document, however good, is not that person.",
        "So the pharmacist-in-charge will spend a few minutes going through this with you and answering anything you want to ask, and will record on the pharmacy's system that he did and on what date. Your record is not complete, and no certificate is issued, until that has happened.",
        "Nothing further is required from you. Come with a question if you have one — the useful ones are usually about a situation that has actually come up rather than about the standard.",
      ],
      takeaways: [
        "The pharmacist-in-charge goes through this with you in person, and records it.",
        "Your training record and certificate are completed at that point, not before.",
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
      options: ["Immediately", "By the end of the shift", "Within 24 hours", "At the next staff meeting"],
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
    {
      q: "You declined the hepatitis B vaccine when you were hired. A year later you want it. What is the position?",
      options: [
        "You declined, so you would have to pay for it yourself",
        "You may have the series at any later time while still in a job with exposure, free of charge",
        "You would need a new exposure incident first",
        "You may have it, but only at the next annual training",
      ],
      answer: 1,
      why: "The standard specifically preserves that right. Declining is not a permanent decision and the offer stands for as long as you are in a job with occupational exposure.",
    },
    {
      q: "The sharps container by the immunization chair is full to the top. What do you do?",
      options: [
        "Press the contents down to make room",
        "Use it carefully until the next delivery",
        "Do not use it — it should have been replaced at the fill line; get a fresh one and have it removed",
        "Put the next needle beside it",
      ],
      answer: 2,
      why: "Containers are replaced at the fill line, never pressed down, and never reached into. Overfilled containers are how the person changing them gets injured.",
    },
    {
      q: "A patient faints and cuts their head; there is blood on the floor and a broken drinking glass. What is the right order?",
      options: [
        "Sweep up the glass by hand, then wipe the blood",
        "Gloves on, absorb the blood, clean, disinfect with an EPA-registered disinfectant or fresh bleach, and lift the glass with tongs or a dustpan",
        "Disinfect first, then pick everything up",
        "Wipe it up with paper towels and rinse them down the sink",
      ],
      answer: 1,
      why: "Absorb, clean, then disinfect with the contact time the product requires — and never touch broken glass, gloved or not.",
    },
    {
      q: "What does the pharmacy learn from the healthcare professional who evaluates you after an exposure?",
      options: [
        "Your full test results",
        "Only whether the hepatitis B vaccine is indicated and that you were told what you need to know",
        "Nothing at all",
        "Whatever the pharmacist-in-charge asks for",
      ],
      answer: 1,
      why: "The written opinion given to the employer is deliberately narrow. Everything else stays in your confidential medical record.",
    },
  ],
};
