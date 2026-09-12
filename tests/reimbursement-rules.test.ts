import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SB20_EFFECTIVE_FROM,
  SB20_MIN_DISPENSING_FEE_CENTS,
  computeFloor,
  nadacInForce,
  verifyClaim,
  type ClaimForFloor,
  type NadacRecord,
} from "../src/lib/reimbursement-rules";

const nadac = (o: Partial<NadacRecord> = {}): NadacRecord => ({
  ndc11: "00093721410",
  unitMicros: 34_280, // $0.03428
  pricingUnit: "EA",
  effectiveOn: "2026-07-01",
  fileAsOf: "2026-07-01",
  ...o,
});

const claim = (o: Partial<ClaimForFloor> = {}): ClaimForFloor => ({
  rxNumber: "313779",
  dateFilled: "2026-08-15",
  ndc11: "00093721410",
  quantityThousandths: 90_000, // 90 each
  quantityUnit: "EA",
  paidCents: 400,
  reversed: false,
  adjustedAfterPayment: false,
  isCompound: false,
  is340B: false,
  planScope: "commercial_non_erisa",
  ...o,
});

const opts = { ksMedicaidDispensingFeeCents: null, materialityCents: 100 };

describe("computeFloor", () => {
  test("NADAC times quantity, plus the statutory dispensing fee", () => {
    // $0.03428 x 90 = $3.0852 -> $3.09, + $10.50 = $13.59
    const f = computeFloor(90_000, nadac(), null);
    assert.equal(f.ingredientFloorCents, 309);
    assert.equal(f.dispensingFeeCents, SB20_MIN_DISPENSING_FEE_CENTS);
    assert.equal(f.floorCents, 1359);
  });

  test("the Kansas Medicaid fee wins when it is higher", () => {
    assert.equal(computeFloor(90_000, nadac(), 1200).dispensingFeeCents, 1200);
  });

  test("$10.50 wins when the Medicaid fee is lower", () => {
    assert.equal(computeFloor(90_000, nadac(), 900).dispensingFeeCents, 1050);
  });

  test("the dispensing fee alone often exceeds what commercial plans pay", () => {
    // A cheap generic: the ingredient is pennies, the fee is the whole claim.
    const f = computeFloor(30_000, nadac({ unitMicros: 2_410 }), null);
    assert.equal(f.ingredientFloorCents, 7); // $0.0723 -> $0.07
    assert.equal(f.floorCents, 1057);
  });
});

describe("nadacInForce", () => {
  const history = [
    nadac({ effectiveOn: "2026-06-24", unitMicros: 30_000 }),
    nadac({ effectiveOn: "2026-07-08", unitMicros: 34_280 }),
    nadac({ effectiveOn: "2026-08-12", unitMicros: 40_000 }),
    nadac({ effectiveOn: "2026-09-02", unitMicros: 50_000 }),
  ];

  test("uses the file in force on the fill date, not the newest", () => {
    assert.equal(nadacInForce(history, "00093721410", "2026-08-15")!.unitMicros, 40_000);
    assert.equal(nadacInForce(history, "00093721410", "2026-07-10")!.unitMicros, 34_280);
  });

  test("a fill on the effective date itself uses that file", () => {
    assert.equal(nadacInForce(history, "00093721410", "2026-08-12")!.unitMicros, 40_000);
  });

  test("a fill the day before uses the previous file", () => {
    assert.equal(nadacInForce(history, "00093721410", "2026-08-11")!.unitMicros, 34_280);
  });

  test("no record before the fill date returns null rather than the nearest", () => {
    assert.equal(nadacInForce(history, "00093721410", "2026-06-01"), null);
  });

  test("does not cross NDCs", () => {
    assert.equal(nadacInForce(history, "99999999999", "2026-08-15"), null);
  });
});

describe("verifyClaim — a filable claim", () => {
  const v = verifyClaim(claim(), [nadac()], opts);

  test("passes every check", () => {
    assert.equal(v.filable, true, v.filable ? "" : JSON.stringify(v.failed));
  });

  test("computes the shortfall against the floor", () => {
    // floor $13.59, paid $4.00
    assert.equal(v.shortfallCents, 959);
  });

  test("carries the NADAC file date, so the complaint can cite its source", () => {
    assert.ok(v.filable && v.floor.nadac.fileAsOf === "2026-07-01");
  });
});

describe("verifyClaim — everything that must stop a filing", () => {
  const rejects = (c: Partial<ClaimForFloor>, id: string, records = [nadac()]) => {
    const v = verifyClaim(claim(c), records, opts);
    assert.equal(v.filable, false, `expected ${id} to block filing`);
    assert.ok(!v.filable && v.failed.some((f) => f.id === id), `expected failure ${id}, got ${!v.filable ? v.failed.map((f) => f.id).join(",") : ""}`);
  };

  test("filled before the statute took effect", () => rejects({ dateFilled: "2026-06-30" }, "fill_date_in_scope"));
  test("ERISA plan", () => rejects({ planScope: "commercial_erisa" }, "plan_in_scope"));
  test("Medicare Part D", () => rejects({ planScope: "part_d" }, "plan_in_scope"));
  test("Medicaid", () => rejects({ planScope: "medicaid" }, "plan_in_scope"));
  test("plan type not yet established — unknown is not a licence to file", () => rejects({ planScope: "unknown" }, "plan_in_scope"));
  test("reversed claim", () => rejects({ reversed: true }, "claim_not_reversed"));
  test("no payment received — adjudicated is not paid", () => rejects({ paidCents: null }, "payment_received"));
  test("adjusted after payment", () => rejects({ adjustedAfterPayment: true }, "no_later_adjustment"));
  test("compound", () => rejects({ isCompound: true }, "not_compound"));
  test("340B", () => rejects({ is340B: true }, "not_340b"));
  test("quantity missing", () => rejects({ quantityThousandths: null }, "quantity_known"));
  test("no NADAC in force on the fill date", () => rejects({}, "nadac_available", [nadac({ effectiveOn: "2026-09-01" })]));

  test("unit of measure mismatch — the error that would be wrong by orders of magnitude", () => {
    rejects({ quantityUnit: "ML" }, "unit_of_measure_agrees");
  });

  test("paid at or above the floor is not a shortfall", () => {
    const v = verifyClaim(claim({ paidCents: 1400 }), [nadac()], opts);
    assert.equal(v.filable, false);
    assert.equal(v.shortfallCents, -41);
  });

  test("a shortfall below materiality is not worth a filing", () => {
    const v = verifyClaim(claim({ paidCents: 1300 }), [nadac()], opts);
    assert.equal(v.shortfallCents, 59);
    assert.equal(v.filable, false);
  });

  test("all checks run, so the exclusion reasons can be counted", () => {
    const v = verifyClaim(claim({ reversed: true, planScope: "part_d", paidCents: null }), [nadac()], opts);
    assert.equal(v.filable, false);
    assert.ok(!v.filable && v.failed.length >= 3, "every failing check should be reported, not just the first");
  });

  test("every check carries a reason a person can read", () => {
    const v = verifyClaim(claim({ quantityUnit: "GM" }), [nadac()], opts);
    for (const c of v.checks) assert.ok(c.detail.length > 10, `${c.id} has no usable explanation`);
  });
});
