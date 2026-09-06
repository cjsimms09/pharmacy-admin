import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { usageFromFills, adviseStock, returnTiming } from "../src/lib/lean-stock";
import { buildBasket, type BasketLine } from "../src/lib/order-basket";

/**
 * One to two days of stock, as arithmetic: usage from the claims, a target from lead time and
 * review, the order that brings the shelf to it, the excess and the last day of the best credit
 * to send it back. And the secondary's minimum met by pulling forward what moves fastest.
 */
describe("usage from the claims", () => {
  test("units a day over the window, reversals and empty rows out, sparse flagged", () => {
    const fills = [
      { ndc11: "A", quantityThousandths: 30_000, dateFilled: "2026-09-01" },
      { ndc11: "A", quantityThousandths: 30_000, dateFilled: "2026-09-10" },
      { ndc11: "A", quantityThousandths: 30_000, dateFilled: "2026-09-20" },
      { ndc11: "B", quantityThousandths: 90_000, dateFilled: "2026-09-05" },
      { ndc11: null, quantityThousandths: 10_000, dateFilled: "2026-09-05" },
    ];
    const u = usageFromFills(fills, 30);
    assert.equal(u.get("A")?.unitsPerDay, 3);
    assert.equal(u.get("A")?.sparse, false);
    assert.equal(u.get("B")?.unitsPerDay, 3);
    assert.equal(u.get("B")?.sparse, true);
  });
});

describe("the target and the order", () => {
  const policy = { leadTimeDays: 1, reviewDays: 1, safetyDays: 1 };
  const usage = { ndc11: "A", unitsPerDay: 10, fills: 20, windowDays: 30, sparse: false };

  test("three days of cover at ten a day is thirty; twelve on hand and packs of 30 means order one pack", () => {
    const a = adviseStock({ ndc11: "A", name: "X", onHandUnits: 12, onOrderUnits: 0, packUnits: 30, usage }, policy);
    assert.equal(a.targetUnits, 30);
    assert.equal(a.orderPacks, 1);
    assert.equal(a.kind, "order");
    assert.match(a.says, /1\.2 days on hand at 10\.0 a day; 3 days of cover needs 30\. Order 1 pack \(30\)/);
  });

  test("what is already on order counts; a shelf at target holds; a pack over is excess", () => {
    assert.equal(adviseStock({ ndc11: "A", name: "X", onHandUnits: 12, onOrderUnits: 30, packUnits: 30, usage }, policy).kind, "hold");
    assert.equal(adviseStock({ ndc11: "A", name: "X", onHandUnits: 30, onOrderUnits: 0, packUnits: 30, usage }, policy).kind, "hold");
    const e = adviseStock({ ndc11: "A", name: "X", onHandUnits: 90, onOrderUnits: 0, packUnits: 30, usage }, policy);
    assert.equal(e.kind, "excess");
    assert.equal(e.excessUnits, 60);
  });

  test("a sparse product is ordered when prescribed, not shelved; a must-stock keeps a pack", () => {
    const sparse = { ...usage, fills: 2, sparse: true, unitsPerDay: 0.2 };
    assert.equal(adviseStock({ ndc11: "A", name: "X", onHandUnits: 0, onOrderUnits: 0, packUnits: 30, usage: sparse }, policy).kind, "order when prescribed");
    const must = adviseStock({ ndc11: "A", name: "X", onHandUnits: 0, onOrderUnits: 0, packUnits: 30, usage: sparse, mustStock: true }, policy);
    assert.equal(must.targetUnits, 30);
    assert.equal(must.orderPacks, 1);
  });

  test("no usage and stock on hand is excess", () => {
    assert.equal(adviseStock({ ndc11: "A", name: "X", onHandUnits: 30, onOrderUnits: 0, packUnits: 30, usage: null }, policy).kind, "excess");
  });
});

describe("when to send the excess back", () => {
  const steps = [{ fromDay: 0, percent: 100 }, { fromDay: 31, percent: 75 }];
  test("the last day of full credit on which the excess still exists, usage until then covered", () => {
    // Invoice 1 Sept, today 10 Sept (day 9). 200 on hand, target 30, 10 a day, packs of 30, $1 a unit.
    // Day 30: excess = 200 − 30 − 10 × 21 = −40 → nothing at 100%. Day 30 is the last day of full credit.
    // So nothing at full credit; at 75% (open-ended, last day = today): excess = 170 → 150 in packs.
    const r = returnTiming({ ndc11: "A", onHandUnits: 200, targetUnits: 30, unitsPerDay: 10, packUnits: 30, unitCostCents: 100, invoiceDate: "2026-09-01", today: "2026-09-10" }, steps, null);
    assert.ok(r);
    assert.equal(r.creditPercent, 75);
    assert.equal(r.unitsToReturn, 150);
  });

  test("slow usage: the excess survives to the last full-credit day and goes back then", () => {
    // 200 on hand, target 6, 2 a day: day 30 excess = 200 − 6 − 2 × 21 = 152 → 150 at 100% by day 30.
    const r = returnTiming({ ndc11: "A", onHandUnits: 200, targetUnits: 6, unitsPerDay: 2, packUnits: 30, unitCostCents: 100, invoiceDate: "2026-09-01", today: "2026-09-10" }, steps, null);
    assert.equal(r?.creditPercent, 100);
    assert.equal(r?.byDate, "2026-10-01");
    assert.equal(r?.unitsToReturn, 150);
    assert.equal(r?.creditCents, 15_000);
    assert.match(r!.says, /Return 150 by 2026-10-01 at 100%.*after that it is 75%/);
  });

  test("no policy on file: nothing is proposed", () => {
    assert.equal(returnTiming({ ndc11: "A", onHandUnits: 200, targetUnits: 6, unitsPerDay: 2, packUnits: 30, unitCostCents: 100, invoiceDate: "2026-09-01", today: "2026-09-10" }, [], null), null);
  });
});

describe("meeting the secondary's minimum", () => {
  const line = (o: Partial<BasketLine> & { ndc11: string }): BasketLine => ({
    name: o.ndc11, neededUnits: 0, packUnits: 30, unitsPerDay: 1, onHandUnits: 0, primaryEffectiveMicros: 1_000_000, secondaryEffectiveMicros: 800_000, returnable: true, ...o,
  });

  test("needed lines go where cheaper; fast movers are pulled forward first, within the days cap", () => {
    const lines = [
      line({ ndc11: "N", neededUnits: 30 }), // needed, $24 at secondary, saves $6
      line({ ndc11: "FAST", unitsPerDay: 20 }), // a pack is 1.5 days
      line({ ndc11: "SLOW", unitsPerDay: 1 }), // a pack is 30 days: never inside 7
      line({ ndc11: "DEAR", neededUnits: 30, secondaryEffectiveMicros: 1_100_000 }), // stays with primary
    ];
    const b = buildBasket(lines, 10_000, { maxPullForwardDays: 7 });
    assert.ok(b.met);
    assert.deepEqual(b.primary.map((p) => p.ndc11), ["DEAR"]);
    const fast = b.picks.find((p) => p.ndc11 === "FAST")!;
    assert.equal(fast.reason, "pulled forward");
    assert.equal(fast.packs, 4); // $24 needed + 4 × $24 = $120 ≥ $100
    assert.ok(fast.pullForwardDays <= 7);
    assert.ok(!b.picks.some((p) => p.ndc11 === "SLOW"));
    assert.equal(b.secondaryCents, 12_000);
    assert.equal(b.savingCents, 3_000);
  });

  test("when the minimum cannot be met inside the cap, buy from the primary and say what was short", () => {
    const b = buildBasket([line({ ndc11: "N", neededUnits: 30 }), line({ ndc11: "SLOW", unitsPerDay: 1 })], 10_000, { maxPullForwardDays: 7 });
    assert.ok(!b.met);
    assert.match(b.says, /cannot be met this order without holding more than 7 days/);
  });

  test("a non-returnable line is never pulled forward", () => {
    const b = buildBasket([line({ ndc11: "N", neededUnits: 30 }), line({ ndc11: "FAST", unitsPerDay: 20, returnable: false })], 10_000);
    assert.ok(!b.met);
  });
});
