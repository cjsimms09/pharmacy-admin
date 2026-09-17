import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { floorEvidence, shortlistTotals, AT_FLOOR_TOLERANCE_CENTS, type FloorPricingRow } from "../src/lib/floor-pricing";

/*
 * Reading a plan's funding off how it pays — the half of the idea that is safe.
 *
 * The owner, 17 September 2026: "can we not tell by how we are paid? if full ensured we should be
 * getting NADAC +10.50 if not that we arent."
 *
 * The first case below is the one that matters most. Taken literally the rule would mean "paid
 * under the floor, therefore the floor does not apply", which reads a violation as an exemption and
 * would erase every underpayment it was built to find. Nothing here may ever treat a short payment
 * as evidence about funding, and there is a case that proves it does not.
 */

const fill = (planId: string, against: number, cls = "commercial_unknown_funding"): FloorPricingRow => ({
  planId,
  classification: cls,
  againstBenchmarkCents: against,
  receivedCents: 5000,
});

describe("what underpayment is allowed to mean", () => {
  test("REGRESSION: a plan paid under the floor on every claim gets no funding inference at all", () => {
    const rows = [fill("p1", -400), fill("p1", -900), fill("p1", -150)];
    const [p] = floorEvidence(rows);
    assert.equal(p.below, 3);
    assert.equal(p.atFloor, 0);
    /* It must say the absence of the fingerprint proves nothing, not that the plan is self-funded. */
    assert.match(p.reads, /not evidence either way about its funding/);
    assert.doesNotMatch(p.reads, /self.funded|not fully insured|out of scope/i);
  });

  test("the money short is still counted, because that is the money", () => {
    const [p] = floorEvidence([fill("p1", -400), fill("p1", -900)]);
    assert.equal(p.shortCents, 1300);
  });
});

describe("the fingerprint: paying exactly what the statute computes", () => {
  test("a plan landing on the floor repeatedly is flagged as worth establishing", () => {
    const rows = [fill("p1", 0), fill("p1", 0), fill("p1", -1), fill("p1", -500)];
    const [p] = floorEvidence(rows);
    assert.equal(p.atFloor, 3, "within tolerance counts");
    assert.match(p.reads, /pricing this plan to a published formula/);
    assert.match(p.reads, /reaches them only once the funding is established/);
  });

  test("the tolerance is a couple of cents, not a dollar", () => {
    const [p] = floorEvidence([fill("p1", AT_FLOOR_TOLERANCE_CENTS), fill("p1", AT_FLOOR_TOLERANCE_CENTS + 1)]);
    assert.equal(p.atFloor, 1);
    assert.equal(p.above, 1);
  });

  test("REGRESSION: it never says the plan IS fully insured, only that it is worth establishing", () => {
    const [p] = floorEvidence([fill("p1", 0), fill("p1", 0), fill("p1", 0)]);
    assert.doesNotMatch(p.reads, /\bis fully insured\b/);
    assert.match(p.reads, /worth establishing rather than assuming/);
  });
});

describe("the order of the worklist", () => {
  test("plans with the fingerprint come first, then by the money short", () => {
    const rows = [
      /* No evidence, lots of money. */
      fill("nothing", -9000),
      /* Evidence, less money. */
      fill("evidence", 0),
      fill("evidence", -1000),
      /* Evidence, more money. */
      fill("evidence-rich", 0),
      fill("evidence-rich", -4000),
    ];
    assert.deepEqual(
      floorEvidence(rows).map((p) => p.planId),
      ["evidence-rich", "evidence", "nothing"],
    );
  });

  test("only the classification asked for is considered", () => {
    const rows = [fill("p1", 0), fill("p2", 0, "commercial_fully_insured"), fill("p3", 0, "medicare")];
    assert.deepEqual(floorEvidence(rows).map((p) => p.planId), ["p1"]);
    assert.deepEqual(floorEvidence(rows, { classification: "medicare" }).map((p) => p.planId), ["p3"]);
  });

  test("a fill with no plan behind it is skipped rather than grouped under nothing", () => {
    assert.deepEqual(floorEvidence([{ planId: null, classification: "commercial_unknown_funding", againstBenchmarkCents: 0, receivedCents: 1 }]), []);
  });
});

describe("the totals above the list", () => {
  test("the two populations are separated, because they are not the same question", () => {
    const rows = floorEvidence([fill("a", 0), fill("a", -1000), fill("b", -2500)]);
    const t = shortlistTotals(rows);
    assert.equal(t.plans, 2);
    assert.equal(t.withEvidence, 1, "only one shows the fingerprint");
    assert.equal(t.claimsShort, 2);
    assert.equal(t.shortCents, 3500);
    assert.equal(t.evidenceShortCents, 1000, "what is short on the plans worth asking about first");
  });
});
