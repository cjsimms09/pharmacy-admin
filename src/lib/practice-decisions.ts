import "server-only";
import { getSettings, setSetting } from "./settings";

/**
 * The handful of facts about how this pharmacy actually works that its manual depends on.
 *
 * The policy reviewer is forbidden from inventing facts about the pharmacy, which is right: a
 * manual is a standard an inspector holds the pharmacy to, and a frequency somebody's software
 * guessed is a finding the pharmacy wrote for itself. But the consequence was twenty-three findings
 * that all said, in different words, "the pharmacy has to decide this" — and no place to decide it.
 * Each one came back on the next pass, unchanged, for ever.
 *
 * So the questions are gathered here, asked once, with a recommended answer for each. Answering
 * turns a sentence on: the fact sheet the reviewer is given grows by that sentence, the sections
 * that were only waiting on it go back in the queue, and the next pass writes the text rather than
 * asking again. Nothing here is a default that applies until it is answered — an unanswered
 * question contributes nothing, and the reviewer still refuses to guess.
 *
 * They live in one settings row as JSON rather than in ten columns, because the list will change
 * as the manual does and a migration per question is a reason not to add one.
 */

export type Choice = {
  value: string;
  label: string;
  /** The sentence this answer contributes to the fact sheet, in the pharmacy's own voice. */
  sentence: string;
  /** Marked as the one most pharmacies of this size land on, and why. */
  recommended?: boolean;
};

export type Decision = {
  key: string;
  /** What the manual is waiting to be told. */
  question: string;
  /** Why the manual cannot be written without it, in terms of what a section says. */
  why: string;
  /** Which part of the manual this unblocks, for the person deciding. */
  affects: string;
  choices: Choice[];
  /** Where an answer needs words rather than a choice: the prompt and how to phrase the sentence. */
  freeText?: { placeholder: string; sentence: (value: string) => string };
};

export const DECISIONS: Decision[] = [
  {
    key: "reg_watch",
    question: "How often does the pharmacist in charge check for regulatory changes, and where?",
    why:
      "The Regulatory Updates section instructs the reader to establish a schedule rather than stating one, so an " +
      "inspector asking who watches for changes and how often gets no answer from the manual.",
    affects: "Regulatory Updates and Compliance Monitoring",
    choices: [
      {
        value: "quarterly",
        label: "Quarterly",
        recommended: true,
        sentence:
          "The pharmacist in charge reviews the Kansas Board of Pharmacy website and newsletter, the DEA Diversion " +
          "Control Division site and the FDA DSCSA pages once a quarter for changes affecting the pharmacy. Where a " +
          "change reaches the counter, the affected policy and the affected training course are both revised and " +
          "reissued; no separate register of updates is kept.",
      },
      {
        value: "monthly",
        label: "Monthly",
        sentence:
          "The pharmacist in charge reviews the Kansas Board of Pharmacy website and newsletter, the DEA Diversion " +
          "Control Division site and the FDA DSCSA pages monthly for changes affecting the pharmacy. Where a change " +
          "reaches the counter, the affected policy and the affected training course are both revised and reissued; " +
          "no separate register of updates is kept.",
      },
      {
        value: "annually",
        label: "Annually, with the manual review",
        sentence:
          "The pharmacist in charge reviews the Kansas Board of Pharmacy website and newsletter, the DEA Diversion " +
          "Control Division site and the FDA DSCSA pages once a year alongside the annual manual review. Where a " +
          "change reaches the counter, the affected policy and the affected training course are both revised and " +
          "reissued; no separate register of updates is kept.",
      },
    ],
  },
  {
    key: "perpetual_inventory",
    question: "Does the pharmacy keep a running (perpetual) count of controlled substances, and for which schedules?",
    why:
      "The reconciliation and adjustment procedures in the inventory section assume a perpetual inventory exists. If " +
      "one does not, those procedures have nothing to reconcile against and should not be in the manual.",
    affects: "Annual and Biennial Inventory",
    choices: [
      {
        value: "c2",
        label: "Yes, Schedule II only",
        recommended: true,
        sentence:
          "A perpetual inventory of Schedule II controlled substances is maintained in the pharmacy dispensing system. " +
          "Receipts are posted as invoices are checked in and dispensings post automatically; the perpetual count is " +
          "reconciled against a physical count at each periodic inventory and whenever a discrepancy is suspected.",
      },
      {
        value: "all",
        label: "Yes, all controlled schedules",
        sentence:
          "A perpetual inventory of all controlled substances the pharmacy holds is maintained in the pharmacy " +
          "dispensing system. Receipts are posted as invoices are checked in and dispensings post automatically; the " +
          "perpetual count is reconciled against a physical count at each periodic inventory and whenever a " +
          "discrepancy is suspected.",
      },
      {
        value: "none",
        label: "No perpetual inventory is kept",
        sentence:
          "The pharmacy does not maintain a perpetual inventory. Controlled substance counts are established by " +
          "physical inventory on the dates this manual requires, and the manual's procedures are written on that basis.",
      },
    ],
  },
  {
    key: "biennial_anchor",
    question: "What date is the biennial controlled substance inventory anchored to?",
    why:
      "21 CFR 1304.11(c) allows the biennial inventory on any date within two years of the previous one. A rule that " +
      "says 'odd-numbered years' permits January 2025 and December 2027 — thirty-five months apart — and still reads " +
      "as compliant, so the manual needs a fixed anniversary.",
    affects: "Annual and Biennial Inventory",
    choices: [
      {
        value: "may1",
        label: "1 May, every second year",
        recommended: true,
        sentence:
          "The biennial controlled substance inventory is taken on 1 May of each odd-numbered year, and in no case " +
          "more than two years after the date of the previous biennial inventory. The annual inventory is taken on 1 " +
          "May of the intervening year, so that a complete count falls on the same date every year.",
      },
      {
        value: "jan1",
        label: "1 January, every second year",
        sentence:
          "The biennial controlled substance inventory is taken on 1 January of each odd-numbered year, and in no case " +
          "more than two years after the date of the previous biennial inventory. The annual inventory is taken on 1 " +
          "January of the intervening year, so that a complete count falls on the same date every year.",
      },
      {
        value: "anniversary",
        label: "The anniversary of the last one",
        sentence:
          "The biennial controlled substance inventory is taken on the anniversary of the date of the previous " +
          "biennial inventory, and in no case more than two years after it. The date of each inventory is recorded on " +
          "the inventory itself, and that record fixes the date the next one is due.",
      },
    ],
  },
  {
    key: "second_counter",
    question: "Is a second person required to verify a controlled substance count?",
    why:
      "The inventory section says to use a second counter 'when possible', which cannot be audited and so amounts to " +
      "no requirement at all. In a pharmacy whose stated purpose for counting is detecting diversion, that is the " +
      "control doing the work.",
    affects: "Annual and Biennial Inventory",
    choices: [
      {
        value: "c2_required",
        label: "Yes, for Schedule II",
        recommended: true,
        sentence:
          "Schedule II counts at a periodic inventory are verified by a second person, who signs the inventory " +
          "alongside the counter. Schedule III to V counts are performed by one person unless the pharmacist in " +
          "charge directs otherwise.",
      },
      {
        value: "all_required",
        label: "Yes, for every controlled substance",
        sentence:
          "Every controlled substance count at a periodic inventory is verified by a second person, who signs the " +
          "inventory alongside the counter.",
      },
      {
        value: "not_required",
        label: "No, one counter is enough",
        sentence:
          "Controlled substance counts are performed by one person, who signs the inventory. The pharmacist in charge " +
          "reviews and signs the completed inventory, and that review is the verification step.",
      },
    ],
  },
  {
    key: "inventory_notice",
    question: "How much notice do staff get before a controlled substance inventory?",
    why:
      "The manual commits the pharmacist in charge to giving two weeks' notice. That is a testable promise, and it " +
      "sits awkwardly with counting as a way of detecting diversion.",
    affects: "Annual and Biennial Inventory",
    choices: [
      {
        value: "none",
        label: "No advance notice",
        recommended: true,
        sentence:
          "Staff are not given advance notice of a controlled substance inventory. The pharmacist in charge schedules " +
          "it and tells those taking part on the day.",
      },
      {
        value: "week",
        label: "About a week",
        sentence:
          "Staff taking part in a controlled substance inventory are told roughly a week beforehand so that the " +
          "rota allows for it.",
      },
    ],
  },
  {
    key: "expiry_checks",
    question: "How often are shelves, will-call and compounding stock checked for expiry?",
    why:
      "The Disposal section says 'routinely', which gives the pharmacist in charge nothing to measure compliance " +
      "against and an inspector nothing to test.",
    affects: "Disposal",
    choices: [
      {
        value: "monthly",
        label: "Monthly",
        recommended: true,
        sentence:
          "Shelf stock, will-call and compounding components are checked for expiry once a month. Anything expiring " +
          "within three months is pulled to the quarantine area for return or destruction, and the check is recorded.",
      },
      {
        value: "quarterly",
        label: "Quarterly",
        sentence:
          "Shelf stock, will-call and compounding components are checked for expiry once a quarter. Anything expiring " +
          "within three months is pulled to the quarantine area for return or destruction, and the check is recorded.",
      },
    ],
  },
  {
    key: "collector",
    question: "Does the pharmacy take back controlled substances from patients?",
    why:
      "The Disposal section is written conditionally — 'if accepted for destruction' — which reads as permission. " +
      "21 CFR 1317.30 allows a pharmacy to receive controlled substances from a patient only if its registration is " +
      "modified to authorise collection, and only by receptacle or mail-back.",
    affects: "Disposal",
    choices: [
      {
        value: "no",
        label: "No, we are not an authorised collector",
        recommended: true,
        sentence:
          "The pharmacy is not a DEA authorised collector and does not accept controlled substances returned by " +
          "patients under any circumstances. Patients asking about disposal are directed to a local law enforcement " +
          "take-back or an authorised collection site.",
      },
      {
        value: "receptacle",
        label: "Yes, by collection receptacle",
        sentence:
          "The pharmacy is a DEA authorised collector and maintains a collection receptacle for controlled " +
          "substances returned by ultimate users, operated in accordance with 21 CFR 1317.75. Contents are never " +
          "counted, sorted or handled, and inner liners are sealed and transferred in the presence of two employees.",
      },
      {
        value: "mailback",
        label: "Yes, by mail-back envelopes",
        sentence:
          "The pharmacy is a DEA authorised collector and makes mail-back envelopes available to patients in " +
          "accordance with 21 CFR 1317.70. The pharmacy does not receive, handle or store the returned contents.",
      },
    ],
  },
  {
    key: "record_storage",
    question: "Where are controlled substance inventories and records physically kept?",
    why:
      "The manual sends prior-year records to archival storage in the building's lower level. If that is outside the " +
      "registered premises, the records are in the wrong place: 21 CFR 1304.04(a) requires them at the registered " +
      "location, and central storage of inventories and Schedule II records elsewhere is expressly not permitted.",
    affects: "Annual and Biennial Inventory",
    choices: [
      {
        value: "onsite",
        label: "All of them, inside the pharmacy",
        recommended: true,
        sentence:
          "Signed controlled substance inventories are kept as printed records at the registered location, in the " +
          "pharmacy itself, for the full retention period, and are produced on request during an inspection. Nothing " +
          "is moved off the registered premises. Retention and backup of the pharmacy's other compliance records " +
          "follow the pharmacy's records arrangements rather than a separate scheme for this one record type.",
      },
      {
        value: "lower_level",
        label: "Current year in the pharmacy, older years in the building's lower level",
        sentence:
          "Signed controlled substance inventories for the current year are kept in the pharmacy at the registered " +
          "location. Earlier years are archived in the lower level of the same building, which is part of the " +
          "registered premises, and are produced on request during an inspection.",
      },
    ],
  },
  {
    key: "inventory_training",
    question: "Which training course carries the inventory content?",
    why:
      "The inventory section sets up its own training scheme with its own frequency and its own records, alongside " +
      "the in-house courses the pharmacy already delivers and records. Two regimes for the same staff drift apart, " +
      "and the one in the manual is the one that goes stale.",
    affects: "Annual and Biennial Inventory",
    choices: [
      {
        value: "diversion",
        label: "Controlled substance diversion awareness",
        recommended: true,
        sentence:
          "Staff who take part in controlled substance inventories are trained through the pharmacy's own controlled " +
          "substance diversion awareness course, which carries the inventory content. Assignment, completion and " +
          "certificates are recorded in the pharmacy's training register; this manual creates no separate training " +
          "obligation or record.",
      },
      {
        value: "separate",
        label: "A separate inventory course of its own",
        sentence:
          "Staff who take part in controlled substance inventories are trained through a dedicated inventory course " +
          "maintained by the pharmacy. Assignment, completion and certificates are recorded in the pharmacy's " +
          "training register; this manual creates no separate record.",
      },
    ],
  },
  {
    key: "estimated_counts",
    question: "May Schedule III to V stock be counted by estimate, or is an exact count always required?",
    why:
      "The manual states the rule three times and the three do not agree: one place allows estimation only for " +
      "Schedule V liquids, another allows it across Schedules III to V, and a third withdraws it again. Staff " +
      "following the middle one would estimate stock the first forbids, and an inspector may hold the pharmacy to " +
      "whichever sentence is least favourable.",
    affects: "Annual and Biennial Inventory",
    choices: [
      {
        value: "exact",
        label: "Exact counts for everything",
        recommended: true,
        sentence:
          "Every controlled substance is counted exactly at a periodic inventory, whatever its schedule. The pharmacy " +
          "counts more strictly than 21 CFR 1304.11(e)(3) requires, which permits an estimate for an unopened " +
          "container of more than one thousand tablets in Schedules III to V; that allowance is not used here. This " +
          "rule is stated once and applies to the annual, biennial and combined procedures alike.",
      },
      {
        value: "federal",
        label: "Estimates allowed where federal law allows them",
        sentence:
          "Schedule II substances are always counted exactly. For Schedules III to V, an estimated count of an " +
          "unopened container is permitted only where 21 CFR 1304.11(e)(3) permits it — a commercial container " +
          "holding more than one thousand tablets or capsules — and an exact count is taken in every other case. This " +
          "rule is stated once and applies to the annual, biennial and combined procedures alike.",
      },
    ],
  },
];

export type DecisionState = Decision & { answer: string | null; sentence: string | null };

const SETTING = "practice_decisions";

function parse(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function practiceDecisions(): Promise<DecisionState[]> {
  const s = await getSettings();
  const answers = parse(s[SETTING as keyof typeof s] as string | undefined);
  return DECISIONS.map((d) => {
    const answer = answers[d.key] ?? null;
    const chosen = answer ? d.choices.find((c) => c.value === answer) ?? null : null;
    const sentence = chosen ? chosen.sentence : answer && d.freeText ? d.freeText.sentence(answer) : null;
    return { ...d, answer, sentence };
  });
}

/** Records one answer. An empty value unanswers the question rather than storing a blank. */
export async function answerDecision(key: string, value: string): Promise<void> {
  const known = DECISIONS.find((d) => d.key === key);
  if (!known) throw new Error("That is not a question this manual asks.");
  const clean = value.trim();
  if (clean && !known.freeText && !known.choices.some((c) => c.value === clean)) {
    throw new Error("That is not one of the answers offered.");
  }
  const s = await getSettings();
  const answers = parse(s[SETTING as keyof typeof s] as string | undefined);
  if (clean) answers[key] = clean;
  else delete answers[key];
  await setSetting(SETTING, JSON.stringify(answers));
}

/**
 * The answered decisions as sentences, for the fact sheet the policy reviewer is given.
 *
 * Only answered ones. An unanswered question contributes nothing at all, so the reviewer goes on
 * refusing to invent the fact rather than being handed a default somebody's software chose.
 */
export async function decisionFacts(): Promise<string[]> {
  return (await practiceDecisions()).flatMap((d) => (d.sentence ? [d.sentence] : []));
}

/** How many are still unanswered, for the badge that says there is something to do. */
export async function decisionsOutstanding(): Promise<number> {
  return (await practiceDecisions()).filter((d) => !d.answer).length;
}
