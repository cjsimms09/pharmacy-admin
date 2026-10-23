import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconcile, products, summarise, type Snapshot, type Receipt, type Fill } from "../src/lib/engine/perpetual";

const A = "99990000101";
const B = "99990000202";
const days = ["2026-09-25", "2026-09-26", "2026-09-27"];
const steady = (ndc: string, units: number[]) => days.slice(0, units.length).map((day, i) => ({ day, ndc11: ndc, units: units[i] }));

describe("the perpetual Schedule II count, reconciled against PioneerRx's own records", () => {
  test("start + received − filled + returned = end, and an item that agrees has no variance", () => {
    const snaps: Snapshot[] = steady(A, [240, 220, 160]);
    const receipts: Receipt[] = [{ day: "2026-09-26", ndc11: A, units: 100 }];
    const fills: Fill[] = [
      { ndc11: A, filledOn: "2026-09-26", reversedOn: null, units: 120 },
      { ndc11: A, filledOn: "2026-09-27", reversedOn: null, units: 60 },
    ];
    const [m] = reconcile(days, snaps, receipts, fills);
    assert.deepEqual([m.open, m.received, m.filled, m.returned, m.expected, m.close, m.variance], [240, 100, 180, 0, 160, 160, 0]);
    assert.equal(m.measured, 3);
  });
  test("a reversal in the window puts the stock back; a fill before the window and a receipt on the first day do not count", () => {
    const snaps: Snapshot[] = steady(A, [100, 100, 100]);
    const receipts: Receipt[] = [{ day: "2026-09-25", ndc11: A, units: 500 }];
    const fills: Fill[] = [
      { ndc11: A, filledOn: "2026-09-20", reversedOn: "2026-09-26", units: 30 },
      { ndc11: A, filledOn: "2026-09-26", reversedOn: null, units: 30 },
    ];
    const [m] = reconcile(days, snaps, receipts, fills);
    assert.equal(m.received, 0, "the first day's receipt is already inside the first day's count");
    assert.equal(m.returned, 30);
    assert.equal(m.filled, 30);
    assert.equal(m.variance, 0);
  });
  test("a bottle that left without a fill is a variance that holds two days: off, signed the way it went, biggest first", () => {
    const snaps: Snapshot[] = [...steady(A, [100, 70, 70]), ...steady(B, [50, 52, 52])];
    const rows = reconcile(days, snaps, [], []);
    assert.equal(rows[0].ndc11, A);
    assert.equal(rows[0].variance, -30);
    assert.equal(rows[0].varianceBefore, -30);
    assert.equal(rows[1].variance, 2);
    const r = summarise(days, rows);
    assert.equal(r.products, 2);
    assert.equal(r.off.length, 2);
    assert.equal(r.off[0].stable, true);
    assert.equal(r.moving.length, 0);
    assert.equal(r.absVariance, 32);
    assert.match(r.says, /2 of 2 Schedule II products are off/);
  });
  test("two NDCs of one product that net to nothing are a substitution, not a loss", () => {
    /* The claim carried A; the bottle opened was B. A reads 30 over, B 30 short, the product agrees. */
    const snaps: Snapshot[] = [...steady(A, [100, 100, 100]), ...steady(B, [100, 70, 70])];
    const fills: Fill[] = [{ ndc11: A, filledOn: "2026-09-26", reversedOn: null, units: 30 }];
    const rows = reconcile(days, snaps, [], fills);
    assert.deepEqual(rows.map((m) => [m.ndc11, m.variance]).sort(), [
      [A, 30],
      [B, -30],
    ]);
    const grouped = products(rows, () => "amphetamine 30 mg tablet oral", () => "Amphetamine salts 30 mg");
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].variance, 0);
    assert.equal(grouped[0].name, "Amphetamine salts 30 mg", "no on-hand name on these rows, so the directory name stands");
    const r = summarise(days, rows, grouped);
    assert.equal(r.off.length, 0);
    assert.equal(r.agree, 1);
    assert.match(r.says, /Every Schedule II product .* agrees/);
    /* With no key, each NDC is its own product and both are off. */
    assert.equal(summarise(days, rows).off.length, 2);
  });
  test("a receipt booked into stock the day after its invoice is a moving figure, not a loss", () => {
    const snaps: Snapshot[] = steady(A, [100, 100, 200]);
    const receipts: Receipt[] = [{ day: "2026-09-26", ndc11: A, units: 100 }];
    const [m] = reconcile(days, snaps, receipts, []);
    assert.equal(m.variance, 0);
    const late: Snapshot[] = steady(A, [100, 100, 100]);
    const [n] = reconcile(days, late, [{ day: "2026-09-27", ndc11: A, units: 100 }], []);
    assert.equal(n.variance, -100);
    assert.equal(n.varianceBefore, 0);
    const r = summarise(days, [n]);
    assert.equal(r.off.length, 0);
    assert.equal(r.moving.length, 1);
    assert.match(r.says, /moved on the last day only/);
  });
  test("an item missing from a day's file is not measured that day, not zero", () => {
    const snaps: Snapshot[] = [
      { day: "2026-09-26", ndc11: A, units: 100 },
      { day: "2026-09-27", ndc11: A, units: 80 },
    ];
    const fills: Fill[] = [{ ndc11: A, filledOn: "2026-09-27", reversedOn: null, units: 20 }];
    const [m] = reconcile(days, snaps, [], fills);
    assert.equal(m.from, "2026-09-26", "the window starts the first day the file lists it");
    assert.equal(m.open, 100);
    assert.equal(m.variance, 0);
    assert.equal(m.varianceBefore, null, "measured on two days only: no day before to compare with");
    assert.equal(reconcile(days, [{ day: "2026-09-25", ndc11: B, units: 7 }], [], []).length, 0, "listed on one day only: not measured");
    const r = summarise(days, [m]);
    assert.ok(r.assumptions.some((a) => /not measured that day, not zero/.test(a)));
    assert.match(r.notSeen, /typed into PioneerRx by hand/);
  });
  test("fewer than two days is nothing to reconcile, said plainly", () => {
    assert.deepEqual(reconcile(["2026-09-25"], [{ day: "2026-09-25", ndc11: A, units: 1 }], [], []), []);
    assert.match(summarise(["2026-09-25"], []).says, /Fewer than two days/);
  });
  test("units are rounded to a tenth, so a liquid's thousandths do not become a false variance", () => {
    const snaps: Snapshot[] = steady(A, [473.333, 453.3, 453.3]);
    const fills: Fill[] = [{ ndc11: A, filledOn: "2026-09-26", reversedOn: null, units: 20.03 }];
    const [m] = reconcile(days, snaps, [], fills);
    assert.equal(m.variance, 0);
    assert.equal(summarise(days, [m]).agree, 1);
  });
});
