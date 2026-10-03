import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { recommendations, perMonthCents, spanDays } from "../src/lib/recommendations";
import { underNadac } from "../src/lib/under-nadac";
import { tierEffect, type Band, type Position } from "../src/lib/ratio-effect";
import type { Buy, LedgerRow } from "../src/lib/product-ledger";
import type { PlanBasis } from "../src/lib/pay-basis";

/**
 * The buying logic's findings as rows of the one money list. A saving measured over the claims
 * held is scaled to a month by the days it was measured on, and never offered as recurring on
 * less than a week; a band about to be lost is a one-off at risk, marked by what scrub it rests on.
 */
const buy = (o: Partial<Buy> = {}): Buy => ({ supplier: "McKesson", unitCostMicros: 100_000, effectiveUnitMicros: 70_000, rebated: true, source: "invoice", on: "2026-09-01", shortDated: null, ...o });
const row = (o: Partial<LedgerRow> = {}): LedgerRow => ({
  ndc11: "A", name: "X 10MG TAB", buys: [], paid: null, best: null, nadacMicros: 120_000, nadacOn: "2026-08-26",
  unitsDispensed: 0, receivedCents: 0, claims: 0, vsNadacMicros: null, switchSavingCents: null, flags: [], ...o,
});
const groupOf = (n: string) => (n === "A" || n === "B" ? "X 10MG" : null);
// A: cheap, low NADAC, dispensed; B: dear, high NADAC. Gain from B over A: (110,000 − 30,000) micros × 1,000 units = $80.
const under = underNadac(
  [
    row({ ndc11: "A", nadacMicros: 80_000, buys: [buy({ supplier: "IPC", unitCostMicros: 50_000, effectiveUnitMicros: 50_000, rebated: false })], paid: buy({ supplier: "IPC", unitCostMicros: 50_000, effectiveUnitMicros: 50_000, rebated: false }), unitsDispensed: 1000, claims: 30 }),
    row({ ndc11: "B", nadacMicros: 200_000, buys: [buy({ effectiveUnitMicros: 90_000 })] }),
  ],
  groupOf,
);

describe("scaling to a month", () => {
  test("thirty days over the span measured, and nothing under a week", () => {
    assert.equal(perMonthCents(9000, 90), 3000);
    assert.equal(perMonthCents(9000, 30), 9000);
    assert.equal(perMonthCents(9000, 6), null);
    assert.equal(perMonthCents(9000, null), null);
  });

  test("the span counts both ends", () => {
    assert.equal(spanDays("2026-09-01", "2026-09-30"), 30);
    assert.equal(spanDays("2026-09-05", "2026-09-05"), 1);
    assert.equal(spanDays("2026-09-05", "2026-09-01"), null);
    assert.equal(spanDays(null, "2026-09-01"), null);
  });
});

describe("the rows", () => {
  test("a better NDC becomes one recurring row, scaled to the month, overlapping the supplier switch", () => {
    const r = recommendations({ under, periodDays: 60 });
    const s = r.rows.find((x) => x.key === "switch-ndc")!;
    assert.ok(s);
    assert.equal(s.amountCents, 4000); // $80 over 60 days → $40 a month
    assert.equal(s.cadence, "recurring_monthly");
    assert.equal(s.confidence, "likely");
    assert.match(s.says, /\$40\.00 a month more on 1 product/);
    assert.match(s.todo, /buy B from McKesson/);
    assert.deepEqual(s.overlapsWith, ["switch-supplier"]);
    assert.match(s.basis, /over 60 days, scaled to thirty/);
  });

  test("measured on too few days it is a watch item, not a recurring amount", () => {
    const r = recommendations({ under, periodDays: 3 });
    assert.ok(!r.rows.some((x) => x.key === "switch-ndc"));
    assert.ok(r.watch.some((w) => /too few days/.test(w.says)));
  });

  test("what is not stocked is a watch item with the percentage under NADAC, never a money row", () => {
    const shelf = underNadac([row({ ndc11: "D", name: "Z 1MG TAB", nadacMicros: 100_000, buys: [buy({ supplier: "IPD", unitCostMicros: 40_000, effectiveUnitMicros: 40_000, rebated: false, source: "catalogue" })] })], () => null);
    const r = recommendations({ under: shelf, periodDays: 30 });
    assert.equal(r.rows.length, 0);
    assert.match(r.watch[0].todo, /Z 1MG TAB: 60% under NADAC at IPD/);
  });

  test("NDCs refused for a missing pack size are a blocked line", () => {
    const u = underNadac([row({ ndc11: "E", buys: [buy()], flags: ["pack_size_unknown"] })], () => null);
    const r = recommendations({ under: u, periodDays: 30 });
    assert.match(r.blocked[0].says, /1 NDC bought on invoice cannot be compared/);
  });
});

describe("a band about to be lost", () => {
  const LADDER: Band[] = [{ thresholdPercent: 0, rebatePercent: 15 }, { thresholdPercent: 20, rebatePercent: 25 }, { thresholdPercent: 24, rebatePercent: 29 }];
  const pos = (ratioPercent: number, scrub: Position["scrub"] = "statement"): Position => ({ ratioPercent, denominatorCents: 4_000_000, definition: "generics_over_rx", scrub });

  test("within a point of the floor: a one-off row for what the band is worth over the one below", () => {
    const effect = tierEffect(pos(20.4), LADDER, [], 600_000);
    const r = recommendations({ tier: { supplierName: "McKesson", effect, baseCents: 600_000, bands: LADDER } });
    const b = r.rows.find((x) => /rebate-band-risk/.test(x.key))!;
    assert.ok(b);
    assert.equal(b.amountCents, Math.round(600_000 * 0.1)); // 25% against 15% on $6,000
    assert.equal(b.cadence, "one_off");
    assert.equal(b.confidence, "certain");
    assert.match(b.todo, /0\.40 points above the 20% band/);
  });

  test("comfortably inside the band: no row", () => {
    const effect = tierEffect(pos(23), LADDER, [], 600_000);
    assert.equal(recommendations({ tier: { supplierName: "McKesson", effect, baseCents: 600_000, bands: LADDER } }).rows.length, 0);
  });

  test("on the drill-down's own exclusions the figure is worth checking, and the basis says why", () => {
    const effect = tierEffect(pos(20.4, "drill-down"), LADDER, [], 600_000);
    const b = recommendations({ tier: { supplierName: "McKesson", effect, baseCents: 600_000, bands: LADDER } }).rows[0];
    assert.equal(b.confidence, "worth checking");
    assert.match(b.basis, /not the figure that selects the band/);
  });
});

describe("plans that cannot be priced", () => {
  const basis = (planKey: string, b: PlanBasis["basis"]): PlanBasis => ({ planKey, basis: b, claims: 5, medianRatio: null, spread: null, direct: { tracks: 0, flat: 0, mixed: 0 }, why: "" });
  test("a fifth or more of units on unknown plans is a blocked line naming the fix", () => {
    const r = recommendations({ plans: [{ basis: basis("a", "unknown"), units: 300 }, { basis: basis("b", "nadac_tracking"), units: 700 }] });
    assert.match(r.blocked[0].says, /30% of units dispensed are on 1 plan/);
    assert.match(r.blocked[0].todo, /522-FM/);
  });
  test("under a fifth is not worth a line", () => {
    const r = recommendations({ plans: [{ basis: basis("a", "unknown"), units: 100 }, { basis: basis("b", "nadac_tracking"), units: 900 }] });
    assert.equal(r.blocked.length, 0);
  });
});
