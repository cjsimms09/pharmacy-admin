import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cashPricing, type CashFill } from "../src/lib/cash-pricing";

const A = "00000000001"; // NADAC $0.05 a tablet
const B = "00000000002"; // no NADAC held
const nadac = new Map([[A, 50_000]]);
const fill = (i: number, over: Partial<CashFill> = {}): CashFill => ({ key: `f${i}`, ndc11: A, name: "Amlodipine 5 mg", dateFilled: "2026-08-10", quantityThousandths: 30_000, chargedCents: 0, acquisitionCents: null, ...over });

describe("cash prices against cost and the floor", () => {
  test("a cash price under the floor is listed with the floor as the target, scaled to fills a month", () => {
    // Floor for 30 tablets: $1.50 NADAC + $10.50 fee = $12.00. Charged $8, cost $1.20.
    const fills = Array.from({ length: 10 }, (_, i) => fill(i, { chargedCents: 800, acquisitionCents: 120 }));
    const r = cashPricing({ fills, nadacMicros: nadac, feeCents: 1_050, months: 2 });
    assert.equal(r.rows.length, 1);
    const row = r.rows[0];
    assert.equal(row.reason, "under_floor");
    assert.equal(row.floorCents, 1_200);
    assert.equal(row.targetCents, 1_200);
    assert.equal(row.marginCents, 680, "clears cost");
    assert.equal(row.fillsPerMonth, 5);
    assert.equal(row.gainPerMonthCents, 2_000, "$4 a fill × 5 fills a month");
    assert.deepEqual(r.underPriced.map((x) => x.ndc11), [A]);
    assert.equal(r.gainPerMonthCents, 2_000);
    assert.match(row.why, /gives away \$4\.00 a fill/);
  });

  test("a cash price under cost is a loss on every bottle and the target is cost plus the fee, or the floor if higher", () => {
    const fills = Array.from({ length: 4 }, (_, i) => fill(i, { chargedCents: 100, acquisitionCents: 120 }));
    const row = cashPricing({ fills, nadacMicros: nadac, feeCents: 1_050, months: 1 }).rows[0];
    assert.equal(row.reason, "under_cost");
    assert.equal(row.targetCents, 1_200, "the floor ($12.00) is above cost plus fee ($11.70)");
    assert.match(row.why, /\$0\.20 lost on every fill/);
    // No NADAC held: the target falls back to cost plus the fee.
    const b = Array.from({ length: 4 }, (_, i) => fill(i, { ndc11: B, chargedCents: 100, acquisitionCents: 120 }));
    const rowB = cashPricing({ fills: b, nadacMicros: nadac, feeCents: 1_050, months: 1 }).rows[0];
    assert.equal(rowB.floorCents, null);
    assert.equal(rowB.targetCents, 1_170);
  });

  test("a price above cost and the floor is a row with no reason, and does not count", () => {
    const fills = Array.from({ length: 3 }, (_, i) => fill(i, { chargedCents: 2_500, acquisitionCents: 120 }));
    const r = cashPricing({ fills, nadacMicros: nadac, feeCents: 1_050, months: 1 });
    assert.equal(r.rows[0].reason, null);
    assert.equal(r.underPriced.length, 0);
    assert.equal(r.gainPerMonthCents, 0);
  });

  test("quantities are scaled to the typical fill so a 90-day fill is not read as a dearer price", () => {
    const fills = [
      ...Array.from({ length: 3 }, (_, i) => fill(i, { chargedCents: 800, acquisitionCents: 120 })),
      fill(9, { quantityThousandths: 90_000, chargedCents: 2_400, acquisitionCents: 360 }),
    ];
    const row = cashPricing({ fills, nadacMicros: nadac, feeCents: 1_050, months: 1 }).rows[0];
    assert.equal(row.typicalThousandths, 30_000);
    assert.equal(row.chargedCents, 800);
    assert.equal(row.costCents, 120);
  });

  test("a product with neither cost nor NADAC is counted as unjudged rather than guessed; small gains are below materiality", () => {
    const fills = [fill(0, { ndc11: B, chargedCents: 500 }), fill(1, { chargedCents: 1_190, acquisitionCents: 120 })];
    const r = cashPricing({ fills, nadacMicros: nadac, feeCents: 1_050, months: 1, materialityCents: 500 });
    assert.equal(r.unjudged, 1);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].reason, "under_floor");
    assert.equal(r.rows[0].gainPerMonthCents, 10);
    assert.equal(r.underPriced.length, 0, "ten cents a month is not a row");
    assert.equal(r.withCost, 1);
  });
});
