import { findPlanClass, isFinding, PROPOSABLE, type PlanEvidence, type PlanFinding, type NoFinding } from "./plan-evidence";
import type { PlanClass } from "@/db/schema";

/**
 * Proposing a plan's class, and confirming it in one click.
 *
 * The deciding now lives in `plan-evidence.ts`, which ranks every source that has anything to say —
 * PioneerRx's own plan file first, then what somebody set here, then the PCN, then the BIN listing,
 * then the payer's name — and returns the answer with its source and its confidence attached. This
 * file is the shape the page and the confirm button were already written against, kept so that the
 * evidence could be made much stronger without rewriting the screen that uses it.
 *
 * ── What may be proposed, and why the list is short ──
 *
 * `plans.ts` draws the line and it is the right one. `needsBasis` names four classes — commercial
 * fully-insured, commercial self-funded, governmental, church plan — that decide whether the Kansas
 * floor reaches a plan, and each one has to be justified from a document, because "an unsourced
 * ERISA determination collapses under questioning".
 *
 * None of those four is ever proposed. The rest identify themselves: a Part D plan file entry, a
 * state Medicaid processor, a card that names itself. Those are the ones offered here.
 *
 * ── Everything carries where it came from ──
 *
 * A proposal is never a classification. It is stored beside the plan with the sentence that
 * produced it, so confirming it is a person adopting a stated reason rather than accepting an
 * answer from nowhere. Pure; the store writes them and the page shows them.
 */

export type { PlanEvidence, PioneerPlanRow, EvidenceSource, Confidence, PlanFinding, NoFinding } from "./plan-evidence";
export { SOURCE_LABEL, governmentHint, findPlanClass, isFinding, PROPOSABLE } from "./plan-evidence";

export type PlanProposal = {
  classification: PlanClass;
  /** Where it came from, in one sentence, stored on the row and shown beside the button. */
  from: string;
};

/** Why nothing was proposed, which is worth showing where it means "this one needs a document". */
export type NoProposal = { classification: null; why: string };

/**
 * What this plan's class appears to be, from what is already on file.
 *
 * Returns a proposal with its source, or the reason there is none. The full finding — with its
 * named source and its confidence — comes from `findPlanClass` for callers that record those; this
 * narrower shape is what the confirm button has always taken.
 */
export function proposePlanClass(e: PlanEvidence): PlanProposal | NoProposal {
  const r: PlanFinding | NoFinding = findPlanClass(e);
  if (!isFinding(r)) return { classification: null, why: r.why };
  /*
   * The guard, restated where it is cheapest to keep.
   *
   * `findPlanClass` is not supposed to return a class that needs a document, and there is a test
   * asserting that list. This is the belt to those braces: if a future source ever does return one,
   * it becomes "nothing is proposed, and here is why" rather than a one-click ERISA determination
   * nobody documented.
   */
  if (!PROPOSABLE.includes(r.classification)) {
    return {
      classification: null,
      why:
        `${r.from} That would make it ${r.classification.replace(/_/g, " ")}, which decides whether the Kansas floor ` +
        `reaches this plan — so it needs the plan document or a Form 5500, not a proposal.`,
    };
  }
  return { classification: r.classification, from: r.from };
}

/** True where a proposal was made. Narrowing helper, so callers stop writing the union check. */
export function isProposal(r: PlanProposal | NoProposal): r is PlanProposal {
  return r.classification !== null;
}
