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

/*
 * ── What replaced "commercial is not an answer" ──
 *
 * That rule refused a commercial listing outright, and it was half right. It was right that such a
 * listing cannot say whether the employer bought insurance or funds its own plan under ERISA, which
 * is the question a Kansas filing turns on. It was wrong to discard the half the listing does
 * establish — that this is a commercial plan and not Part D — and the cost was 396 plans and
 * $138,178.78 of September sitting at "not yet determined", indistinguishable from plans nobody had
 * ever looked at.
 *
 * The owner, 11 September: "Only problem will be ERISA vs commercial which we should just treat all
 * as commercial until proven otherwise."
 *
 * So the refusal became a narrower finding: `commercial_unknown_funding`, which asserts the benefit
 * type and expressly not the funding. The safety property did not weaken, it moved — from "this is
 * never classified" to "this is classified, and no classification of it can reach a floor filing".
 * That is what these tests hold, and the last two are the ones that matter.
 */
describe("commercial is half an answer, and only the stated half is taken", () => {
  test("a commercial line of business is proposed as commercial, funding left open", () => {
    const r = proposePlanClass(evidence({ linesOfBusiness: "Commercial" }));
    assert.ok(isProposal(r));
    assert.equal(r.classification, "commercial_unknown_funding");
    // The sentence still has to name the unanswered question and what would settle it: the owner
    // reads it to decide whether chasing a Form 5500 for this plan is worth an afternoon.
    assert.match(r.from, /bought insurance or funds its own plan/);
    assert.match(r.from, /Form 5500|plan document/);
  });

  test("it is offered as indicated, never as stated", async () => {
    // A listing names the lines of business a BIN carries; the PCN selects one out of them. That is
    // enough to rule out Part D and not enough to be called a document about this employer.
    //
    // Asserted against `findPlanClass`, because `proposePlanClass` returns only the class and the
    // sentence — the confidence is what the register stores beside them, and it is the field that
    // stops a listing being recorded as though a payer had stated it.
    const { findPlanClass: find } = await import("../src/lib/plan-evidence");
    const r = find(evidence({ linesOfBusiness: "Commercial" }));
    assert.ok(r.classification === "commercial_unknown_funding");
    assert.equal((r as { confidence: string }).confidence, "indicated");
  });

  test("an employer group or group health line reads the same way", () => {
    for (const lob of ["Group Health", "Employer Group"]) {
      assert.equal(proposePlanClass(evidence({ linesOfBusiness: lob })).classification, "commercial_unknown_funding", lob);
    }
  });

  /*
   * The property that actually protects a filing, asserted against the whitelist rather than
   * restated here.
   *
   * `planScopeOf` is a switch with a default, so a class absent from it yields "unknown" — but
   * "absent by accident" and "absent on purpose" look identical until something asserts it. If
   * somebody later adds this class to it, reasoning that the register is full of them and they
   * ought to count, this fails and says why.
   */
  test("a commercial finding can never carry a claim into a Kansas floor filing", async () => {
    const { planScopeOf, CLASS_INFO, needsBasis: nb } = await import("../src/lib/plans");
    assert.equal(planScopeOf("commercial_unknown_funding"), "unknown");
    assert.equal(CLASS_INFO.commercial_unknown_funding.inScope, false);
    // And it needs no basis, for the same reason a card needs none: the finding claims no more
    // than the listing says. If it ever starts needing one, it has stopped being a default.
    assert.equal(nb("commercial_unknown_funding"), false);
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
