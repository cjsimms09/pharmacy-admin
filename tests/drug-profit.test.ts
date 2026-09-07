import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { drugProfit, drugProfitReport, modelFromBasis, type ClaimLeg, type Price, type Bench } from "../src/lib/drug-profit";

/**
 * Omeprazole 20 mg, two NDCs. A is the cheap one; B is dearer but carries a much higher NADAC and AWP.
 * Prices per unit in micros: A $0.03 at IPC, $0.04 at McKesson; B $0.06 at McKesson.
 * NADAC: A $0.035, B $0.09. AWP: A $0.50, B $1.20.
 */
const A = "00000000001";
const B = "00000000002";
const group = (ndc: string) => (ndc === A || ndc === B ? "omeprazole|20mg|cap" : null);
const bench: Bench[] = [
  { ndc11: A, description: "OMEPRAZOLE 20MG CAP A", nadacMicros: 35_000, awpMicros: 500_000 },
  { ndc11: B, description: "OMEPRAZOLE 20MG CAP B", nadacMicros: 90_000, awpMicros: 1_200_000 },
];
const prices: Price[] = [
  { ndc11: A, supplier: "IPC", effectiveUnitMicros: 30_000, source: "catalogue", itemNumber: "5001" },
  { ndc11: A, supplier: "McKesson", effectiveUnitMicros: 40_000, source: "invoice" },
  { ndc11: B, supplier: "McKesson", effectiveUnitMicros: 60_000, source: "catalogue", itemNumber: "9001" },
];
// Thirty capsules a fill, dispensed as A today.
const leg = (i: number, over: Partial<ClaimLeg> = {}): ClaimLeg => ({
  fillKey: `f${i}`, ndc11: A, dateFilled: "2026-08-15", payer: "Caremark", basisCode: null, quantityThousandths: 30_000,
  remitCents: 0, ingredientPaidCents: null, feePaidCents: null, awpCents: null, cashPlan: false, ...over,
});

describe("the basis code", () => {
  test("reads the codes that decide the NDC and treats the rest as flat", () => {
    assert.equal(modelFromBasis("01"), "AWP");
    assert.equal(modelFromBasis("06"), "MAC");
    assert.equal(modelFromBasis("20"), "NADAC");
    assert.equal(modelFromBasis("7"), "UC");
    assert.equal(modelFromBasis("05"), "flat");
    assert.equal(modelFromBasis(""), null);
    assert.equal(modelFromBasis("99"), null);
  });
});

describe("which NDC earns most, given how the payer pays", () => {
  test("NADAC plus a fee: the NDC furthest under its own NADAC wins, not the cheapest", () => {
    // Paid NADAC(A) × 30 = $1.05 ingredient + $10.50 fee, no basis code: inferred from the arithmetic.
    const legs = Array.from({ length: 10 }, (_, i) => leg(i, { remitCents: 1_155, ingredientPaidCents: 105, feePaidCents: 1_050 }));
    const [r] = drugProfit({ legs, prices, bench, groupOf: group, months: 1 });
    assert.equal(r.model, "NADAC");
    assert.equal(r.modelShare, 1);
    assert.equal(r.modelSays, "NADAC + $10.50");
    // A at IPC: revenue $1.05 + $10.50 = $11.55, cost $0.90 → $10.65. B at McKesson: $2.70 + $10.50 − $1.80 = $11.40.
    assert.equal(r.best?.ndc11, B, "B is dearer and earns more, because the plan pays B's own NADAC");
    assert.equal(r.best?.marginCents, 1_140);
    assert.equal(r.best?.itemNumber, "9001");
    assert.equal(r.current?.ndc11, A);
    assert.equal(r.current?.supplier, "McKesson", "priced at what it was last bought for, the invoice");
    assert.equal(r.current?.marginCents, 1_155 - 120);
    assert.equal(r.gainPerFillCents, 1_140 - 1_035);
    assert.equal(r.gainPerMonthCents, (1_140 - 1_035) * 10);
    assert.match(r.why, /furthest under its own NADAC/);
  });

  test("AWP less a discount: the NDC with the higher AWP wins", () => {
    // Basis code 01, paid AWP(A) × 30 × (1 − 0.8) = $3.00 + $1.00 fee.
    const legs = Array.from({ length: 5 }, (_, i) => leg(i, { basisCode: "01", remitCents: 400, ingredientPaidCents: 300, feePaidCents: 100, awpCents: 1_500 }));
    const [r] = drugProfit({ legs, prices, bench, groupOf: group, months: 1 });
    assert.equal(r.model, "AWP");
    assert.equal(r.modelSays, "AWP − 80.0% + $1.00");
    // B: AWP $36 × 0.2 = $7.20 + $1 − $1.80 = $6.40. A at IPC: $3 + $1 − $0.90 = $3.10.
    assert.equal(r.best?.ndc11, B);
    assert.equal(r.best?.marginCents, 640);
  });

  test("a MAC or a flat price: the cheapest NDC after rebate wins, and the model is named", () => {
    const legs = Array.from({ length: 4 }, (_, i) => leg(i, { basisCode: "06", remitCents: 350, ingredientPaidCents: 200, feePaidCents: 150 }));
    const [r] = drugProfit({ legs, prices, bench, groupOf: group, months: 2 });
    assert.equal(r.model, "MAC");
    assert.equal(r.best?.ndc11, A);
    assert.equal(r.best?.supplier, "IPC");
    assert.equal(r.best?.marginCents, 350 - 90);
    assert.equal(r.fillsPerMonth, 2);
    assert.match(r.why, /cheapest NDC/);
  });

  test("the model is the majority of fills, payers are counted, and a coordinated fill is read on its pricing leg", () => {
    const legs = [
      ...Array.from({ length: 6 }, (_, i) => leg(i, { basisCode: "20", remitCents: 1_155, ingredientPaidCents: 105, feePaidCents: 1_050 })),
      ...Array.from({ length: 3 }, (_, i) => leg(10 + i, { payer: "ESI", basisCode: "06", remitCents: 350, ingredientPaidCents: 200, feePaidCents: 150 })),
      // The secondary leg of fill f0: smaller, and never the one that sets the model.
      leg(0, { payer: "Medicaid", basisCode: "06", remitCents: 50, ingredientPaidCents: 50, feePaidCents: 0 }),
    ];
    const [r] = drugProfit({ legs, prices, bench, groupOf: group, months: 1 });
    assert.equal(r.fills, 9);
    assert.equal(r.model, "NADAC");
    assert.equal(Math.round(r.modelShare * 100), 67);
    assert.deepEqual(r.payers.map((p) => [p.payer, p.fills, p.model]), [["Caremark", 6, "NADAC"], ["ESI", 3, "MAC"]]);
  });

  test("an NDC with no price, or no benchmark under the model, is left out and counted", () => {
    const legs = Array.from({ length: 3 }, (_, i) => leg(i, { basisCode: "20", remitCents: 1_155, ingredientPaidCents: 105, feePaidCents: 1_050 }));
    const [r] = drugProfit({ legs, prices: prices.filter((p) => p.ndc11 === A), bench: [bench[0]], groupOf: group, months: 1 });
    assert.equal(r.best?.ndc11, A);
    assert.equal(r.candidates.length, 2);
    const [r2] = drugProfit({ legs, prices, bench: [bench[0]], groupOf: group, months: 1 });
    assert.equal(r2.leftOut.noBenchmark, 1, "B has a price but no NADAC held, so it cannot be placed under a NADAC model");
  });

  test("cash fills are not a payer model, and a fill with no quantity is skipped", () => {
    const legs = [leg(0, { cashPlan: true, remitCents: 2_000 }), leg(1, { quantityThousandths: null, remitCents: 2_000 })];
    assert.deepEqual(drugProfit({ legs, prices, bench, groupOf: group, months: 1 }), []);
  });
});

describe("what the law settles, and the mix of ways a drug is paid", () => {
  test("a fill on a plan the floor reaches, paid at the floor, is NADAC plus the fee by law — whatever the code says", () => {
    // Paid exactly NADAC(A) × 30 + $10.50, the PBM's code saying MAC: the floor bound, and the law wins.
    const legs = Array.from({ length: 6 }, (_, i) => leg(i, { settled: "floor", basisCode: "06", remitCents: 1_155, ingredientPaidCents: 105, feePaidCents: 1_050 }));
    const { rows, summary } = drugProfitReport({ legs, prices, bench, groupOf: group, months: 1, floorFeeCents: 1_050 });
    const [r] = rows;
    assert.equal(r.model, "NADAC");
    assert.equal(r.modelSays, "NADAC + $10.50");
    assert.deepEqual(r.settledBy, { law: 6, code: 0, inferred: 0 });
    assert.equal(r.confidence, "settled");
    assert.deepEqual(r.floor, { bound: 6, above: 0, unpriced: 0 });
    assert.equal(r.best?.ndc11, B, "the NDC furthest under its own NADAC, because the floor pays each NDC's own");
    assert.equal(summary.byLaw.fills, 6);
    assert.equal(summary.byLaw.remitCents, 6 * 1_155);
    assert.deepEqual(summary.floor, { fills: 6, bound: 6, above: 0, unpriced: 0 });
  });

  test("a floor fill paid well above the floor was priced by the contract, and is read the ordinary way", () => {
    // $3.50 paid on a $1.05 NADAC fill: the MAC paid more than the floor, so the floor did not bind.
    const legs = Array.from({ length: 4 }, (_, i) => leg(i, { settled: "floor", basisCode: "06", remitCents: 1_600, ingredientPaidCents: 400, feePaidCents: 1_200 }));
    const { rows, summary } = drugProfitReport({ legs, prices, bench, groupOf: group, months: 1, floorFeeCents: 1_050 });
    const [r] = rows;
    assert.equal(r.model, "MAC");
    assert.deepEqual(r.settledBy, { law: 0, code: 4, inferred: 0 });
    assert.deepEqual(r.floor, { bound: 0, above: 4, unpriced: 0 });
    assert.equal(r.best?.ndc11, A, "the contract pays the same whichever NDC, so the cheapest wins");
    assert.equal(summary.floor.above, 4);
  });

  test("a floor fill on an NDC with no NADAC cannot be priced against the floor, and says so", () => {
    const legs = Array.from({ length: 3 }, (_, i) => leg(i, { settled: "floor", remitCents: 1_155, ingredientPaidCents: 105, feePaidCents: 1_050 }));
    const { rows } = drugProfitReport({ legs, prices, bench: [{ ...bench[0], nadacMicros: null }, bench[1]], groupOf: group, months: 1 });
    assert.deepEqual(rows[0].floor, { bound: 0, above: 0, unpriced: 3 });
    assert.equal(rows[0].settledBy.inferred, 3);
  });

  test("Medicaid is NADAC by law, at the ratio it actually paid", () => {
    const legs = Array.from({ length: 3 }, (_, i) => leg(i, { settled: "medicaid", payer: "KS Medicaid", remitCents: 105 + 1_200, ingredientPaidCents: 105, feePaidCents: 1_200 }));
    const [r] = drugProfit({ legs, prices, bench, groupOf: group, months: 1 });
    assert.equal(r.model, "NADAC");
    assert.equal(r.modelSays, "NADAC + $12.00");
    assert.equal(r.settledBy.law, 3);
  });

  test("a drug split between a floor plan and a MAC plan gets the NDC that wins on the month, weighed by share", () => {
    // Half the fills at the floor (B earns $11.40, A at IPC $10.65), half on a MAC paying $2.00 + $1.50 (A $2.60, B $1.70).
    const legs = [
      ...Array.from({ length: 5 }, (_, i) => leg(i, { settled: "floor", remitCents: 1_155, ingredientPaidCents: 105, feePaidCents: 1_050 })),
      ...Array.from({ length: 5 }, (_, i) => leg(10 + i, { payer: "ESI", basisCode: "06", remitCents: 350, ingredientPaidCents: 200, feePaidCents: 150 })),
    ];
    const [r] = drugProfit({ legs, prices, bench, groupOf: group, months: 1, floorFeeCents: 1_050 });
    assert.equal(r.mix.length, 2);
    assert.deepEqual(r.mix.map((m) => [m.model, m.share]), [["NADAC", 0.5], ["MAC", 0.5]]);
    // Weighted revenue: B (270 + 1050)/2 + 350/2 = 835 → margin 835 − 180 = 655. A at IPC (105 + 1050)/2 + 350/2 = 752.5 → 753 − 90 = 663.
    assert.equal(r.best?.ndc11, A, "on the whole month A wins by a hair; on the floor fills alone B would");
    assert.equal(r.best?.marginCents, 663);
    const b = r.candidates.find((c) => c.ndc11 === B);
    assert.equal(b?.marginCents, 655);
    assert.match(r.why, /50% of fills are paid another way/);
    assert.equal(r.confidence, "settled");
  });

  test("a way of paying under one fill in twenty does not decide, and an NDC that one weighed way cannot price is left out whole", () => {
    // 24 floor fills and one AWP fill: the AWP fill is too thin to weigh, so B needs no AWP to be placed.
    const legs = [
      ...Array.from({ length: 24 }, (_, i) => leg(i, { settled: "floor", remitCents: 1_155, ingredientPaidCents: 105, feePaidCents: 1_050 })),
      leg(99, { basisCode: "01", remitCents: 400, ingredientPaidCents: 300, feePaidCents: 100, awpCents: 1_500 }),
    ];
    const noAwp = bench.map((b) => ({ ...b, awpMicros: null }));
    const [r] = drugProfit({ legs, prices, bench: noAwp, groupOf: group, months: 1 });
    assert.equal(r.best?.ndc11, B);
    assert.equal(r.leftOut.noBenchmark, 0);
    // Half AWP fills: now B cannot be priced without an AWP, and is left out rather than valued on the floor fills alone.
    const half = [
      ...Array.from({ length: 5 }, (_, i) => leg(i, { settled: "floor", remitCents: 1_155, ingredientPaidCents: 105, feePaidCents: 1_050 })),
      ...Array.from({ length: 5 }, (_, i) => leg(10 + i, { basisCode: "01", remitCents: 400, ingredientPaidCents: 300, feePaidCents: 100, awpCents: 1_500 })),
    ];
    const [r2] = drugProfit({ legs: half, prices, bench: noAwp, groupOf: group, months: 1 });
    assert.equal(r2.leftOut.noBenchmark, 2, "both NDCs lack an AWP");
    assert.equal(r2.candidates.length, 0);
  });
});
