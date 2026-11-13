/**
 * Which plans of unknown funding are worth establishing first, from how they actually pay.
 *
 * The owner, 17 September 2026: "can we not tell by how we are paid? if full ensured we should be
 * getting NADAC +10.50 if not that we arent."
 *
 * ── Why the inference as stated is not used ──
 *
 * "Paid below the floor, therefore the floor does not apply" reads a violation as an exemption. A
 * fully insured plan that underpays is exactly what SB 20 exists to catch, so that rule would
 * reclassify every offender as out of scope and erase the finding it was built to make. Nothing
 * here treats underpayment as evidence of anything about funding.
 *
 * ── What is used, and why it is different ──
 *
 * A plan paying *exactly* NADAC plus the dispensing fee, to the cent, repeatedly, is pricing to a
 * published formula. That is a fingerprint rather than an inference: somebody computed the statute
 * and paid it. Measured on this pharmacy's own claims, it discriminates — Medicaid, which prices to
 * a published formula, lands exactly on it on 93% of claims; Medicare, which prices to its own
 * contracts, on 1%. Of commercial claims whose funding is unknown, 28% land exactly on it.
 *
 * ── What this is emphatically not ──
 *
 * It is not a classifier and must never become one. Two reasons, and the second is the one that
 * matters. First, paying exactly at the floor is consistent with a self-funded plan that happens to
 * price off NADAC. Second, and decisive: on the day this was written there were no established
 * fully-insured claims in the NADAC comparison at all, so the discriminator has never been tested
 * against a known answer. A rule that has not been tried on a case whose answer is known is a guess
 * with arithmetic in it, and this codebase has had four of those in a week.
 *
 * So it ranks, and a person decides. The output is a worklist: the plans where the money is and the
 * evidence is strongest, so the finding is established by a Form 5500, a plan document or the
 * employer's own answer — which is what an appeal can stand on, and what this cannot.
 */

export type FloorPricingRow = {
  planId: string | null;
  classification: string | null;
  /** Received less the floor, in cents. Negative is short. */
  againstBenchmarkCents: number;
  receivedCents: number;
};

export type PlanEvidence = {
  planId: string;
  /** Claims landing within a couple of cents of NADAC plus the fee: the fingerprint. */
  atFloor: number;
  /** Claims paid below it. Counted because it is the money, never as evidence about funding. */
  below: number;
  above: number;
  claims: number;
  /** What those short claims come to, as a positive number of cents. */
  shortCents: number;
  receivedCents: number;
  /** One sentence, saying what the evidence is and what it is not. */
  reads: string;
};

/**
 * Within two cents, because a floor computed per unit and a payment rounded per claim will differ
 * in the last place on a large quantity without either being a different number.
 */
export const AT_FLOOR_TOLERANCE_CENTS = 2;

export function floorEvidence(
  rows: FloorPricingRow[],
  opts: { classification?: string } = {},
): PlanEvidence[] {
  const want = opts.classification ?? "commercial_unknown_funding";
  const by = new Map<string, PlanEvidence>();

  for (const r of rows) {
    if (r.classification !== want || !r.planId) continue;
    const at =
      by.get(r.planId) ??
      ({ planId: r.planId, atFloor: 0, below: 0, above: 0, claims: 0, shortCents: 0, receivedCents: 0, reads: "" } as PlanEvidence);
    at.claims++;
    at.receivedCents += r.receivedCents;
    if (Math.abs(r.againstBenchmarkCents) <= AT_FLOOR_TOLERANCE_CENTS) at.atFloor++;
    else if (r.againstBenchmarkCents > 0) at.above++;
    else {
      at.below++;
      at.shortCents += -r.againstBenchmarkCents;
    }
    by.set(r.planId, at);
  }

  const out = [...by.values()];
  for (const p of out) p.reads = readsAs(p);

  /*
   * The ones with evidence first, then by the money short.
   *
   * Not a score. A single number combining "how likely" with "how much" would be a figure nobody
   * can argue with, and both halves of it are things a person should see separately: the evidence
   * decides whether it is worth asking, the money decides whether it is worth asking first.
   */
  return out.sort(
    (a, b) => (b.atFloor > 0 ? 1 : 0) - (a.atFloor > 0 ? 1 : 0) || b.shortCents - a.shortCents || b.atFloor - a.atFloor,
  );
}

function readsAs(p: PlanEvidence): string {
  const money = `$${(p.shortCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  if (p.atFloor === 0) {
    return `No claim on this plan lands on the Kansas floor, so there is nothing here that suggests it is priced to the statute — which is not evidence either way about its funding.`;
  }
  const most = p.atFloor / p.claims >= 0.5;
  /*
   * The wording avoids the phrase "is fully insured" entirely, conditional or not.
   *
   * An earlier version ended "the floor only reaches them if the plan is fully insured", which is
   * true and still too close to the thing this must never say. A sentence on a worklist is read at
   * speed, and half of it is read as a conclusion. There is a test that the phrase does not appear.
   */
  return (
    `${p.atFloor} of ${p.claims} claims are paid within a couple of cents of NADAC plus the dispensing fee` +
    `${most ? ", which is most of them" : ""}. Somebody is pricing this plan to a published formula. ` +
    `That is worth establishing rather than assuming` +
    (p.below > 0
      ? `: ${p.below} claim${p.below === 1 ? "" : "s"} on it ${p.below === 1 ? "is" : "are"} short by ${money}, ` +
        `and the floor reaches them only once the funding is established.`
      : `, since the floor reaches this plan only once the funding is established.`)
  );
}

/**
 * What the whole shortlist is worth, for the sentence above it.
 *
 * Deliberately separates the two populations rather than adding them: the plans showing the
 * fingerprint are where an hour of somebody's time is best spent, and the rest are not a smaller
 * version of the same thing — they are plans about which nothing at all is known.
 */
export function shortlistTotals(rows: PlanEvidence[]): {
  plans: number;
  withEvidence: number;
  claimsShort: number;
  shortCents: number;
  evidenceShortCents: number;
} {
  const withEvidence = rows.filter((r) => r.atFloor > 0);
  return {
    plans: rows.length,
    withEvidence: withEvidence.length,
    claimsShort: rows.reduce((n, r) => n + r.below, 0),
    shortCents: rows.reduce((n, r) => n + r.shortCents, 0),
    evidenceShortCents: withEvidence.reduce((n, r) => n + r.shortCents, 0),
  };
}
