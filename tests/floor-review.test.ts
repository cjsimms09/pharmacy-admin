import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reviewClaims, type ClaimRow, type PlanRow } from "../src/lib/floor-review";
import type { NadacRecord } from "../src/lib/reimbursement-rules";

/**
 * The review that decides what gets put in front of the Insurance Department.
 *
 * The distinction everything here turns on is between a claim the floor does not reach and a
 * claim we cannot yet tell about. Confusing the two in one direction hides recoverable money; in
 * the other it puts a claim on a schedule that should never have been there, which costs the
 * whole schedule its credibility.
 */

const NDC = "00378395293";

const nadac = (over: Partial<NadacRecord> = {}): NadacRecord => ({
  ndc11: NDC,
  unitMicros: 100_000, // $0.10 per unit
  pricingUnit: "EA",
  effectiveOn: "2026-07-01",
  fileAsOf: "2026-07-01",
  ...over,
});

/** 30 units at $0.10 is $3.00 of ingredient, plus the $10.50 fee: a floor of $13.50. */
const claim = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  id: "c1",
  rxNumber: "1000001",
  dateFilled: "2026-08-01",
  ndc11: NDC,
  itemName: "Something 10mg tablet",
  payerLabel: "A Plan",
  pbmName: "A PBM",
  bin: "610000",
  groupNumber: "GRP1",
  quantityThousandths: 30_000,
  quantityUnit: "EA",
  remitCents: 1000,
  copayCents: 0,
  ...over,
});

const insured: PlanRow[] = [{ bin: "610000", groupNumber: "GRP1", classification: "commercial_fully_insured" }];
const OPTS = { ksMedicaidDispensingFeeCents: null, materialityCents: 100 };

describe("finding the claims paid under the floor", () => {
  test("a short payment on a plan the floor reaches is filable, with the shortfall computed", () => {
    const r = reviewClaims([claim()], insured, [nadac()], OPTS);
    assert.equal(r.filable.length, 1);
    // Floor 1350, received 1000 → 350 short.
    assert.equal(r.filable[0].shortfallCents, 350);
    assert.equal(r.filableCents, 350);
  });

  test("the copay counts as money received, or every shortfall reads too large", () => {
    const r = reviewClaims([claim({ remitCents: 500, copayCents: 500 })], insured, [nadac()], OPTS);
    assert.equal(r.filable[0].shortfallCents, 350, "the patient's payment was not counted");
  });

  test("a claim paid at or above the floor is counted as correct, not as a problem", () => {
    const r = reviewClaims([claim({ remitCents: 1400 })], insured, [nadac()], OPTS);
    assert.equal(r.filable.length, 0);
    assert.equal(r.paidAtOrAbove, 1);
    assert.equal(r.blocked.length, 0);
  });

  test("a shortfall under the materiality threshold is not filed", () => {
    // Floor 1350, received 1300 → 50 short, below the 100 threshold.
    const r = reviewClaims([claim({ remitCents: 1300 })], insured, [nadac()], OPTS);
    assert.equal(r.filable.length, 0);
    assert.equal(r.paidAtOrAbove, 1, "a trivial shortfall should not read as a blocker");
  });

  test("the Kansas Medicaid fee raises the floor where it is higher than the statutory minimum", () => {
    const r = reviewClaims([claim({ remitCents: 1400 })], insured, [nadac()], {
      ...OPTS,
      ksMedicaidDispensingFeeCents: 1200,
    });
    // Floor becomes 300 + 1200 = 1500, so 1400 is now 100 short.
    assert.equal(r.settings.dispensingFeeUsedCents, 1200);
    assert.equal(r.filable.length, 1);
    assert.equal(r.filable[0].shortfallCents, 100);
  });

  test("a lower state fee never lowers the floor below the statutory minimum", () => {
    const r = reviewClaims([claim()], insured, [nadac()], { ...OPTS, ksMedicaidDispensingFeeCents: 400 });
    assert.equal(r.settings.dispensingFeeUsedCents, 1050);
  });
});

describe("out of scope is not the same as blocked", () => {
  const cases: [string, Partial<ClaimRow>, PlanRow[]][] = [
    ["filled before the statute took effect", { dateFilled: "2026-06-30" }, insured],
    ["a self-funded ERISA plan", {}, [{ bin: "610000", groupNumber: "GRP1", classification: "commercial_self_funded" }]],
    ["Medicare Part D", {}, [{ bin: "610000", groupNumber: "GRP1", classification: "medicare" }]],
    ["Medicaid", {}, [{ bin: "610000", groupNumber: "GRP1", classification: "medicaid" }]],
    ["a discount card", {}, [{ bin: "610000", groupNumber: "GRP1", classification: "discount_card" }]],
  ];

  for (const [what, over, plans] of cases) {
    test(`${what} is out of scope, with nothing to chase`, () => {
      const r = reviewClaims([claim(over)], plans, [nadac()], OPTS);
      assert.equal(r.filable.length, 0, what);
      assert.equal(r.blocked.length, 0, `${what} was listed as something to fix`);
      assert.equal(r.outOfScope, 1, what);
      assert.equal(r.blockers.length, 0);
    });
  }

  test("a plan nobody has classified is blocked, not out of scope — and it is the money question", () => {
    const r = reviewClaims([claim()], [], [nadac()], OPTS);
    assert.equal(r.outOfScope, 0, "an unclassified plan was written off");
    assert.equal(r.blocked.length, 1);
    const b = r.blockers.find((x) => x.id === "plan_in_scope");
    assert.ok(b, "no blocker was raised for the unclassified plan");
    assert.equal(b!.onlyThis, 1);
    // The whole point: it can still be priced, so the prize behind the blocker has a number.
    assert.equal(b!.onlyThisCents, 350);
  });
});

describe("what is stopping the rest, ranked by what clearing it is worth", () => {
  test("no NADAC in force on the fill date blocks, and says so", () => {
    const r = reviewClaims([claim()], insured, [nadac({ effectiveOn: "2026-09-01" })], OPTS);
    assert.equal(r.blocked.length, 1);
    assert.ok(r.blockers.some((b) => b.id === "nadac_available"));
  });

  test("a NADAC effective before the fill date is the one used, not the newest", () => {
    const r = reviewClaims(
      [claim()],
      insured,
      [nadac({ effectiveOn: "2026-07-01", unitMicros: 100_000 }), nadac({ effectiveOn: "2026-08-15", unitMicros: 900_000 })],
      OPTS,
    );
    // Filled 1 August, so the July price applies: floor 1350, not 3750.
    assert.equal(r.filable[0].floorCents, 1350);
  });

  test("a unit of measure that disagrees with NADAC blocks rather than converting", () => {
    // Pricing 30 mL against a per-each price would be wrong by orders of magnitude.
    const r = reviewClaims([claim({ quantityUnit: "ML" })], insured, [nadac()], OPTS);
    assert.equal(r.filable.length, 0);
    assert.ok(r.blockers.some((b) => b.id === "unit_of_measure_agrees"));
  });

  test("a missing quantity blocks", () => {
    const r = reviewClaims([claim({ quantityThousandths: null })], insured, [nadac()], OPTS);
    assert.ok(r.blockers.some((b) => b.id === "quantity_known"));
  });

  test("nothing recorded as received blocks", () => {
    const r = reviewClaims([claim({ remitCents: null, copayCents: null })], insured, [nadac()], OPTS);
    assert.ok(r.blockers.some((b) => b.id === "payment_received"));
  });

  test("blockers are ranked by the money behind them, not by the number of claims", () => {
    const claims: ClaimRow[] = [
      // Ten claims blocked only on the unit of measure, each worth nothing yet since they cannot
      // be priced at all.
      ...Array.from({ length: 10 }, (_, i) => claim({ id: `u${i}`, rxNumber: `u${i}`, quantityUnit: "ML" })),
      // One claim blocked only on plan classification, priced, and worth $3.50.
      claim({ id: "p1", rxNumber: "p1", bin: "999999", groupNumber: "GRPX" }),
    ];
    const r = reviewClaims(claims, insured, [nadac()], OPTS);
    assert.equal(r.blockers[0].id, "plan_in_scope", "the ten-claim blocker with no money behind it came first");
    assert.ok(r.blockers[0].onlyThisCents > 0);
  });

  test("a claim held back by two things counts against both, but only unblocks when both clear", () => {
    const r = reviewClaims([claim({ quantityUnit: "ML" })], [], [nadac()], OPTS);
    const unit = r.blockers.find((b) => b.id === "unit_of_measure_agrees")!;
    const plan = r.blockers.find((b) => b.id === "plan_in_scope")!;
    assert.equal(unit.claims, 1);
    assert.equal(plan.claims, 1);
    assert.equal(unit.onlyThis, 0, "it was counted as unblockable by fixing one thing");
    assert.equal(plan.onlyThis, 0);
  });
});

describe("the review is honest about what it is assuming", () => {
  test("it states the flags the export does not carry", () => {
    const r = reviewClaims([claim()], insured, [nadac()], OPTS);
    const text = r.caveats.join(" ").toLowerCase();
    assert.match(text, /revers/, "nothing said about reversals, which are assumed away");
    assert.match(text, /compound/);
    assert.match(text, /340b/);
    assert.match(text, /adjudicat/, "nothing said about the amount being adjudicated rather than remitted");
  });

  test("a claim with no NDC is left out entirely rather than counted as anything", () => {
    const r = reviewClaims([claim({ ndc11: null })], insured, [nadac()], OPTS);
    assert.equal(r.examined, 0);
  });

  test("every claim is accounted for in exactly one bucket", () => {
    const claims: ClaimRow[] = [
      claim({ id: "a", rxNumber: "a" }), // filable
      claim({ id: "b", rxNumber: "b", remitCents: 5000 }), // paid fine
      claim({ id: "c", rxNumber: "c", dateFilled: "2026-01-01" }), // out of scope
      claim({ id: "d", rxNumber: "d", quantityThousandths: null }), // blocked
    ];
    const r = reviewClaims(claims, insured, [nadac()], OPTS);
    assert.equal(r.examined, 4);
    assert.equal(r.filable.length + r.paidAtOrAbove + r.outOfScope + r.blocked.length, r.examined);
  });
});

describe("the week a claim was filled", () => {
  test("Monday to Sunday all report the same week", async () => {
    const { weekStart } = await import("../src/lib/nadac");
    // 2026-07-13 is a Monday.
    for (const d of ["2026-07-13", "2026-07-14", "2026-07-17", "2026-07-19"]) {
      assert.equal(weekStart(d), "2026-07-13", `${d} landed in the wrong week`);
    }
    assert.equal(weekStart("2026-07-20"), "2026-07-20", "the next Monday should start a new week");
    assert.equal(weekStart("2026-07-12"), "2026-07-06", "Sunday belongs to the week that started six days earlier");
  });

  test("something that is not a date comes back unchanged rather than as 1970", async () => {
    const { weekStart } = await import("../src/lib/nadac");
    assert.equal(weekStart("not-a-date"), "not-a-date");
  });
});
