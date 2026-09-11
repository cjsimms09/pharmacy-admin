import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CLASS_INFO, planScopeOf, planKey, planLookup } from "../src/lib/plans";
import { PLAN_CLASSES } from "../src/db/schema";

/**
 * This single determination decides whether anything is filable. The dangerous direction is
 * over-inclusion: putting an ERISA plan into a state filing gets the whole schedule dismissed
 * and damages the next one. So every default here leans toward excluding.
 */
describe("plan classes", () => {
  test("every class says whether the floor reaches it and why", () => {
    for (const c of PLAN_CLASSES) {
      assert.ok(CLASS_INFO[c], `${c} has no entry`);
      assert.ok(CLASS_INFO[c].why.length > 30, `${c} does not explain itself`);
    }
  });

  /*
   * Updated deliberately, against sources, not to make a failing test pass.
   *
   * Rutledge v. PCMA, 592 U.S. 80 (2020), was unanimous that Arkansas Act 900 — PBMs must reimburse
   * at or above acquisition cost — is not preempted by ERISA, expressly including as applied to
   * self-funded plans. A law that sets the rate a PBM pays regulates cost, not plan administration.
   * Kansas SB 20 is that kind of law: at or above NADAC plus a dispensing fee, in force 1 July 2026.
   *
   * PCMA v. Mulready, 78 F.4th 1183 (10th Cir. 2023), cert. denied 30 June 2025, binds Kansas and did
   * strike down much of Oklahoma's act — but on network design, and it distinguished Rutledge rather
   * than disturbing it.
   */
  test("every class but the federally governed ones is in scope", () => {
    const inScope = PLAN_CLASSES.filter((c) => CLASS_INFO[c].inScope);
    assert.deepEqual([...inScope].sort(), [
      "church_plan",
      "commercial_fully_insured",
      "commercial_self_funded",
      "governmental",
    ]);
  });

  test("a governmental plan stays in scope — it is not an ERISA plan even when self-funded", () => {
    assert.equal(CLASS_INFO.governmental.inScope, true);
    assert.equal(planScopeOf("governmental"), "commercial_non_erisa");
  });

  /*
   * The rate is owed; the route to enforcing it is not the same one. A self-funded plan is still not
   * an insurer the Kansas Insurance Department regulates, so the scope label stays distinct — the
   * caution at the top of this file about over-inclusion is about *filing*, and it still holds.
   */
  test("self-funded commercial is in scope for the rate, and still its own scope for procedure", () => {
    assert.equal(CLASS_INFO.commercial_self_funded.inScope, true);
    assert.equal(planScopeOf("commercial_self_funded"), "commercial_erisa");
  });

  test("and it says why, citing what it turns on", () => {
    assert.match(CLASS_INFO.commercial_self_funded.why, /Rutledge/);
  });

  test("a discount card is not a payer that can owe a floor", () => {
    assert.equal(CLASS_INFO.discount_card.inScope, false);
  });

  test("unknown is never in scope — an unexamined plan is not a filable one", () => {
    assert.equal(CLASS_INFO.unknown.inScope, false);
    assert.equal(planScopeOf("unknown"), "unknown");
  });

  test("Medicare and Medicaid map onto the gate's own scopes", () => {
    assert.equal(planScopeOf("medicare"), "part_d");
    assert.equal(planScopeOf("medicaid"), "medicaid");
    assert.equal(planScopeOf("workers_comp"), "unknown");
  });
});

describe("planKey", () => {
  test("a plan is BIN, PCN and group together, and the same BIN and group under two PCNs are two plans", () => {
    assert.equal(planKey("610455", "KSPDP", "KS2336"), "610455|KSPDP|KS2336");
    assert.notEqual(planKey("610455", "BCBSKS", "KS2336"), planKey("610455", "KSPDP", "KS2336"));
    assert.notEqual(planKey("610455", "KSPDP", "KS2336"), planKey("610014", "KSPDP", "KS2336"));
  });
  test("a missing part is its own key, not a collision with every other blank", () => {
    assert.equal(planKey("028249", null, null), "028249||");
    assert.notEqual(planKey("028249", null, null), planKey("610014", null, null));
  });
});

describe("planLookup", () => {
  const rows = [
    { bin: "610455", pcn: null, groupNumber: "KS2336", classification: "commercial_fully_insured" as const },
    { bin: "610455", pcn: "KSPDP", groupNumber: "KS2336", classification: "medicare" as const },
    { bin: "610455", pcn: "BCBSKS", groupNumber: "KS2336", classification: "unknown" as const },
  ];
  test("the decided row for the exact PCN wins; an undecided one falls back to the row kept before the PCN was known", () => {
    const look = planLookup(rows);
    assert.equal(look({ bin: "610455", pcn: "KSPDP", groupNumber: "KS2336" })?.classification, "medicare");
    assert.equal(look({ bin: "610455", pcn: "BCBSKS", groupNumber: "KS2336" })?.classification, "commercial_fully_insured");
    assert.equal(look({ bin: "610455", pcn: "OTHER", groupNumber: "KS2336" })?.classification, "commercial_fully_insured");
    assert.equal(look({ bin: "999999", pcn: "X", groupNumber: "KS2336" }), undefined);
  });
});
