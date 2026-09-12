/**
 * Where an adjustment on a remittance belongs in the books, and saying so when it does not belong
 * anywhere yet.
 *
 * The owner: *"Fees often come over with a code, we might need to get codes from contracts in order
 * to decipher what that fee is."* And later, on what he needs from the whole system: *"identify when
 * we don't [know] or when something is wrong."* Both of those are this file.
 *
 * An 835 explains itself in codes at two levels — CAS on the claim, PLB on the whole remittance —
 * and today the site reads every one of them and throws them away. So a contractual write-off, the
 * patient's share, a DIR fee, a transaction fee, a recoupment and interest are six different
 * headings in the books and all six currently arrive as the same thing: an absence of money nobody
 * can explain.
 *
 * ── What may be decided here, and what may not ──
 *
 * This is the line that decides whether this module is honest.
 *
 * **The group code may be decided here.** CAS02's group is a closed set of five defined by the 835
 * implementation guide itself — it is part of the shape of the segment, not a list somebody
 * republishes. CO is money the pharmacy agreed to write off, PR is money the patient owes, and
 * those two alone settle the heading for the great majority of adjustments. A group outside the
 * five is not "other": it is `unknown`, because a sixth group means the file is not what we think
 * it is.
 *
 * **The reason code may not be decided here.** CARC and RARC are maintained externally and revised
 * three times a year, and PLB's reasons come from the implementation guide. Writing any of them
 * out from memory is exactly the inference this repository forbids — `CLAUDE.md`: *nothing is
 * inferred where a document could say it*. So they arrive as a dictionary, loaded as data, and
 * every entry carries where it came from and when. Until one is loaded the reason refines nothing,
 * which costs less than it sounds: the group has already placed the money.
 *
 * ── Unknown is an answer, not a fallback ──
 *
 * A code the dictionary does not hold produces `unknown` **carrying its amount**, so it can be
 * counted by `unclassified.ts` and shrink as the dictionary grows. It must never be quietly folded
 * into "other": a dictionary that maps an unknown code to a heading is worse than no dictionary,
 * because it turns a gap into a figure somebody will trust.
 *
 * ── The trap this module must not walk into ──
 *
 * A PR adjustment is the patient's share, and the claim almost certainly **already carries it** as
 * `patientTotalCents`. Adding it to revenue would count the same money twice — the same shape as
 * the e-voucher, where a stored column that nothing read looked exactly like a forgotten figure and
 * adding it would have invented $4,804.48. So every classification says what it must never be used
 * for, in the manner of the data dictionary, and PR's says this first.
 *
 * Pure.
 */

/** Where the money goes in the books. Not interchangeable: each behaves differently at year end. */
export type Heading =
  | "contractual_writeoff"
  | "patient_responsibility"
  | "payer_reduction"
  | "fee"
  | "recoupment"
  | "interest"
  | "unknown";

export type Certainty = "settled" | "needs_reason_code" | "unknown";

/** One published code and what it means, loaded as data and never written from memory. */
export type CodeEntry = {
  code: string;
  /** "cas" for a claim adjustment reason code, "plb" for a provider-level one. */
  kind: "cas" | "plb";
  meaning: string;
  heading: Heading;
  /** Where this came from and when, so a stale dictionary can be told from a current one. */
  source: { list: string; version: string; loadedOn: string };
};

export type Dictionary = { entries: CodeEntry[]; loadedOn: string | null };

export const EMPTY_DICTIONARY: Dictionary = { entries: [], loadedOn: null };

/**
 * The five adjustment groups, from the 835 implementation guide.
 *
 * Structural, not a republished list — which is why they are here and the reason codes are not.
 */
const GROUPS: Record<string, { heading: Heading; certainty: Certainty; why: string; neverUseFor: string[] }> = {
  CO: {
    heading: "contractual_writeoff",
    certainty: "settled",
    why: "Contractual obligation: the difference between what was charged and what the contract allows. The pharmacy agreed to it when it signed.",
    neverUseFor: [
      "revenue — it was never collectible, and counting it as a shortfall makes every contract look like a loss",
      "an appeal on its own — a write-off is only worth appealing where the contract's own rate says otherwise, which is what the payer model is for",
    ],
  },
  PR: {
    heading: "patient_responsibility",
    certainty: "settled",
    why: "The patient's share — copay, deductible or coinsurance. Money owed to the pharmacy by the person, not by the plan.",
    neverUseFor: [
      "adding to revenue: the claim almost certainly already carries this as `patientTotalCents`, and adding it counts the same money twice (the e-voucher's shape exactly)",
      "chasing the plan — the plan does not owe it",
    ],
  },
  PI: {
    heading: "payer_reduction",
    certainty: "needs_reason_code",
    why: "Payer-initiated: the plan reduced the payment on its own judgement rather than under the contract's rate. Often disputable, and the reason code says whether.",
    neverUseFor: ["treating as agreed — this is not a write-off the pharmacy signed up to, and filing it as one loses the appeal before it is made"],
  },
  OA: {
    heading: "unknown",
    certainty: "needs_reason_code",
    why: "Other adjustment: by definition neither contractual nor the patient's. It is the reason code or nothing.",
    neverUseFor: ["assuming a heading — OA is the group that exists because the money is none of the obvious things"],
  },
  CR: {
    heading: "unknown",
    certainty: "needs_reason_code",
    why: "Correction and reversal: it changes an earlier adjudication rather than describing this one, so what it means depends entirely on what it corrects.",
    neverUseFor: ["netting against the claim it appears on without first finding the adjudication it corrects"],
  },
};

export type Adjustment = {
  /** "claim" for CAS on the claim loop, "service" for CAS on a service line, "provider" for PLB. */
  level: "claim" | "service" | "provider";
  /** CAS01's group. Absent on a provider-level adjustment, which has no group. */
  groupCode?: string | null;
  reasonCode: string;
  amountCents: number;
};

export type Classified = {
  adjustment: Adjustment;
  heading: Heading;
  certainty: Certainty;
  /** Why it landed there, in words a person can check. */
  why: string;
  /** What this figure must never be used for. Empty only where nothing is known about it. */
  neverUseFor: string[];
  /** True where the money could not be placed and must be counted as unclassified. */
  unplaced: boolean;
};

export function classifyAdjustment(a: Adjustment, dict: Dictionary = EMPTY_DICTIONARY): Classified {
  const entry = dict.entries.find((e) => e.code === a.reasonCode.trim().toUpperCase() && e.kind === (a.level === "provider" ? "plb" : "cas"));

  if (a.level === "provider") {
    /*
     * Provider-level money belongs to no claim, so there is no group to fall back on: the reason
     * code is all there is. Without the dictionary it is unplaced, and saying so is the point —
     * this is the money the receipt currently describes as "not yet on either account".
     */
    if (!entry) {
      return {
        adjustment: a,
        heading: "unknown",
        certainty: "unknown",
        why: `PLB reason ${a.reasonCode} is not in the code list${dict.loadedOn ? ` loaded on ${dict.loadedOn}` : ", and no list has been loaded"}. Provider-level money has no group code to fall back on, so nothing places it.`,
        neverUseFor: ["any heading in the books until the code is known — this is the money that goes missing between the claims and the bank"],
        unplaced: true,
      };
    }
    return {
      adjustment: a,
      heading: entry.heading,
      certainty: "settled",
      why: `PLB ${entry.code}: ${entry.meaning} (${entry.source.list} ${entry.source.version}).`,
      neverUseFor: headingWarnings(entry.heading),
      unplaced: false,
    };
  }

  const group = GROUPS[(a.groupCode ?? "").trim().toUpperCase()];
  if (!group) {
    return {
      adjustment: a,
      heading: "unknown",
      certainty: "unknown",
      why: `${a.groupCode ? `"${a.groupCode}" is not one of the five adjustment groups` : "The adjustment carries no group code"}, so this file is not shaped the way an 835 is and nothing here should be trusted to place it.`,
      neverUseFor: ["any heading — a sixth group means the file was misread, not that the money is unusual"],
      unplaced: true,
    };
  }

  // The group has placed the money where it can. The reason code only ever refines it.
  if (group.certainty === "settled") {
    return {
      adjustment: a,
      heading: group.heading,
      certainty: "settled",
      why: entry ? `${group.why} ${entry.code}: ${entry.meaning}.` : group.why,
      neverUseFor: group.neverUseFor,
      unplaced: false,
    };
  }

  if (!entry) {
    return {
      adjustment: a,
      heading: group.heading,
      certainty: "unknown",
      why: `${group.why} Reason ${a.reasonCode} is not in the code list${dict.loadedOn ? ` loaded on ${dict.loadedOn}` : ", and no list has been loaded"}, so the group could not be refined.`,
      neverUseFor: group.neverUseFor,
      unplaced: group.heading === "unknown",
    };
  }

  return {
    adjustment: a,
    heading: entry.heading,
    certainty: "settled",
    why: `${group.why} ${entry.code}: ${entry.meaning} (${entry.source.list} ${entry.source.version}).`,
    neverUseFor: [...group.neverUseFor, ...headingWarnings(entry.heading)],
    unplaced: false,
  };
}

function headingWarnings(h: Heading): string[] {
  switch (h) {
    case "recoupment":
      return ["this month's revenue — a recoupment takes back an earlier month's, and netting it here hides both"];
    case "interest":
      return ["cost of goods — interest a payer pays is income, and it is not part of what the drugs cost"];
    case "fee":
      return ["revenue foregone — a fee is money that left, and showing it as a smaller payment makes the contract look worse than it is"];
    case "patient_responsibility":
      return ["adding to revenue: the claim almost certainly already carries the patient's share"];
    default:
      return [];
  }
}

export type RemittanceClassification = {
  lines: Classified[];
  /** Per heading, what the remittance's adjustments come to. */
  byHeading: { heading: Heading; cents: number; count: number }[];
  /** The money nothing could place, which is the figure that should shrink over time. */
  unplacedCents: number;
  unplacedCount: number;
  says: string;
};

/** Every adjustment on one remittance, placed or named. */
export function classifyRemittance(adjustments: Adjustment[], dict: Dictionary = EMPTY_DICTIONARY): RemittanceClassification {
  const lines = adjustments.map((a) => classifyAdjustment(a, dict));
  const map = new Map<Heading, { cents: number; count: number }>();
  for (const l of lines) {
    const e = map.get(l.heading) ?? { cents: 0, count: 0 };
    map.set(l.heading, { cents: e.cents + l.adjustment.amountCents, count: e.count + 1 });
  }
  const byHeading = [...map.entries()].map(([heading, v]) => ({ heading, ...v })).sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
  const unplaced = lines.filter((l) => l.unplaced);
  const unplacedCents = unplaced.reduce((n, l) => n + l.adjustment.amountCents, 0);

  const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const says =
    adjustments.length === 0
      ? "This remittance carries no adjustments: every claim was paid as charged."
      : unplaced.length === 0
        ? `Every adjustment on this remittance is under a heading: ${byHeading.map((h) => `${money(h.cents)} ${h.heading.replace(/_/g, " ")}`).join(", ")}.`
        : `${money(unplacedCents)} across ${unplaced.length} adjustment${unplaced.length === 1 ? "" : "s"} could not be placed${dict.loadedOn ? "" : " — no code list has been loaded"}. It is money this remittance moved and the books cannot name.`;

  return { lines, byHeading, unplacedCents, unplacedCount: unplaced.length, says };
}
