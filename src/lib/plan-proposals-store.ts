import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { proposePlanClass, isProposal, type PlanEvidence } from "./plan-proposals";
import { classifyPlan } from "./plans";
import type { PlanClass } from "@/db/schema";

/**
 * Working out which plans can be proposed, and how much each one is worth deciding.
 *
 * The decisions are in `plan-proposals.ts`, which is pure. This finds the evidence, counts the
 * fills behind each plan so the biggest come first, and writes a confirmation through the register's
 * own `classifyPlan` rather than around it.
 *
 * ── Order is the feature ──
 *
 * Ninety-odd plans is a list nobody finishes and six of 1,054 fills are classified, so the question
 * is not whether the register can be filled in but which twenty rows are worth an evening. A plan
 * carrying three hundred fills decides three hundred claims' worth of floor test; one carrying a
 * single fill decides one. Sorted by fills, the top of the list is most of the money.
 */

export type PlanCandidate = {
  id: string;
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  payerLabel: string | null;
  pbmName: string | null;
  linesOfBusiness: string | null;
  /** Where the register stands today. */
  classification: PlanClass;
  /** What is on offer, and the sentence behind it. Null where nothing can be proposed. */
  proposed: PlanClass | null;
  proposedFrom: string | null;
  /** Why nothing is proposed, where nothing is. Worth reading: it says what document is needed. */
  why: string | null;
  /** Insured paid fills on this plan's triple, which is what orders the list. */
  fills: number;
};

/** The claims' own count of fills per BIN/PCN/group, by prescription, fill number, date and NDC. */
async function fillsByTriple(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      bin: schema.claims.bin,
      pcn: schema.claims.pcn,
      groupNumber: schema.claims.groupNumber,
      rxNumber: schema.claims.rxNumber,
      fillNumber: schema.claims.fillNumber,
      dateFilled: schema.claims.dateFilled,
      ndc11: schema.claims.ndc11,
      cashPlan: schema.claims.cashPlan,
      status: schema.claims.status,
    })
    .from(schema.claims);

  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const c of rows) {
    if (c.cashPlan || c.status !== "paid") continue;
    const fill = [c.rxNumber, c.fillNumber ?? "", c.dateFilled, c.ndc11 ?? ""].join("|");
    if (seen.has(fill)) continue;
    seen.add(fill);
    const key = tripleKey(c.bin, c.pcn, c.groupNumber);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

const tripleKey = (bin: string | null, pcn: string | null, group: string | null) =>
  [bin ?? "", pcn ?? "", group ?? ""].join("|").toUpperCase();

/**
 * Every plan the register holds, with a proposal where one can be made, biggest first.
 *
 * Plans a person has already classified are left out by default: the register's answer stands and
 * re-proposing against it would invite somebody to overwrite a documented finding with a guess.
 */
export async function planCandidates(opts: { includeClassified?: boolean } = {}): Promise<PlanCandidate[]> {
  const [plans, bins, fills] = await Promise.all([
    db.select().from(schema.planGroups),
    db.select({ bin: schema.payerBins.bin, linesOfBusiness: schema.payerBins.linesOfBusiness, pbmName: schema.payerBins.pbmName }).from(schema.payerBins),
    fillsByTriple(),
  ]);

  /*
   * One BIN can be listed under several PBMs, and `collides` exists to say so. Where the listings
   * disagree about the line of business, none of them is taken — a proposal is only worth making
   * when the document speaks with one voice.
   */
  const lobByBin = new Map<string, string | null>();
  for (const b of bins) {
    const seen = lobByBin.get(b.bin);
    if (seen === undefined) lobByBin.set(b.bin, b.linesOfBusiness);
    else if (seen !== b.linesOfBusiness) lobByBin.set(b.bin, null);
  }

  const out: PlanCandidate[] = [];
  for (const p of plans) {
    if (!opts.includeClassified && p.classification !== "unknown") continue;
    const evidence: PlanEvidence = {
      bin: p.bin,
      pcn: p.pcn,
      groupNumber: p.groupNumber,
      payerLabel: p.payerLabel,
      pbmName: p.pbmName ?? (p.bin ? (bins.find((b) => b.bin === p.bin)?.pbmName ?? null) : null),
      linesOfBusiness: p.bin ? (lobByBin.get(p.bin) ?? null) : null,
    };
    const r = proposePlanClass(evidence);
    out.push({
      id: p.id,
      bin: p.bin,
      pcn: p.pcn,
      groupNumber: p.groupNumber,
      payerLabel: p.payerLabel,
      pbmName: evidence.pbmName,
      linesOfBusiness: evidence.linesOfBusiness,
      classification: p.classification,
      proposed: isProposal(r) ? r.classification : null,
      proposedFrom: isProposal(r) ? r.from : null,
      why: isProposal(r) ? null : r.why,
      fills: fills.get(tripleKey(p.bin, p.pcn, p.groupNumber)) ?? 0,
    });
  }

  // Biggest first, then the ones with something on offer, so an evening's work starts where the
  // money is rather than where the alphabet does.
  return out.sort((a, b) => b.fills - a.fills || Number(b.proposed !== null) - Number(a.proposed !== null));
}

/** Stores the proposals so the page can show them without recomputing, and so a run is a record. */
export async function refreshProposals(): Promise<{ proposed: number; unproposable: number }> {
  const candidates = await planCandidates();
  let proposed = 0;
  let unproposable = 0;
  for (const c of candidates) {
    await db
      .update(schema.planGroups)
      .set({ proposedClassification: c.proposed, proposedFrom: c.proposedFrom ?? c.why })
      .where(eq(schema.planGroups.id, c.id));
    if (c.proposed) proposed++;
    else unproposable++;
  }
  return { proposed, unproposable };
}

/**
 * The owner adopting a proposal, which is the only way one ever becomes a classification.
 *
 * It goes through `classifyPlan` rather than writing the column directly, so every rule the
 * register already enforces — chiefly that the four classes deciding the Kansas floor cannot be set
 * without a documented basis — applies to a confirmation exactly as it does to a typed answer. The
 * proposal's own sentence becomes the basis, because it quotes the document it came from.
 */
export async function confirmProposal(
  planId: string,
  user: { id: string; name: string },
): Promise<{ ok: true; classification: PlanClass } | { ok: false; why: string }> {
  const plan = await db.query.planGroups.findFirst({ where: eq(schema.planGroups.id, planId) });
  if (!plan) return { ok: false, why: "That plan is no longer on the register." };
  if (!plan.proposedClassification) return { ok: false, why: "There is nothing proposed for this plan to confirm." };

  await classifyPlan(
    planId,
    {
      classification: plan.proposedClassification,
      // The proposal's own sentence becomes the basis, because it quotes the document it came from.
      basis: plan.proposedFrom ?? "Proposed from the BIN listing and confirmed.",
    },
    user,
  );
  await db.update(schema.planGroups).set({ proposedClassification: null }).where(eq(schema.planGroups.id, planId));
  return { ok: true, classification: plan.proposedClassification };
}
