import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { problemsWith, packUnits, worstLevel, quarantineWrongPrices, type CatalogueItem } from "../src/lib/catalogue-check";
import { packReadings } from "../src/lib/drug-file";

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

describe("a price the arithmetic says is wrong never wins a comparison", () => {
  const row = (supplier: string, packSize: string | null, unitCostMicros: number | null, corrected = false) => ({
    ndc11: "00555904358", supplier, packSize, unitCostMicros,
    packCostCents: unitCostMicros !== null && packUnits(packSize) ? Math.round((unitCostMicros * packUnits(packSize)!) / 10_000) : null,
    corrected,
  });

  test("the real Apri row: one wholesaler calls a six-card box 1 EA and prices it 118x dear", () => {
    const { rows, taken } = quarantineWrongPrices([
      row("Smith Drug", "168 EA", 130_200),
      row("TopRx", "168 EA", 130_200),
      row("McKesson", "168 EA", 130_200),
      row("ABC (Cencora)", "1 EA", 15_390_000),
    ]);
    const abc = rows.find((r) => r.supplier === "ABC (Cencora)")!;
    assert.equal(abc.unitCostMicros, null, "its price is withheld");
    assert.equal(abc.packCostCents, null);
    assert.equal(abc.packSize, "1 EA", "the row itself stays, so the supplier is still known to carry it");
    assert.equal(rows.filter((r) => r.unitCostMicros !== null).length, 3, "the three that agree are untouched");
    assert.match(taken.get("00555904358|ABC (Cencora)")!.says, /118 times dearer/);
  });

  test("the expensive direction: a row that looks cheapest and would take the order", () => {
    // Fondaparinux. ABC reads 4 ML at $12.50 where the rest read 1.2 ML at $57.12 — five times
    // cheaper than anybody, so it wins, and the invoice arrives at five times the promise.
    const { rows } = quarantineWrongPrices([
      row("ParMed", "1.2 ML", 57_116_700),
      row("McKesson", "1.2 ML", 57_116_700),
      row("Smith Drug", "1.2 ML", 57_000_000),
      row("ABC (Cencora)", "4 ML", 12_497_500),
    ]);
    const cheapest = rows.filter((r) => r.unitCostMicros !== null).sort((a, b) => a.unitCostMicros! - b.unitCostMicros!)[0];
    assert.notEqual(cheapest.supplier, "ABC (Cencora)", "the wrong row can no longer win the order");
  });

  test("two notations for one box are not touched: the price agrees, so nothing is wrong", () => {
    // McKesson's "(25) 3 ML" and API's "75 ML" level to the same unit price; only the wording differs.
    const { rows, taken } = quarantineWrongPrices([
      row("McKesson", "(25) 3 ML", 253_200),
      row("API", "75 ML", 253_200),
      row("ABC (Cencora)", "75 ML", 250_000),
    ]);
    assert.equal(taken.size, 0);
    assert.equal(rows.filter((r) => r.unitCostMicros === null).length, 0);
  });

  test("a real price difference is left alone, however large, while the package agrees", () => {
    // A short-dated lot or a genuinely better contract is not an error. Same package, so it stands.
    const { taken } = quarantineWrongPrices([
      row("McKesson", "100 EA", 500_000),
      row("ABC (Cencora)", "100 EA", 500_000),
      row("ANDA", "100 EA", 40_000),
    ]);
    assert.equal(taken.size, 0);
  });

  test("two suppliers are never enough to make one of them a majority", () => {
    const { taken } = quarantineWrongPrices([row("McKesson", "168 EA", 130_200), row("ABC (Cencora)", "1 EA", 15_390_000)]);
    assert.equal(taken.size, 0, "with nobody to break the tie the site does not get to pick a winner");
  });

  test("an even split is not a majority either", () => {
    const { taken } = quarantineWrongPrices([
      row("McKesson", "168 EA", 130_200),
      row("Smith Drug", "168 EA", 130_200),
      row("ABC (Cencora)", "1 EA", 15_390_000),
      row("ANDA", "1 EA", 15_390_000),
    ]);
    assert.equal(taken.size, 0);
  });

  test("a row the pharmacy corrected by hand is never second-guessed", () => {
    const { rows, taken } = quarantineWrongPrices([
      row("Smith Drug", "168 EA", 130_200),
      row("TopRx", "168 EA", 130_200),
      row("McKesson", "168 EA", 130_200),
      row("ABC (Cencora)", "1 EA", 15_390_000, true),
    ]);
    assert.equal(taken.size, 0, "the pharmacy has the bottle and the site does not");
    assert.equal(rows.find((r) => r.supplier === "ABC (Cencora)")!.unitCostMicros, 15_390_000);
  });
});

describe("the FDA settles an argument, it does not overrule everybody", () => {
  /*
   * Every case here is a real row from the pharmacy's catalogue after the first FDA load, when the
   * directory's figure was applied without asking whether anybody recognised it. 69 rows moved and
   * several moved badly: a $124.99 buprenorphine patch read as $0.74.
   *
   * The rule the code now applies: use the FDA's package only where some supplier already reads it
   * that way — same measure, and its own inner or whole figure equal to the FDA's.
   */
  const agrees = (supplierPacks: string[], fda: string): boolean => {
    const seen = new Set<string>();
    for (const p of supplierPacks) {
      const r = packReadings(p);
      if (r.uom === null) continue;
      if (r.inner !== null) seen.add(`${r.inner} ${r.uom}`);
      if (r.whole !== null) seen.add(`${r.whole} ${r.uom}`);
    }
    return seen.has(fda);
  };

  test("a box of four patches is not six hundred and seventy-two", () => {
    // The FDA states a seven-day patch as 168 hours in a pouch; multiplied through it is 672.
    assert.equal(agrees(["4 EA"], "672 EA"), false);
    assert.equal(agrees(["4 EA"], "96 EA"), false, "and a daily clonidine patch is not 96 either");
  });

  test("actuations are not grams, however confidently either is stated", () => {
    // Breyna: the wholesalers price the 10.3 g canister, the FDA counts 120 doses out of it.
    assert.equal(agrees(["10.3 GM"], "120 EA"), false);
    assert.equal(agrees(["(2) 33.4 GM"], "2 EA"), false);
  });

  test("but a carton written out is exactly what this is for", () => {
    // Atovaquone: McKesson writes 42 bottles of 5 mL, the FDA writes 210 mL. One package.
    assert.equal(agrees(["(42) 5 ML"], "210 ML"), true);
    // Apri: one wholesaler writes the box out, another writes the cards, the FDA agrees with one.
    assert.equal(agrees(["1 EA", "168 EA", "(6) 28 EA"], "168 EA"), true);
  });

  test("a reading nobody in the trade recognises is refused", () => {
    // Asenapine: every file says 60 or 100 and the directory says 600 or 1000.
    assert.equal(agrees(["60 EA", "60 EA", "1 EA"], "600 EA"), false);
    assert.equal(agrees(["100 EA"], "1000 EA"), false);
  });
});
