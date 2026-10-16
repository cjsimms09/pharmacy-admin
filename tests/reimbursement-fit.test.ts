import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fitPlan, type FitClaim } from "../src/lib/reimbursement-fit";

/**
 * Back-calculating how a plan prices a claim from what it paid. Three formulas are tried and the
 * one with the least scatter is named, with the scatter; a close call is said to be one.
 */
const claim = (o: Partial<FitClaim> & { paidPerUnit: number; nadac?: number; awp?: number; product?: string; ndc?: string }): FitClaim => ({
  planKey: "P", ndc11: o.ndc ?? "N", classification: o.classification ?? "G", productKey: o.product ?? null,
  quantityThousandths: 30_000, ingredientPaidCents: Math.round(o.paidPerUnit * 30), nadacUnitMicros: o.nadac ? o.nadac * 10_000 : null, awpUnitMicros: o.awp ? o.awp * 10_000 : null,
});

describe("finding the formula", () => {
  test("NADAC + 3% on every fill reads as NADAC + 3.0%", () => {
    const claims = Array.from({ length: 15 }, (_, i) => { const n = 50 + i * 7; return claim({ paidPerUnit: n * 1.03, nadac: n, awp: n * 3 + (i % 4) * 25, ndc: `N${i}` }); });
    const [f] = fitPlan(claims);
    assert.equal(f.formula, "nadac_plus");
    assert.ok(Math.abs(f.percent! - 3) < 0.01);
    assert.match(f.says, /generic: NADAC \+ 3\.0%, ±0\.0 points, on 15 fills/);
  });

  test("AWP − 17.5% on brands reads as AWP − 17.5%, fitted apart from generics", () => {
    const brands = Array.from({ length: 15 }, (_, i) => { const a = 500 + i * 40; return claim({ classification: "B", paidPerUnit: a * 0.825, awp: a, nadac: a * 0.8 + (i % 3) * 5, ndc: `B${i}` }); });
    const generics = Array.from({ length: 15 }, (_, i) => { const n = 20 + i; return claim({ classification: "G", paidPerUnit: n * 1.0, nadac: n, awp: n * 4 + (i % 3) * 15, ndc: `G${i}` }); });
    const fits = fitPlan([...brands, ...generics]);
    const b = fits.find((f) => f.classification === "B")!;
    const g = fits.find((f) => f.classification === "G")!;
    assert.equal(b.formula, "awp_minus");
    assert.ok(Math.abs(b.percent! - 17.5) < 0.01);
    assert.equal(g.formula, "nadac_plus");
  });

  test("the same price per unit for every NDC of a product, whatever its NADAC, reads as a MAC", () => {
    const claims: FitClaim[] = [];
    for (let p = 0; p < 4; p++) for (let i = 0; i < 4; i++) claims.push(claim({ paidPerUnit: 10 + p * 5, nadac: 6 + p * 5 + i * 2, awp: 40 + p * 10 + i * 6, product: `prod${p}`, ndc: `P${p}N${i}` }));
    const [f] = fitPlan(claims);
    assert.equal(f.formula, "mac_per_product");
    assert.equal(f.spreadPoints, 0);
    assert.match(f.says, /a MAC per product/);
  });

  test("a close call is not called: two formulas within a point of each other", () => {
    // NADAC and AWP move together exactly (AWP = 3 × NADAC), so both fit equally.
    const claims = Array.from({ length: 15 }, (_, i) => { const n = 50 + i * 7; return claim({ paidPerUnit: n * 1.1, nadac: n, awp: n * 3, ndc: `N${i}` }); });
    const [f] = fitPlan(claims);
    assert.equal(f.formula, null);
    assert.match(f.says, /not settled/);
  });

  test("residuals name the fills the formula does not explain", () => {
    const claims = Array.from({ length: 15 }, (_, i) => claim({ paidPerUnit: (50 + i) * 1.0, nadac: 50 + i, ndc: `N${i}` }));
    claims.push(claim({ paidPerUnit: 20, nadac: 60, ndc: "SHORT" })); // paid a third of NADAC
    const [f] = fitPlan(claims);
    assert.equal(f.formula, "nadac_plus");
    assert.equal(f.residuals[0].ndc11, "SHORT");
    assert.ok(f.residuals[0].gapCents < 0);
  });

  test("too few fills, or none with a benchmark: no formula, and the sentence says how many are needed", () => {
    const [f] = fitPlan([claim({ paidPerUnit: 10, nadac: 9 })]);
    assert.equal(f.formula, null);
    assert.match(f.says, /12 with a benchmark are needed/);
  });
});
