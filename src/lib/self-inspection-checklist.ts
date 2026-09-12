import "server-only";

/**
 * What to look at when walking the pharmacy.
 *
 * Written as the questions an inspector asks standing in the room, not as a restatement of the
 * regulations. "Is the registration displayed where the public can see it" is answerable by
 * looking up; "the pharmacy shall display its certificate of registration" is answerable only by
 * someone who already knows what they are looking for. The citation is on each item for the
 * moment somebody asks why it is being asked.
 *
 * Every item is answerable ok / finding / not applicable. That third option matters as much as
 * the others: a pharmacy that does not compound should record that it does not compound, not
 * quietly tick the compounding items as fine. A checklist where everything is always green is a
 * checklist nobody reads.
 *
 * The order is the order you would physically walk it — front of shop, then the counter, then the
 * safe, then the back — because a list ordered by regulation number makes you criss-cross the
 * pharmacy and is how items get skipped.
 */

export type ChecklistItem = {
  key: string;
  /** The question, as asked standing in the room. */
  ask: string;
  /** Why it is being asked. */
  authority: string;
  /** What "good" looks like, where it is not obvious. */
  looksLike?: string;
  /**
   * Where in this site the thing is fixed.
   *
   * A checklist that tells a pharmacist-in-charge they have a problem and then leaves them to
   * find the screen that solves it is doing half a job. Where the site holds the tool, the
   * finding links straight to it.
   */
  fixHref?: string;
  /**
   * Set where the site already knows the answer.
   *
   * These are pre-answered from the records the site keeps, with the evidence shown, so the
   * walkthrough is spent on the things that genuinely need eyes — the fridge, the bins, the
   * shelves — rather than on re-checking what the software has been tracking all along.
   */
  autoKey?: "temperature_logs" | "training_records" | "technician_list" | "baas" | "cqi_records" | "licences_current" | "biennial_inventory";
};

export type ChecklistSection = {
  key: string;
  title: string;
  /** Where you are standing. */
  where: string;
  items: ChecklistItem[];
};

export const CHECKLIST: ChecklistSection[] = [
  {
    key: "front",
    title: "Front of the shop",
    where: "Standing where a patient stands.",
    items: [
      {
        key: "registration_displayed",
        ask: "Is the current pharmacy registration displayed where the public can see it?",
        authority: "K.S.A. 65-1643; K.A.R. 68-7-11.",
        looksLike: "The current certificate, not last year's, visible without asking.",
      },
      {
        key: "pharmacist_identified",
        ask: "Can a patient tell who the pharmacist on duty is?",
        authority: "K.A.R. 68-1-1a — identification of personnel.",
        looksLike: "Name badges, or the pharmacist's name displayed.",
      },
      {
        key: "npp_posted",
        fixHref: "/documents",
        ask: "Is the Notice of Privacy Practices posted and available to take?",
        authority: "45 CFR 164.520 — the notice must be posted and provided.",
      },
      {
        key: "counselling_area",
        ask: "Is there somewhere a patient can be counselled without being overheard from the line?",
        authority: "K.A.R. 68-5-16 — patient counselling.",
        looksLike: "A distinct area, or a practice of stepping aside. Not a gap in the queue.",
      },
      {
        key: "hours_posted",
        ask: "Are the pharmacy's hours posted, and does the department close when no pharmacist is present?",
        authority: "K.A.R. 68-7-11 — the pharmacy must be closed and secured when no pharmacist is on duty.",
      },
    ],
  },
  {
    key: "counter",
    title: "The counter and the workflow",
    where: "Behind the counter, watching a prescription being filled.",
    items: [
      {
        key: "labels",
        ask: "Do finished labels carry everything they must — patient, drug, strength, directions, prescriber, date, quantity, refills, pharmacy, and the serial number?",
        authority: "K.A.R. 68-7-12; 21 CFR 1306.24 for controlled substances.",
      },
      {
        key: "cs_warning_label",
        ask: "Do Schedule II–IV labels carry the federal transfer warning?",
        authority: "21 CFR 1306.14(c) — 'Caution: Federal law prohibits the transfer of this drug to any person other than the patient for whom it was prescribed.'",
      },
      {
        key: "counselling_offered",
        ask: "Is counselling actually offered on new prescriptions, and is a refusal recorded?",
        authority: "K.A.R. 68-5-16.",
        looksLike: "Ask a technician what they say. If the answer is 'we ask if they have questions', that is the finding.",
      },
      {
        key: "final_check",
        ask: "Does a pharmacist perform and record the final verification of every prescription?",
        authority: "K.A.R. 68-5-17 — the pharmacist's responsibility for the final product.",
      },
      {
        key: "tech_ratio",
        ask: "Is the pharmacist-to-technician ratio within what Kansas allows at every hour you are open?",
        authority: "K.S.A. 65-1663.",
        looksLike: "Check the busiest shift, not today's.",
      },
      {
        key: "will_call_privacy",
        ask: "Are bagged prescriptions in will-call stored so a patient cannot read another patient's name?",
        authority: "45 CFR 164.530(c) — reasonable safeguards.",
      },
    ],
  },
  {
    key: "controlled",
    title: "Controlled substances",
    where: "At the safe, and at the shelf where III–V are dispersed.",
    items: [
      {
        key: "cii_storage",
        ask: "Are Schedule II drugs in a securely locked, substantially constructed cabinet — or dispersed through the stock in a way that genuinely obstructs theft?",
        authority: "21 CFR 1301.75(b).",
      },
      {
        key: "cs_access",
        fixHref: "/staff",
        ask: "Is access to the safe limited to people who need it, and does that list match who actually works here now?",
        authority: "21 CFR 1301.71 — effective controls against diversion.",
        looksLike: "A code that three former employees still know is a finding whether or not anyone has used it.",
      },
      {
        key: "biennial_inventory",
        fixHref: "/inventory",
        autoKey: "biennial_inventory",
        ask: "Is the most recent controlled substance inventory on file, dated, signed, and taken at opening or close?",
        authority: "21 CFR 1304.11 — biennial at minimum; Kansas expects annual.",
      },
      {
        key: "cii_records_separate",
        ask: "Are Schedule II records kept separately, and are III–V records readily retrievable?",
        authority: "21 CFR 1304.04(h).",
        looksLike: "'Readily retrievable' means produced while the inspector waits, not found later.",
      },
      {
        key: "222_forms",
        fixHref: "/inventory/power-of-attorney",
        ask: "Are executed 222 forms and CSOS records complete, with the powers of attorney filed alongside them?",
        authority: "21 CFR 1305.",
      },
      {
        key: "invoices",
        ask: "Are invoices for Schedules III–V dated on receipt and filed where they can be produced?",
        authority: "21 CFR 1304.21 and 1304.22.",
      },
      {
        key: "losses_reported",
        fixHref: "/inventory/discrepancies",
        ask: "Has every loss, theft or significant discrepancy been reported to the field office within one business day and followed by a Form 106?",
        authority: "21 CFR 1301.74(c), 1301.76(b).",
      },
      {
        key: "destruction",
        fixHref: "/inventory/discrepancies",
        ask: "Are destructions and returns to a reverse distributor documented, with Form 41 or the distributor's receipt on file?",
        authority: "21 CFR 1317.",
      },
      {
        key: "refill_log",
        fixHref: "/inventory/pharmacist-log",
        ask: "Is the daily pharmacist review log for Schedule III and IV refill data being signed, every day the pharmacy is open?",
        authority: "21 CFR 1306.22(f).",
        looksLike: "A run of blank days is the finding. A closed day should say so.",
      },
      {
        key: "ktracs",
        fixHref: "/compliance",
        ask: "Are dispensings reaching K-TRACS, and is somebody checking that they arrived?",
        authority: "K.S.A. 65-1683.",
      },
    ],
  },
  {
    key: "records",
    title: "Records and files",
    where: "At the filing cabinet and the computer.",
    items: [
      {
        key: "rx_retention",
        fixHref: "/documents",
        ask: "Are prescription records kept five years and retrievable by patient, drug and prescriber?",
        authority: "K.A.R. 68-7-12.",
      },
      {
        key: "policy_manual",
        fixHref: "/documents",
        ask: "Is there a current policy and procedure manual, and has anyone read it this year?",
        authority: "K.A.R. 68-7-11.",
        looksLike: "Ask a technician where it is. The answer tells you more than the manual does.",
      },
      {
        key: "cqi_records",
        fixHref: "/cqi",
        autoKey: "cqi_records",
        ask: "Are CQI records complete — events logged, reviews started within seven days, summaries every two months?",
        authority: "K.A.R. 68-19-1.",
      },
      {
        key: "training_records",
        fixHref: "/compliance/training/records",
        autoKey: "training_records",
        ask: "Can you produce every member of staff's training records on the spot?",
        authority: "45 CFR 164.530(b); 29 CFR 1910.1030(h)(2).",
      },
      {
        key: "technician_list",
        fixHref: "/staff/technician-list",
        autoKey: "technician_list",
        ask: "Is the technician list current and available for inspection?",
        authority: "K.S.A. 65-1663(i).",
      },
    ],
  },
  {
    key: "storage",
    title: "Storage, equipment and the room itself",
    where: "Walking the shelves, the fridge and the back.",
    items: [
      {
        key: "expired_segregated",
        ask: "Is any expired, damaged or recalled stock physically separated from dispensable stock and clearly marked?",
        authority: "K.A.R. 68-7-11; USP standards.",
        looksLike: "Pull three bottles at random from the fast-movers and check the dates yourself.",
      },
      {
        key: "temperature_logs",
        fixHref: "/temps",
        autoKey: "temperature_logs",
        ask: "Are refrigerator and room temperatures being recorded, with every excursion explained?",
        authority: "CDC Vaccine Storage and Handling Toolkit; USP 1079.",
      },
      {
        key: "fridge_dedicated",
        ask: "Is the vaccine refrigerator used for medication only, with no food or drink in it?",
        authority: "CDC Vaccine Storage and Handling Toolkit.",
      },
      {
        key: "sanitation",
        ask: "Is the dispensing area clean, with a working sink, hot and cold water, and soap?",
        authority: "K.A.R. 68-7-11.",
      },
      {
        key: "references",
        ask: "Are current references available — current enough to be useful, not just present?",
        authority: "K.A.R. 68-7-11.",
      },
      {
        key: "equipment",
        ask: "Is measuring and counting equipment clean, calibrated where it needs to be, and separate for hazardous drugs?",
        authority: "K.A.R. 68-7-11; USP 800 where hazardous drugs are handled.",
      },
      {
        key: "sharps",
        ask: "Are sharps containers below the fill line, labelled, and out of public reach?",
        authority: "29 CFR 1910.1030(d)(4).",
      },
    ],
  },
  {
    key: "compounding",
    title: "Compounding",
    where: "At the bench where non-sterile preparations are made.",
    items: [
      {
        key: "compounding_scope",
        ask: "Is everything being compounded within what the manual actually permits — simple, non-sterile, non-hazardous, from commercially available ingredients?",
        authority: "USP 795; the pharmacy's own compounding policy.",
        looksLike: "Anything outside that scope needs the policy changed first, not the practice explained afterwards.",
      },
      {
        key: "compounding_records",
        ask: "Is there a record for each preparation — the formula, the ingredients and their lot numbers and expiry, who made it, and who checked it?",
        authority: "USP 795; K.A.R. 68-7-12.",
        looksLike: "This is the first thing asked for and the most commonly absent. A label without a compounding record behind it is the finding.",
      },
      {
        key: "compounding_bud",
        ask: "Does every compounded preparation carry a beyond-use date, assigned by a stated rule rather than by guess?",
        authority: "USP 795 default beyond-use dates.",
      },
      {
        key: "compounding_equipment",
        ask: "Is compounding equipment clean, dedicated where it needs to be, and is the balance within calibration if one is used?",
        authority: "USP 795; K.A.R. 68-7-11.",
      },
      {
        key: "compounding_area",
        ask: "Is there a defined compounding area, kept clean and separate from routine dispensing traffic?",
        authority: "USP 795.",
      },
      {
        key: "compounding_ingredients",
        ask: "Are bulk ingredients labelled with their source, lot and expiry, and is a certificate of analysis on file where one is required?",
        authority: "USP 795.",
      },
    ],
  },
  {
    key: "immunization",
    title: "Immunizations",
    where: "At the immunization station.",
    items: [
      {
        key: "protocol_current",
        fixHref: "/staff",
        ask: "Is the physician-signed protocol current, and does it cover every vaccine actually being given?",
        authority: "K.S.A. 65-1635a.",
      },
      {
        key: "immunizer_credentials",
        fixHref: "/staff",
        ask: "Does every person immunizing hold current training and a current CPR card?",
        authority: "K.S.A. 65-1635a.",
      },
      {
        key: "emergency_kit",
        fixHref: "/compliance",
        ask: "Is epinephrine present, in date, and is the equipment to manage a reaction to hand?",
        authority: "Standard of practice for administering vaccines.",
        looksLike: "Check the expiry with your own eyes. This is the single most commonly expired item in a pharmacy.",
      },
      {
        key: "vis",
        ask: "Is the current Vaccine Information Statement being given, and the date of the VIS recorded?",
        authority: "42 U.S.C. 300aa-26.",
      },
      {
        key: "registry",
        ask: "Are administrations being reported to the state immunization registry?",
        authority: "Kansas immunization registry requirements.",
      },
    ],
  },
  {
    key: "people",
    title: "People and privacy",
    where: "Anywhere. Ask, do not look.",
    items: [
      {
        key: "licences_current",
        fixHref: "/staff",
        autoKey: "licences_current",
        ask: "Is every licence and registration current, and displayed or produceable?",
        authority: "K.S.A. 65-1657, 65-1663.",
      },
      {
        key: "logins",
        ask: "Does everyone use their own login, and has every departed employee's access been removed?",
        authority: "45 CFR 164.308(a)(3)(ii)(C) — termination procedures.",
        looksLike: "A shared login makes every audit trail worthless, including the one that would protect your staff.",
      },
      {
        key: "screens",
        ask: "Are screens positioned so a patient at the counter cannot read them, and locked when unattended?",
        authority: "45 CFR 164.530(c).",
      },
      {
        key: "shredding",
        ask: "Is anything with a patient's name on it going into a shred bin rather than a bin?",
        authority: "45 CFR 164.530(c).",
        looksLike: "Look in the actual bin. That is where this is found.",
      },
      {
        key: "baas",
        fixHref: "/agreements",
        autoKey: "baas",
        ask: "Does every vendor who can see patient information have a current signed agreement?",
        authority: "45 CFR 164.502(e).",
      },
      {
        key: "exclusion_screening",
        fixHref: "/compliance",
        ask: "Has everyone been screened against the OIG exclusion list, and does anyone with access to controlled substances have a DEA screening record?",
        authority: "42 CFR 1001.1901; 21 CFR 1301.90–1301.93.",
      },
    ],
  },
];

export const ALL_ITEMS = CHECKLIST.flatMap((s) => s.items.map((i) => ({ ...i, section: s.title, sectionKey: s.key })));

export function itemFor(key: string) {
  return ALL_ITEMS.find((i) => i.key === key);
}

export const ITEM_COUNT = ALL_ITEMS.length;
