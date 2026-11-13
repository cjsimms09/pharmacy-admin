import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Cycles, cycleDays, typicalDays, percentile, groupKey } from "../src/lib/engine/cycles";

const PAYER = "OptumRx";
const build = (payer: { p50: number; p90: number; n: number } | null, group: { p50: number; p90: number; n: number } | null) => {
  const c = new Cycles();
  if (payer) c.set(PAYER, payer);
  if (group) c.groups.set(groupKey(PAYER, "IRX", "610011"), group);
  return c;
};
const pooled = { p50: 13, p90: 17, n: 556 };

describe("the cycle a claim is judged by", () => {
  test("a plan group with twenty-five tied payments is judged by its own slowest-in-ten, not the payer's pool", () => {
    assert.equal(cycleDays(build(pooled, { p50: 28, p90: 29, n: 25 }), PAYER, "IRX", "610011"), 29);
  });
  test("a smaller group stretches the payer's cycle to its own, and never shortens it", () => {
    assert.equal(cycleDays(build(pooled, { p50: 28, p90: 29, n: 5 }), PAYER, "IRX", "610011"), 29);
    assert.equal(cycleDays(build(pooled, { p50: 5, p90: 6, n: 5 }), PAYER, "IRX", "610011"), 17);
  });
  test("under five payments the group says nothing and the payer's cycle stands", () => {
    assert.equal(cycleDays(build(pooled, { p50: 28, p90: 29, n: 4 }), PAYER, "IRX", "610011"), 17);
  });
  test("a claim whose group was never seen is judged by the payer", () => {
    assert.equal(cycleDays(build(pooled, null), PAYER, "9999", "610279"), 17);
  });
  test("an unmeasured payer has no cycle, whatever its group hints", () => {
    assert.equal(cycleDays(build({ p50: 13, p90: 17, n: 20 }, { p50: 28, p90: 29, n: 5 }), PAYER, "IRX", "610011"), null);
    assert.equal(cycleDays(build(null, null), PAYER, "IRX", "610011"), null);
  });
  test("without a group named, the payer's cycle is the answer, as before", () => {
    assert.equal(cycleDays(build(pooled, { p50: 28, p90: 29, n: 25 }), PAYER), 17);
  });
  test("the typical wait follows the same precedence at the median, and needs only five of the payer", () => {
    assert.equal(typicalDays(build(pooled, { p50: 28, p90: 29, n: 25 }), PAYER, "IRX", "610011"), 28);
    assert.equal(typicalDays(build(pooled, { p50: 28, p90: 29, n: 24 }), PAYER, "IRX", "610011"), 13);
    assert.equal(typicalDays(build({ p50: 13, p90: 17, n: 5 }, null), PAYER), 13);
    assert.equal(typicalDays(build({ p50: 13, p90: 17, n: 4 }, null), PAYER), null);
  });
  test("percentile: the slowest one in ten of twenty payments is the nineteenth", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(xs, 0.9), 19);
    assert.equal(percentile(xs, 0.5), 11);
    assert.equal(percentile([7], 0.9), 7);
  });
});
