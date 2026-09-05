import { z } from "zod";

/**
 * The terms a supplier trades on that no feed carries: the rebate schedule and the return policy.
 *
 * Pure. No database, no server-only import, so the shapes and the arithmetic can be tested by
 * hand — and they need to be, because a rebate tier typed in wrong is a purchasing recommendation
 * built on a number nobody checked.
 *
 * ── Rebates ──
 *
 * The common shape, and McKesson's, is a ladder: the pharmacy's generic compliance ratio for the
 * period (eligible generic purchases over total purchases, both at that supplier) lands in a tier,
 * and every eligible purchase in the period earns that tier's percentage. The tiers are not
 * cumulative — a ratio of 16% at a 15% threshold earns the 15% tier's rate on everything, not the
 * lower tier's rate on the first part. A flat programme is the same shape with one tier at zero.
 *
 * Which purchases are "eligible" is the supplier's decision and is read off the catalogue (the
 * rebate column marks the OneStop items), so it is recorded here as a rule rather than a list.
 *
 * ── Returns ──
 *
 * A return window is stated as months before expiry (the earliest a supplier will take it back)
 * and months after (the latest), and the credit as a percentage that steps down with the months
 * left on the product. Non-returnable categories are words because they are words on the policy:
 * "refrigerated", "controlled Schedule II", "short-dated at purchase", "partial bottle".
 */

export const TERMS_VERSION = 1;

const percent = z.number().min(0).max(100);

export const RebateTier = z.object({
  /** The ratio at or above which this tier applies, in percent. 0 for the base tier. */
  thresholdPercent: percent,
  /** What every eligible purchase in the period earns at this tier, in percent. */
  rebatePercent: percent,
});

export const RebateTerms = z.object({
  /** "tiered_ratio": the ratio ladder above. "flat_percent": one rate on every eligible purchase. */
  kind: z.enum(["tiered_ratio", "flat_percent"]),
  /** How often the ratio is measured and the rebate settled. */
  period: z.enum(["month", "quarter", "year"]),
  /**
   * What counts. "catalog_rebate_flag": the items the catalogue marks rebated (McKesson OneStop).
   * "all_generics": every generic. "all_purchases": everything on the invoice.
   */
  eligibility: z.enum(["catalog_rebate_flag", "all_generics", "all_purchases"]),
  /** The supplier's own definition of the ratio, in its words, where it has one. */
  ratioDefinition: z.string().nullable(),
  /** Ascending by threshold. At least one tier. */
  tiers: z.array(RebateTier).min(1),
  /** How and when it is paid: "credit memo the month after quarter end". */
  paidAs: z.string().nullable(),
  /** Anything else that changes the money: minimum commitments, exclusions, promotional windows. */
  notes: z.string().nullable(),
});
export type RebateTermsT = z.infer<typeof RebateTerms>;

export const CreditStep = z.object({
  /** Applies when at least this many months remain to expiry at the time of return. */
  monthsToExpiryMin: z.number().min(-60).max(120),
  creditPercent: percent,
});

export const ReturnTerms = z.object({
  /** The earliest a product can go back, in months before its expiry date. Null when not stated. */
  windowMonthsBeforeExpiry: z.number().min(0).max(120).nullable(),
  /** The latest, in months after expiry. 0 means nothing after expiry. Null when not stated. */
  windowMonthsAfterExpiry: z.number().min(0).max(60).nullable(),
  /** Credit as a percentage of what was paid, stepping down with the months left. Descending by months. */
  creditSteps: z.array(CreditStep),
  restockingFeePercent: percent.nullable(),
  /** Categories the supplier will not take back, in the policy's own words. */
  nonReturnable: z.array(z.string()),
  /** Who handles it when the supplier does not: a reverse distributor, by name. */
  reverseDistributor: z.string().nullable(),
  notes: z.string().nullable(),
});
export type ReturnTermsT = z.infer<typeof ReturnTerms>;

/**
 * Reads tier lines as somebody types them: one tier per line, threshold then rebate.
 *
 *   14% → 2.5%      14 -> 2.5      14, 2.5      14% = 2.5%      0: 1
 *
 * Anything else on a line is refused with the line quoted, because a tier silently dropped is a
 * rebate silently understated. Returned sorted ascending, and a repeated threshold is refused.
 */
export function parseTierLines(text: string): { tiers: z.infer<typeof RebateTier>[]; problems: string[] } {
  const tiers: z.infer<typeof RebateTier>[] = [];
  const problems: string[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([\d.]+)\s*%?\s*(?:→|->|=>|=|:|,|\s)\s*([\d.]+)\s*%?$/.exec(line);
    if (!m) {
      problems.push(`"${line}" is not a tier. Write it as threshold then rebate, e.g. "14% -> 2.5%".`);
      continue;
    }
    const thresholdPercent = Number(m[1]);
    const rebatePercent = Number(m[2]);
    if (!Number.isFinite(thresholdPercent) || !Number.isFinite(rebatePercent) || thresholdPercent > 100 || rebatePercent > 100) {
      problems.push(`"${line}" has a figure that is not a percentage.`);
      continue;
    }
    tiers.push({ thresholdPercent, rebatePercent });
  }
  tiers.sort((a, b) => a.thresholdPercent - b.thresholdPercent);
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].thresholdPercent === tiers[i - 1].thresholdPercent) problems.push(`Two tiers start at ${tiers[i].thresholdPercent}%.`);
  }
  return { tiers, problems };
}

/**
 * Reads credit steps the same way: months-to-expiry then credit percent, one per line.
 *
 *   6 -> 100      3 -> 50      0 -> 0
 */
export function parseCreditLines(text: string): { steps: z.infer<typeof CreditStep>[]; problems: string[] } {
  const steps: z.infer<typeof CreditStep>[] = [];
  const problems: string[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(-?[\d.]+)\s*(?:mo|months?)?\s*(?:→|->|=>|=|:|,|\s)\s*([\d.]+)\s*%?$/.exec(line);
    if (!m) {
      problems.push(`"${line}" is not a credit step. Write it as months-to-expiry then credit, e.g. "6 -> 100%".`);
      continue;
    }
    const monthsToExpiryMin = Number(m[1]);
    const creditPercent = Number(m[2]);
    if (!Number.isFinite(monthsToExpiryMin) || !Number.isFinite(creditPercent) || creditPercent > 100) {
      problems.push(`"${line}" has a figure out of range.`);
      continue;
    }
    steps.push({ monthsToExpiryMin, creditPercent });
  }
  steps.sort((a, b) => b.monthsToExpiryMin - a.monthsToExpiryMin);
  return { steps, problems };
}

/** One item per line or comma, trimmed, blanks dropped. */
export function parseList(text: string): string[] {
  return [...new Set((text ?? "").split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean))];
}

/**
 * The rebate earned at a given compliance ratio: the highest tier whose threshold the ratio meets.
 *
 * Returns the tier, so the caller can say which one, and null below the lowest threshold — which
 * for a ladder that starts at 0% never happens, and for one that starts higher means "no rebate
 * this period", a fact worth stating rather than rounding to the bottom tier.
 */
export function rebateTierFor(terms: RebateTermsT, ratioPercent: number): z.infer<typeof RebateTier> | null {
  let best: z.infer<typeof RebateTier> | null = null;
  for (const t of [...terms.tiers].sort((a, b) => a.thresholdPercent - b.thresholdPercent)) {
    if (ratioPercent >= t.thresholdPercent) best = t;
  }
  return best;
}

/** The next tier above the ratio, and how far away it is, so a page can say "0.4% short of 3.5%". */
export function nextTierFor(terms: RebateTermsT, ratioPercent: number): { tier: z.infer<typeof RebateTier>; shortByPercent: number } | null {
  const above = [...terms.tiers].filter((t) => t.thresholdPercent > ratioPercent).sort((a, b) => a.thresholdPercent - b.thresholdPercent);
  if (above.length === 0) return null;
  return { tier: above[0], shortByPercent: Math.round((above[0].thresholdPercent - ratioPercent) * 100) / 100 };
}

/**
 * What a return is worth, as a percentage of what was paid, given the months left to expiry.
 *
 * Null when the policy says it cannot go back at all at that point: outside the window, or a
 * policy with no credit steps recorded. "Cannot say" is null; "worth nothing" is 0.
 */
export function returnCreditPercent(terms: ReturnTermsT, monthsToExpiry: number): number | null {
  if (terms.windowMonthsBeforeExpiry !== null && monthsToExpiry > terms.windowMonthsBeforeExpiry) return null;
  if (terms.windowMonthsAfterExpiry !== null && monthsToExpiry < -terms.windowMonthsAfterExpiry) return null;
  if (terms.windowMonthsAfterExpiry === null && monthsToExpiry < 0 && terms.creditSteps.every((s) => s.monthsToExpiryMin >= 0)) return null;
  const step = [...terms.creditSteps].sort((a, b) => b.monthsToExpiryMin - a.monthsToExpiryMin).find((s) => monthsToExpiry >= s.monthsToExpiryMin);
  if (!step) return null;
  const fee = terms.restockingFeePercent ?? 0;
  return Math.max(0, Math.round((step.creditPercent - fee) * 100) / 100);
}

/** One sentence for a supplier card. */
export function describeRebate(terms: RebateTermsT): string {
  const period = { month: "monthly", quarter: "quarterly", year: "annual" }[terms.period];
  const on = { catalog_rebate_flag: "the items the catalogue marks rebated", all_generics: "all generics", all_purchases: "all purchases" }[terms.eligibility];
  if (terms.kind === "flat_percent" || terms.tiers.length === 1) {
    return `${terms.tiers[0].rebatePercent}% on ${on}, ${period}.`;
  }
  const ladder = [...terms.tiers].sort((a, b) => a.thresholdPercent - b.thresholdPercent).map((t) => `${t.thresholdPercent}% → ${t.rebatePercent}%`).join(", ");
  return `${period} ladder on ${on}: ${ladder}.`;
}

export function describeReturns(terms: ReturnTermsT): string {
  const bits: string[] = [];
  if (terms.windowMonthsBeforeExpiry !== null) bits.push(`from ${terms.windowMonthsBeforeExpiry} months before expiry`);
  if (terms.windowMonthsAfterExpiry !== null) bits.push(terms.windowMonthsAfterExpiry === 0 ? "nothing after expiry" : `to ${terms.windowMonthsAfterExpiry} months after`);
  if (terms.creditSteps.length) {
    const steps = [...terms.creditSteps].sort((a, b) => b.monthsToExpiryMin - a.monthsToExpiryMin).map((s) => `${s.creditPercent}% at ${s.monthsToExpiryMin}+ months`).join(", ");
    bits.push(`credit ${steps}`);
  }
  if (terms.restockingFeePercent) bits.push(`${terms.restockingFeePercent}% restocking fee`);
  if (terms.nonReturnable.length) bits.push(`never: ${terms.nonReturnable.join(", ")}`);
  return bits.length ? bits.join("; ") + "." : "Nothing recorded yet.";
}

/** Parses stored JSON back into terms, refusing anything that no longer fits the shape. */
export function readRebateTerms(json: string): RebateTermsT | null {
  try {
    const r = RebateTerms.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function readReturnTerms(json: string): ReturnTermsT | null {
  try {
    const r = ReturnTerms.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
