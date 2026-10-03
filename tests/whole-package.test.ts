import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { wholePackage } from "../src/lib/catalogue-cache";

const row = (a: Partial<Parameters<typeof wholePackage>[0]> = {}) => ({
  ndc11: "76204001155", supplier: "McKesson", description: "Albuterol", productKey: null,
  packSize: "(25) 3 ML", unitCostMicros: 6_250_000, packCostCents: 1_875, awpCents: null,
  contractFlag: null, availability: null, pricedOn: null, ...a,
});

describe("putting every supplier's row on the same footing", () => {
  test("a carton is priced as the package it is, not as one vial", () => {
    // McKesson lists this NDC as "(25) 3 ML" at $6.2500 a unit; API lists it as "75 ML" at $0.2532.
    // Compared on the printed unit cost API looks twenty-five times cheaper, and the buy list would
    // send every order there on a comparison of a millilitre against a vial.
    const r = wholePackage(row());
    assert.equal(r.packSize, "75 ML");
    assert.equal(r.packCostCents, 1_875, "what the box costs is the figure two wholesalers agree on");
    assert.equal(r.unitCostMicros, 250_000, "$18.75 over 75 mL is 25 cents");
  });

  test("what the file said is kept, because the first question about a changed row is what it read", () => {
    const r = wholePackage(row());
    assert.deepEqual(r.asImported, { packSize: "(25) 3 ML", unitCostMicros: 6_250_000, packCostCents: 1_875 });
  });

  test("a row without a carton is already whole and is not touched", () => {
    const plain = row({ packSize: "180 EA", unitCostMicros: 620_000, packCostCents: 11_160 });
    assert.deepEqual(wholePackage(plain), plain);
    // "(1) 100 EA" is a carton of one, which is the same package written the long way.
    const one = row({ packSize: "(1) 100 EA", unitCostMicros: 100_000, packCostCents: 1_000 });
    assert.deepEqual(wholePackage(one), one);
  });

  test("with no pack total there is nothing to divide, so nothing is guessed", () => {
    // Choosing which of two columns to believe is the mistake this exists to avoid.
    const noTotal = row({ packCostCents: null });
    assert.deepEqual(wholePackage(noTotal), noTotal);
  });

  test("an unreadable pack size is left alone for the check that names it", () => {
    const odd = row({ packSize: "Package" });
    assert.deepEqual(wholePackage(odd), odd);
  });

  test("millilitres, grams and eaches all keep their unit", () => {
    assert.equal(wholePackage(row({ packSize: "(3) 30 ML", packCostCents: 9_364 })).packSize, "90 ML");
    assert.equal(wholePackage(row({ packSize: "(30) 1.25 GM", packCostCents: 5_000 })).packSize, "37.5 GM");
    assert.equal(wholePackage(row({ packSize: "(6) 28 EA", packCostCents: 1_492 })).packSize, "168 EA");
  });

  test("a correction already applied is not overwritten by the file's original", () => {
    // asImported is set by the fix path; levelling must not replace what the pharmacy corrected.
    const corrected = row({ asImported: { packSize: "(25) 3 ML", unitCostMicros: 1, packCostCents: 2 } });
    assert.deepEqual(wholePackage(corrected).asImported, { packSize: "(25) 3 ML", unitCostMicros: 1, packCostCents: 2 });
  });
});
