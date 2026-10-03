import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { routingFromClaims, PROPOSABLE } from "../src/lib/plan-evidence";
import { confirmGroups, groupKey, type GroupableCandidate } from "../src/lib/plan-proposals";
import { CLASS_INFO, needsBasis } from "../src/lib/plans";

/**
 * Asking one question once, about every plan one document settles — and never asking the question
 * the Kansas floor turns on this way.
 *
 * The register holds 491 plans and 481 of them are unclassified: 1,751 paid claims and $226,094.82
 * of reimbursement that cannot be followed to a contract, and the whole SB 20 programme blocked
 * behind it. The owner: "Can you not do research and see if we can classify some based on
 * confidence level.. I don't think it will be that hard for most." He is right; the obstacle was
 * arithmetic. The register is keyed on BIN, PCN *and group number*, and the group number is the
 * employer — so one fact about one routing arrives as a dozen rows and a dozen buttons.
 *
 * These tests pin the two halves of the answer:
 *
 *   1. a row that predates the PCN can be read against the PCN its own claims carry — but only
 *      where they all carry the same one;
 *   2. proposals gather into one press per document, and a press can never decide scope.
 *
 * The second is the one that matters most. A previous attempt at bulk classification was caught by
 * tests and reverted because it could have settled whether the Kansas floor reaches a plan without
 * a person and without a document. What is bulk here is the asking, never the deciding.
 */

describe("the PCN a register row predates, read back off its own claims", () => {
  test("one PCN across every claim is the routing, and the sentence says how many", () => {
    /*
     * 197 of the register's 211 PCN-less unclassified rows are this case, carrying 1,237 claims and
     * $179,029.56 — and nothing could propose a class for any of them, because every source worth
     * anything (the payer sheets, PioneerRx's plan file, the PCN patterns) is looked up by BIN *and
     * PCN*. The claims were carrying the PCN the whole time.
     */
    const r = routingFromClaims(null, [{ pcn: "9999", claims: 116 }]);
    assert.ok(r);
    assert.equal(r.pcn, "9999");
    assert.match(r.from, /116 claims/);
    assert.match(r.from, /PCN 9999/);
  });

  test("THE GUARD: two PCNs under one BIN and group settle nothing", () => {
    /*
     * The PCN selects the line of business, so a BIN and group carrying a commercial PCN and a Part
     * D PCN is exactly what the register was re-keyed to stop treating as one plan. Taking the
     * bigger side would be the "silent majority" fault that once filed 151 commercial claims as
     * Part D. Nine of the 211 rows are this case; they get nothing.
     */
    assert.equal(routingFromClaims(null, [{ pcn: "BCBSKS", claims: 195 }, { pcn: "KSPDP", claims: 288 }]), null);
  });

  test("a claim with no PCN is its own routing, not a blank to be filled in from its neighbours", () => {
    // "No PCN" is a route the payer chose. Letting the PCN-bearing claims speak for it would be
    // borrowing an answer from a different network.
    assert.equal(routingFromClaims(null, [{ pcn: null, claims: 4 }, { pcn: "ADV", claims: 9 }]), null);
    assert.equal(routingFromClaims(null, [{ pcn: "", claims: 4 }]), null);
  });

  test("a row that already has a PCN borrows nothing", () => {
    assert.equal(routingFromClaims("CNRX", [{ pcn: "OTHER", claims: 40 }]), null);
  });

  test("a row with no claims borrows nothing", () => {
    assert.equal(routingFromClaims(null, []), null);
    assert.equal(routingFromClaims(null, [{ pcn: "9999", claims: 0 }]), null);
  });
});

const cand = (over: Partial<GroupableCandidate> = {}): GroupableCandidate => ({
  id: Math.random().toString(36).slice(2),
  bin: "610097",
  pcn: "9999",
  groupNumber: "G1",
  payerLabel: "610097 (9999)",
  planName: null,
  proposed: "medicare",
  proposedFrom: "CMS, Part D contract/plan BIN-PCN file (CY2026) names BIN 610097 / PCN 9999 as Medicare Advantage.",
  proposedSource: "payer_sheet",
  proposedConfidence: "stated",
  routingPcn: "9999",
  claims: 10,
  receivedCents: 1000,
  ...over,
});

describe("one document, one press", () => {
  test("plans differing only by employer group gather into one group", () => {
    // BIN 610097 / PCN 9999 is nine register rows and one fact. The group number is the employer
    // and the CMS file says nothing about employers, so nine rows is nine copies of one question.
    const gs = confirmGroups([cand({ groupNumber: "G1" }), cand({ groupNumber: "G2" }), cand({ groupNumber: "G3" })]);
    assert.equal(gs.length, 1);
    assert.equal(gs[0].plans.length, 3);
    assert.equal(gs[0].claims, 30);
    assert.equal(gs[0].receivedCents, 3000);
  });

  test("a PCN-less row joins the group of the PCN its claims carry", () => {
    // This is the point of `routingFromClaims`: the seven register rows behind BIN 019158 / PCN
    // CNRX are three PCN-less ones and four with the PCN, and they are one copay-card routing worth
    // $41,298.17. Split across two groups they would read as two decisions.
    const gs = confirmGroups([cand({ pcn: "9999" }), cand({ pcn: null, routingPcn: "9999", groupNumber: "G2" })]);
    assert.equal(gs.length, 1);
    assert.equal(gs[0].plans.length, 2);
  });

  test("two documents about one BIN stay two decisions", () => {
    // BIN 610455 carries KSPDP (Part D) and BCBSKS (commercial) side by side. A BIN is a processor's
    // front door; the PCN is what picks a network behind it.
    const gs = confirmGroups([cand({ bin: "610455", pcn: "KSPDP", routingPcn: "KSPDP" }), cand({ bin: "610455", pcn: "KSPARTD", routingPcn: "KSPARTD" })]);
    assert.equal(gs.length, 2);
  });

  test("the same class read from different sources is not one press", () => {
    /*
     * The button this replaced said "confirm all 33 Medicare". Thirty-three plans read from eleven
     * different documents is eleven decisions wearing one button, and nothing on the screen let him
     * check any of them because the sentence behind each was different.
     */
    const gs = confirmGroups([cand({ proposedSource: "payer_sheet" }), cand({ proposedSource: "pcn", proposedConfidence: "indicated" })]);
    assert.equal(gs.length, 2);
  });

  test("a group is only as good as its weakest row", () => {
    // One press over a mixture cannot advertise the confidence of its best member: a guess that
    // looks exactly like a fact is the fault this whole area is built against.
    const gs = confirmGroups([cand({ proposedConfidence: "stated" }), cand({ proposedConfidence: "indicated", groupNumber: "G2" })]);
    assert.equal(gs.length, 1);
    assert.equal(gs[0].confidence, "indicated");
  });

  test("biggest money first, because that is why any of it is being done", () => {
    const gs = confirmGroups([
      cand({ bin: "610014", pcn: "MEDDPRIME", routingPcn: "MEDDPRIME", receivedCents: 192 }),
      cand({ bin: "019158", pcn: "CNRX", routingPcn: "CNRX", proposed: "copay_card", receivedCents: 4_129_817 }),
    ]);
    assert.equal(gs[0].bin, "019158");
  });

  test("a plan with nothing on offer is in no group", () => {
    assert.equal(confirmGroups([cand({ proposed: null, proposedFrom: null, proposedSource: null, proposedConfidence: null })]).length, 0);
  });

  test("the key is stable and names the routing, so a press acts on what it said it would", () => {
    const a = cand();
    assert.equal(groupKey(a), "medicare|payer_sheet|610097|9999");
    assert.equal(groupKey(cand({ bin: "610097", routingPcn: "9999" })), groupKey(a));
  });
});

describe("THE GUARD: a press can take a plan out of the floor's reach, never put one in", () => {
  test("no class that can be group-confirmed is in scope for the Kansas floor", () => {
    /*
     * This is the architectural statement, asserted rather than described.
     *
     * SB 20 reaches commercial plans not subject to ERISA preemption — Kansas deliberately exempted
     * ERISA plans — so the three classes that put a plan in reach (fully-insured commercial,
     * governmental, church) are the three that decide money and get argued about. Every class a
     * group can carry is `inScope: false`, so the worst a wrong press can do is leave money out of a
     * filing that should have been in it, which is recoverable. Over-including a self-funded plan is
     * what gets a schedule dismissed, and no amount of pressing here can do it.
     */
    for (const cls of PROPOSABLE) {
      assert.equal(CLASS_INFO[cls].inScope, false, `${cls} is in scope for the Kansas floor and must never be confirmable in bulk`);
    }
  });

  test("nor can one need a document, which is the same guard from the other side", () => {
    for (const cls of PROPOSABLE) {
      assert.equal(needsBasis(cls), false, `${cls} needs a documented basis and must never be proposed, let alone in bulk`);
    }
  });

  test("and the grouper refuses one even if a source ever returns it", () => {
    // Belt to those braces, at the one place where a mistake would be multiplied by the size of the
    // group. If `commercial_fully_insured` ever reached here it would be a one-press scope
    // determination over a dozen employers.
    for (const cls of ["commercial_fully_insured", "commercial_self_funded", "governmental", "church_plan"] as const) {
      assert.equal(confirmGroups([cand({ proposed: cls })]).length, 0, `${cls} must never form a group`);
    }
  });
});
