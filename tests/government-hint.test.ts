import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { governmentHint, namesAGovernmentEmployer, PROPOSABLE } from "../src/lib/plan-evidence";
import { needsBasis } from "../src/lib/plans";

/**
 * The most valuable unanswered question on the register, which had never once been asked.
 *
 * The owner: "Can you not do research and see if we can classify some based on confidence level.. I
 * don't think it will be that hard for most."
 *
 * Most of them are hard, and for a reason he supplied himself: Kansas SB 20 sets its floor for plans
 * *not subject to ERISA preemption*, so whether a commercial plan is fully insured or self-funded
 * decides whether the floor reaches it at all — and that cannot be read off a claim.
 *
 * A governmental plan is the exception. ERISA section 4(b)(1) excludes it from the Act, so preemption
 * never arises and the funding question never has to be answered. `governmentHint` exists for exactly
 * that and is deliberately a lead rather than a classification, because `governmental` decides scope
 * and scope determinations are never one press.
 *
 * It read `planType === "Government"` alone. Not one of the 2,136 rows in PioneerRx's plan file
 * carries that type — every one is "Standard" — so on this pharmacy's data the hint had never fired.
 */
const row = (o: Partial<{ bin: string; pcn: string | null; planName: string | null; planType: string | null; isActive: boolean }> = {}) => ({
  bin: o.bin ?? "005377",
  pcn: o.pcn ?? "10000019",
  planName: o.planName ?? null,
  planType: o.planType ?? "Standard",
  processor: null,
  carrierCode: null,
  isActive: o.isActive ?? true,
  source: "plan_file" as const,
});

describe("a name that says the employer is a government", () => {
  test("a city, a county, a state, a school district", () => {
    for (const n of ["City of Wichita", "County Of El Paso", "State of Kansas Employee Health", "Wichita Unified School District", "Board of Education Plan"]) {
      assert.equal(namesAGovernmentEmployer(n), true, n);
    }
  });

  test("an ordinary employer or PBM is not", () => {
    for (const n of ["Cargill Incorporated", "Bc/bs Kansas", "Express Scripts", "Maxor Plus", null]) {
      assert.equal(namesAGovernmentEmployer(n), false, String(n));
    }
  });

  /* A private university is an ordinary ERISA employer; only a state one is governmental. */
  test("a university is left alone, because the name does not say which kind", () => {
    assert.equal(namesAGovernmentEmployer("University of Phoenix Employee Plan"), false);
  });
});

describe("the government hint", () => {
  test("fires on the claim's own payer label, which is how this pharmacy's data reads", () => {
    const h = governmentHint([], "005377 (10000019)- City of Wichita");
    assert.ok(h);
    assert.match(h, /City of Wichita/);
    assert.match(h, /excluded from ERISA/);
  });

  test("still fires on a PioneerRx Government filing, as it always did", () => {
    const h = governmentHint([row({ planName: "City of Wichita", planType: "Government" })]);
    assert.ok(h);
    assert.match(h, /filed as a Government plan/);
  });

  test("and now on a plan-file name, where the file names one plan for the routing", () => {
    const h = governmentHint([row({ planName: "City Of Amarillo" })]);
    assert.ok(h);
    assert.match(h, /named for a government employer/);
  });

  /*
   * The trap this file already documents: joining thirteen plan names under 004336/ADV once
   * classified 151 commercial claims as Part D. A routing that names many plans names none of them.
   */
  test("but not where the routing carries several plans and only one reads that way", () => {
    const many = [row({ bin: "610014", planName: "Oklahoma State Employees" }), row({ bin: "610014", planName: "Aetna Commercial" })];
    assert.equal(governmentHint(many), null, "one of many names is a lead about none of them");
  });

  test("nothing to say when nothing names a government", () => {
    assert.equal(governmentHint([row({ planName: "Bc/bs Kansas" })], "004336 (ADV)"), null);
  });
});

describe("it stays a lead, never a classification", () => {
  /*
   * `governmental` puts a plan *in* reach of the floor, which makes it one of the four that decide
   * scope. Those need a documented basis and must never be one press — a self-funded plan wrongly
   * filed as governmental is the mistake that gets a schedule dismissed.
   */
  test("governmental still needs a basis and still cannot be proposed", () => {
    assert.equal(needsBasis("governmental"), true);
    assert.equal(PROPOSABLE.includes("governmental"), false);
  });

  test("and neither commercial class may be proposed either", () => {
    assert.equal(PROPOSABLE.includes("commercial_fully_insured"), false);
    assert.equal(PROPOSABLE.includes("commercial_self_funded"), false);
  });
});
