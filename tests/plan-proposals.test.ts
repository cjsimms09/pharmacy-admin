import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { proposePlanClass, isProposal, PROPOSABLE } from "../src/lib/plan-proposals";
import { needsBasis } from "../src/lib/plans";

/**
 * A proposal is an offer with a source attached, and the owner confirms it in one click. That makes
 * the dangerous failure a plausible proposal rather than a missing one: a wrong class he clicks
 * through decides whether the Kansas floor reaches a plan, and every appeal built on it collapses
 * when somebody asks how it was established.
 */

const evidence = (over: Partial<Parameters<typeof proposePlanClass>[0]> = {}) => ({
  bin: "610455",
  pcn: null,
  groupNumber: "RX1234",
  payerLabel: null,
  pbmName: null,
  linesOfBusiness: null,
  ...over,
});

describe("what the BIN listing settles", () => {
  test("a Part D line of business proposes Medicare, quoting the listing", () => {
    const r = proposePlanClass(evidence({ linesOfBusiness: "Medicare Part D" }));
    assert.ok(isProposal(r));
    assert.equal(r.classification, "medicare");
    assert.match(r.from, /BIN listing/);
    assert.match(r.from, /Medicare Part D/);
  });

  test("Medicaid beats Medicare where a listing names both", () => {
    // A managed Medicaid plan's listing routinely names both, and the narrower of the two is the
    // truth about who actually pays.
    const r = proposePlanClass(evidence({ linesOfBusiness: "Medicaid MCO / Medicare dual" }));
    assert.ok(isProposal(r));
    assert.equal(r.classification, "medicaid");
  });

  test("workers' compensation and discount cards are recognised", () => {
    assert.equal((proposePlanClass(evidence({ linesOfBusiness: "Workers Compensation" })) as { classification: string }).classification, "workers_comp");
    assert.equal((proposePlanClass(evidence({ linesOfBusiness: "Discount card" })) as { classification: string }).classification, "discount_card");
  });
});

describe("THE REFUSAL THAT MATTERS: commercial is not an answer", () => {
  test("a commercial line of business proposes nothing, and says why at length", () => {
    // "Commercial" does not say whether the employer bought insurance from a state-regulated
    // carrier or funds the plan itself under ERISA. That is the entire question the register
    // exists to answer: one is in reach of the Kansas floor and the other is preempted.
    const r = proposePlanClass(evidence({ linesOfBusiness: "Commercial" }));
    assert.equal(r.classification, null);
    assert.match((r as { why: string }).why, /bought insurance or funds the plan/);
    assert.match((r as { why: string }).why, /Form 5500|plan document/);
  });

  test("nor does an employer group or group health line", () => {
    for (const lob of ["Group Health", "Employer Group"]) {
      assert.equal(proposePlanClass(evidence({ linesOfBusiness: lob })).classification, null, lob);
    }
  });

  test("no class that needs a document can ever be proposed", () => {
    // The guard, asserted against plans.ts rather than restated. If PROPOSABLE ever grows to
    // include one of the four that need a basis, this fails — which is the point, because the
    // register would silently become a list of guesses.
    for (const cls of PROPOSABLE) {
      assert.equal(needsBasis(cls), false, `${cls} needs a documented basis and must never be proposed`);
    }
  });
});

describe("what the claim says about itself", () => {
  test("a PCN naming Part D is the plan identifying itself", () => {
    const r = proposePlanClass(evidence({ pcn: "MEDDPRIME" }));
    assert.ok(isProposal(r));
    assert.equal(r.classification, "medicare");
    assert.match(r.from, /PCN "MEDDPRIME"/);
  });

  test("the payer's own name counts, and is quoted", () => {
    const r = proposePlanClass(evidence({ payerLabel: "Kansas Medicaid" }));
    assert.ok(isProposal(r));
    assert.equal(r.classification, "medicaid");
    assert.match(r.from, /Kansas Medicaid/);
  });

  test("the listing outranks the name, because it is a published document", () => {
    // The payer label is whatever the pharmacy system printed; the listing is a document.
    const r = proposePlanClass(evidence({ linesOfBusiness: "Medicaid", payerLabel: "SOMETHING PART D" }));
    assert.ok(isProposal(r));
    assert.equal(r.classification, "medicaid");
    assert.match(r.from, /BIN listing/);
  });
});

describe("when nothing is known, nothing is offered", () => {
  test("a BIN with no line of business and an unrevealing name proposes nothing", () => {
    const r = proposePlanClass(evidence({ payerLabel: "OptumRx" }));
    assert.equal(r.classification, null);
    assert.match((r as { why: string }).why, /610455/);
  });

  test("a plan with no BIN says that, rather than blaming the listing", () => {
    const r = proposePlanClass(evidence({ bin: null }));
    assert.equal(r.classification, null);
    assert.match((r as { why: string }).why, /no BIN/);
  });

  test("an insurer's name alone is never enough", () => {
    // "Blue Cross Blue Shield" is the commercial case wearing a payer name: it says nothing about
    // whether the employer behind this particular group funds its own plan.
    assert.equal(proposePlanClass(evidence({ payerLabel: "Blue Cross Blue Shield" })).classification, null);
  });
});
