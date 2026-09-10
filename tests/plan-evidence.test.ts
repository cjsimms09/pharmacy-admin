import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findPlanClass, isFinding, governmentHint, namedKinds, PROPOSABLE, type PioneerPlanRow } from "../src/lib/plan-evidence";
import { proposePlanClass, isProposal } from "../src/lib/plan-proposals";
import { needsBasis } from "../src/lib/plans";

/**
 * Classifying a plan is the one determination the Kansas floor turns on, and every one of these
 * tests exists because a wrong answer here is invisible: it arrives with a published document
 * quoted next to it, the owner clicks Confirm, and an appeal built on it collapses a year later
 * when somebody asks how it was established.
 *
 * Two of the cases below are regressions against faults that were live in this codebase and were
 * each classifying hundreds of real claims under the wrong law. They are marked.
 */

/*
 * A BIN nothing publishes a payer sheet for.
 *
 * These tests are about the sources BELOW the payer sheet — PioneerRx, the PCN, the BIN listing —
 * and they were written against real routings that the payer-sheet table has since settled. A test
 * pinned to a real BIN silently stops testing what it says it tests the moment a stronger source
 * learns that BIN's answer, so they use a number nobody will ever publish.
 */
const FICTION = "900001";

const ev = (over: Partial<Parameters<typeof findPlanClass>[0]> = {}) => ({
  bin: FICTION,
  pcn: null,
  groupNumber: null,
  payerLabel: null,
  pbmName: null,
  linesOfBusiness: null,
  ...over,
});

const row = (over: Partial<PioneerPlanRow> = {}): PioneerPlanRow => ({
  bin: FICTION,
  pcn: "",
  source: "plan_file",
  planName: null,
  processor: null,
  planType: "Standard",
  isActive: true,
  ...over,
});

describe("PioneerRx's own answer, which nothing was reading", () => {
  test("a plan file entry filed as Part D settles it, and says so in words", () => {
    const r = findPlanClass(ev({ pcn: "KSPARTD", pioneer: [row({ pcn: "KSPARTD", planName: "Bc/bs Kansas Pdp", planType: "Part D" })] }));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "medicare");
    assert.equal(r.source, "pioneer_plan_file");
    assert.equal(r.confidence, "stated");
    assert.match(r.from, /Bc\/bs Kansas Pdp/);
  });

  test("the plan file outranks what somebody here typed", () => {
    // Both are PioneerRx. One is a reference it ships and one is a person's answer, and the
    // difference is the whole reason both are stored.
    const r = findPlanClass(
      ev({
        pcn: "X",
        pioneer: [
          row({ pcn: "X", source: "pharmacy", planType: "Medicaid/Welfare" }),
          row({ pcn: "X", source: "plan_file", planName: "Something Pdp", planType: "Part D" }),
        ],
      }),
    );
    assert.ok(isFinding(r));
    assert.equal(r.source, "pioneer_plan_file");
  });

  test("what the pharmacy set is offered, but only as indicated", () => {
    const r = findPlanClass(ev({ pcn: "03200000", pioneer: [row({ pcn: "03200000", source: "pharmacy", planName: "Careplus D Humana Pdp", planType: "Medicare Part D" })] }));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "medicare");
    assert.equal(r.confidence, "indicated");
  });

  test("Part D and Part B are both Medicare, and which is recorded", () => {
    const d = findPlanClass(ev({ pcn: "A", pioneer: [row({ pcn: "A", planType: "Part D" })] }));
    const b = findPlanClass(ev({ pcn: "B", pioneer: [row({ pcn: "B", source: "pharmacy", planType: "Medicare Part B" })] }));
    assert.equal((d as { classification: string }).classification, "medicare");
    assert.equal((b as { classification: string }).classification, "medicare");
    assert.equal((b as { detail: string }).detail, "Medicare Part B");
  });
});

describe('THE TRAP: "Standard" is PioneerRx\'s default, not an answer', () => {
  test("a plan filed Standard settles nothing", () => {
    // GoodRx is filed Standard. This pharmacy's own cash plan is filed Standard. So is Bc/bs
    // Kansas. Reading Standard as a classification would have put 535 September claims under a
    // class nobody chose, with "PioneerRx" written beside them.
    const r = findPlanClass(ev({ pcn: "GDRX", pioneer: [row({ pcn: "GDRX", planName: "Goodrx", planType: "Standard" })] }));
    assert.equal(r.classification, null);
  });

  test('"Documentary" — PioneerRx\'s own test plans — settles nothing either', () => {
    const r = findPlanClass(ev({ pcn: "T", pioneer: [row({ pcn: "T", planName: "Paid D.0 Test Plan", planType: "Documentary" })] }));
    assert.equal(r.classification, null);
  });

  test("a silent majority is not a majority, and the refusal counts both sides", () => {
    /*
     * REGRESSION. BIN 004336 PCN ADV carries thirteen named plans — Amerigroup, Molina, Bc/bs
     * Arkansas, Oklahoma State Employees, SilverScript Plus Pdp. Two are Part D and eleven are not.
     * Reading the two as unanimous (because the other eleven "said nothing") classified 151
     * commercial claims as Medicare.
     */
    const many = [
      row({ pcn: "ADV", planName: "Amerigroup", planType: "Standard" }),
      row({ pcn: "ADV", planName: "Molina Healthcare", planType: "Standard" }),
      row({ pcn: "ADV", planName: "Oklahoma State Empl", planType: "Standard" }),
      row({ pcn: "ADV", planName: "Silverscript Plus Pdp", planType: "Part D" }),
      row({ pcn: "ADV", planName: "Care Improvement + Pdp", planType: "Part D" }),
    ];
    const r = findPlanClass(ev({ pcn: "ADV", pioneer: many }));
    assert.equal(r.classification, null);
    assert.match((r as { why: string }).why, /5 plans/);
    assert.match((r as { why: string }).why, /2 filed as medicare and 3 not filed as anything/);
  });

  test("two different answers on one routing take neither", () => {
    const r = findPlanClass(ev({ pcn: "Z", pioneer: [row({ pcn: "Z", planType: "Part D" }), row({ pcn: "Z", planType: "Medicaid" })] }));
    assert.equal(r.classification, null);
    assert.match((r as { why: string }).why, /disagrees with itself/);
  });

  test("a deleted or inactive plan is not evidence", () => {
    const r = findPlanClass(ev({ pcn: "Q", pioneer: [row({ pcn: "Q", planType: "Part D", isActive: false })] }));
    assert.equal(r.classification, null);
  });
});

describe("THE TRAP: a BIN is a front door, not a line of business", () => {
  /*
   * REGRESSION, and the worst one found. `payer_bins.lines_of_business` lists every network under a
   * BIN, because that is what a BIN is. Matching "Medicare" anywhere in BIN 610455's listing
   * classified Blue Cross Blue Shield of Kansas *commercial* as Medicare — 392 claims and
   * $30,251.54 of one month — and the same match made the Communications Workers of America plan on
   * BIN 610011 into Medicaid. The PCN is what selects a network; the BIN cannot.
   */
  const BCBSKS_LISTING = [
    "Commercial & Extended Day *only for pharmacies not contracted with ESI",
    "Medicare D & Extended Day",
    "Medicare D Home Infusion",
    "Medicare D Preferred",
    "Commercial & Medicare D Rural",
    "Vaccines",
    "Workers Compensation",
    "Magellan Commercial",
  ].join("\n");

  test("Blue Cross Blue Shield of Kansas commercial is not Medicare", () => {
    const r = findPlanClass(ev({ pcn: "BCBSKS", payerLabel: "610455 (BCBSKS)", linesOfBusiness: BCBSKS_LISTING }));
    assert.equal(r.classification, null, "a multi-network BIN listing must never classify a plan");
    assert.match((r as { why: string }).why, /3 different lines of business/);
    assert.match((r as { why: string }).why, /the PCN is what selects one/);
  });

  test("the refusal names the PCN, because that is what the payer sheet is looked up by", () => {
    const r = findPlanClass(ev({ pcn: "KSPDP", linesOfBusiness: BCBSKS_LISTING }));
    assert.match((r as { why: string }).why, /PCN KSPDP/);
  });

  test("a listing naming one line of business still settles it", () => {
    const r = findPlanClass(ev({ bin: "024284", pcn: "ACR", linesOfBusiness: "Manufacturer Coupon" }));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "discount_card");
    assert.equal(r.source, "bin_listing");
  });

  test("Medicaid and Medicare together is the dual case, and Medicaid is who pays", () => {
    // The one exception to counting. A managed Medicaid plan's listing routinely names both, and
    // the narrower of the two is the truth about who pays.
    const r = findPlanClass(ev({ linesOfBusiness: "Medicaid MCO / Medicare dual" }));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "medicaid");
  });

  test("namedKinds counts kinds rather than matching the first one", () => {
    assert.deepEqual([...namedKinds("Medicare Part D")], ["medicare"]);
    assert.equal(namedKinds(BCBSKS_LISTING).size, 3);
    assert.equal(namedKinds(null).size, 0);
  });
});

describe("THE TRAP: many plan names joined together name nothing", () => {
  test("a routing carrying several named plans is not classified by their names", () => {
    /*
     * REGRESSION. The same fault as the BIN listing in a second costume: joining every plan name
     * under BIN 610014 into one string and searching it for "Medicare" found "Aarp / Paid Pdp"
     * among twenty-four names and classified 59 claims as Part D on the strength of it.
     */
    const r = findPlanClass(
      ev({
        bin: "610014",
        pcn: null,
        pioneer: [
          row({ planName: "General Motors" }),
          row({ planName: "Geha Plan" }),
          row({ planName: "Aarp / Paid Pdp", planType: "Part D" }),
          row({ planName: "Oklahoma State Employees" }),
        ],
      }),
    );
    assert.equal(r.classification, null);
  });

  test("but one name, standing alone, still counts", () => {
    const r = findPlanClass(ev({ pcn: null, pioneer: [row({ planName: "Aarp Medicare Pdp" })] }));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "medicare");
    assert.equal(r.source, "payer_name");
  });
});

describe("what the claim's own routing says", () => {
  test("a PCN naming Part D is the plan identifying itself", () => {
    const r = findPlanClass(ev({ pcn: "MEDDPRIME" }));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "medicare");
    assert.equal(r.source, "pcn");
    assert.match(r.from, /PCN "MEDDPRIME"/);
  });

  test("MPPP is the Prescription Payment Plan — Part D, not a copay card", () => {
    // MPPPKS reads like a card and is not one: it is the Part D plan itself billed on the
    // instalment arrangement the Inflation Reduction Act created. A copay card would be classed
    // the opposite way, so this needed naming rather than leaving to chance.
    const r = findPlanClass(ev({ pcn: "MPPPKS" }));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "medicare");
    assert.match(r.detail ?? "", /Prescription Payment Plan/);
  });

  test("Medicaid is tested before Medicare, because a dual plan names both", () => {
    assert.equal((findPlanClass(ev({ pcn: "KSCAID" })) as { classification: string }).classification, "medicaid");
  });
});

describe("what may never be answered without a document", () => {
  test("commercial proposes nothing, and says which document would settle it", () => {
    const r = findPlanClass(ev({ linesOfBusiness: "Commercial" }));
    assert.equal(r.classification, null);
    assert.match((r as { why: string }).why, /bought insurance or funds the plan/);
    assert.match((r as { why: string }).why, /Form 5500|plan document/);
  });

  test("a Government filing is a lead, never a classification", () => {
    /*
     * `governmental` puts a plan *in* reach of the Kansas floor, which makes it one of the four
     * that need a document — so PioneerRx filing something Government must not become a one-click
     * finding. It is far too useful to throw away, though: it points at the rows worth chasing.
     */
    const gov = [row({ pcn: "G", source: "pharmacy", planName: "City of Wichita", planType: "Government" })];
    const r = findPlanClass(ev({ pcn: "G", pioneer: gov }));
    assert.equal(r.classification, null);
    const hint = governmentHint(gov);
    assert.ok(hint);
    assert.match(hint, /City of Wichita/);
    assert.match(hint, /excluded from ERISA/);
  });

  test('"Cash/AR" is two opposite answers in one word, so it is neither', () => {
    // Cash is a discount plan; AR is a nursing home billed on account, which is not out of scope
    // at all. One word covering both cannot settle either.
    const r = findPlanClass(ev({ pcn: "C", pioneer: [row({ pcn: "C", source: "pharmacy", planType: "Cash/AR" })] }));
    assert.equal(r.classification, null);
  });

  test("no class that needs a document can ever be proposed", () => {
    for (const cls of PROPOSABLE) {
      assert.equal(needsBasis(cls), false, `${cls} needs a documented basis and must never be proposed`);
    }
  });

  test("and the proposal layer refuses one even if a source ever returns it", () => {
    // The belt to those braces: proposePlanClass re-checks PROPOSABLE, so a future source that
    // returned `governmental` becomes an explanation rather than a one-click ERISA determination.
    const gov = findPlanClass(ev({ pcn: "G", pioneer: [row({ pcn: "G", source: "pharmacy", planType: "Government" })] }));
    assert.equal(gov.classification, null);
    assert.equal(isProposal(proposePlanClass(ev({ linesOfBusiness: "Commercial" }))), false);
  });
});

describe("when nothing is known, nothing is offered", () => {
  test("an unrevealing BIN says so, and names itself", () => {
    const r = findPlanClass(ev({ payerLabel: "OptumRx", linesOfBusiness: null }));
    assert.equal(r.classification, null);
    assert.match((r as { why: string }).why, new RegExp(FICTION));
  });

  test("a plan with no BIN says that, rather than blaming the listing", () => {
    const r = findPlanClass(ev({ bin: null }));
    assert.equal(r.classification, null);
    assert.match((r as { why: string }).why, /no BIN/);
  });

  test("an insurer's name alone is never enough", () => {
    // "Blue Cross Blue Shield" is the commercial case wearing a payer name: it says nothing about
    // whether the employer behind this particular group funds its own plan.
    assert.equal(findPlanClass(ev({ payerLabel: "Blue Cross Blue Shield" })).classification, null);
  });
});
