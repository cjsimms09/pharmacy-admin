import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { brandOffToReach, genericOnToReach, planForBand, bandStrategy, type Levers } from "../src/lib/band-strategy";
import type { Band, Position } from "../src/lib/ratio-effect";

/**
 * Where to draw the line between the cheapest product and the rebate: line by line, buy where the
 * effective cost is lowest; once a month, cross a band only when what it pays on the whole base
 * exceeds what it costs to get there. Round figures, checked by hand.
 */
const LADDER: Band[] = [
  { thresholdPercent: 0, rebatePercent: 15 },
  { thresholdPercent: 20, rebatePercent: 25 },
  { thresholdPercent: 24, rebatePercent: 29 },
];
// $40,000 at McKesson this month, 21% generic: G = $8,400, D = $40,000. OneStop base $6,000.
const pos = (ratioPercent = 21): Position => ({ ratioPercent, denominatorCents: 4_000_000, definition: "generics_over_rx", scrub: "statement" });
const BASE = 600_000;
const levers = (o: Partial<Levers> = {}): Levers => ({
  brandOff: { availableCents: 1_000_000, costFraction: 0.02 }, // brands 2% dearer at the secondary, brand factor included
  genericOn: { availableCents: 500_000, costFraction: 0.05 }, // McKesson generics 5% dearer effective than the secondary
  oneStopShare: 0.8,
  ...o,
});

describe("what it takes to reach a band", () => {
  test("brand off: G ÷ (D − x) = t → x = D − G/t", () => {
    // 8,400 / (40,000 − x) = 0.24 → x = 40,000 − 35,000 = 5,000
    assert.equal(brandOffToReach(840_000, 4_000_000, 24), 500_000);
  });
  test("generic on: (G + y) ÷ (D + y) = t → y = (tD − G) / (1 − t)", () => {
    // (9,600 − 8,400) / 0.76 = 1,578.95
    assert.ok(Math.abs(genericOnToReach(840_000, 4_000_000, 24) - 157_894.7) < 1);
    assert.equal(genericOnToReach(1, 1, 100), Number.POSITIVE_INFINITY);
  });
});

describe("the month's plan for one band", () => {
  test("the cheaper lever per point goes first, and the band is taken when it pays", () => {
    // To 24%: generic on needs $1,578.95 at 5% = $78.95, and lifts 3 points → $26.3 a point.
    //         brand off needs $5,000 at 2% = $100, same 3 points → $33.3 a point. Generic first.
    // Worth: base $6,000 + 80% of $1,578.95 = $7,263.16 × (29% − 25%) = $290.53. Net ≈ $211.58.
    const plan = planForBand(pos(), LADDER, BASE, levers(), LADDER[2]);
    assert.equal(plan.verdict, "do it");
    assert.equal(plan.moves?.length, 1);
    assert.equal(plan.moves?.[0].lever, "genericOn");
    assert.equal(plan.moves?.[0].cents, 157_895);
    assert.equal(plan.costCents, 7_895);
    assert.equal(plan.worthCents, Math.round((600_000 + Math.round(157_895 * 0.8)) * 0.04));
    assert.match(plan.says, /Reach the 24% band: move \$1,578.95 of generics to McKesson/);
  });

  test("when the generic lever runs out, brand off finishes the job", () => {
    const plan = planForBand(pos(), LADDER, BASE, levers({ genericOn: { availableCents: 100_000, costFraction: 0.05 } }), LADDER[2]);
    assert.equal(plan.moves?.length, 2);
    assert.deepEqual(plan.moves?.map((m) => m.lever), ["genericOn", "brandOff"]);
    // After $1,000 of generic: G = 9,400, D = 41,000 → brand off = 41,000 − 9,400/0.24 = 1,833.33
    assert.ok(Math.abs(plan.moves![1].cents - 183_333) <= 1);
  });

  test("a band that costs more than it pays is left alone, and the sentence says buy cheapest", () => {
    // Brand only, at a 10% premium: $5,000 × 10% = $500 to earn $240 (4% of $6,000).
    const plan = planForBand(pos(), LADDER, BASE, levers({ brandOff: { availableCents: 1_000_000, costFraction: 0.1 }, genericOn: { availableCents: 0, costFraction: 0.05 } }), LADDER[2]);
    assert.equal(plan.verdict, "not worth it");
    assert.equal(plan.costCents, 50_000);
    assert.equal(plan.worthCents, 24_000);
    assert.match(plan.says, /Buy each line where it is cheapest and let the ratio land/);
  });

  test("out of reach with what can move this month", () => {
    const plan = planForBand(pos(), LADDER, BASE, levers({ brandOff: { availableCents: 100_000, costFraction: 0.02 }, genericOn: { availableCents: 50_000, costFraction: 0.05 } }), LADDER[2]);
    assert.equal(plan.verdict, "out of reach");
    assert.equal(plan.moves, null);
  });

  test("a lever that saves money (negative cost) is used first and makes the net larger", () => {
    // McKesson's effective generic price is 3% below the secondary: moving generics on is free money.
    const plan = planForBand(pos(), LADDER, BASE, levers({ genericOn: { availableCents: 500_000, costFraction: -0.03 } }), LADDER[2]);
    assert.equal(plan.moves?.[0].lever, "genericOn");
    assert.ok(plan.costCents! < 0);
    assert.ok(plan.netCents! > plan.worthCents!);
  });
});

describe("the month's strategy", () => {
  test("every band above is costed and the best net is the recommendation", () => {
    const s = bandStrategy(pos(), LADDER, BASE, levers());
    assert.equal(s.bandNow?.thresholdPercent, 20);
    assert.equal(s.up.length, 1);
    assert.equal(s.best?.target.thresholdPercent, 24);
    assert.match(s.says, /Reach the 24% band/);
  });

  test("when nothing pays, Rule 1 stands alone and the brand headroom guards the current band", () => {
    const s = bandStrategy(pos(), LADDER, BASE, levers({ brandOff: { availableCents: 1_000_000, costFraction: 0.1 }, genericOn: { availableCents: 0, costFraction: 0.05 } }));
    assert.equal(s.best, null);
    // Headroom: 8,400 / 0.20 − 40,000 = $2,000 of brand before the 20% band is lost.
    assert.equal(s.brandHeadroomCents, 200_000);
    assert.match(s.says, /keep brand through McKesson under \$2,000\.00 more this month to hold the 20% band/);
  });

  test("at the top band there is nothing above to cost", () => {
    const s = bandStrategy(pos(25), LADDER, BASE, levers());
    assert.equal(s.up.length, 0);
    assert.equal(s.best, null);
    assert.match(s.says, /No band above 24%/);
  });
});
