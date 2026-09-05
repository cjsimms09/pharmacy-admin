import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  RebateTerms,
  ReturnTerms,
  parseTierLines,
  parseCreditLines,
  parseList,
  rebateTierFor,
  nextTierFor,
  returnCreditPercent,
  describeRebate,
  describeReturns,
  readRebateTerms,
  readReturnTerms,
} from "../src/lib/supplier-terms";

/**
 * The rebate ladder and the return policy are typed in by a person and then relied on by every
 * purchasing comparison. These pin how the typing is read and how the arithmetic goes, because a
 * tier read wrong is a recommendation built on a number nobody checked.
 */
describe("reading tier lines as people type them", () => {
  test("every separator somebody might use reads the same", () => {
    for (const text of ["14% -> 2.5%", "14 -> 2.5", "14, 2.5", "14% = 2.5%", "14: 2.5", "14 2.5", "14% → 2.5%"]) {
      const r = parseTierLines(text);
      assert.deepEqual(r.problems, [], text);
      assert.deepEqual(r.tiers, [{ thresholdPercent: 14, rebatePercent: 2.5 }], text);
    }
  });

  test("tiers come back sorted by threshold, blank lines and comments ignored", () => {
    const r = parseTierLines("# McKesson OneStop\n\n16% -> 3.5%\n0 -> 1\n14% -> 2.5%\n");
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.tiers.map((t) => t.thresholdPercent), [0, 14, 16]);
  });

  test("a line that is not a tier is refused with the line quoted, not dropped", () => {
    const r = parseTierLines("14% -> 2.5%\nabout fifteen percent\n");
    assert.equal(r.tiers.length, 1);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /about fifteen percent/);
  });

  test("a repeated threshold is a problem", () => {
    assert.match(parseTierLines("14 -> 2\n14 -> 3").problems[0], /Two tiers start at 14%/);
  });

  test("a percentage over a hundred is refused", () => {
    assert.equal(parseTierLines("140 -> 2").problems.length, 1);
  });
});

describe("the rebate earned at a ratio", () => {
  const terms = RebateTerms.parse({
    kind: "tiered_ratio",
    period: "quarter",
    eligibility: "catalog_rebate_flag",
    ratioDefinition: null,
    tiers: [
      { thresholdPercent: 0, rebatePercent: 1 },
      { thresholdPercent: 14, rebatePercent: 2.5 },
      { thresholdPercent: 16, rebatePercent: 3.5 },
    ],
    paidAs: null,
    notes: null,
  });

  test("the highest tier the ratio meets, not cumulative", () => {
    assert.equal(rebateTierFor(terms, 10)?.rebatePercent, 1);
    assert.equal(rebateTierFor(terms, 14)?.rebatePercent, 2.5, "exactly on the threshold counts");
    assert.equal(rebateTierFor(terms, 15.9)?.rebatePercent, 2.5);
    assert.equal(rebateTierFor(terms, 40)?.rebatePercent, 3.5);
  });

  test("below the lowest threshold is no rebate, said plainly", () => {
    const high = RebateTerms.parse({ ...terms, tiers: [{ thresholdPercent: 14, rebatePercent: 2.5 }] });
    assert.equal(rebateTierFor(high, 10), null);
  });

  test("the next tier up, and how far away it is", () => {
    assert.deepEqual(nextTierFor(terms, 13.6), { tier: { thresholdPercent: 14, rebatePercent: 2.5 }, shortByPercent: 0.4 });
    assert.equal(nextTierFor(terms, 20), null);
  });

  test("a flat programme is one tier and reads as one", () => {
    const flat = RebateTerms.parse({ ...terms, kind: "flat_percent", period: "month", eligibility: "all_generics", tiers: [{ thresholdPercent: 0, rebatePercent: 2 }] });
    assert.equal(rebateTierFor(flat, 0)?.rebatePercent, 2);
    assert.equal(describeRebate(flat), "2% on all generics, monthly.");
  });

  test("the ladder is described in order", () => {
    assert.equal(describeRebate(terms), "quarterly ladder on the items the catalogue marks rebated: 0% → 1%, 14% → 2.5%, 16% → 3.5%.");
  });

  test("the shape refuses a programme with no tiers", () => {
    assert.equal(RebateTerms.safeParse({ ...terms, tiers: [] }).success, false);
  });
});

describe("the return policy", () => {
  const terms = ReturnTerms.parse({
    windowMonthsBeforeExpiry: 6,
    windowMonthsAfterExpiry: 6,
    creditSteps: [
      { monthsToExpiryMin: 3, creditPercent: 100 },
      { monthsToExpiryMin: 0, creditPercent: 50 },
      { monthsToExpiryMin: -6, creditPercent: 25 },
    ],
    restockingFeePercent: 10,
    nonReturnable: ["refrigerated", "partial bottles"],
    reverseDistributor: null,
    notes: null,
  });

  test("credit steps read like tiers, sorted with the most months first", () => {
    const r = parseCreditLines("0 -> 50\n6 months -> 100%\n-6 -> 25");
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.steps.map((s) => s.monthsToExpiryMin), [6, 0, -6]);
  });

  test("credit is the step for the months left, less the restocking fee", () => {
    assert.equal(returnCreditPercent(terms, 5), 90);
    assert.equal(returnCreditPercent(terms, 1), 40);
    assert.equal(returnCreditPercent(terms, -2), 15);
  });

  test("outside the window is null, which means cannot go back, not worth nothing", () => {
    assert.equal(returnCreditPercent(terms, 7), null, "too early: more than 6 months left");
    assert.equal(returnCreditPercent(terms, -7), null, "too late: more than 6 months past");
  });

  test("a policy with nothing after expiry refuses an expired product", () => {
    const strict = ReturnTerms.parse({ ...terms, windowMonthsAfterExpiry: 0, creditSteps: [{ monthsToExpiryMin: 0, creditPercent: 100 }] });
    assert.equal(returnCreditPercent(strict, -1), null);
    assert.equal(returnCreditPercent(strict, 0), 90);
  });

  test("a policy that states no after-expiry window and only positive steps still refuses expired stock", () => {
    const unstated = ReturnTerms.parse({ ...terms, windowMonthsAfterExpiry: null, creditSteps: [{ monthsToExpiryMin: 0, creditPercent: 100 }] });
    assert.equal(returnCreditPercent(unstated, -1), null);
  });

  test("lists split on lines, commas and semicolons, and drop repeats", () => {
    assert.deepEqual(parseList("refrigerated, partial bottles\nrefrigerated;controlled"), ["refrigerated", "partial bottles", "controlled"]);
  });

  test("described in one sentence", () => {
    assert.equal(
      describeReturns(terms),
      "from 6 months before expiry; to 6 months after; credit 100% at 3+ months, 50% at 0+ months, 25% at -6+ months; 10% restocking fee; never: refrigerated, partial bottles.",
    );
  });
});

describe("what is stored is read back through the same shape", () => {
  test("valid JSON round-trips; anything that no longer fits reads as nothing", () => {
    const terms = { kind: "flat_percent", period: "month", eligibility: "all_purchases", ratioDefinition: null, tiers: [{ thresholdPercent: 0, rebatePercent: 2 }], paidAs: null, notes: null };
    assert.deepEqual(readRebateTerms(JSON.stringify(terms)), terms);
    assert.equal(readRebateTerms('{"kind":"flat_percent"}'), null);
    assert.equal(readRebateTerms("not json"), null);
    const ret = { windowMonthsBeforeExpiry: 6, windowMonthsAfterExpiry: 0, creditSteps: [], restockingFeePercent: null, nonReturnable: [], reverseDistributor: null, notes: null };
    assert.deepEqual(readReturnTerms(JSON.stringify(ret)), ret);
    assert.equal(readReturnTerms("[]"), null);
  });
});
