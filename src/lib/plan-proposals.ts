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
export { SOURCE_LABEL, governmentHint, findPlanClass, isFinding, PROPOSABLE, routingFromClaims } from "./plan-evidence";

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

/**
 * One question, asked once, about every plan the same document settles.
 *
 * ── The problem this is for ──
 *
 * The register holds 491 plans and 481 of them are unclassified — 1,751 paid claims and $226,094.82
 * that no contract, and no Kansas floor test, can be followed to. The owner:
 *
 *   "Can you not do research and see if we can classify some based on confidence level.. I don't
 *    think it will be that hard for most"
 *
 * He is right, and the reason it had not happened is arithmetic rather than difficulty. The register
 * is keyed on BIN, PCN *and group number*, and the group number is the employer — so one document
 * settling one routing shows up as dozens of separate rows with dozens of separate buttons. BIN
 * 019158 / PCN CNRX is seven register rows and one fact: it is DST Pharmacy Solutions' copay-card
 * routing. The CMS Part D file naming BIN 610455 / PCN KSPDP is twelve rows and one fact.
 *
 * Grouping by the *evidence* rather than by the row is what turns that into a job somebody finishes.
 *
 * ── Why the group is the routing and not the class ──
 *
 * The page already had a "confirm all 33 Medicare" button, and it was the wrong grouping. Thirty-
 * three plans read from eleven different documents is not one decision — it is eleven decisions
 * wearing one button, and the owner cannot check any of them, because the sentence that produced
 * each is different. A group here is one class, from one named source, for one BIN and PCN, and
 * every plan in it carries the *same sentence*. That is a thing a person can read once and agree to.
 *
 * ── What this can never do ──
 *
 * It cannot make a scope determination. Every class `PROPOSABLE` allows — Medicare, Medicaid,
 * workers' comp, discount card, copay card — is `inScope: false`, so confirming a group can only
 * ever take plans *out* of the Kansas floor's reach, never put them in. The four classes that decide
 * whether the floor reaches a plan still need a Form 5500 or the plan document, one plan at a time,
 * and there is a test asserting that no group-confirmable class is in scope. A previous attempt to
 * let scope be settled in bulk was caught by tests and reverted; this is deliberately the other
 * shape — the site does the grouping and the evidence-gathering, the person still decides.
 */
export type GroupableCandidate = {
  id: string;
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  payerLabel: string | null;
  planName: string | null;
  proposed: PlanClass | null;
  proposedFrom: string | null;
  proposedSource: import("./plan-evidence").EvidenceSource | null;
  proposedConfidence: import("./plan-evidence").Confidence | null;
  /** The PCN the evidence was actually read against — the row's own, or the one its claims carry. */
  routingPcn: string | null;
  /** Paid claims this row governs, counted once. See `plan-proposals-store.ts` for why "governs". */
  claims: number;
  receivedCents: number;
};

export type ConfirmGroup<T extends GroupableCandidate = GroupableCandidate> = {
  /** Stable across a re-render, and what the confirm button posts back. */
  key: string;
  classification: PlanClass;
  source: import("./plan-evidence").EvidenceSource;
  confidence: import("./plan-evidence").Confidence;
  bin: string | null;
  pcn: string | null;
  /** The best name anybody has for the routing, so he recognises it without opening anything. */
  name: string | null;
  /** The one sentence every plan in the group was read from. */
  from: string;
  plans: T[];
  claims: number;
  receivedCents: number;
};

const up = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/** The key a group is confirmed by: one class, from one source, for one routing. */
export function groupKey(c: Pick<GroupableCandidate, "proposed" | "proposedSource" | "bin" | "routingPcn">): string {
  return [c.proposed ?? "", c.proposedSource ?? "", up(c.bin), up(c.routingPcn)].join("|");
}

/**
 * The proposals, gathered into one press each, biggest money first.
 *
 * Ranked by what was received rather than by how many rows a group saves, because the reason any of
 * this is being done is that reimbursement cannot be followed to a contract — and a group worth
 * $41,263 on seven rows is worth doing before one worth $23 on two.
 */
export function confirmGroups<T extends GroupableCandidate>(rows: T[]): ConfirmGroup<T>[] {
  const out = new Map<string, ConfirmGroup<T>>();
  for (const r of rows) {
    if (!r.proposed || !r.proposedSource || !r.proposedConfidence || !r.proposedFrom) continue;
    /*
     * The guard restated where the button is, not only where the proposal is made.
     *
     * `proposePlanClass` already refuses a class that needs a document, and there is a test on the
     * list. This is the belt to those braces at the one place where a mistake would be multiplied by
     * the number of rows in the group.
     */
    if (!PROPOSABLE.includes(r.proposed)) continue;
    const key = groupKey(r);
    let g = out.get(key);
    if (!g) {
      g = {
        key,
        classification: r.proposed,
        source: r.proposedSource,
        confidence: r.proposedConfidence,
        bin: r.bin,
        pcn: r.routingPcn,
        name: r.planName ?? r.payerLabel ?? null,
        from: r.proposedFrom,
        plans: [],
        claims: 0,
        receivedCents: 0,
      };
      out.set(key, g);
    }
    if (!g.name) g.name = r.planName ?? r.payerLabel ?? null;
    /*
     * The weakest confidence in the group is the group's confidence.
     *
     * A group is one press, so it is only as good as its worst member. Showing "stated" over a group
     * where one row was read from four letters of a PCN would be the fault this whole file is built
     * against: a guess that looks exactly like a fact.
     */
    if (r.proposedConfidence === "indicated") g.confidence = "indicated";
    g.plans.push(r);
    g.claims += r.claims;
    g.receivedCents += r.receivedCents;
  }
  return [...out.values()].sort((a, b) => b.receivedCents - a.receivedCents || b.claims - a.claims || b.plans.length - a.plans.length);
}
