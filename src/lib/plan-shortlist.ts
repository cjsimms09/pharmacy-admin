import type { PlanClass } from "@/db/schema";
import { findPlanClass, isFinding, governmentHint, type PlanEvidence, type EvidenceSource, type Confidence } from "./plan-evidence";

/**
 * The plans nobody can settle, cut down to a list the owner can answer in one sitting.
 *
 * Fifty-one unexplained PCNs is an afternoon, and an afternoon is a thing that does not happen. The
 * job of this file is to turn it into fifteen minutes: rank what is left by what it is worth,
 * carry enough on each row that he can recognise the plan without opening anything, and say plainly
 * how much is being left behind by stopping where the list stops.
 *
 * ── Why the key is BIN and PCN, not the register's triple ──
 *
 * `plan_groups` is keyed on BIN, PCN and group number, and on these claims that is 280 rows. Nobody
 * answers 280 questions. But the group number is the employer, and almost nothing here turns on it:
 * the line of business is selected by the PCN, so BIN and PCN together is the level at which the
 * question has one answer — and it is 61 rows, of which most already have one. Confirming at this
 * level and letting the register's own fallback carry it down to the groups is the difference
 * between a list that gets finished and one that does not.
 *
 * ── Ranked by money, but never only by money ──
 *
 * The owner asked for both volume and dollars, and they disagree: BIN 019158 PCN CNRX is 28 claims
 * and $35,476, and BIN 028249 PCN RXLOCAL is 307 claims and $9,607. Both belong near the top for
 * opposite reasons, so both are shown on every row and the cut is made on whichever is larger as a
 * share of what is left.
 *
 * Pure. The store finds the claims and the evidence; this decides what makes the list.
 */

/** One BIN-and-PCN pair as the claims and the reference data have it. */
export type PlanAggregate = {
  bin: string | null;
  pcn: string | null;
  claims: number;
  receivedCents: number;
  /** The payer as the claims export wrote it — usually the BIN typed back at us. */
  payerLabel: string | null;
  /** The PBM the BIN resolved to, from the BIN listing. */
  pbmName: string | null;
  /** The best name anybody has for it: PioneerRx's plan file first, then the label. */
  planName: string | null;
  linesOfBusiness: string | null;
  /** One drug actually dispensed on it, so he recognises the plan by the patient he remembers. */
  exampleDrug: string | null;
  /** The group numbers seen under this BIN and PCN, so a group-level answer can still be given. */
  groups: string[];
  pioneer: PlanEvidence["pioneer"];
};

export type SettledPlan = PlanAggregate & {
  classification: PlanClass;
  source: EvidenceSource;
  confidence: Confidence;
  from: string;
  /** "Medicare Part D" or "Medicare Part B" where the class alone does not say which. */
  detail: string | null;
};

export type OpenPlan = PlanAggregate & {
  /** Why nothing settles it — usually naming the document that would. */
  why: string;
  /** The one question to put to the owner, in his terms. */
  ask: string;
  /** Set where PioneerRx has this filed as a Government plan, which would put it *in* scope. */
  governmentHint: string | null;
};

const cents = (n: number) => `$${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The question to put, chosen from what is already known.
 *
 * A list that says "unknown" 51 times is the same list he could not face before. What makes it
 * fifteen minutes is that each row asks something specific and answerable — and the two questions
 * below are genuinely the only two that come up.
 */
export function askFor(p: PlanAggregate, why: string): string {
  const who = p.planName ?? p.payerLabel ?? p.pbmName ?? `BIN ${p.bin ?? "—"}`;

  /*
   * The FEHB question, which is a lawyer's and not a pharmacist's.
   *
   * A federal employee plan is not an ERISA plan, so the obvious reading is that state law reaches
   * it. It is very likely wrong: 5 U.S.C. §8902(m)(1) preempts state law relating to FEHB benefits.
   * Asked as "insured or self-funded" it would get the wrong answer confidently, so it is asked as
   * what it is.
   */
  if (/Federal employee health benefits/.test(why)) {
    return `${who}: this is the Blue Cross federal employee programme, and whether the Kansas floor reaches an FEHB plan is a preemption question under 5 U.S.C. §8902(m)(1) rather than an ERISA one. Worth an opinion before ${p.claims} claims (${cents(p.receivedCents)}) go into a filing either way.`;
  }

  /*
   * The one question that decides a commercial plan, and the reason the payer sheets were worth
   * gathering: it can now be asked about a named payer rather than about a BIN.
   */
  if (/bought insurance or funds the plan/.test(why) || /as Commercial —/.test(why)) {
    return `${who}: is the employer behind this group insured, or does it fund its own plan? (A Form 5500 or the plan document settles it. Insured means the Kansas floor reaches these ${p.claims} claims, ${cents(p.receivedCents)}; self-funded means ERISA preempts it and they are out.)`;
  }

  return `${who}: what is this — commercial, Part D, Medicare Advantage, Medicaid, workers' comp, or a card? ${p.claims} claims, ${cents(p.receivedCents)}${p.exampleDrug ? `, e.g. ${p.exampleDrug}` : ""}.`;
}

export type Shortlist = {
  settled: SettledPlan[];
  /** The ones he has to answer, ranked, cut to a sitting. */
  open: OpenPlan[];
  /** Everything below the cut, summarised — so stopping the list is a decision he can see. */
  tail: { plans: number; claims: number; receivedCents: number };
  /** What is settled, for the report at the top of the page. */
  totals: { plans: number; claims: number; receivedCents: number; settledClaims: number; settledCents: number; openClaims: number; openCents: number };
};

/**
 * How far down the list is worth going.
 *
 * Not a fixed fifteen. A cut at a fixed count either leaves real money below the line on a bad
 * month or pads the list with single-claim curiosities on a good one, and both teach him that the
 * list is arbitrary. So: rows come off in order of what they are worth, and the list stops when
 * everything still below it is under a fortieth of the open claims *and* under a fortieth of the
 * open money. The cap is there only so the list can always be read in one sitting, and when the cap
 * bites, `tail` says exactly what was left — which is the honest version of "that's enough".
 */
export const MAX_ROWS = 15;
const TAIL_SHARE = 1 / 40;

export function shortlist(rows: PlanAggregate[]): Shortlist {
  const settled: SettledPlan[] = [];
  const open: OpenPlan[] = [];

  for (const p of rows) {
    const r = findPlanClass({
      bin: p.bin,
      pcn: p.pcn,
      groupNumber: null,
      payerLabel: p.payerLabel,
      pbmName: p.pbmName,
      linesOfBusiness: p.linesOfBusiness,
      pioneer: p.pioneer,
    });
    if (isFinding(r)) settled.push({ ...p, classification: r.classification, source: r.source, confidence: r.confidence, from: r.from, detail: r.detail });
    else open.push({ ...p, why: r.why, ask: askFor(p, r.why), governmentHint: governmentHint(p.pioneer) });
  }

  /*
   * Ordered by money, with claim count breaking ties.
   *
   * Money first because the Kansas floor programme is a money programme and a plan paying nothing
   * on three hundred claims is already visible elsewhere in the site. Claims break ties so that two
   * plans worth the same are worked in the order that decides the most fills.
   */
  open.sort((a, b) => b.receivedCents - a.receivedCents || b.claims - a.claims);

  const openClaims = open.reduce((n, r) => n + r.claims, 0);
  const openCents = open.reduce((n, r) => n + r.receivedCents, 0);

  let cut = 0;
  let claimsLeft = openClaims;
  let centsLeft = openCents;
  while (cut < open.length && cut < MAX_ROWS) {
    if (claimsLeft <= openClaims * TAIL_SHARE && centsLeft <= openCents * TAIL_SHARE) break;
    claimsLeft -= open[cut].claims;
    centsLeft -= open[cut].receivedCents;
    cut++;
  }

  const kept = open.slice(0, cut);
  const rest = open.slice(cut);
  return {
    settled: settled.sort((a, b) => b.claims - a.claims || b.receivedCents - a.receivedCents),
    open: kept,
    tail: { plans: rest.length, claims: rest.reduce((n, r) => n + r.claims, 0), receivedCents: rest.reduce((n, r) => n + r.receivedCents, 0) },
    totals: {
      plans: rows.length,
      claims: rows.reduce((n, r) => n + r.claims, 0),
      receivedCents: rows.reduce((n, r) => n + r.receivedCents, 0),
      settledClaims: settled.reduce((n, r) => n + r.claims, 0),
      settledCents: settled.reduce((n, r) => n + r.receivedCents, 0),
      openClaims,
      openCents,
    },
  };
}
