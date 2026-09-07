import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { problemsWith, packUnits, worstLevel, type CatalogueItem } from "../src/lib/catalogue-check";

/** A row as the McKesson import stores one, sound unless a test says otherwise. */
function item(a: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    ndc11: "68462043518",
    supplier: "McKesson",
    description: "Acamprosate Calc Dr 333 Mg Tab",
    packSize: "180 EA",
    // $0.62 a tablet, 180 to the bottle, $111.60 the bottle.
    unitCostMicros: 620_000,
    packCostCents: 11_160,
    awpCents: 31_626,
    contractFlag: "rebated",
    ...a,
  };
}

describe("reading a pack size", () => {
  test("the plain form and the order-multiple form", () => {
    assert.equal(packUnits("180 EA"), 180);
    assert.equal(packUnits("(12) 500 ML"), 500, "the bracket is how many packs an order line buys, not the pack");
    assert.equal(packUnits("30 GM"), 30);
  });

  test("anything that gives no number of units is null, not a guess", () => {
    assert.equal(packUnits(null), null);
    assert.equal(packUnits(""), null);
    assert.equal(packUnits("Package"), null);
    assert.equal(packUnits("0 EA"), null, "nought units is not a pack size");
  });
});

describe("what is wrong with a catalogue row", () => {
  test("a sound row has nothing said about it", () => {
    assert.deepEqual(problemsWith(item(), 600_000), []);
  });

  test("a pack size that gives no number is wrong, because the row drops out of everything", () => {
    const p = problemsWith(item({ packSize: "Package", packCostCents: null }));
    assert.equal(p.length, 1);
    assert.equal(p[0].kind, "pack_size_unreadable");
    assert.equal(p[0].level, "wrong");
  });

  test("a pack cost that disagrees with its own unit cost names all three figures", () => {
    // 180 × $0.62 is $111.60, and the row claims $11.16 — a decimal place, or the wrong column.
    const p = problemsWith(item({ packCostCents: 1_116 }));
    const disagree = p.find((x) => x.kind === "pack_cost_disagrees");
    assert.ok(disagree, "the disagreement is found");
    assert.match(disagree.says, /\$111\.60/);
    assert.match(disagree.says, /\$11\.16/);
    assert.equal(disagree.level, "wrong");
  });

  test("rounding between cents and millionths is not a disagreement", () => {
    // $0.6249 a unit over 7 units is 437.43 cents, stored as 437.
    const p = problemsWith(item({ packSize: "7 EA", unitCostMicros: 624_900, packCostCents: 437, awpCents: null }));
    assert.equal(p.filter((x) => x.kind === "pack_cost_disagrees").length, 0);
  });

  test("a price a long way from NADAC is a misplaced column, and is said as a factor", () => {
    // $6.20 a tablet against NADAC's $0.60: ten times, which is a pack price in a unit column.
    const p = problemsWith(item({ unitCostMicros: 6_200_000, packCostCents: 111_600 }), 600_000);
    const far = p.find((x) => x.kind === "price_far_from_nadac");
    assert.ok(far);
    assert.match(far.says, /10\.3 times/);
    assert.equal(far.level, "check");
  });

  test("a good price is not a problem, and a dear drug is not one either", () => {
    // Half of NADAC is a good week, not a fault.
    assert.equal(problemsWith(item({ unitCostMicros: 300_000, packCostCents: 5_400 }), 600_000).length, 0);
    // Bortezomib at $1,058.85 a vial, with no benchmark held, says nothing.
    const dear = item({ packSize: "1 EA", unitCostMicros: 1_058_850_000, packCostCents: 105_885, awpCents: null });
    assert.deepEqual(problemsWith(dear, null), []);
  });

  test("a list price under the cost is worth a look, because a plan pays a discount off it", () => {
    const p = problemsWith(item({ awpCents: 9_000 }), 600_000);
    const awp = p.find((x) => x.kind === "awp_below_cost");
    assert.ok(awp);
    assert.match(awp.says, /\$90\.00/);
    assert.match(awp.says, /\$111\.60/);
    assert.equal(awp.costCents, 2_160, "what it is worth is the gap, not the price of the pack");
  });

  test("a list price a penny under the cost is stale, not a fault", () => {
    // The real McKesson file has 176 rows under one per cent, and putting a $3,720 vial that is
    // twenty dollars light at the top buried the rows that were actually costing money.
    assert.equal(problemsWith(item({ awpCents: 11_159 }), 600_000).length, 0, "a penny is rounding");
    assert.equal(problemsWith(item({ awpCents: 11_100 }), 600_000).length, 0, "half a per cent is not a fault");
    // Both floors have to be cleared: a per cent of a very dear pack is still only rounding.
    const dear = item({ packSize: "1 EA", unitCostMicros: 3_720_750_000, packCostCents: 372_075, awpCents: 369_942 });
    assert.equal(problemsWith(dear, null).length, 0, "$21 off $3,720 is a stale list price, not a wrong one");
  });

  test("the biggest number wrong is what a row is worth opening for", () => {
    // 180 × $0.62 is $111.60 and the row says $11.16: the fault is worth the hundred dollars it
    // would misprice, not the eleven the row admits to.
    const p = problemsWith(item({ packCostCents: 1_116, awpCents: null }));
    const disagree = p.find((x) => x.kind === "pack_cost_disagrees");
    assert.ok(disagree);
    assert.equal(disagree.costCents, 10_044);
  });

  test("no price at all is said once, and nothing else is claimed about the row", () => {
    const p = problemsWith(item({ unitCostMicros: null, packCostCents: null, packSize: "rubbish" }), 600_000);
    assert.equal(p.length, 1);
    assert.equal(p[0].kind, "no_price");
  });

  test("arithmetic outranks opinion when a list is sorted", () => {
    assert.equal(worstLevel(problemsWith(item({ packSize: "Package", packCostCents: null }))), "wrong");
    assert.equal(worstLevel(problemsWith(item({ awpCents: 9_000 }), 600_000)), "check");
    assert.equal(worstLevel([]), null);
  });
});
