import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { leanShelf, stateOf, urgencyOf, shelfTotals, type ShelfInput } from "../src/lib/lean-shelf";

const shelf = (o: Partial<ShelfInput> = {}): ShelfInput => ({
  onHand: [], movement: [], targetDays: 2, materialityCents: 500, ...o,
});

describe("what state a line is in", () => {
  test("the boundaries of the two-day target", () => {
    // Ten units a day. Under twenty is short, twenty to forty is lean, over forty is overstocked.
    assert.equal(stateOf(19_000, 10_000, 2), "short");
    assert.equal(stateOf(20_000, 10_000, 2), "lean");
    assert.equal(stateOf(40_000, 10_000, 2), "lean");
    assert.equal(stateOf(41_000, 10_000, 2), "overstocked");
  });

  test("nothing on the shelf for something that moves is out, never lean", () => {
    assert.equal(stateOf(0, 10_000, 2), "out");
  });

  test("stock with no movement is dead, and no stock with no movement is simply out", () => {
    assert.equal(stateOf(100_000, 0, 2), "dead");
    assert.equal(stateOf(0, 0, 2), "out");
  });
});

describe("sizing the surplus", () => {
  test("keeps the target and calls the rest surplus", () => {
    const rows = leanShelf(shelf({
      onHand: [{ ndc11: "A", description: "Drug A", quantityThousandths: 100_000, valueCents: 10_000 }],
      movement: [{ ndc11: "A", name: "Drug A", perDayThousandths: 10_000, steady: true, lastOn: "2026-09-05" }],
    }));
    assert.equal(rows.length, 1);
    // 100 units held, 10 a day, keep two days = 20, surplus 80.
    assert.equal(rows[0].surplusThousandths, 80_000);
    assert.equal(rows[0].daysOfStock, 10);
    // The surplus's share of the value: 80% of $100.
    assert.equal(rows[0].surplusValueCents, 8_000);
  });

  test("dead stock keeps nothing, because the target is a target for something that moves", () => {
    const rows = leanShelf(shelf({
      onHand: [{ ndc11: "A", description: "Drug A", quantityThousandths: 100_000, valueCents: 10_000 }],
      movement: [{ ndc11: "A", name: "Drug A", perDayThousandths: 0, steady: false, lastOn: null }],
    }));
    assert.equal(rows[0].state, "dead");
    assert.equal(rows[0].surplusThousandths, 100_000);
    assert.equal(rows[0].daysOfStock, Infinity);
  });

  test("a lean or short line is not a return and does not appear", () => {
    const rows = leanShelf(shelf({
      onHand: [
        { ndc11: "LEAN", description: null, quantityThousandths: 30_000, valueCents: 100 },
        { ndc11: "SHORT", description: null, quantityThousandths: 5_000, valueCents: 100 },
      ],
      movement: [
        { ndc11: "LEAN", name: null, perDayThousandths: 10_000, steady: true, lastOn: null },
        { ndc11: "SHORT", name: null, perDayThousandths: 10_000, steady: true, lastOn: null },
      ],
    }));
    assert.deepEqual(rows, []);
  });

  test("no value on the file leaves the surplus value unknown rather than zero", () => {
    const rows = leanShelf(shelf({
      onHand: [{ ndc11: "A", description: "A", quantityThousandths: 100_000, valueCents: null }],
      movement: [{ ndc11: "A", name: "A", perDayThousandths: 10_000, steady: true, lastOn: null }],
    }));
    assert.equal(rows[0].surplusValueCents, null);
  });
});

describe("what the supplier will credit", () => {
  const withTerms = (o: { creditPercentNow: number; dropsInDays: number | null; dropsToPercent: number | null; closesInDays?: number | null }) =>
    leanShelf(shelf({
      onHand: [{ ndc11: "A", description: "Drug A", quantityThousandths: 100_000, valueCents: 10_000 }],
      movement: [{ ndc11: "A", name: "Drug A", perDayThousandths: 10_000, steady: true, lastOn: "2026-09-05" }],
      returns: new Map([["A", { supplier: "McKesson", closesInDays: null, ...o }]]),
    }))[0];

  test("credit is a percentage of the surplus, not of the whole holding", () => {
    const r = withTerms({ creditPercentNow: 100, dropsInDays: 3, dropsToPercent: 75 });
    // Surplus is $80 of the $100 held; full credit today is $80.
    assert.equal(r.ret?.creditNowCents, 8_000);
    // Falling to 75% costs a quarter of it.
    assert.equal(r.ret?.atRiskCents, 2_000);
  });

  test("the sentence names the money, the step and the days", () => {
    const r = withTerms({ creditPercentNow: 100, dropsInDays: 3, dropsToPercent: 75 });
    assert.match(r.says, /10 days of stock against a 2-day target/);
    assert.match(r.says, /80 units surplus/);
    assert.match(r.says, /McKesson credits \$80\.00 \(100%\) today, falling to 75% in 3 days/);
  });

  test("no policy on file states the surplus and refuses to invent a window", () => {
    const r = leanShelf(shelf({
      onHand: [{ ndc11: "A", description: "Drug A", quantityThousandths: 100_000, valueCents: 10_000 }],
      movement: [{ ndc11: "A", name: "Drug A", perDayThousandths: 10_000, steady: true, lastOn: null }],
    }))[0];
    assert.equal(r.ret, null);
    assert.match(r.says, /No return window on file/);
  });

  test("a final deadline with no step reads as the window shutting", () => {
    const r = withTerms({ creditPercentNow: 75, dropsInDays: null, dropsToPercent: null, closesInDays: 9 });
    assert.match(r.says, /the window shuts in 9 days/);
    assert.equal(r.ret?.atRiskCents, null);
  });
});

describe("ordering and urgency", () => {
  test("money at risk comes first, not days of stock", () => {
    const rows = leanShelf(shelf({
      onHand: [
        { ndc11: "CHEAP", description: "Cheap", quantityThousandths: 1_000_000, valueCents: 400 },
        { ndc11: "DEAR", description: "Dear", quantityThousandths: 5_000, valueCents: 400_000 },
      ],
      movement: [
        { ndc11: "CHEAP", name: "Cheap", perDayThousandths: 1_000, steady: true, lastOn: null },
        { ndc11: "DEAR", name: "Dear", perDayThousandths: 1_000, steady: true, lastOn: null },
      ],
      returns: new Map([
        ["CHEAP", { supplier: "IPC", creditPercentNow: 100, dropsInDays: 2, dropsToPercent: 0, closesInDays: null }],
        ["DEAR", { supplier: "McKesson", creditPercentNow: 100, dropsInDays: 2, dropsToPercent: 75, closesInDays: null }],
      ]),
    }));
    // A thousand days of a $4 line is a rounding error; three units of a $400,000 line is not.
    assert.equal(rows[0].ndc11, "DEAR");
    assert.equal(rows[0].ret?.atRiskCents, 60_000);
    assert.equal(rows[1].ret?.atRiskCents, 399);
  });

  test("a credit step tomorrow is today's work", () => {
    assert.equal(urgencyOf({ state: "overstocked", dropsInDays: 1, closesInDays: null, atRiskCents: 5_000, surplusValueCents: 10_000, materialityCents: 500 }), "today");
    assert.equal(urgencyOf({ state: "overstocked", dropsInDays: 6, closesInDays: null, atRiskCents: 5_000, surplusValueCents: 10_000, materialityCents: 500 }), "this week");
    assert.equal(urgencyOf({ state: "overstocked", dropsInDays: 60, closesInDays: 3, atRiskCents: 5_000, surplusValueCents: 10_000, materialityCents: 500 }), "this week", "the soonest of the two decides it");
  });

  test("a surplus worth less than an authorisation is worth is not urgent at all", () => {
    assert.equal(urgencyOf({ state: "overstocked", dropsInDays: 1, closesInDays: null, atRiskCents: 100, surplusValueCents: 100, materialityCents: 500 }), "none");
  });

  test("dead stock with no window still gets chased this month", () => {
    assert.equal(urgencyOf({ state: "dead", dropsInDays: null, closesInDays: null, atRiskCents: null, surplusValueCents: 50_000, materialityCents: 500 }), "this month");
    assert.equal(urgencyOf({ state: "overstocked", dropsInDays: null, closesInDays: null, atRiskCents: null, surplusValueCents: 50_000, materialityCents: 500 }), "later");
  });
});

describe("the totals at the top of the page", () => {
  test("surplus, risk, dead lines and the share of the shelf", () => {
    const rows = leanShelf(shelf({
      onHand: [
        { ndc11: "A", description: "A", quantityThousandths: 100_000, valueCents: 10_000 },
        { ndc11: "DEAD", description: "Dead", quantityThousandths: 50_000, valueCents: 20_000 },
      ],
      movement: [
        { ndc11: "A", name: "A", perDayThousandths: 10_000, steady: true, lastOn: null },
        { ndc11: "DEAD", name: "Dead", perDayThousandths: 0, steady: false, lastOn: "2026-06-01" },
      ],
      returns: new Map([["A", { supplier: "McKesson", creditPercentNow: 100, dropsInDays: 3, dropsToPercent: 75, closesInDays: null }]]),
    }));
    const t = shelfTotals(rows, 100_000);
    assert.equal(t.lines, 2);
    assert.equal(t.surplusValueCents, 8_000 + 20_000);
    assert.equal(t.atRiskCents, 2_000);
    assert.equal(t.deadLines, 1);
    assert.equal(t.deadValueCents, 20_000);
    assert.equal(t.surplusShare, 0.28);
  });

  test("an unknown shelf value gives no share rather than a wrong one", () => {
    assert.equal(shelfTotals([], null).surplusShare, null);
  });
});
