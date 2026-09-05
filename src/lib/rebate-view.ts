import { paysOn, paysOnShort, measuredBy, type RebateTermsT } from "./supplier-terms";

/**
 * A supplier's rebate ladders, arranged so a person can see what they are worth.
 *
 * The screen this replaces was wrong in the way that matters most: it picked one of the three
 * ladders McKesson runs — whichever happened to sort first — headed it "Rebate schedule", and put
 * the other two under "Earlier schedules", which they were not. What it chose was the purchase
 * ratio ladder, the one paying nothing, so the page said this pharmacy's rebate schedule was
 * "0% → 0%, 75% → 1%…" while the ladder actually paying thirty percent sat hidden behind a
 * disclosure triangle. Underneath it offered "a ratio of 15% would earn 0%", a sentence with no
 * bearing on anything.
 *
 * Three things have to be true of a rebate screen and none of them were:
 *
 *   1. **Every ladder in force is shown, as itself.** A supplier running three programmes has
 *      three, and calling two of them "earlier" is not a presentation problem, it is a false
 *      statement about the agreement.
 *   2. **The band the pharmacy is actually in is marked.** A ladder is eleven rows of percentages;
 *      exactly one of them is today's answer, and finding it by eye is a step nobody should take.
 *   3. **The money is on the page.** "You are at 23.41%" is trivia. "Thirty percent comes off
 *      contract generics, which was $8,246.76 last month, and the next band is worth $164 more"
 *      is the thing worth knowing.
 *
 * Pure, so all of it can be checked by hand against a real statement.
 */

export type BandRow = {
  fromPercent: number;
  toPercent: number | null;
  rebatePercent: number;
  /** True for the one band the measured figure lands in. */
  current: boolean;
};

export type ProgrammeView = {
  id: string;
  name: string;
  effectiveFrom: string;
  terms: RebateTermsT;
  /** What it pays on, in the pharmacy's words. */
  paysOn: string;
  paysOnShort: string;
  /** Which measured figure picks the band, in words. Null where the programme never said. */
  measuredBy: string | null;
  /** That figure, where the statement carries it. */
  achievedPercent: number | null;
  /** What this programme pays right now. Null where nothing says which band applies. */
  rateNow: number | null;
  bands: BandRow[];
  /** The next band up, how far away it is, and what it would have been worth on last month's buying. */
  next: { fromPercent: number; rebatePercent: number; shortByPercent: number; worthCents: number | null } | null;
  /** What this programme actually paid on the last statement. */
  earnedCents: number | null;
  /** The purchases it was paid on. */
  basisCents: number | null;
  /** One sentence a person can act on. */
  headline: string;
};

/** The figures off the last statement that decide where the pharmacy sits on each ladder. */
export type Achieved = {
  scrubbedGcrPercent: number | null;
  gprPercent: number | null;
  periodFrom: string | null;
  oneStopPurchasedCents: number | null;
  brandPurchasedCents: number | null;
  gcrRebateCents: number | null;
  gprRebateCents: number | null;
  brandRebateCents: number | null;
};

export type RebateView = {
  programmes: ProgrammeView[];
  /**
   * What actually comes off a contract generic today, adding every ladder that pays on one.
   *
   * The number the purchasing comparison needs, and one no single programme holds: McKesson pays
   * the compliance rate and the purchase-ratio rate on the same OneStop items, so a contract
   * generic is discounted by their sum. Today that is 30% + 0%, and the day the ratio clears 75%
   * it becomes 31% without anybody editing anything.
   */
  contractGenericPercent: number | null;
  /** The same for a brand line. */
  brandPercent: number | null;
  /** What every generic earns regardless of contract flag, where a supplier pays that way. */
  allGenericsPercent: number | null;
  /** The period the achieved figures came from. */
  asOf: string | null;
  /** Everything worth knowing in one sentence, for the top of the card and the supplier list. */
  headline: string;
  /** Money left on the table: the sum of what one more band on each ladder would have paid. */
  nextBandWorthCents: number | null;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The band a figure lands in: the highest whose floor it reaches. */
function bandAt(terms: RebateTermsT, at: number | null): { thresholdPercent: number; rebatePercent: number } | null {
  if (at === null) return null;
  let found: { thresholdPercent: number; rebatePercent: number } | null = null;
  for (const t of [...terms.tiers].sort((a, b) => a.thresholdPercent - b.thresholdPercent)) {
    if (at >= t.thresholdPercent) found = t;
  }
  return found;
}

/** The top of a band is the next band's floor, less a hundredth — which is how the report prints it. */
function bandRows(terms: RebateTermsT, at: number | null): BandRow[] {
  const sorted = [...terms.tiers].sort((a, b) => a.thresholdPercent - b.thresholdPercent);
  const here = bandAt(terms, at);
  return sorted.map((t, i) => ({
    fromPercent: t.thresholdPercent,
    toPercent: i + 1 < sorted.length ? round2(sorted[i + 1].thresholdPercent - 0.01) : null,
    rebatePercent: t.rebatePercent,
    current: here !== null && here.thresholdPercent === t.thresholdPercent,
  }));
}

/** Which measured figure drives a programme, and what the purchases it is paid on came to. */
function figuresFor(terms: RebateTermsT, a: Achieved): { achieved: number | null; basis: number | null; earned: number | null } {
  const achieved =
    terms.ratioMeasure === "generic_purchase_ratio" ? a.gprPercent : terms.ratioMeasure === "generic_compliance" ? a.scrubbedGcrPercent : null;
  if (terms.eligibility === "brand_purchases") return { achieved, basis: a.brandPurchasedCents, earned: a.brandRebateCents };
  if (terms.eligibility === "catalog_rebate_flag") {
    return {
      achieved,
      basis: a.oneStopPurchasedCents,
      earned: terms.ratioMeasure === "generic_purchase_ratio" ? a.gprRebateCents : a.gcrRebateCents,
    };
  }
  return { achieved, basis: null, earned: null };
}

export function rebateView(
  programmes: { id: string; name: string; effectiveFrom: string; terms: RebateTermsT }[],
  achieved: Achieved | null,
): RebateView {
  const a: Achieved = achieved ?? {
    scrubbedGcrPercent: null,
    gprPercent: null,
    periodFrom: null,
    oneStopPurchasedCents: null,
    brandPurchasedCents: null,
    gcrRebateCents: null,
    gprRebateCents: null,
    brandRebateCents: null,
  };

  const views: ProgrammeView[] = programmes.map((p) => {
    const { achieved: at, basis, earned } = figuresFor(p.terms, a);
    const here = bandAt(p.terms, at);
    const bands = bandRows(p.terms, at);
    const above = [...p.terms.tiers].filter((t) => at !== null && t.thresholdPercent > at).sort((x, y) => x.thresholdPercent - y.thresholdPercent)[0] ?? null;
    const next =
      above && at !== null
        ? {
            fromPercent: above.thresholdPercent,
            rebatePercent: above.rebatePercent,
            shortByPercent: round2(above.thresholdPercent - at),
            worthCents: basis !== null && here ? Math.round((basis * (above.rebatePercent - here.rebatePercent)) / 100) : null,
          }
        : null;

    const rateNow = here?.rebatePercent ?? null;
    const headline =
      rateNow === null
        ? `Nothing says which band applies — ${measuredBy(p.terms) ?? "the figure that picks it"} has not been read yet, so this ladder is on file but not pricing anything.`
        : rateNow === 0
          ? `Earning nothing. ${next ? `The first band that pays starts at ${next.fromPercent}%, which is ${next.shortByPercent} points away.` : "No band on this ladder pays anything."}`
          : `${rateNow}% off ${paysOn(p.terms)}${earned !== null ? `, worth ${money(earned)} last period` : ""}.`;

    return {
      id: p.id,
      name: p.name,
      effectiveFrom: p.effectiveFrom,
      terms: p.terms,
      paysOn: paysOn(p.terms),
      paysOnShort: paysOnShort(p.terms),
      measuredBy: measuredBy(p.terms),
      achievedPercent: at,
      rateNow,
      bands,
      next,
      earnedCents: earned,
      basisCents: basis,
      headline,
    };
  });

  /*
   * Adding the ladders that pay on the same thing.
   *
   * Not a display nicety — it is the number a purchasing comparison has to use, and no single
   * programme holds it. A supplier paying two rebates on one contract generic discounts it by
   * both, and picking either one alone understates what the pharmacy is really paying.
   */
  const sumOver = (want: RebateTermsT["eligibility"]) => {
    const parts = views.filter((v) => v.terms.eligibility === want && v.rateNow !== null);
    return parts.length ? round2(parts.reduce((n, v) => n + (v.rateNow ?? 0), 0)) : null;
  };
  const contractGenericPercent = sumOver("catalog_rebate_flag");
  const brandPercent = sumOver("brand_purchases");
  const allGenericsPercent = sumOver("all_generics");

  const worth = views.map((v) => v.next?.worthCents ?? 0).reduce((n, x) => n + x, 0);
  const nextBandWorthCents = views.some((v) => v.next?.worthCents != null) ? worth : null;

  const bits: string[] = [];
  if (contractGenericPercent !== null) bits.push(`${contractGenericPercent}% off contract items`);
  if (allGenericsPercent !== null) bits.push(`${allGenericsPercent}% off every generic`);
  if (brandPercent !== null) bits.push(`${brandPercent}% off brand`);
  const headline = bits.length
    ? `${bits.join(", ")}${a.periodFrom ? `, on the ${a.periodFrom} figures` : ""}.`
    : programmes.length
      ? "Ladders are on file, but nothing has said which band this pharmacy is in, so no price is being discounted."
      : "No rebate schedule on file, so every comparison uses this supplier's gross prices.";

  return { programmes: views, contractGenericPercent, brandPercent, allGenericsPercent, asOf: a.periodFrom, headline, nextBandWorthCents };
}
