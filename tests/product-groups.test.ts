import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { groupKey, groupProducts, equivalentsOf, normalizeDescription } from "../src/lib/product-groups";

/**
 * Whether two NDCs are the same product for buying purposes. The key is NADAC's description plus
 * the things that must also match — brand/generic, pricing unit, OTC — and it errs towards too
 * many groups: a product split loses a comparison, a product wrongly merged recommends a switch
 * that cannot be dispensed.
 */
const row = (ndc11: string, description: string | null, over: Partial<{ classification: string; pricingUnit: string; otc: boolean }> = {}) => ({
  ndc11, description, classification: "G", pricingUnit: "EA", otc: false, ...over,
});

describe("what makes two NDCs one product", () => {
  test("the same NADAC description from two manufacturers is one product", () => {
    const g = groupProducts([row("00093505698", "ATORVASTATIN CALCIUM 40 MG TABLET"), row("68180063609", "ATORVASTATIN CALCIUM 40 MG TABLET")]);
    assert.equal(g.size, 1);
    assert.deepEqual([...g.values()][0], ["00093505698", "68180063609"]);
  });

  test("spacing between a number and its unit does not split a product", () => {
    assert.equal(normalizeDescription("Amlodipine 5 mg tablet"), normalizeDescription("AMLODIPINE 5MG TABLET"));
    assert.equal(groupKey(row("1", "AMLODIPINE 5 MG TABLET")), groupKey(row("2", "AMLODIPINE 5MG TABLET")));
  });

  test("a brand and its generic are not one buying decision", () => {
    assert.notEqual(groupKey(row("1", "LIPITOR 40 MG TABLET", { classification: "B" })), groupKey(row("2", "LIPITOR 40 MG TABLET", { classification: "G" })));
  });

  test("different strengths, units or OTC status are different products", () => {
    assert.notEqual(groupKey(row("1", "ATORVASTATIN CALCIUM 40 MG TABLET")), groupKey(row("2", "ATORVASTATIN CALCIUM 20 MG TABLET")));
    assert.notEqual(groupKey(row("1", "X", { pricingUnit: "EA" })), groupKey(row("2", "X", { pricingUnit: "ML" })));
    assert.notEqual(groupKey(row("1", "X", { otc: false })), groupKey(row("2", "X", { otc: true })));
  });

  test("an NDC with no NADAC description is placed nowhere and is its own equivalent", () => {
    assert.equal(groupKey(row("1", null)), null);
    assert.equal(groupKey(row("1", "   ")), null);
    assert.deepEqual(equivalentsOf([row("1", null), row("2", "X")], "1"), ["1"]);
  });

  test("one NDC with several NADAC rows is one NDC, placed by its first description", () => {
    const g = groupProducts([row("1", "X 5MG TABLET"), row("1", "X 5MG TABLET"), row("1", "SOMETHING ELSE"), row("2", "X 5MG TABLET")]);
    assert.equal(g.size, 1);
    assert.deepEqual(equivalentsOf([row("1", "X 5MG TABLET"), row("2", "X 5MG TABLET"), row("3", "Y")], "2"), ["1", "2"]);
  });
});
