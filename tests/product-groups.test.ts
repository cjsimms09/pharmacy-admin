import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { groupKey, groupProducts, equivalentsOf } from "../src/lib/product-groups";

/**
 * Whether two NDCs are the same product for buying purposes. The key is product-key.ts's reading of
 * NADAC's description plus the things that must also match — brand/generic, pricing unit, OTC —
 * and it errs towards too many groups: a product split loses a comparison, a product wrongly
 * merged recommends a switch that cannot be dispensed.
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
    assert.equal(groupKey(row("1", "AMLODIPINE 5 MG TABLET")), groupKey(row("2", "AMLODIPINE 5MG TABLET")));
  });

  test("a salt or a release profile is never blurred, as product-key.ts guarantees", () => {
    assert.notEqual(groupKey(row("1", "METOPROLOL SUCCINATE ER 50 MG TABLET")), groupKey(row("2", "METOPROLOL TARTRATE 50 MG TABLET")));
    assert.notEqual(groupKey(row("1", "METFORMIN HCL ER 500 MG TABLET")), groupKey(row("2", "METFORMIN HCL 500 MG TABLET")));
  });

  test("a brand and its generic are not one buying decision", () => {
    assert.notEqual(groupKey(row("1", "LIPITOR 40 MG TABLET", { classification: "B" })), groupKey(row("2", "LIPITOR 40 MG TABLET", { classification: "G" })));
  });

  test("different strengths, units or OTC status are different products", () => {
    assert.notEqual(groupKey(row("1", "ATORVASTATIN CALCIUM 40 MG TABLET")), groupKey(row("2", "ATORVASTATIN CALCIUM 20 MG TABLET")));
    assert.notEqual(groupKey(row("1", "X 5MG TABLET", { pricingUnit: "EA" })), groupKey(row("2", "X 5MG TABLET", { pricingUnit: "ML" })));
    assert.notEqual(groupKey(row("1", "X 5MG TABLET", { otc: false })), groupKey(row("2", "X 5MG TABLET", { otc: true })));
  });

  test("an NDC with no description, or one too thin to key safely, is placed nowhere and is its own equivalent", () => {
    assert.equal(groupKey(row("1", null)), null);
    assert.equal(groupKey(row("1", "   ")), null);
    assert.equal(groupKey(row("1", "LATANOPROST")), null); // no strength: a name alone is not a product
    assert.deepEqual(equivalentsOf([row("1", null), row("2", "X 5MG TABLET")], "1"), ["1"]);
  });

  test("one NDC with several NADAC rows is one NDC, placed by its first description", () => {
    const g = groupProducts([row("1", "X 5MG TABLET"), row("1", "X 5MG TABLET"), row("1", "SOMETHING ELSE 1MG TABLET"), row("2", "X 5MG TABLET")]);
    assert.equal(g.size, 1);
    assert.deepEqual(equivalentsOf([row("1", "X 5MG TABLET"), row("2", "X 5MG TABLET"), row("3", "Y 5MG TABLET")], "2"), ["1", "2"]);
  });
});

/**
 * The FDA directory's key, which is the identity wherever the directory carries the NDC.
 *
 * This exists because reading the product out of a description failed in the direction the module
 * says it must never fail in. Measured against the directory across the 23,494 catalogue NDCs where
 * both had an answer, keying on NADAC's description merged 1,092 keys covering 10,427 NDCs that
 * the FDA says are different products — lithium carbonate 300mg arriving as one product covering
 * the capsule, the tablet and the gelatin-coated capsule, because NADAC's house style often states
 * no dosage form and everything collapses into "unspecified-form".
 */
describe("the FDA directory decides the product where it carries the NDC", () => {
  const fda = (ndc11: string, equivalenceKey: string | null, description: string | null, over: Partial<{ classification: string; pricingUnit: string; otc: boolean }> = {}) => ({
    ndc11, equivalenceKey, description, classification: "G", pricingUnit: "EA", otc: false, ...over,
  });

  test("two labelers of one FDA product are one product, whatever their descriptions say", () => {
    const key = "atorvastatin calcium|20 mg/1|tablet|oral";
    assert.equal(
      groupKey(fda("00093505698", key, "ATORVASTATIN CALC TB 20MG BRP 90")),
      groupKey(fda("68180063609", key, "ATORVASTATIN 20MG TABLET")),
    );
  });

  test("the form the description lost is still kept apart, because the FDA states it", () => {
    // The real case: NADAC gives no form for either, so both keyed to "lithium carbonate|300mg|
    // unspecified-form" and one group covered the capsule and the tablet.
    const capsule = "lithium carbonate|300 mg/1|capsule|oral";
    const tablet = "lithium carbonate|300 mg/1|tablet|oral";
    assert.notEqual(
      groupKey(fda("1", capsule, "LITHIUM CARBONATE 300MG")),
      groupKey(fda("2", tablet, "LITHIUM CARBONATE 300MG")),
    );
  });

  test("a brand and its generic share an FDA key and are still not one buying decision", () => {
    const key = "atorvastatin calcium|20 mg/1|tablet|oral";
    assert.notEqual(
      groupKey(fda("1", key, "LIPITOR 20 MG TABLET", { classification: "B" })),
      groupKey(fda("2", key, "ATORVASTATIN 20 MG TABLET", { classification: "G" })),
    );
  });

  test("two pricing units are never one product, FDA key or not", () => {
    const key = "amoxicillin|400 mg/5ml|suspension|oral";
    assert.notEqual(
      groupKey(fda("1", key, "AMOXICILLIN 400MG/5ML", { pricingUnit: "ML" })),
      groupKey(fda("2", key, "AMOXICILLIN 400MG/5ML", { pricingUnit: "EA" })),
    );
  });

  test("the description is read only where the directory has no answer", () => {
    // Same description, one placed by the FDA and one not: two groups, which costs a comparison
    // and cannot recommend a switch. That is the safe direction.
    assert.notEqual(
      groupKey(fda("1", "gabapentin|300 mg/1|capsule|oral", "GABAPENTIN 300 MG CAPSULE")),
      groupKey(fda("2", null, "GABAPENTIN 300 MG CAPSULE")),
    );
    // And where neither has an FDA key, the description still groups them as it always did.
    assert.equal(
      groupKey(fda("1", null, "GABAPENTIN 300 MG CAPSULE")),
      groupKey(fda("2", null, "GABAPENTIN 300MG CAP")),
    );
  });

  test("an FDA key can never collide with a description key", () => {
    const both = "gabapentin 300mg|300mg|capsule";
    assert.notEqual(groupKey(fda("1", both, null)), groupKey(fda("2", null, "GABAPENTIN 300 MG CAPSULE")));
  });

  test("an NDC the FDA places needs no description at all", () => {
    assert.ok(groupKey(fda("1", "gabapentin|300 mg/1|capsule|oral", null)) !== null);
    // Where it has neither, it is still unplaceable rather than placed loosely.
    assert.equal(groupKey(fda("1", null, null)), null);
  });
});
