import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkMonth, positionFrom, type DrillDownMonth } from "../src/lib/drill-down";
import { projectRatio, withScrub } from "../src/lib/ratio-effect";

/**
 * The daily Purchase Drill Down checked against itself. The money under each ratio must reproduce
 * the ratio, which is how a figure read into the wrong column is caught before it selects a band.
 * The rows are the shape of the pharmacy's own report with the figures altered, except that the
 * arithmetic between them is preserved exactly, because that is what is being tested.
 */
const month = (over: Partial<DrillDownMonth> = {}): DrillDownMonth => ({
  month: "2026-09",
  netPurchasesCents: 10_632_262,
  totalRxCents: 10_596_691,
  totalBrandCents: 9_670_076,
  totalGenericCents: 962_186,
  genericRxExMpbCents: 942_958,
  oneStopCents: 767_864,
  multiSourceCents: 10_191,
  gcrPercent: 8.9,
  osRxPercent: 7.25,
  osGxPercent: 79.8,
  ...over,
});

describe("a month row that reproduces itself", () => {
  test("every ratio comes out of the money under it", () => {
    const r = checkMonth(month());
    assert.ok(r.ok, r.checks.map((c) => `${c.what}: ${c.detail}`).join("\n"));
    assert.equal(r.checks.length, 4);
  });

  test("a month with the flu pre-book drop-shipped: the implied denominator sits under total Rx by the exclusion", () => {
    // Generic 53,393.28 over total Rx 561,554.90 is 9.51%, printed 9.55%: about $2,300 excluded.
    const r = checkMonth(month({ month: "2026-06", netPurchasesCents: 56_404_380, totalRxCents: 56_155_490, totalBrandCents: 50_997_373, totalGenericCents: 5_407_007, genericRxExMpbCents: 5_339_328, oneStopCents: 3_644_424, gcrPercent: 9.55, osRxPercent: 6.49, osGxPercent: 67.4 }));
    const gcr = r.checks.find((c) => /GCR/.test(c.what))!;
    assert.ok(gcr.ok, gcr.detail);
    assert.ok(r.impliedExclusionsCents! > 200_000 && r.impliedExclusionsCents! < 260_000, String(r.impliedExclusionsCents));
    assert.match(gcr.detail, /flu or drop-ship/);
  });

  test("a percentage read into the wrong column is refused with the arithmetic shown", () => {
    const r = checkMonth(month({ gcrPercent: 79.8, osGxPercent: 8.9 })); // GCR and OS/Gx swapped
    assert.ok(!r.ok);
    const gcr = r.checks.find((c) => /GCR/.test(c.what))!;
    assert.ok(!gcr.ok);
    assert.match(gcr.detail, /more than exclusions explain/);
  });

  test("a money figure off by a factor is refused", () => {
    const r = checkMonth(month({ oneStopCents: 76_786 })); // $767.86 instead of $7,678.64
    assert.ok(!r.ok);
    assert.ok(!r.checks.find((c) => /OS\/Rx/.test(c.what))!.ok);
  });

  test("missing figures are 'not checked', never passed", () => {
    const r = checkMonth(month({ oneStopCents: null }));
    assert.ok(!r.ok);
    assert.match(r.checks.find((c) => /OS\/Rx/.test(c.what))!.detail, /not checked/);
  });
});

describe("the position the row gives", () => {
  test("its denominator is the one the printed ratio implies, so projecting reproduces the report's own arithmetic", () => {
    const p = positionFrom(month())!;
    assert.equal(p.definition, "generics_over_rx");
    assert.equal(p.scrub, "drill-down");
    assert.ok(Math.abs(p.denominatorCents - 10_595_034) < 2);
    // A $1,000 generic at McKesson: (9,429.58 + 1,000) / (105,950.34 + 1,000)
    const after = projectRatio(p, [{ cents: 100_000, atPrimary: true, kind: "other_generic" }]).afterPercent;
    assert.ok(Math.abs(after - (1_042_958 / 10_695_034) * 100) < 1e-6);
  });

  test("a row that does not check gives no position", () => {
    assert.equal(positionFrom(month({ gcrPercent: 79.8, osGxPercent: 8.9 })), null);
  });

  test("restated to the statement's scrub, the ratio roughly doubles and is labelled an estimate", () => {
    const p = positionFrom(month())!;
    const s = withScrub(p, { drillDownPercent: 10.13, statementPercent: 20.64 });
    assert.equal(s.scrub, "estimated");
    assert.ok(Math.abs(s.ratioPercent - 8.9 * (20.64 / 10.13)) < 0.05);
    // The numerator is unchanged: the same generics, a smaller denominator.
    assert.ok(Math.abs(s.ratioPercent * s.denominatorCents - p.ratioPercent * p.denominatorCents) < s.denominatorCents * 0.01);
  });
});
