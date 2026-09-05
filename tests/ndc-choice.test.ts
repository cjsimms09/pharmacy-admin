import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chooseNdc, scoreCandidate, type Candidate, type PlanShare } from "../src/lib/ndc-choice";

/**
 * Which NDC of a product pays the most. Two NDCs of one generic: the cheap one with the low NADAC
 * and the dear one with the high NADAC. Who is paying decides which is the better buy, and where
 * nothing can be priced nothing is said.
 */
const cheap: Candidate = { ndc11: "CHEAP", name: "X 10MG TAB", effectiveUnitMicros: 50_000, supplier: "IPC", nadacUnitMicros: 80_000, comparable: true };
const dear: Candidate = { ndc11: "DEAR", name: "X 10MG TAB", effectiveUnitMicros: 90_000, supplier: "McKesson", nadacUnitMicros: 200_000, comparable: true };

const floorPlan = (units: number): PlanShare => ({ planKey: "floor", units, basis: "floor", ratioToNadac: 1, paidPerUnitMicros: null });
const macPlan = (units: number, paid = 120_000): PlanShare => ({ planKey: "mac", units, basis: "flat_per_product", ratioToNadac: null, paidPerUnitMicros: paid });
const unknownPlan = (units: number): PlanShare => ({ planKey: "?", units, basis: "unknown", ratioToNadac: null, paidPerUnitMicros: null });

describe("the margin, per plan", () => {
  test("a floor plan pays each NDC its own NADAC, so the dear NDC with the high NADAC earns more", () => {
    const c = scoreCandidate(cheap, [floorPlan(100)])!;
    const d = scoreCandidate(dear, [floorPlan(100)])!;
    assert.equal(c.marginPerUnitMicros, 30_000);
    assert.equal(d.marginPerUnitMicros, 110_000);
  });

  test("a per-product plan pays both the same, so only the cost matters", () => {
    const c = scoreCandidate(cheap, [macPlan(100)])!;
    const d = scoreCandidate(dear, [macPlan(100)])!;
    assert.equal(c.marginPerUnitMicros, 70_000);
    assert.equal(d.marginPerUnitMicros, 30_000);
  });

  test("a NADAC-tracking plan applies its own ratio", () => {
    const plan: PlanShare = { planKey: "n", units: 10, basis: "nadac_tracking", ratioToNadac: 1.1, paidPerUnitMicros: null };
    assert.equal(scoreCandidate(dear, [plan])!.marginPerUnitMicros, 220_000 - 90_000);
  });

  test("units on a plan that cannot be priced are left out and the share says so", () => {
    const s = scoreCandidate(dear, [floorPlan(60), unknownPlan(40)])!;
    assert.equal(s.pricedShare, 0.6);
    assert.equal(s.marginPerUnitMicros, 110_000);
    assert.equal(s.byPlan[1].why, "how the plan pays is not known");
  });

  test("nothing is scored without a per-unit price", () => {
    assert.equal(scoreCandidate({ ...dear, comparable: false }, [floorPlan(1)]), null);
    assert.equal(scoreCandidate({ ...dear, effectiveUnitMicros: null }, [floorPlan(1)]), null);
  });
});

describe("the choice", () => {
  test("mostly floor plans: switch to the dear NDC, and the gain is the units times the margin difference", () => {
    const r = chooseNdc([cheap, dear], [floorPlan(900), macPlan(100)], "CHEAP");
    assert.equal(r.verdict, "recommend");
    assert.equal(r.best?.ndc11, "DEAR");
    // cheap: floor 30,000 × 900 + mac 70,000 × 100 = 34,000/unit; dear: 110,000 × 900 + 30,000 × 100 = 102,000/unit
    assert.equal(r.gainCents, Math.round(((102_000 - 34_000) * 1000) / 10_000));
  });

  test("mostly per-product plans: keep the cheap NDC", () => {
    const r = chooseNdc([cheap, dear], [floorPlan(100), macPlan(900)], "CHEAP");
    assert.equal(r.verdict, "keep");
    assert.equal(r.best?.ndc11, "CHEAP");
    assert.equal(r.gainCents, 0);
  });

  test("a gain under the materiality line is not a recommendation", () => {
    const r = chooseNdc([cheap, dear], [floorPlan(3)], "CHEAP", { materialityCents: 500 });
    assert.equal(r.verdict, "keep");
    assert.ok(r.reasons.some((x) => /under the \$5.00 line/.test(x)));
  });

  test("too many units on plans nobody can read: cannot say, and the reason names the share", () => {
    const r = chooseNdc([cheap, dear], [floorPlan(50), unknownPlan(50)], "CHEAP");
    assert.equal(r.verdict, "cannot_say");
    assert.ok(r.reasons.some((x) => /50% of the units could be priced/.test(x)));
  });

  test("an NDC whose pack size is unknown is named and left out; a current NDC that cannot be priced blocks the gain", () => {
    const r = chooseNdc([cheap, { ...dear, comparable: false }], [floorPlan(100)], "DEAR");
    assert.equal(r.verdict, "cannot_say");
    assert.ok(r.reasons.some((x) => /DEAR: its pack size is not known/.test(x)));
    assert.ok(r.reasons.some((x) => /bought today \(DEAR\) could not be priced/.test(x)));
  });

  test("nothing dispensed: nothing to weigh by", () => {
    const r = chooseNdc([cheap, dear], [], "CHEAP");
    assert.equal(r.verdict, "cannot_say");
    assert.ok(r.reasons.some((x) => /nothing of this product has been dispensed/.test(x)));
  });

  test("no current NDC: the best is offered without a gain figure", () => {
    const r = chooseNdc([cheap, dear], [floorPlan(100)], null);
    assert.equal(r.verdict, "recommend");
    assert.equal(r.gainCents, null);
  });
});
