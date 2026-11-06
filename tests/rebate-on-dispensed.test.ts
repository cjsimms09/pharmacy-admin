import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rebateOnDispensed } from "../src/lib/rebate-on-dispensed";

describe("the wholesaler rebate that belongs to what was dispensed", () => {
  const flagged = new Map<string, boolean>([
    ["11111111111", true],
    ["22222222222", false],
  ]);
  const fills = [
    { ndc11: "11111111111", itemName: "ATORVASTATIN 20MG TAB", acquisitionCents: 10_000 },
    { ndc11: "11111111111", itemName: "ATORVASTATIN 20MG TAB", acquisitionCents: 5_000 },
    { ndc11: "22222222222", itemName: "ELIQUIS 5MG TAB", acquisitionCents: 40_000 },
    { ndc11: "33333333333", itemName: "SOMETHING BOUGHT ELSEWHERE", acquisitionCents: 7_000 },
    { ndc11: "22222222222", itemName: "OZEMPIC 1 MG/DOSE PEN", acquisitionCents: 90_000 },
    { ndc11: "11111111111", itemName: "ATORVASTATIN 20MG TAB", acquisitionCents: null },
  ];

  test("contract products earn the contract rate and other McKesson products the brand factor, on their dispensed cost", () => {
    const r = rebateOnDispensed(fills, flagged, { contractPercent: 30, brandPercent: 1 });
    assert.equal(r.contractCostCents, 15_000);
    assert.equal(r.brandCostCents, 40_000);
    assert.equal(r.cents, 4_500 + 400);
  });

  test("a GLP-1 earns nothing even though its product is on the wholesaler's invoices, and is named", () => {
    const r = rebateOnDispensed(fills, flagged, { contractPercent: 30, brandPercent: 1 });
    assert.equal(r.glp1CostCents, 90_000);
    assert.match(r.note, /GLP-1s \(\$900\.00\)/);
  });

  test("a product never bought from the wholesaler earns nothing from it, and a fill with no cost is not counted", () => {
    const r = rebateOnDispensed(fills, flagged, { contractPercent: 30, brandPercent: 1 });
    assert.equal(r.otherCostCents, 7_000);
  });

  test("a month at a lower band earns less on the same fills", () => {
    const r = rebateOnDispensed(fills, flagged, { contractPercent: 29, brandPercent: 0.75 });
    assert.equal(r.cents, Math.round(15_000 * 0.29) + Math.round(40_000 * 0.0075));
  });

  test("no rates, no rebate", () => {
    assert.equal(rebateOnDispensed(fills, flagged, { contractPercent: null, brandPercent: null }).cents, 0);
  });
});
