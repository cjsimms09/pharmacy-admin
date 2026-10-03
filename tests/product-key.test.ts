import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { productKey, sameProduct } from "../src/lib/product-key";

/**
 * This decides which NDCs get compared on price, so a wrong grouping becomes a recommendation to
 * buy one drug in place of another. The asymmetry governs every test below: a missed match costs
 * a saving, a false match is a dispensing error waiting to happen.
 */

describe("descriptions that are the same product", () => {
  const same = (a: string, b: string) => test(`${a}  ==  ${b}`, () => assert.ok(sameProduct(a, b), `${productKey(a).key} vs ${productKey(b).key}`));

  same("Escitalopram 20 Mg Tablet", "ESCITALOPRAM 20MG TAB");
  same("Metoclopramide 10 Mg Tablet", "metoclopramide 10 mg tablets");
  same("Gabapentin 300 Mg Capsule", "GABAPENTIN 300MG CAP");
  same("AMOXICILLIN 400 MG/5 ML SUSP", "Amoxicillin 400mg/5ml Suspension");
  same("Metformin HCl ER 500 Mg Tablet", "METFORMIN HCL 500MG ER TABLET");
  same("Atorvastatin Calcium 20 Mg Tablet", "atorvastatin calcium 20mg tab");
  same("Levothyroxine 0.05 Mg Tablet", "LEVOTHYROXINE .05MG TABLET");
});

describe("descriptions that must never be merged", () => {
  const differ = (a: string, b: string, why: string) =>
    test(why, () => assert.ok(!sameProduct(a, b), `wrongly matched: ${productKey(a).key}`));

  differ("Metoprolol Succinate ER 25 Mg Tablet", "Metoprolol Tartrate 25 Mg Tablet", "salt forms are different drugs");
  differ("Metformin HCl ER 500 Mg Tablet", "Metformin HCl 500 Mg Tablet", "extended release is not immediate release");
  differ("Bupropion HCl XL 300 Mg Tablet", "Bupropion HCl SR 300 Mg Tablet", "XL and SR are different products");
  differ("Escitalopram 10 Mg Tablet", "Escitalopram 20 Mg Tablet", "different strengths");
  differ("Gabapentin 300 Mg Capsule", "Gabapentin 300 Mg Tablet", "capsule is not tablet");
  differ("Amoxicillin 400 Mg/5 Ml Susp", "Amoxicillin 400 Mg Tablet", "suspension is not tablet");
  differ("Amoxicillin 250 Mg/5 Ml Susp", "Amoxicillin 400 Mg/5 Ml Susp", "different concentrations");
  differ("Diltiazem 120 Mg Capsule", "Diltiazem CD 120 Mg Capsule", "a release modifier distinguishes");
  differ("Venlafaxine ER 75 Mg Capsule", "Venlafaxine 75 Mg Tablet", "release and form both differ");
  differ("Potassium Chloride 10 Meq Tablet", "Potassium Chloride 20 Meq Tablet", "different milliequivalents");
});

describe("what the key is made of", () => {
  test("strength, form and salt are all kept", () => {
    const p = productKey("Metoprolol Succinate ER 25 Mg Tablet");
    assert.equal(p.strength, "25mg");
    assert.equal(p.form, "er tablet");
    assert.ok(p.base.includes("succinate"), "the salt must survive into the key");
  });

  test("a ratio strength keeps both halves", () => {
    assert.equal(productKey("Amoxicillin 400 Mg/5 Ml Susp").strength, "400mg/5ml");
  });

  test("leading zeros and trailing zeros agree", () => {
    assert.equal(productKey("Levothyroxine 0.050 Mg Tablet").strength, productKey("Levothyroxine .05 Mg Tab").strength);
  });

  test("percentage strengths are kept", () => {
    assert.equal(productKey("Hydrocortisone 2.5 % Cream").strength, "2.5%");
  });
});

describe("descriptions too thin to key", () => {
  test("no strength means no key — a bare name would match every strength of it", () => {
    assert.equal(productKey("Escitalopram Tablet").key, null);
    assert.equal(productKey("Insulin").key, null);
  });

  test("empty input is not a product", () => {
    assert.equal(productKey("").key, null);
    assert.equal(productKey(null).key, null);
    assert.equal(productKey(undefined).key, null);
  });

  test("two unkeyable descriptions are never treated as the same product", () => {
    assert.equal(sameProduct("Escitalopram Tablet", "Escitalopram Tablet"), false);
    assert.equal(sameProduct(null, null), false);
  });
});

describe("combination products", () => {
  test("every component of the strength is kept together", () => {
    assert.equal(productKey("Oxycodone-Acetaminophen 10-325 Mg Tablet").strength, "10-325mg");
    assert.equal(productKey("Oxycodone-Acetaminophen 10-325 Mg Tablet").base, "oxycodone-acetaminophen");
  });

  test("two strengths of the same combination stay apart", () => {
    assert.ok(!sameProduct("Oxycodone-Acetaminophen 10-325 Mg Tablet", "Oxycodone-Acetaminophen 5-325 Mg Tablet"));
  });

  test("the same combination written two ways matches", () => {
    assert.ok(sameProduct("Oxycodone-Acetaminophen 10-325 Mg Tablet", "OXYCODONE-ACETAMINOPHEN 10-325MG TAB"));
  });

  test("a device with no strength is not keyed, rather than keyed loosely", () => {
    assert.equal(productKey("Dexcom G7 Sensor").key, null);
    assert.equal(productKey("FREESTYLE LIBRE 2 SENSOR").key, null);
  });
});
