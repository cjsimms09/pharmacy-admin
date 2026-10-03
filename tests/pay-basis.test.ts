import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { payBasisByPlan, type PaidClaim } from "../src/lib/pay-basis";
import type { NadacRecord } from "../src/lib/reimbursement-rules";

/**
 * Reading how a plan pays off what it paid. A NADAC-based plan pays each NDC by its own NADAC; a
 * MAC plan pays every NDC of a product the same. The direct test — two NDCs of one product,
 * different NADACs, what did the plan do — outranks the cluster, and too few claims stays unknown.
 */
const nadac = (ndc11: string, unitMicros: number): NadacRecord => ({ ndc11, unitMicros, pricingUnit: "EA", effectiveOn: "2026-08-01", fileAsOf: "2026-08-01" });
const NADAC = [nadac("A1", 100_000), nadac("A2", 200_000), nadac("B1", 500_000), nadac("B2", 800_000), nadac("C1", 50_000)];
const group = (ndc: string) => (ndc.startsWith("A") ? "product A" : ndc.startsWith("B") ? "product B" : null);

/** A paid claim for `units` of `ndc` at `perUnitCents` a unit. */
const claim = (planKey: string, ndc11: string | null, units: number, perUnitCents: number, over: Partial<PaidClaim> = {}): PaidClaim => ({
  planKey, ndc11, dateFilled: "2026-09-01", quantityThousandths: units * 1000, ingredientPaidCents: Math.round(perUnitCents * units), ...over,
});

describe("how a plan pays", () => {
  test("paid that follows each NDC's NADAC reads as NADAC-tracking, with the ratio", () => {
    // NADAC + 3% on every NDC, both NDCs of product A and both of product B.
    const claims = [
      ...Array.from({ length: 4 }, () => claim("P", "A1", 30, 10.3)),
      ...Array.from({ length: 4 }, () => claim("P", "A2", 30, 20.6)),
      ...Array.from({ length: 3 }, () => claim("P", "B1", 10, 51.5)),
      ...Array.from({ length: 3 }, () => claim("P", "B2", 10, 82.4)),
    ];
    const [p] = payBasisByPlan(claims, NADAC, group);
    assert.equal(p.basis, "nadac_tracking");
    assert.equal(p.claims, 14);
    assert.ok(Math.abs(p.medianRatio! - 1.03) < 0.001);
    assert.deepEqual(p.direct, { tracks: 2, flat: 0, mixed: 0 });
  });

  test("the same price for two NDCs whose NADACs differ reads as a per-product schedule", () => {
    const claims = [
      ...Array.from({ length: 6 }, () => claim("M", "A1", 30, 15)),
      ...Array.from({ length: 6 }, () => claim("M", "A2", 30, 15)),
    ];
    const [p] = payBasisByPlan(claims, NADAC, group);
    assert.equal(p.basis, "flat_per_product");
    assert.deepEqual(p.direct, { tracks: 0, flat: 1, mixed: 0 });
  });

  test("the direct test outranks a tight cluster", () => {
    // Everything within a few percent of NADAC by coincidence, but product A is paid flat.
    const claims = [
      ...Array.from({ length: 6 }, () => claim("M", "A1", 30, 10)),
      ...Array.from({ length: 6 }, () => claim("M", "A2", 30, 10)),
      ...Array.from({ length: 6 }, () => claim("M", "C1", 30, 5)),
    ];
    const [p] = payBasisByPlan(claims, NADAC, group);
    assert.equal(p.basis, "flat_per_product");
  });

  test("a tight cluster with nothing tested directly still reads as NADAC-tracking", () => {
    const claims = Array.from({ length: 12 }, (_, i) => claim("Q", i % 2 ? "A1" : "C1", 30, i % 2 ? 10.2 : 5.1));
    const [p] = payBasisByPlan(claims, NADAC, group);
    assert.equal(p.basis, "nadac_tracking");
    assert.equal(p.direct.tracks + p.direct.flat, 0);
  });

  test("too few claims stays unknown, whatever they show", () => {
    const claims = [...Array.from({ length: 4 }, () => claim("S", "A1", 30, 15)), ...Array.from({ length: 4 }, () => claim("S", "A2", 30, 15))];
    const [p] = payBasisByPlan(claims, NADAC, group);
    assert.equal(p.basis, "unknown");
    assert.match(p.why, /8 claims/);
  });

  test("products that disagree leave the plan unclassified rather than picking a side", () => {
    const claims = [
      ...Array.from({ length: 4 }, () => claim("X", "A1", 30, 15)),
      ...Array.from({ length: 4 }, () => claim("X", "A2", 30, 15)), // flat on A
      ...Array.from({ length: 4 }, () => claim("X", "B1", 10, 50)),
      ...Array.from({ length: 4 }, () => claim("X", "B2", 10, 80)), // tracks on B
    ];
    const [p] = payBasisByPlan(claims, NADAC, group);
    assert.equal(p.basis, "unknown");
    assert.deepEqual(p.direct, { tracks: 1, flat: 1, mixed: 0 });
  });

  test("reversed claims, zero payments, missing NDCs and NDCs with no NADAC do not count", () => {
    const claims = [
      claim("Z", "A1", 30, 10, { status: "reversed" }),
      claim("Z", "A1", 30, 0),
      claim("Z", null, 30, 10),
      claim("Z", "NOPE", 30, 10),
      claim("Z", "A1", 30, 10, { dateFilled: "2026-07-01" }), // before any NADAC is in force
    ];
    // Nothing entered the reading, so the plan is not even listed.
    assert.equal(payBasisByPlan(claims, NADAC, group).length, 0);
  });

  test("without a grouping no plan can be called flat", () => {
    const claims = [...Array.from({ length: 6 }, () => claim("M", "A1", 30, 15)), ...Array.from({ length: 6 }, () => claim("M", "A2", 30, 15))];
    const [p] = payBasisByPlan(claims, NADAC);
    assert.notEqual(p.basis, "flat_per_product");
  });
});
