import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  proposePlanClass,
  isProposal,
  findPlanClass,
  isFinding,
  governmentHint,
  routingFromClaims,
  confirmGroups,
  type PlanEvidence,
  type PioneerPlanRow,
  type EvidenceSource,
  type Confidence,
  type ConfirmGroup,
} from "./plan-proposals";
import { allPioneerPlanRows, pioneerRowsFor } from "./pioneer-plans";
import { classifyPlan } from "./plans";
import { planLookup } from "./plan-key";
import { receivedCents } from "./money";
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
  /**
   * Which source produced the proposal, and how well it settles it.
   *
   * Shown beside the offer, because a class read out of PioneerRx's own plan file and a class read
   * out of four letters of a PCN are not the same offer and must never look like the same offer.
   */
  proposedSource: EvidenceSource | null;
  proposedConfidence: Confidence | null;
  /** Set where PioneerRx has this filed as a Government plan — which would put it *in* scope. */
  governmentHint: string | null;
  /** Insured paid fills on this plan's triple, which is what orders the list. */
  fills: number;
  /**
   * The best name anybody has for this routing: PioneerRx's plan file where it names exactly one
   * plan, then the payer label. "003858 / A4" is not a thing anybody recognises and "Cigna
   * Commercial" is.
   */
  planName: string | null;
  /**
   * The PCN the evidence was actually read against.
   *
   * The row's own PCN, except on a row that predates the PCN being kept, where it is the PCN every
   * one of that row's claims carries. Null where the row has none and its claims do not agree on
   * one. See `routingFromClaims`.
   */
  routingPcn: string | null;
  /** Set where the PCN was borrowed from the claims, saying so in words. Recorded in the basis. */
  routingNote: string | null;
  /**
   * Paid claims this row GOVERNS, and what came in on them — counted once each.
   *
   * Not the claims whose BIN, PCN and group match this row: those double count, badly. A claim on
   * BIN 019158 / PCN CNRX matches both the CNRX row and the PCN-less row for the same BIN and group,
   * so summing per-row matches over the register gives 4,084 claims against 2,350 that exist and
   * $41,263 of DST money twice. "The same money down two roads" is the fault this site keeps
   * finding, and a total on a bulk-confirm button is the worst place to have it.
   *
   * So each paid claim is handed to exactly one row — the one `planLookup` says governs it, which is
   * also the row whose classification the claim will actually inherit — and the counts add up.
   */
  claims: number;
  receivedCents: number;
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
type PlanRowT = typeof schema.planGroups.$inferSelect;
type BinRowT = { bin: string; linesOfBusiness: string | null; pbmName: string };

/**
 * The evidence for one plan, built once so the page and the confirmation cannot read it differently.
 *
 * That divergence was a real bug: the page listed proposals computed live while confirming read a
 * column only written when somebody pressed "Look again", so on a register nobody had refreshed
 * every button failed. Two paths to one answer is the fault this project keeps finding.
 */
function evidenceFor(
  p: PlanRowT,
  bins: BinRowT[],
  lobByBin: Map<string, string | null>,
  pioneer: PioneerPlanRow[],
  routings: Map<string, { pcn: string | null; claims: number }[]>,
): { evidence: PlanEvidence; routingNote: string | null } {
  /*
   * The PCN this row is read against.
   *
   * Its own, normally. On a row made before the PCN was kept — 211 of the 481 unclassified ones —
   * there is none, and every source worth anything here is looked up by BIN *and PCN*. So the PCN is
   * borrowed from the row's own claims, but only where all of them agree on one; where they do not,
   * `routingFromClaims` returns nothing and the row keeps its blank, which is the honest answer.
   */
  const borrowed = routingFromClaims(p.pcn, routings.get(binGroupKey(p.bin, p.groupNumber)) ?? []);
  const pcn = borrowed ? borrowed.pcn : p.pcn;
  return {
    routingNote: borrowed ? borrowed.from : null,
    evidence: {
      bin: p.bin,
      pcn,
      groupNumber: p.groupNumber,
      payerLabel: p.payerLabel,
      pbmName: p.pbmName ?? (p.bin ? (bins.find((b) => b.bin === p.bin)?.pbmName ?? null) : null),
      linesOfBusiness: p.bin ? (lobByBin.get(p.bin) ?? null) : null,
      /*
       * PioneerRx's own answer, which is the strongest source here and was not being read at all.
       * Passed in already loaded rather than fetched per plan: the register is 211 rows and the
       * landing table is a couple of thousand, so one read and a filter beats 211 queries.
       */
      pioneer: pioneerRowsFor(pioneer, p.bin, pcn),
    },
  };
}

const binGroupKey = (bin: string | null, group: string | null) => [bin ?? "", group ?? ""].join("|").toUpperCase();

/**
 * What the claims say about each register row: which PCNs run under a BIN and group, and which row
 * governs each paid claim.
 *
 * Read in one pass because both answers come off the same rows and the second one is the reason the
 * first is safe to use: a row's money is counted where the claim will actually inherit its class.
 */
async function claimFacts(plans: PlanRowT[]) {
  const claims = await db.query.claims.findMany({
    columns: { bin: true, pcn: true, groupNumber: true, remitCents: true, copayCents: true, status: true, cashPlan: true },
  });
  const routings = new Map<string, { pcn: string | null; claims: number }[]>();
  const governed = new Map<string, { claims: number; receivedCents: number }>();
  const lookup = planLookup(plans);
  for (const c of claims) {
    if (c.cashPlan || c.status !== "paid") continue;
    const k = binGroupKey(c.bin, c.groupNumber);
    const list = routings.get(k) ?? [];
    const hit = list.find((r) => (r.pcn ?? "").trim().toUpperCase() === (c.pcn ?? "").trim().toUpperCase());
    if (hit) hit.claims++;
    else list.push({ pcn: c.pcn, claims: 1 });
    routings.set(k, list);

    const g = lookup({ bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber });
    if (!g) continue;
    const e = governed.get(g.id) ?? { claims: 0, receivedCents: 0 };
    e.claims++;
    e.receivedCents += receivedCents(c.remitCents, c.copayCents) ?? 0;
    governed.set(g.id, e);
  }
  return { routings, governed };
}

/** The name the plan file gives this routing, where it names exactly one. See `findPlanClass`. */
function planNameFor(pioneer: PioneerPlanRow[], bin: string | null, pcn: string | null): string | null {
  const named = [...new Set(pioneerRowsFor(pioneer, bin, pcn).filter((r) => r.isActive).map((r) => (r.planName ?? "").trim()).filter(Boolean))];
  return named.length === 1 ? named[0] : null;
}

/**
 * One BIN can be listed under several PBMs, and `collides` exists to say so. Where the listings
 * disagree about the line of business, none of them is taken — a proposal is only worth making when
 * the document speaks with one voice.
 */
function linesOfBusinessByBin(bins: BinRowT[]): Map<string, string | null> {
  const lobByBin = new Map<string, string | null>();
  for (const b of bins) {
    const seen = lobByBin.get(b.bin);
    if (seen === undefined) lobByBin.set(b.bin, b.linesOfBusiness);
    else if (seen !== b.linesOfBusiness) lobByBin.set(b.bin, null);
  }
  return lobByBin;
}

const allBins = () =>
  db.select({ bin: schema.payerBins.bin, linesOfBusiness: schema.payerBins.linesOfBusiness, pbmName: schema.payerBins.pbmName }).from(schema.payerBins);

export async function planCandidates(opts: { includeClassified?: boolean } = {}): Promise<PlanCandidate[]> {
  const [plans, bins, fills, pioneer] = await Promise.all([db.select().from(schema.planGroups), allBins(), fillsByTriple(), allPioneerPlanRows()]);
  const lobByBin = linesOfBusinessByBin(bins);
  const { routings, governed } = await claimFacts(plans);

  const out: PlanCandidate[] = [];
  for (const p of plans) {
    if (!opts.includeClassified && p.classification !== "unknown") continue;
    const { evidence, routingNote } = evidenceFor(p, bins, lobByBin, pioneer, routings);
    const r = proposePlanClass(evidence);
    // The same pure decision, kept whole, so the source and confidence shown beside the offer are
    // the ones that produced it rather than a second opinion computed some other way.
    const finding = findPlanClass(evidence);
    const mine = governed.get(p.id) ?? { claims: 0, receivedCents: 0 };
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
      // The borrowed routing is part of how the class was established, so it travels with the
      // sentence rather than only living on the screen — it is what somebody checking this a year
      // from now needs in order to see why a row with no PCN was read against one.
      proposedFrom: isProposal(r) ? [r.from, routingNote].filter(Boolean).join(" ") : null,
      why: isProposal(r) ? null : r.why,
      proposedSource: isProposal(r) && isFinding(finding) ? finding.source : null,
      proposedConfidence: isProposal(r) && isFinding(finding) ? finding.confidence : null,
      governmentHint: governmentHint(evidence.pioneer, evidence.payerLabel),
      fills: fills.get(tripleKey(p.bin, p.pcn, p.groupNumber)) ?? 0,
      planName: planNameFor(pioneer, p.bin, evidence.pcn),
      routingPcn: evidence.pcn,
      routingNote,
      claims: mine.claims,
      receivedCents: mine.receivedCents,
    });
  }

  // Biggest first, then the ones with something on offer, so an evening's work starts where the
  // money is rather than where the alphabet does.
  return out.sort((a, b) => b.fills - a.fills || Number(b.proposed !== null) - Number(a.proposed !== null));
}

/**
 * The proposals gathered into one press each — the list the owner actually works.
 *
 * 481 plans is not a job anybody does. 13 groups is. Every plan inside a group carries the same
 * class, from the same named document, for the same BIN and PCN, so the group is one thing to read
 * and one thing to agree to — and the money on it is counted once, because each claim is attributed
 * to the single row that governs it.
 */
export async function proposalGroups(): Promise<ConfirmGroup<PlanCandidate>[]> {
  return confirmGroups(await planCandidates());
}

/**
 * Records what the last run offered. A LOG, not the answer — do not render from these columns.
 *
 * The docstring here used to say "so the page can show them without recomputing", and that sentence
 * was an instruction to reintroduce a bug this file has already had once. The page does not show
 * them. It calls `planCandidates`, which recomputes from the evidence as it stands right now, and
 * `confirmProposal` recomputes again before it writes anything. The columns are written here and
 * read by nothing.
 *
 * That is deliberate and it must stay that way. These rows are only as fresh as the last time
 * somebody pressed "Look again", while the evidence behind them moves whenever the PioneerRx feed
 * runs or a payer sheet is added. Rendering the stored value would put a figure on the screen that
 * disagrees with the finding the Confirm button is about to record — which is exactly what happened
 * before: the page listed proposals computed live, `confirmProposal` read the stale column, and so
 * on a register nobody had refreshed every button silently refused.
 *
 * The same fault in a different costume cost the owner his Inbox on the same day this was written:
 * a training reply was handled correctly, the outcome was written into one field, and the list that
 * renders it read another — so six replies that had been dealt with perfectly were the entire
 * contents of his needs-you list. Two facts about one event, written by two pieces of code, is how
 * both of these happened. One fact here, computed in one place, is the whole defence.
 *
 * What the columns ARE for: a record that a run happened and what it said at the time, so a
 * classification made last week can be read back against the evidence that was in front of it.
 */
export async function refreshProposals(): Promise<{ proposed: number; unproposable: number }> {
  const candidates = await planCandidates();
  let proposed = 0;
  let unproposable = 0;
  for (const c of candidates) {
    await db
      .update(schema.planGroups)
      .set({ proposedClassification: c.proposed, proposedFrom: c.proposedFrom ?? c.why, proposedSource: c.proposedSource, proposedConfidence: c.proposedConfidence })
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
 *
 * ── Recomputed here, not read out of the column ──
 *
 * The first version read `proposed_classification`, which is written only when somebody presses
 * "Look again" — while the page lists proposals computed live. So on a register nobody had
 * refreshed, every row showed a proposal and every Confirm refused, and the page threw the refusal
 * away, so the button appeared to do nothing at all. A button that silently does nothing is worse
 * than one that is missing.
 *
 * Recomputing also settles a question the stored column could not: a confirmation adopts the
 * evidence as it stands at the moment of adoption, not as it stood whenever the last run happened.
 * The basis recorded is then true of the document today, which is what makes it defensible a year
 * from now.
 */
export async function confirmProposal(
  planId: string,
  user: { id: string; name: string },
): Promise<{ ok: true; classification: PlanClass } | { ok: false; why: string }> {
  const plan = await db.query.planGroups.findFirst({ where: eq(schema.planGroups.id, planId) });
  if (!plan) return { ok: false, why: "That plan is no longer on the register." };
  if (plan.classification !== "unknown") {
    return { ok: false, why: `This plan is already classified as ${plan.classification.replace(/_/g, " ")}.` };
  }

  const [bins, pioneer, plans] = await Promise.all([allBins(), allPioneerPlanRows(), db.select().from(schema.planGroups)]);
  const { routings } = await claimFacts(plans);
  const { evidence, routingNote } = evidenceFor(plan, bins, linesOfBusinessByBin(bins), pioneer, routings);
  const proposal = proposePlanClass(evidence);
  if (!isProposal(proposal)) return { ok: false, why: proposal.why };

  await classifyPlan(
    planId,
    {
      classification: proposal.classification,
      // The proposal's own sentence becomes the basis, because it quotes the document it came from —
      // and, where the PCN was borrowed from this row's own claims, the sentence that says so, so
      // the record shows what was read and what it was read against.
      basis: [proposal.from, routingNote, `Confirmed by ${user.name}.`].filter(Boolean).join(" "),
    },
    user,
  );
  // The offer is spent: it has become a finding, and leaving it would offer it again.
  await db
    .update(schema.planGroups)
    .set({ proposedClassification: null, proposedFrom: null, proposedSource: null, proposedConfidence: null })
    .where(eq(schema.planGroups.id, planId));
  return { ok: true, classification: proposal.classification };
}

/**
 * The owner adopting one document's answer for every plan it settles, in one press.
 *
 * ── What it does not do, and why that is the whole design ──
 *
 * It confirms each plan *individually*, through `confirmProposal`, which recomputes the evidence for
 * that plan and writes through `classifyPlan`. So every rule already in force applies unchanged: a
 * class that needs a Form 5500 or the plan document is refused, the sentence the class was read from
 * is recorded as that plan's own basis, and the audit line names that plan. The file afterwards
 * reads exactly as it would have done pressing them one at a time.
 *
 * What is bulk here is the *asking*, not the deciding. The group is one class from one named
 * document for one BIN and PCN — and every class that can appear in one is `inScope: false`, so
 * confirming a group can only ever take plans out of the Kansas floor's reach. It cannot put one in.
 * That is deliberate and there is a test on it: the four findings that decide scope stay one plan,
 * one document, one person, and a previous attempt to make them bulk was caught by tests and
 * reverted.
 *
 * A group is re-derived here rather than taken from the caller, so the press acts on what the
 * evidence says now — the same reason `confirmProposal` recomputes.
 */
export async function confirmGroup(
  key: string,
  user: { id: string; name: string },
): Promise<{ confirmed: number; refused: { plan: string; why: string }[]; classification: PlanClass | null; claims: number; receivedCents: number }> {
  const group = (await proposalGroups()).find((g) => g.key === key);
  if (!group) return { confirmed: 0, refused: [], classification: null, claims: 0, receivedCents: 0 };

  let confirmed = 0;
  const refused: { plan: string; why: string }[] = [];
  for (const p of group.plans) {
    const r = await confirmProposal(p.id, user);
    // Any refusal is named rather than silently skipped — a bulk press that quietly did four of
    // seven is the "button that appears to do nothing" fault multiplied by the size of the group.
    if (!r.ok) refused.push({ plan: `${p.bin ?? "—"} / ${p.routingPcn || "no PCN"} / ${p.groupNumber ?? "no group"}`, why: r.why });
    else confirmed++;
  }
  return { confirmed, refused, classification: group.classification, claims: group.claims, receivedCents: group.receivedCents };
}
