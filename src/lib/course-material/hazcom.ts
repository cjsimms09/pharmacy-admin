import type { Course } from "./types";

/**
 * Hazard communication, scaled to what is actually in a retail pharmacy.
 *
 * The standard is written for chemical plants and applies to us too, which invites a training that
 * is nine tenths irrelevant. So this covers the chemicals that are genuinely here, the label and
 * the safety data sheet in enough detail to use them under pressure, and the one finding a
 * pharmacy actually gets: the unlabelled spray bottle behind the counter.
 */
export const hazcom: Course = {
  type: "osha_hazard_communication",
  title: "Hazard communication",
  authority:
    "29 CFR 1910.1200(h) — information and training on hazardous chemicals in the work area, at initial " +
    "assignment and whenever a new hazard is introduced.",
  whoMayTeach:
    "29 CFR 1910.1200(h) requires the employer to provide the information and training and names no qualification " +
    "for the trainer. This is in-house training delivered by the pharmacist-in-charge and it is not continuing " +
    "education.",
  intro:
    "There are hazardous chemicals in this pharmacy. Not many, and none exotic, but the standard applies and the " +
    "three things it really asks of you are that you can read a label, can find and use a safety data sheet, and " +
    "know what to do in the first two minutes after a splash.",
  objectives: [
    "List the hazardous chemicals kept in this pharmacy and where they are.",
    "Read a GHS label: signal word, hazard statements, precautionary statements and pictograms.",
    "Find a safety data sheet and go straight to the section you need.",
    "Label a secondary container correctly, which is the single most common finding against a pharmacy.",
    "Respond to a spill or a splash, and know which ones you do not clean up yourself.",
  ],
  seeAlso: [
    "The pharmacy's written hazard communication programme and chemical inventory.",
    "The safety data sheet binder, kept where the pharmacist-in-charge will show you.",
  ],
  references: [
    "29 CFR 1910.1200 — the hazard communication standard.",
    "29 CFR 1910.1200(g) — safety data sheets and their sixteen sections.",
    "29 CFR 1910.1200(f)(6) — workplace (secondary) container labelling.",
    "NIOSH List of Hazardous Drugs in Healthcare Settings, and 29 U.S.C. 654(a)(1), the general duty clause.",
  ],
  sections: [
    {
      heading: "What the standard actually requires of this pharmacy",
      body: [
        "Three things. A written hazard communication programme with a list of the hazardous chemicals kept here. A safety data sheet for each of them, accessible to you during your shift without having to ask permission. And training — this — at initial assignment and whenever a new hazard is introduced.",
        "Note what is not on that list: an annual refresher. Hazard communication training is not required annually the way bloodborne pathogens training is. This pharmacy runs it annually anyway, because the chemicals and the people both change and an annual cycle is easier to keep honest than a list of trigger events.",
        "Consumer products used the way a consumer would use them are outside the standard. A bottle of hand sanitiser at the register is not the same thing as a case of bulk sanitiser you decant from.",
      ],
      takeaways: [
        "A written programme, a safety data sheet you can reach, and training.",
        "Required at assignment and on a new hazard; we do it yearly regardless.",
      ],
    },
    {
      heading: "What is here",
      body: [
        "Cleaning and disinfecting products, isopropyl alcohol, bleach, hand sanitiser in bulk, printer and copier toners, and compressed gases if any are kept.",
        "Isopropyl alcohol and alcohol-based sanitiser are flammable in quantity. Keep them away from heat and do not store bulk quantities near the compounding bench or anything that gets hot.",
        "Bleach and ammonia-based cleaners must never be mixed — the reaction produces chloramine gas. That is the one chemical accident a pharmacy is genuinely likely to have, and it happens when somebody tops up a bucket.",
        "Hazardous drugs are handled under their own procedures, not this one. If this pharmacy handles any drug on the NIOSH hazardous drug list, the pharmacist-in-charge will tell you which and what is required — do not assume from the label alone. Crushing or splitting a tablet on that list, or counting it on a shared tray, is where the exposure actually happens in retail.",
      ],
      takeaways: [
        "Alcohol and sanitiser in bulk are flammable.",
        "Never mix bleach with an ammonia cleaner.",
        "Hazardous drugs have their own rules — ask which ones we hold.",
      ],
    },
    {
      heading: "Reading a label",
      body: [
        "Every shipped container carries six things: a product identifier, a signal word, hazard statements, precautionary statements, pictograms, and the supplier's name and contact details.",
        "There are exactly two signal words. 'Danger' is the more severe; 'Warning' is the less severe. There is no third one, and words like 'Caution' on an older container mean the label predates the current system.",
        "The pictograms worth knowing here: the flame for flammables, the corrosion symbol for things that burn skin, eyes or metal, the exclamation mark for irritants and less severe effects, the health hazard symbol — the silhouette with a star on the chest — for longer-term effects such as carcinogenicity, and the flame over a circle for oxidisers.",
        "Hazard statements say what the chemical does — 'Causes serious eye damage'. Precautionary statements say what to do about it — 'Wear eye protection', 'IF IN EYES: rinse cautiously with water for several minutes'. The second set is the one to read before you start, not after.",
        "Never remove or deface the label on a shipped container. If a label is illegible, take the container out of use and tell the pharmacist-in-charge.",
      ],
      takeaways: [
        "Two signal words only: Danger is worse than Warning.",
        "Hazard statements say what it does; precautionary statements say what to do.",
        "An illegible label means the container comes out of use.",
      ],
    },
    {
      heading: "Secondary containers — the finding a pharmacy actually gets",
      body: [
        "If you pour a chemical into another container and it will not be used up by you, on that shift, under your control, it has to be labelled with the product identifier and the hazard information.",
        "An unlabelled spray bottle behind the counter is the classic hazard communication citation and it is thirty seconds to prevent. Write the product name and, at minimum, the words from the original label's hazard statements.",
        "The exception is narrow and worth knowing precisely: a portable container into which you transfer a chemical, that is used only by you, and only during that shift. The moment you leave it for the next person, it needs a label.",
        "Never use a food or drink container for a chemical. Not once, not temporarily.",
      ],
      takeaways: [
        "Label anything that outlives your shift or leaves your hand.",
        "The unlabelled spray bottle is the citation we would actually get.",
        "Never a food or drink container, ever.",
      ],
    },
    {
      heading: "Safety data sheets",
      body: [
        "There is a safety data sheet for every hazardous chemical kept here, and you are entitled to see any of them at any time during your shift, without asking permission and without anyone asking why.",
        "They have sixteen standard sections, in the same order on every sheet from every manufacturer. That standardisation is the point: under pressure you do not read the sheet, you go straight to the section you need.",
        "Section 2 is the hazards. Section 4 is first aid. Section 7 is handling and storage. Section 8 is exposure controls and personal protection. Section 10 is what it reacts badly with. Those are the five worth remembering.",
        "They are in a known place in this pharmacy. If you do not know where, ask now rather than during an incident.",
      ],
      takeaways: [
        "Sixteen sections, always in the same order.",
        "Section 4 for first aid, section 8 for protection, section 2 for the hazards.",
        "Find the binder today, not during a spill.",
      ],
    },
    {
      heading: "If something spills or splashes",
      body: [
        "Small, familiar and safe to handle: gloves on, clean up, ventilate.",
        "Anything else — an unknown chemical, a large volume, fumes, a container that is bulging or hot, or any splash to eyes or skin — get away from it, move other people away, tell the pharmacist-in-charge, and follow the safety data sheet.",
        "For a splash to the eyes or skin: flush with water for fifteen minutes. Fifteen minutes is much longer than it feels; use a clock. Remove contaminated clothing while flushing. Do not stop early to go and find the safety data sheet — somebody else can bring it to you.",
        "Report every exposure, however minor it seems, and however embarrassing. A splash you rinsed off and said nothing about is a splash with no record if it turns into something a week later.",
      ],
      takeaways: [
        "Unknown, large, fuming, or on a person: step back and get the PIC.",
        "Flush eyes and skin for a full fifteen minutes, by the clock.",
        "Every exposure gets reported, however small.",
      ],
    },
    {
      heading: "Hazardous drugs, which are the real exposure here",
      body: [
        "The cleaning chemicals are the ones the standard is written about. The hazardous drugs are the ones that matter more, because the exposure is daily, invisible, and happens during work that feels routine.",
        "NIOSH publishes a List of Hazardous Drugs in Healthcare Settings. It has three groups: antineoplastic drugs; non-antineoplastic drugs that meet at least one hazard criterion; and drugs with reproductive effects that may pose a risk to somebody who is pregnant or trying to conceive. A community pharmacy stocks drugs from all three — methotrexate, finasteride and dutasteride, misoprostol, spironolactone, valproic acid, warfarin, carbamazepine, mycophenolate, and several others.",
        "The exposure route in retail is not what people imagine. It is not handling an intact tablet. It is dust: counting on a shared tray, crushing or splitting a tablet, opening a capsule, pouring a bulk bottle, and cleaning up a spill. Finasteride dust on a counting tray transfers to the next drug counted on it, and to the hands of the next person to use it.",
        "So the practical rules here are short. Ask the pharmacist-in-charge which drugs we hold from that list, and know them. Use a dedicated counting tray and spatula for them, kept separate and cleaned after every use. Wear gloves, and use two pairs where the pharmacy's own procedure says so. Never crush, split or open a capsule of one of these outside the procedure — bring it to the pharmacist. Do not let a pregnant employee, or one trying to conceive, handle group three drugs; that is a conversation to have privately with the pharmacist-in-charge and it is nobody else's business.",
        "USP <800> is the standard behind those rules. This pharmacy's own assessment of risk determines exactly which of them apply to which drug, and that assessment is the pharmacist-in-charge's — do not infer it from a label.",
      ],
      takeaways: [
        "The real exposure is dust: counting trays, crushing, splitting, opening capsules.",
        "Dedicated tray and spatula for hazardous drugs, cleaned after every use.",
        "Ask which drugs we hold from the NIOSH list. Never guess from the label.",
      ],
    },
    {
      heading: "The other physical hazards in a pharmacy",
      body: [
        "Hazard communication is the chemical standard, but the general duty clause — 29 U.S.C. 654(a)(1) — obliges the pharmacy to provide a workplace free from recognised hazards likely to cause death or serious harm, and the ones here are not chemical.",
        "Slips and falls. Water by the sink, a spilled liquid, a cable across a walkway, a step-stool used as a ladder. Clean it now rather than after; the pharmacy has mats and a wet-floor sign and both work only if used.",
        "Lifting. Cases of fluids and bulk stock arrive heavy and at bad heights. Bend at the knees, keep the load close, do not twist under it, and ask for help rather than proving something. A back injury in a three-person pharmacy is everybody's problem for six weeks.",
        "Reaching. Use the step-stool for the top shelf. Standing on a chair with castors is how people break wrists.",
        "Repetitive strain and posture. Counting, typing and standing all day. Adjust the screen height, alternate tasks where you can, and say something early rather than after three months of pain.",
        "Sharps and glass. Broken bottles get a dustpan, never hands. Needles are covered by the bloodborne training and never go anywhere but a sharps container.",
        "Report every injury, and every near miss, to the pharmacist-in-charge. An unreported injury has no record if it turns into something, and the near miss is the free lesson.",
      ],
      takeaways: [
        "Clean spills now; use the step-stool, never a chair.",
        "Lift with the knees, keep it close, ask for help.",
        "Report every injury and near miss, however small it seems.",
      ],
    },
  ],
  questions: [
    {
      q: "Where does hazardous drug exposure actually happen in a retail pharmacy?",
      options: [
        "Handling intact tablets in their bottles",
        "Dust — counting on a shared tray, crushing, splitting, opening capsules, and spills",
        "Only during compounding",
        "It does not happen outside a hospital",
      ],
      answer: 1,
      why: "The tablet in the bottle is not the problem. Finasteride dust left on a shared counting tray transfers to the next drug counted on it and to the next pair of hands.",
    },
    {
      q: "You are asked to split a tablet you think may be on the hazardous drug list. What do you do?",
      options: [
        "Split it with gloves on",
        "Split it and wash your hands afterwards",
        "Stop and ask the pharmacist-in-charge — the pharmacy's own assessment decides what applies",
        "Check the label; if it says nothing, it is fine",
      ],
      answer: 2,
      why: "The NIOSH list and this pharmacy's risk assessment decide, not the label. Asking costs nothing and this is exactly the moment exposure would happen.",
    },

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
      why: "Under GHS there are two signal words: Danger for the more severe hazards and Warning for the less severe. 'Caution' and 'Notice' are not GHS signal words at all.",
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
      why: "Safety data sheets have sixteen standard sections in a fixed order. Section 4 is first aid and section 8 is exposure controls and personal protection.",
    },
    {
      q: "A cleaner splashes into your eye. What do you do first?",
      options: [
        "Find the safety data sheet, then act on it",
        "Flush the eye with water for fifteen minutes and have somebody else bring the sheet",
        "Rinse briefly and see whether it stings",
        "Finish serving the patient, then rinse",
      ],
      answer: 1,
      why: "Flushing starts immediately and runs for a full fifteen minutes. The sheet is useful but it is not worth the delay, and somebody else can fetch it.",
    },
    {
      q: "Somebody has topped up a mop bucket of bleach solution with an ammonia-based cleaner. What is the concern?",
      options: [
        "The solution will be too weak",
        "It will stain the floor",
        "The mixture produces chloramine gas — leave the area and get the pharmacist-in-charge",
        "Nothing, they are both disinfectants",
      ],
      answer: 2,
      why: "This is the chemical accident a pharmacy realistically has. It is a reason to leave the area and ventilate it, not to open a window and carry on mopping.",
    },
  ],
};
