import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { proposeFdaCorrection, proposeContainerContents, unitCostMicros, isFromFda, isFromPerson, FDA_SOURCE, FDA_CONTENTS_SOURCE } from "../src/lib/pack-fixes";

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

/**
 * A wholesaler counting containers where the FDA states what is in them.
 *
 * "McKesson counts 1 EA where the FDA counts 20 ML" is not a disagreement about the package — it is
 * two conventions describing one box truthfully, and it is every single-dose vial in the catalogue.
 * The FDA's reading is the one to keep because NADAC prices injectables per millilitre, and a
 * per-EA cost held against a per-ML benchmark is the fault that once read as 100 times NADAC.
 */
describe("containers counted against contents stated", () => {
  const vial20 = "1 VIAL in 1 CARTON (0002-7501-01) / 20 mL in 1 VIAL";

  test("one vial against twenty millilitres settles at the millilitres", () => {
    const p = proposeContainerContents({ catalogue: "1 EA", packageDescription: vial20, nadacUnit: "ML" });
    assert.equal(p.apply, true);
    if (!p.apply) return;
    assert.equal(p.packSize, "20 ML");
    assert.match(p.note, /NADAC prices this NDC per millilitre/);
  });

  test("twenty-five syringes of three millilitres", () => {
    const p = proposeContainerContents({
      catalogue: "25 EA",
      packageDescription: "25 SYRINGE in 1 CARTON (0002-7501-25) / 3 mL in 1 SYRINGE",
      nadacUnit: "ML",
    });
    assert.equal(p.apply, true);
    if (!p.apply) return;
    assert.equal(p.packSize, "75 ML");
  });

  test("THE GUARD: the wholesaler's count must equal the number of containers", () => {
    // Without this the rule would settle "4 EA" at the contents of one vial and make the per-unit
    // cost wrong by four. A mismatch is not two conventions, it is two different numbers.
    const p = proposeContainerContents({ catalogue: "4 EA", packageDescription: vial20, nadacUnit: "ML" });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "differs");
    assert.match((p as { why: string }).why, /not the same package by two conventions/);
  });

  test("a carton is not a container anybody dispenses, so it is still refused", () => {
    const p = proposeContainerContents({
      catalogue: "1 EA",
      packageDescription: "1 CARTON in 1 CASE (0002-7501-99) / 20 mL in 1 CARTON",
      nadacUnit: "ML",
    });
    assert.equal(p.apply, false);
  });

  test("a package counted in tablets is not this shape at all", () => {
    const p = proposeContainerContents({
      catalogue: "100 EA",
      packageDescription: "100 CAPSULE in 1 BOTTLE (0093-0073-01)",
      nadacUnit: "ML",
    });
    assert.equal(p.apply, false);
    assert.match((p as { why: string }).why, /does not describe this as containers/);
  });

  test("a catalogue already counting millilitres is not counting containers", () => {
    const p = proposeContainerContents({ catalogue: "20 ML", packageDescription: vial20, nadacUnit: "ML" });
    assert.equal(p.apply, false);
    assert.match((p as { why: string }).why, /already counts ML/);
  });

  test("the patch is refused here too, because hours are not a volume", () => {
    const p = proposeContainerContents({
      catalogue: "4 EA",
      packageDescription: "4 POUCH in 1 CARTON (0378-1234-56) / 168 h in 1 POUCH",
      nadacUnit: "ML",
    });
    assert.equal(p.apply, false);
  });
});

describe("the two automatic rules do not fight each other", () => {
  const vial20 = "1 VIAL in 1 CARTON (0002-7501-01) / 20 mL in 1 VIAL";

  test("neither rule may touch a package a person signed", () => {
    const person = { packSize: "1 EA", correctedBy: "Cory Simms" };
    assert.equal(proposeContainerContents({ catalogue: "1 EA", packageDescription: vial20, nadacUnit: "ML", existing: person }).apply, false);
    assert.equal(
      proposeFdaCorrection({
        catalogue: "30 EA",
        packageDescription: "30 BLISTER PACK in 1 CARTON (1234-5678-90) / 6 TABLET in 1 BLISTER PACK",
        existing: person,
      }).apply,
      false,
    );
  });

  test("the multiple rule does not overwrite a contents correction, which is the more specific one", () => {
    const p = proposeFdaCorrection({
      catalogue: "30 EA",
      packageDescription: "30 BLISTER PACK in 1 CARTON (1234-5678-90) / 6 TABLET in 1 BLISTER PACK",
      existing: { packSize: "20 ML", correctedBy: FDA_CONTENTS_SOURCE },
    });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "already-settled");
  });

  test("both automatic authors are counted as the file, not as a person", () => {
    // Getting this wrong is a quiet miscount: rows the file settled would be reported as work
    // somebody did by hand.
    assert.equal(isFromFda(FDA_CONTENTS_SOURCE), true);
    assert.equal(isFromPerson(FDA_CONTENTS_SOURCE), false);
    assert.equal(isFromPerson("Cory Simms"), true);
    assert.equal(isFromPerson(""), false);
  });
});

/**
 * NADAC decides the unit; the FDA only decides the quantity.
 *
 * The first version of the contents rule would have been wrong, and the claims proved it. Of the
 * dispensed NDCs it would have touched, not one is billed in millilitres: Restasis is billed 60
 * against an FDA package of 24 mL — sixty 0.4 mL vials, billed per vial; an EpiPen is billed 2
 * against 0.6 mL; clindamycin pledgets are billed 60 against "60 mL", where the number matches by
 * coincidence and the things are pledgets. Rewriting those to millilitres would have made an
 * injectable look enormously profitable.
 *
 * claims.quantity_unit cannot arbitrate — the daily report never carries it and it is null on every
 * row — so the document that states the unit is NADAC.
 */
describe("the unit comes from NADAC, not from the FDA", () => {
  const vial20 = "1 VIAL in 1 CARTON (0002-7501-01) / 20 mL in 1 VIAL";

  test("NADAC counting in EA closes the question without a correction", () => {
    // Nothing was wrong. The wholesaler's count is the right divisor, and this is a different
    // answer from "somebody must look at it" — the page counts the two apart.
    const p = proposeContainerContents({ catalogue: "1 EA", packageDescription: vial20, nadacUnit: "EA" });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "counted-as-nadac-counts");
    assert.match((p as { why: string }).why, /nothing needs correcting/);
  });

  test("no NADAC row means no document states the unit, so a person does", () => {
    const p = proposeContainerContents({ catalogue: "1 EA", packageDescription: vial20, nadacUnit: null });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "no-nadac");
  });

  test("NADAC counting in millilitres is what lets the FDA's contents stand", () => {
    const p = proposeContainerContents({ catalogue: "1 EA", packageDescription: vial20, nadacUnit: "ML" });
    assert.equal(p.apply, true);
    if (!p.apply) return;
    assert.equal(p.packSize, "20 ML");
    assert.match(p.note, /NADAC prices this NDC per millilitre/);
  });

  test("two documents disagreeing about the kind of thing goes to a person", () => {
    // NADAC says grams, the FDA measured millilitres. Neither is arithmetic away from the other.
    const p = proposeContainerContents({ catalogue: "1 EA", packageDescription: vial20, nadacUnit: "GM" });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "unit-differs");
  });

  test("the real fills: Restasis is billed per vial, and the rule must not touch it", () => {
    // Sixty 0.4 mL vials in a 24 mL package, billed 60. NADAC prices it per EA, so the catalogue's
    // count is right and the FDA's 24 mL is the wrong divisor for margin.
    const p = proposeContainerContents({
      catalogue: "60 EA",
      packageDescription: "60 VIAL in 1 CARTON (0023-9163-60) / 0.4 mL in 1 VIAL",
      nadacUnit: "EA",
    });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "counted-as-nadac-counts");
  });

  test("the real fills: an EpiPen is two auto-injectors, not 0.6 millilitres", () => {
    const p = proposeContainerContents({
      catalogue: "2 EA",
      packageDescription: "2 SYRINGE in 1 CARTON (49502-0102-02) / 0.3 mL in 1 SYRINGE",
      nadacUnit: "EA",
    });
    assert.equal(p.apply, false);
    assert.equal((p as { verdict: string }).verdict, "counted-as-nadac-counts");
  });
});
