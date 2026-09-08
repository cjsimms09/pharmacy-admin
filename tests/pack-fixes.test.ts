import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { proposeFdaCorrection, unitCostMicros, isFromFda, FDA_SOURCE } from "../src/lib/pack-fixes";

/**
 * Applying the FDA's package figure blind has already broken this site once: 69 rows, and a
 * $124.99 box of patches priced at $0.74. So the tests that matter most here are the ones that
 * prove the automatic pass refuses, and the first two are the exact packages that did the damage.
 */

describe("the two packages that broke it before", () => {
  test("a box of patches the FDA counts in hours is refused, not multiplied", () => {
    // "4 POUCH in 1 CARTON / 168 h in 1 POUCH" multiplies out to 672 if hours are treated as
    // things. 672 is a clean multiple of the wholesalers' 4 — a factor of 168 — so the multiple
    // rule alone would not have saved it. The reader refuses the description outright instead.
    const p = proposeFdaCorrection({
      catalogue: "4 EA",
      packageDescription: "4 POUCH in 1 CARTON (0378-1234-56) / 168 h in 1 POUCH",
    });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "cannot-compare");
  });

  test("an inhaler counted in actuations against grams is left to a person", () => {
    // 120 actuations and 10.3 grams are both true and no factor turns one into the other.
    const p = proposeFdaCorrection({
      catalogue: "10.3 GM",
      packageDescription: "1 CANISTER in 1 CARTON (0093-1234-56) / 120 ACTUATION in 1 CANISTER",
    });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "unit-differs");
    assert.match((p as { why: string }).why, /not the same kind of thing/);
  });
});

describe("what the FDA does settle on its own", () => {
  test("thirty blister packs of six: the catalogue was quoting an inner pack", () => {
    const p = proposeFdaCorrection({
      catalogue: "30 EA",
      packageDescription: "30 BLISTER PACK in 1 CARTON (1234-5678-90) / 6 TABLET in 1 BLISTER PACK",
    });
    assert.equal(p.apply, true);
    if (!p.apply) return;
    assert.equal(p.packSize, "180 EA");
    assert.equal(p.factor, 6);
    // The arithmetic is the only record of why this changed, so it has to be in the note.
    assert.match(p.note, /180 EA/);
    assert.match(p.note, /factor of 6/);
  });

  test("nothing is written where the two already agree", () => {
    const p = proposeFdaCorrection({
      catalogue: "100 EA",
      packageDescription: "100 CAPSULE in 1 BOTTLE (0093-0073-01)",
    });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "agree");
  });

  test("a disagreement that is not a whole factor goes to a person", () => {
    const p = proposeFdaCorrection({
      catalogue: "90 EA",
      packageDescription: "100 CAPSULE in 1 BOTTLE (0093-0073-01)",
    });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "differs");
  });

  test("a description that stops at a container goes to a person, with the reason", () => {
    const p = proposeFdaCorrection({
      catalogue: "84 EA",
      packageDescription: "3 BLISTER PACK in 1 CARTON (0555-9043-58)",
    });
    assert.equal(p.apply, false);
    assert.match((p as { why: string }).why, /never says what is inside/);
  });
});

describe("a person always outranks the file", () => {
  const settled = { packSize: "42 EA", correctedBy: "Cory Simms" };

  test("a package a pharmacist has settled is never touched, even to agree with him", () => {
    // Agreeing would rewrite his name and his note with the file's, and his note is the record of
    // what was checked against what — the bottle, the invoice, the manufacturer's page.
    const p = proposeFdaCorrection({
      catalogue: "30 EA",
      packageDescription: "30 BLISTER PACK in 1 CARTON (1234-5678-90) / 6 TABLET in 1 BLISTER PACK",
      existing: settled,
    });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "already-settled");
    assert.match((p as { why: string }).why, /Cory Simms/);
  });

  test("a correction the automatic pass wrote before may be rewritten by it", () => {
    // Otherwise the first run would freeze its own answer in place and a better FDA file could
    // never improve on it.
    const p = proposeFdaCorrection({
      catalogue: "30 EA",
      packageDescription: "30 BLISTER PACK in 1 CARTON (1234-5678-90) / 6 TABLET in 1 BLISTER PACK",
      existing: { packSize: "180 EA", correctedBy: FDA_SOURCE },
    });
    assert.equal(p.apply, true);
  });

  test("the author tells the two apart", () => {
    assert.equal(isFromFda(FDA_SOURCE), true);
    assert.equal(isFromFda("Cory Simms"), false);
    assert.equal(isFromFda(null), false);
    assert.equal(isFromFda(""), false);
  });
});

describe("the cost per unit under a reading, which is what makes the choice decidable", () => {
  test("a pack cost divided by the units in the pack", () => {
    // $72.30 for 30 is $2.41 a tablet; the same box read as 180 is $0.40. The pharmacist knows
    // which one he pays, and that is the whole point of showing both.
    assert.equal(unitCostMicros(7_230, "30 EA"), 2_410_000);
    assert.equal(unitCostMicros(7_230, "180 EA"), 401_667);
  });

  test("no pack cost means no per-unit cost, rather than a made-up one", () => {
    assert.equal(unitCostMicros(null, "30 EA"), null);
    assert.equal(unitCostMicros(0, "30 EA"), null);
  });

  test("an unreadable pack size means no per-unit cost", () => {
    assert.equal(unitCostMicros(7_230, null), null);
    assert.equal(unitCostMicros(7_230, "a box"), null);
  });

  test("McKesson's inner-pack notation divides by the whole box, not the inner pack", () => {
    // "(3) 28 EA" is 84 tablets, so $84.00 is a dollar a tablet. Dividing by the inner 28 would
    // read the same box as $3.00 a tablet — three times the truth, in the direction that makes a
    // drug look worth avoiding.
    assert.equal(unitCostMicros(8_400, "(3) 28 EA"), 1_000_000);
    assert.equal(unitCostMicros(8_400, "28 EA"), 3_000_000);
  });
});
