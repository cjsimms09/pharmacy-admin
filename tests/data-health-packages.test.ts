import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fdaPackageUnits, cataloguePackUnits, comparePack, containerShape } from "../src/lib/data-health-packages";

/**
 * A pack size is a divisor. Every per-unit cost on this site is a pack cost over the units in the
 * pack, so a pack size wrong by six makes a drug look six times cheaper than it is and the buy list
 * recommends it. The failure this file guards is not "a number is slightly off" — it is a
 * purchasing recommendation built on one.
 */

describe("reading the FDA package description down to the dispensing unit", () => {
  test("a plain bottle", () => {
    assert.deepEqual(fdaPackageUnits("100 CAPSULE, DELAYED RELEASE in 1 BOTTLE (0093-0073-01)"), {
      ok: true,
      units: 100,
      uom: "EA",
    });
  });

  test("a nested blister pack multiplies out to the tablets", () => {
    // The case the whole module exists for: 3 cards of 28 is 84 tablets, not 3 of anything.
    assert.deepEqual(fdaPackageUnits("3 BLISTER PACK in 1 CARTON (0555-9043-58) / 28 TABLET in 1 BLISTER PACK"), {
      ok: true,
      units: 84,
      uom: "EA",
    });
  });

  test("a volume keeps its own unit rather than becoming a count", () => {
    assert.deepEqual(fdaPackageUnits("1 BOTTLE in 1 CARTON (0069-0069-01) / 30 mL in 1 BOTTLE"), {
      ok: true,
      units: 30,
      uom: "ML",
    });
  });

  test("a description that stops at a container is refused, not counted as containers", () => {
    // This is the bug that produced "84 EA vs FDA 3 EA". Three blister packs is not three
    // dispensing units, and reporting it as one manufactures a 28-fold disagreement out of a
    // description that simply never said what was inside.
    const r = fdaPackageUnits("3 BLISTER PACK in 1 CARTON (0555-9043-58)");
    assert.equal(r.ok, false);
    assert.match((r as { why: string }).why, /never says what is inside/);
  });

  test("every outer container is refused the same way, so none of them scores as a unit", () => {
    for (const noun of ["CARTON", "BOX", "CASE", "BLISTER PACK", "PACKAGE", "TRAY", "BOTTLE", "POUCH", "BAG"]) {
      const r = fdaPackageUnits(`4 ${noun} in 1 CASE (1234-5678-90)`);
      assert.equal(r.ok, false, `${noun} must not be read as a dispensing unit`);
    }
  });

  test("a kit has no single dispensing unit and says so", () => {
    const r = fdaPackageUnits("1 KIT in 1 CARTON (12345-678-90) * 1 TABLET in 1 BLISTER PACK");
    assert.equal(r.ok, false);
    assert.match((r as { why: string }).why, /kit/i);
  });

  test("hours are not things: the patch that became six hundred and seventy-two", () => {
    // "4 POUCH in 1 CARTON / 168 h in 1 POUCH" is four seven-day patches. Multiplied through as a
    // count it is 672, and a $124.99 patch reads as $0.74.
    const r = fdaPackageUnits("4 POUCH in 1 CARTON (0378-1234-56) / 168 h in 1 POUCH");
    assert.equal(r.ok, false);
  });

  test("nothing at all is not a package of zero", () => {
    assert.equal(fdaPackageUnits("").ok, false);
    assert.equal(fdaPackageUnits(null).ok, false);
    assert.equal(fdaPackageUnits("something the FDA never wrote").ok, false);
  });
});

describe("reading a wholesaler's pack size", () => {
  test("the plain forms", () => {
    assert.deepEqual(cataloguePackUnits("84 EA"), { ok: true, units: 84, uom: "EA" });
    assert.deepEqual(cataloguePackUnits("473 ML"), { ok: true, units: 473, uom: "ML" });
    assert.deepEqual(cataloguePackUnits("30"), { ok: true, units: 30, uom: "EA" });
  });

  test("McKesson's inner-pack notation multiplies out", () => {
    // "(3) 28 EA" is three inner packs of twenty-eight. It is 84, and it is neither 3 nor 28 —
    // priced against IPD's "84 EA" one of them looked like a third of the other.
    assert.deepEqual(cataloguePackUnits("(3) 28 EA"), { ok: true, units: 84, uom: "EA" });
  });

  test("a unit nobody can compare is refused rather than assumed to be tablets", () => {
    assert.equal(cataloguePackUnits("6 LB").ok, false);
    assert.equal(cataloguePackUnits("").ok, false);
    assert.equal(cataloguePackUnits(null).ok, false);
  });
});

describe("comparing the two", () => {
  test("the ordinary case: they agree", () => {
    assert.deepEqual(comparePack("100 EA", "100 CAPSULE in 1 BOTTLE (0093-0073-01)"), {
      verdict: "agree",
      units: 100,
      uom: "EA",
    });
  });

  test("a whole multiple is called out as one, because that is the expensive kind", () => {
    // IPD "30 EA" against an FDA 180 — thirty blister packs of six. A per-unit cost from the
    // catalogue is six times too high.
    const v = comparePack("30 EA", "30 BLISTER PACK in 1 CARTON (1234-5678-90) / 6 TABLET in 1 BLISTER PACK");
    assert.deepEqual(v, { verdict: "multiple", factor: 6, catalogue: 30, fda: 180, uom: "EA" });
  });

  test("counted in different things is its own answer, never a quantity disagreement", () => {
    // Grams against tablets cannot be reconciled by any factor, and a per-EA cost against a per-GM
    // benchmark is the error that once read as 100 times NADAC.
    const v = comparePack("60 GM", "60 TABLET in 1 BOTTLE (1234-5678-90)");
    assert.equal(v.verdict, "unit-differs");
  });

  test("an unreadable FDA description is not a disagreement", () => {
    // The heart of it. Scoring these as disagreements would put a false alarm beside every real
    // one, on the page built to find the real ones.
    const v = comparePack("84 EA", "3 BLISTER PACK in 1 CARTON (0555-9043-58)");
    assert.equal(v.verdict, "cannot-compare");
    assert.match((v as { why: string }).why, /never says what is inside/);
  });

  test("an unreadable catalogue pack size is not a disagreement either", () => {
    assert.equal(comparePack(null, "100 CAPSULE in 1 BOTTLE (0093-0073-01)").verdict, "cannot-compare");
    assert.equal(comparePack("", "100 CAPSULE in 1 BOTTLE (0093-0073-01)").verdict, "cannot-compare");
  });

  test("a genuine mismatch that is not a clean multiple is reported as itself", () => {
    const v = comparePack("90 EA", "100 CAPSULE in 1 BOTTLE (0093-0073-01)");
    assert.deepEqual(v, { verdict: "differs", catalogue: 90, fda: 100, uom: "EA" });
  });

  test("the nested case both sides read correctly comes out as agreement", () => {
    // McKesson "(3) 28 EA" against the FDA's 3 × 28. Both reach 84 and there is nothing wrong.
    const v = comparePack("(3) 28 EA", "3 BLISTER PACK in 1 CARTON (0555-9043-58) / 28 TABLET in 1 BLISTER PACK");
    assert.deepEqual(v, { verdict: "agree", units: 84, uom: "EA" });
  });
});

/**
 * Naming why a description is not "containers with a volume in each".
 *
 * Two thousand NDCs reported as "not this shape" is a number nobody can act on, and guessing at
 * what the bulk of them were is what produced a rule that reached 309 of 12,659. Each reason is a
 * different piece of work, so each is named.
 */
describe("why a package is not containers-with-contents", () => {
  test("a single level counting tablets is a count, not a measure", () => {
    assert.match(containerShape("100 CAPSULE in 1 BOTTLE (0093-0073-01)"), /one level only, counting/);
  });

  test("a nested package whose innermost is still counted", () => {
    assert.match(
      containerShape("3 BLISTER PACK in 1 CARTON (0555-9043-58) / 28 TABLET in 1 BLISTER PACK"),
      /innermost "TABLET" is counted, not measured/,
    );
  });

  test("outer packaging that nobody dispenses is named as such", () => {
    assert.match(
      containerShape("1 CARTON in 1 CASE (0002-7501-99) / 20 mL in 1 CARTON"),
      /is packaging, not a container anybody dispenses/,
    );
  });

  test("a duration is not a unit, and says so rather than being called a shape problem", () => {
    assert.match(containerShape("4 POUCH in 1 CARTON (0378-1234-56) / 168 h in 1 POUCH"), /not a dispensing unit/);
  });

  test("a kit and an empty description are their own answers", () => {
    assert.match(containerShape("1 KIT in 1 CARTON (1) * 1 TABLET in 1 BLISTER PACK"), /kit/);
    assert.match(containerShape(""), /no FDA package description/);
    assert.match(containerShape(null), /no FDA package description/);
  });

  test("the shape the rule does handle says so, so the breakdown adds up", () => {
    assert.match(containerShape("1 VIAL in 1 CARTON (0002-7501-01) / 20 mL in 1 VIAL"), /this rule's own shape/);
  });
});

/**
 * The FDA's qualifier after the comma must not defeat any of the lists.
 *
 * The directory writes "BOTTLE, PLASTIC", "VIAL, SINGLE-USE", "SYRINGE, PLASTIC". Every list here
 * names the thing, not the thing plus an adjective, so the qualifier let the container fault walk
 * back in behind a comma: "3 BOTTLE, PLASTIC in 1 CARTON" read as three dispensing units and gave a
 * per-unit cost three times too cheap, on the same descriptions the plain nouns refuse.
 */
describe("a container with an adjective is still a container", () => {
  test("qualified outer packaging is refused exactly as the plain nouns are", () => {
    // Only the nouns that are packaging. A bottle of unknown contents is not three of anything.
    for (const noun of ["BOTTLE, PLASTIC", "BOTTLE, PUMP", "CARTON, UNIT-DOSE", "BLISTER PACK, UNIT-DOSE"]) {
      const r = fdaPackageUnits(`3 ${noun} in 1 CASE (1234-5678-90)`);
      assert.equal(r.ok, false, `"${noun}" must not read as three dispensing units`);
    }
  });

  test("a qualified vial or syringe still counts, because those are dispensed one at a time", () => {
    // The list that stops a reading deliberately excludes vial, syringe, tube and ampule. Three
    // vials IS three dispensing units, and the qualifier must not change that in either direction.
    for (const noun of ["VIAL, SINGLE-USE", "VIAL, MULTI-DOSE", "SYRINGE, PLASTIC"]) {
      assert.deepEqual(fdaPackageUnits(`3 ${noun} in 1 CARTON (1234-5678-90)`), { ok: true, units: 3, uom: "EA" }, noun);
    }
  });

  test("a qualified dosage form is still that dosage form", () => {
    // The head noun rule has to cut both ways, or "TABLET, DELAYED RELEASE" stops being a tablet.
    assert.deepEqual(fdaPackageUnits("100 TABLET, DELAYED RELEASE in 1 BOTTLE (0093-0073-01)"), {
      ok: true,
      units: 100,
      uom: "EA",
    });
  });

  test("a qualified vial still counts as a container somebody dispenses", () => {
    // The other direction: the contents rule needs "VIAL, SINGLE-USE" to be a vial, or a package
    // the FDA describes perfectly well is refused for having an adjective in it.
    const v = comparePack("20 ML", "1 VIAL, SINGLE-USE in 1 CARTON (0002-7501-01) / 20 mL in 1 VIAL, SINGLE-USE");
    assert.equal(v.verdict, "agree");
    assert.match(containerShape("1 VIAL, SINGLE-USE in 1 CARTON (0002-7501-01) / 20 mL in 1 VIAL, SINGLE-USE"), /this rule's own shape/);
  });

  test("the shape everything else is measured against says what it is", () => {
    // It read literally "this shape", which is a label that lost its words on a page somebody reads.
    assert.doesNotMatch(containerShape("1 VIAL in 1 CARTON (1) / 20 mL in 1 VIAL"), /^this shape$/);
  });
});
