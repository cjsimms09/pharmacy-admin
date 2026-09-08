import type { PlanClass } from "@/db/schema";

/**
 * Proposing a plan's class from what the claim and the BIN listing already say.
 *
 * 6 of 1,054 fills sit on a plan anybody has classified, so the law-first rung in the profit engine
 * — Medicaid pays NADAC plus a fee, the Kansas floor binds or it does not — never fires for 99% of
 * what this pharmacy dispenses. The register is not going to be filled in by somebody typing into
 * 90-odd blank boxes, so this offers the ones that can be offered and the owner confirms.
 *
 * ── What may be proposed, and why the list is short ──
 *
 * `plans.ts` already draws the line and it is the right one. `needsBasis` names four classes —
 * commercial fully-insured, commercial self-funded, governmental, church plan — that decide whether
 * the Kansas floor reaches a plan, and each one has to be justified from a document, because "an
 * unsourced ERISA determination collapses under questioning".
 *
 * This proposes none of those four, ever. The rest identify themselves on the claim: a Part D BIN, a
 * state Medicaid processor, a card that names itself. Those are the ones offered here.
 *
 * The refusal that matters most is "Commercial". A BIN listing saying a BIN carries commercial
 * business does not say whether the employer bought insurance or funded the plan itself — and that
 * is the entire question, because one is state-regulated and the other is preempted by ERISA. A
 * proposal there would be a guess wearing a source's clothes, and the owner would click it.
 *
 * ── Everything carries where it came from ──
 *
 * A proposal is never a classification. It is stored beside the plan with the sentence that
 * produced it, so confirming it is a person adopting a stated reason rather than accepting an
 * answer from nowhere. Pure; the store writes them and the page shows them.
 */

export type PlanEvidence = {
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  /** The payer as the claims export wrote it. */
  payerLabel: string | null;
  /** The PBM the BIN resolved to. */
  pbmName: string | null;
  /** `payer_bins.lines_of_business`, free text as the listing prints it. */
  linesOfBusiness: string | null;
};

export type PlanProposal = {
  classification: PlanClass;
  /** Where it came from, in one sentence, stored on the row and shown beside the button. */
  from: string;
};

/** Why nothing was proposed, which is worth showing where it means "this one needs a document". */
export type NoProposal = { classification: null; why: string };

const has = (s: string | null | undefined, re: RegExp) => (s ? re.test(s) : false);

/*
 * The words each class is recognised by.
 *
 * Deliberately narrow and anchored on the terms a BIN listing actually prints. "Medicare Part D",
 * "MAPD", "Medicaid", "Workers Compensation", "Discount". Loose matching here would be the same
 * fault as a loose supplier match: a plausible answer nobody can trace.
 */
const MEDICARE = /\b(part\s*-?\s*d|pdp|mapd|ma-pd|medicare)\b/i;
const MEDICAID = /\bmedicaid\b|\bmco\b|\bchip\b/i;
const WORKERS = /\bworkers?[\s'’-]*comp(ensation)?\b|\bwc\b/i;
const DISCOUNT = /\bdiscount\b|\bsavings\s*card\b|\bcash\s*card\b|\bcoupon\b/i;
const COMMERCIAL = /\bcommercial\b|\bgroup\s*health\b|\bemployer\b/i;

/*
 * A PCN is a code, not prose, and needs its own patterns.
 *
 * The word-boundary tests above are right for "Medicare Part D" printed in a listing and wrong for
 * "MEDDPRIME" on a claim — real Part D PCNs run the words together: MEDDPRIME, MEDDADV, KSPARTD.
 * Matching prose rules against a code recognised none of them, which is the whole population this
 * was meant to reach.
 */
const MEDICARE_PCN = /medd|partd|\bpdp\b|\bmapd\b/i;
const MEDICAID_PCN = /medicaid|kscaid|\bmcd\b/i;

/**
 * What this plan's class appears to be, from what is already on file.
 *
 * Returns a proposal with its source, or the reason there is none. Order matters: Medicaid is
 * tested before Medicare because a managed Medicaid plan's listing routinely names both, and the
 * narrower of the two is the truth about who pays.
 */
export function proposePlanClass(e: PlanEvidence): PlanProposal | NoProposal {
  const lob = e.linesOfBusiness;
  const names = [e.payerLabel, e.pbmName].filter(Boolean).join(" ");

  /*
   * The BIN listing first, because it is a published document rather than a name somebody typed.
   *
   * The payer label on a claim is whatever the pharmacy system printed, and it is the weaker source
   * of the two — kept below, and only for the classes that genuinely name themselves.
   */
  if (has(lob, MEDICAID)) {
    return { classification: "medicaid", from: `The BIN listing records this BIN's line of business as "${lob}".` };
  }
  if (has(lob, MEDICARE)) {
    return { classification: "medicare", from: `The BIN listing records this BIN's line of business as "${lob}".` };
  }
  if (has(lob, WORKERS)) {
    return { classification: "workers_comp", from: `The BIN listing records this BIN's line of business as "${lob}".` };
  }
  if (has(lob, DISCOUNT)) {
    return { classification: "discount_card", from: `The BIN listing records this BIN's line of business as "${lob}".` };
  }

  /*
   * "Commercial" is where a proposal would do harm, so it is refused loudly rather than skipped.
   *
   * The listing saying commercial does not say whether the employer bought insurance from a
   * state-regulated carrier or funded the plan itself under ERISA — and that distinction is the
   * whole reason the register exists. Both answers are commercial and only one is in reach.
   */
  if (has(lob, COMMERCIAL)) {
    return {
      classification: null,
      why:
        `The BIN listing says "${lob}", which does not say whether the employer bought insurance or funds the plan ` +
        `itself. That is the difference between the Kansas floor applying and ERISA preempting it, so it needs a Form ` +
        `5500 or the plan document rather than a guess.`,
    };
  }

  /*
   * The claim's own routing, for the two classes that cannot be anything else.
   *
   * A PCN reading MEDD or a payer named "Part D" is the plan telling you what it is. Nothing here
   * proposes a class that needs a basis, so the worst case is a proposal the owner declines.
   */
  // Medicaid before Medicare here for the same reason as above: a dual plan names both.
  if (has(e.pcn, MEDICAID_PCN) || has(names, MEDICAID)) {
    const where = has(e.pcn, MEDICAID_PCN) ? `The PCN "${e.pcn}"` : `The payer name "${names.trim()}"`;
    return { classification: "medicaid", from: `${where} names Medicaid on the claim itself.` };
  }
  if (has(e.pcn, MEDICARE_PCN) || has(names, MEDICARE)) {
    const where = has(e.pcn, MEDICARE_PCN) ? `The PCN "${e.pcn}"` : `The payer name "${names.trim()}"`;
    return { classification: "medicare", from: `${where} names Medicare Part D on the claim itself.` };
  }
  if (has(names, DISCOUNT)) {
    return { classification: "discount_card", from: `The payer name "${names.trim()}" is a discount card rather than insurance.` };
  }

  return {
    classification: null,
    why: e.bin
      ? `Nothing on file says what BIN ${e.bin} carries. The BIN listing has no line of business for it and the payer name does not identify itself.`
      : "This plan has no BIN, so there is nothing to look it up by.",
  };
}

/** True where a proposal was made. Narrowing helper, so callers stop writing the union check. */
export function isProposal(r: PlanProposal | NoProposal): r is PlanProposal {
  return r.classification !== null;
}

/**
 * The classes this will ever propose.
 *
 * Exported so a test can assert the list has not quietly grown to include one that needs a
 * document. The guard is the point: adding "commercial_fully_insured" here would turn a register
 * of findings into a register of guesses, and every appeal built on it would collapse.
 */
export const PROPOSABLE: PlanClass[] = ["medicare", "medicaid", "workers_comp", "discount_card"];
