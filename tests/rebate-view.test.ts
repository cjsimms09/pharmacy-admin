import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rebateView, type Achieved } from "../src/lib/rebate-view";
import type { RebateTermsT } from "../src/lib/supplier-terms";

/**
 * The three ladders McKesson runs, arranged the way the pharmacy has to read them.
 *
 * Figures are the July 2026 statement: a scrubbed compliance rate of 23.41% paying 30% on
 * $27,489.19 of contract generics and 0.75% on $147,967.72 of brand, and a purchase ratio of 68%
 * paying nothing because nothing pays below 75%.
 */
const ladder = (
  name: string,
  eligibility: RebateTermsT["eligibility"],
  ratioMeasure: RebateTermsT["ratioMeasure"],
  tiers: [number, number][],
): { id: string; name: string; effectiveFrom: string; terms: RebateTermsT } => ({
  id: name,
  name,
  effectiveFrom: "2026-07-01",
  terms: {
    kind: "tiered_ratio",
    period: "month",
    eligibility,
    ratioMeasure,
    ratioDefinition: null,
    tiers: tiers.map(([thresholdPercent, rebatePercent]) => ({ thresholdPercent, rebatePercent })),
    paidAs: null,
    notes: null,
  },
});

const GCR: [number, number][] = [[0, 15], [9, 20], [13, 24], [16, 26], [19, 29], [23, 30], [24, 30]];
const BRAND: [number, number][] = [[0, 0], [9, 0], [13, 0.25], [16, 0.5], [19, 0.75], [23, 0.75], [24, 1]];
const GPR: [number, number][] = [[0, 0], [75, 1], [80, 2], [85, 3], [95, 10]];

const programmes = [
  ladder("McKesson generics (OneStop) rebate", "catalog_rebate_flag", "generic_compliance", GCR),
  ladder("McKesson generic purchase ratio (GPR)", "catalog_rebate_flag", "generic_purchase_ratio", GPR),
  ladder("McKesson brand factor", "brand_purchases", "generic_compliance", BRAND),
];

const july: Achieved = {
  scrubbedGcrPercent: 23.41,
  gprPercent: 68,
  periodFrom: "2026-07-01",
  oneStopPurchasedCents: 2748919,
  brandPurchasedCents: 14796772,
  gcrRebateCents: 824676,
  gprRebateCents: 0,
  brandRebateCents: 110976,
};

describe("a supplier's rebate ladders, as a person has to read them", () => {
  const v = rebateView(programmes, july);

  test("every programme in force is shown — none is called an earlier version of another", () => {
    assert.equal(v.programmes.length, 3);
  });

  test("each ladder marks the one band the pharmacy is actually in", () => {
    const gcr = v.programmes[0];
    const current = gcr.bands.filter((b) => b.current);
    assert.equal(current.length, 1);
    assert.deepEqual({ from: current[0].fromPercent, to: current[0].toPercent, rate: current[0].rebatePercent }, { from: 23, to: 23.99, rate: 30 });
    assert.equal(gcr.rateNow, 30);
  });

  test("the two ladders are driven by different figures, and each takes its own", () => {
    assert.equal(v.programmes[0].achievedPercent, 23.41, "compliance ladder reads the compliance rate");
    assert.equal(v.programmes[1].achievedPercent, 68, "purchase-ratio ladder reads the ratio");
  });

  test("the ladder paying nothing says so, and says how far away the money is", () => {
    const gpr = v.programmes[1];
    assert.equal(gpr.rateNow, 0);
    assert.match(gpr.headline, /Earning nothing/);
    assert.equal(gpr.next?.fromPercent, 75);
    assert.equal(gpr.next?.shortByPercent, 7);
  });

  test("what actually comes off a contract generic is the two ladders added", () => {
    // The whole reason the purchase-ratio ladder had to stop claiming it paid on all generics:
    // both are paid on the same OneStop items, so a contract generic is discounted by their sum.
    assert.equal(v.contractGenericPercent, 30);
    assert.equal(v.brandPercent, 0.75);
    assert.equal(v.allGenericsPercent, null, "nothing here pays on generics at large");
  });

  test("clearing the purchase-ratio threshold adds to the contract discount without an edit", () => {
    const better = rebateView(programmes, { ...july, gprPercent: 81 });
    assert.equal(better.programmes[1].rateNow, 2);
    assert.equal(better.contractGenericPercent, 32);
  });

  test("the next band is priced against the purchases it would have been paid on", () => {
    const gcr = v.programmes[0];
    assert.equal(gcr.next?.fromPercent, 24);
    // 24% band pays the same 30% on generics, so moving up is worth nothing on this ladder.
    assert.equal(gcr.next?.worthCents, 0);
    const brand = v.programmes[2];
    // But it pays 1% on brand rather than 0.75% — a quarter point on $147,967.72.
    assert.equal(brand.next?.worthCents, 36992);
  });

  test("with no statement read, nothing is claimed", () => {
    const blind = rebateView(programmes, null);
    assert.equal(blind.contractGenericPercent, null);
    assert.equal(blind.brandPercent, null);
    assert.match(blind.headline, /nothing has said which band/);
    assert.ok(blind.programmes.every((p) => p.rateNow === null && p.bands.every((b) => !b.current)));
  });

  test("with no ladder at all, it says the comparison is using gross prices", () => {
    assert.match(rebateView([], july).headline, /gross prices/);
  });
});
