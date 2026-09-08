import test from "node:test";
import assert from "node:assert/strict";
import { offersFor, planOrder, type Offer } from "../src/lib/order-plan";

/*
 * A short-dated lot is stock expiring inside the return window. order-plan.ts says it "will not
 * recommend short-dated stock as a bulk buy" and sorts it last — but it was also throwing away the
 * sound lot belonging to the same supplier, and measuring savings against a price it would never
 * pay.
 */

const offer = (supplier: string, unit: number, shortDated: string | null = null): Offer => ({
  ndc11: "N1", supplier, unitCostMicros: unit, effectiveUnitMicros: unit,
  packQty: 100, shortDated, itemNumber: null, rebated: null,
});

test("a supplier's sound lot is not thrown away because it also has a short-dated one", () => {
  // Smith: short-dated at 4c and a good lot at 10c. ANDA: one good lot at 11c.
  const ranked = offersFor(
    [offer("Smith", 40_000, "Short-dated only (exp 09/25)"), offer("Smith", 100_000), offer("ANDA", 110_000)],
    "N1",
  );
  assert.equal(ranked[0].supplier, "Smith");
  assert.equal(ranked[0].shortDated, null, "the sound lot represents Smith, not the expiring one");
  assert.equal(ranked[0].effectiveUnitMicros, 100_000, "10c — the cheapest sound price on the table");
});

test("a short-dated lot still never outranks a sound one", () => {
  const ranked = offersFor([offer("Smith", 40_000, "exp 09/25"), offer("ANDA", 110_000)], "N1");
  assert.equal(ranked[0].supplier, "ANDA", "4c expiring does not beat 11c sound");
});

test("where a supplier has only a short-dated lot, that is still what it offers", () => {
  const ranked = offersFor([offer("Smith", 40_000, "exp 09/25")], "N1");
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].shortDated, "exp 09/25");
});

test("the saving is measured against a price the planner would actually pay", () => {
  // Smith sound at 10c wins; ANDA's 4c is short-dated. Measured against it, a good buy read as a loss.
  const plan = planOrder({
    needs: [{ ndc11: "N1", name: "Amlodipine", needThousandths: 100_000 }],
    offers: [offer("Smith", 100_000), offer("ANDA", 40_000, "exp 09/25")],
    terms: [{ supplier: "Smith", minimumCents: null }, { supplier: "ANDA", minimumCents: null }],
    movement: [],
    maxDaysOfStock: 14,
    materialityCents: 500,
  });
  const line = plan.baskets.flatMap((b) => b.lines).find((l) => l.ndc11 === "N1");
  assert.ok(line);
  assert.equal(line.supplier, "Smith");
  // No sound alternative exists, so there is nothing honest to compare against.
  assert.equal(line.alternativeCostCents, null);
  assert.equal(line.savingCents, 0, "rather than a negative saving against stock nobody would buy");
});

test("a need filled from an expiring lot says so on the line", () => {
  const plan = planOrder({
    needs: [{ ndc11: "N1", name: "Amlodipine", needThousandths: 100_000 }],
    offers: [offer("Smith", 40_000, "Short-dated only (exp 09/25)")],
    terms: [{ supplier: "Smith", minimumCents: null }],
    movement: [],
    maxDaysOfStock: 14,
    materialityCents: 500,
  });
  const line = plan.baskets.flatMap((b) => b.lines).find((l) => l.ndc11 === "N1");
  assert.ok(line);
  // The drug is wanted and this may be the only lot anybody has — but it is a decision, not a surprise.
  assert.match(line.why, /expires inside the return window/);
});
