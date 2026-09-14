import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { route, remedyBook, priceRequests, ingredientReceivedCents, type Fill } from "../src/lib/claim-remedy";

/**
 * Routing a claim that lost money to the one thing worth doing about it.
 *
 * The owner's tree, in his words: *"Are we buying too expensive and should request a price reduction
 * to buying group... If we are buying fine and still losing money, then we need to do mac appeals
 * (if Mac based reimbursement only), if NADAC based we need to submit NADAC underpayment to Kansas
 * insurance."*
 *
 * The case that matters most here is the first one below. It is not an edge case — it was 342 of
 * September's 628 "below cost" claims and $25,810.59 of money the site said was lost and was not.
 */
const fill = (over: Partial<Fill> = {}): Fill => ({
  claimId: "c1",
  rxNumber: "100001",
  fillNumber: 0,
  dateFilled: "2026-09-04",
  ndc11: "00093310953",
  drugName: "AMOXICILLIN 500 MG CAPSULE",
  pbmName: "CVS Caremark",
  bin: "004336",
  pcn: "ADV",
  groupNumber: "RX1234",
  quantityThousandths: 30_000, // 30 capsules
  acquisitionCents: 700,
  ingredientPaidCents: 800,
  dispensingFeePaidCents: 100,
  remitCents: 700,
  copayCents: 200,
  basisOfReimbursement: "06",
  nadacPerUnitCents: 40, // 40c a capsule -> $12.00 for 30
  nadacOn: "2026-09-02",
  inKansasScope: null,
  ...over,
});

describe("what the pharmacy was actually paid for the drug", () => {
  test("REGRESSION: the copay is part of the ingredient cost, not money on top of it", () => {
    /*
     * The bug this file exists for. A Wegovy fill cost $1,308.55; the plan sent $172.10 and the
     * patient owed $1,535.01. Compared against the plan's share alone it reads as $1,136.45 in the
     * red. It made $398.56.
     *
     * Measured on the real book, `remit = ingredient + fee − copay` holds on 1,523 of 1,594
     * September fills, so the plan's remittance is the ingredient cost *less* the patient's slice.
     */
    const wegovy = fill({
      drugName: "WEGOVY 1.5MG",
      acquisitionCents: 130_855,
      ingredientPaidCents: 170_711,
      dispensingFeePaidCents: 0,
      remitCents: 17_210,
      copayCents: 153_501,
      nadacPerUnitCents: null,
    });
    const r = route(wegovy);
    assert.equal(r.remedy, "not_below_cost");
    assert.equal(r.shortfallCents, 0);
    assert.match(r.says, /\$1,707\.11/);
  });

  test("where the feed omitted the split, it is rebuilt from remit + copay − fee, and says so", () => {
    // 71 of 1,594 September fills, mostly Mounjaro and Eliquis lines.
    const g = ingredientReceivedCents(fill({ ingredientPaidCents: null, remitCents: 700, copayCents: 200, dispensingFeePaidCents: 100 }));
    assert.equal(g.cents, 800);
    assert.equal(g.from, "derived");
  });

  test("no reimbursement figure at all is null, never nought", () => {
    const g = ingredientReceivedCents(fill({ ingredientPaidCents: null, remitCents: null }));
    assert.equal(g.cents, null);
    assert.equal(g.from, null);
    assert.equal(route(fill({ ingredientPaidCents: null, remitCents: null })).remedy, "no_cost");
  });
});

describe("the tree, in the order he set it out", () => {
  test("bought above the national average is a price request, whatever the plan did", () => {
    /*
     * The buying comes first because no PBM will ever fix it. 30 capsules at a NADAC of 40c is
     * $12.00; paying $25.00 for them is this pharmacy's price being worse than the country's.
     */
    const r = route(fill({ acquisitionCents: 2_500, ingredientPaidCents: 1_400, basisOfReimbursement: "06" }));
    assert.equal(r.remedy, "buy_better");
    assert.equal(r.shortfallCents, 1_100);
    assert.equal(r.overNadacCents, 1_300);
    assert.match(r.says, /national average/);
  });

  test("and where it was ALSO underpaid, the second letter is named rather than dropped", () => {
    // Bought dear and paid under NADAC. A better price does not settle the underpayment.
    const r = route(fill({ acquisitionCents: 2_500, ingredientPaidCents: 900 }));
    assert.equal(r.remedy, "buy_better");
    assert.equal(r.alsoUnderNadac, true);
    assert.match(r.says, /separate letter/);
  });

  test("bought well and MAC-priced is a MAC appeal", () => {
    for (const basis of ["06", "07", "6", "7"]) {
      const r = route(fill({ acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: basis }));
      assert.equal(r.remedy, "mac_appeal", `basis ${basis}`);
      assert.equal(r.shortfallCents, 200);
    }
  });

  test("bought well, paid under NADAC, on a plan the floor reaches is a Kansas filing", () => {
    const r = route(fill({ acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "09", inKansasScope: true }));
    assert.equal(r.remedy, "kansas_underpayment");
    assert.match(r.says, /the floor reaches/);
  });

  test("the same claim on an unclassified plan says it cannot be filed, and does not say 'no'", () => {
    /*
     * 481 of 491 plans have never been classified. Treating an unclassified plan as out of scope
     * would silently drop the filing; treating it as in scope would file against a self-funded
     * ERISA plan the department cannot act on. It is a third state and it is said as one.
     */
    const r = route(fill({ acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "09", inKansasScope: null }));
    assert.equal(r.remedy, "kansas_plan_unclassified");
    assert.match(r.says, /nobody has classified/);
    assert.equal(r.shortfallCents, 200, "the money is still counted while it waits");
  });

  test("a plan proved out of the floor's reach is a contract question, not a filing", () => {
    const r = route(fill({ acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "09", inKansasScope: false }));
    assert.equal(r.remedy, "contract_problem");
  });

  test("INVARIANT: a below-cost fill bought at or under NADAC was always paid under NADAC", () => {
    /*
     * The arithmetic that removed a branch. Below cost means ingredient < acquisition; bought well
     * means acquisition <= NADAC; so ingredient < NADAC, always. There is no "bought well, paid at
     * or above NADAC, and still short" case, and the first draft of this router had one that could
     * never fire. If this ever fails, a fourth remedy is needed and the router is incomplete.
     */
    for (const [acq, ing, nadacUnit] of [
      [1_100, 900, 40],
      [1_200, 1_199, 40],
      [500, 1, 40],
      [1_100, 900, 200],
    ] as const) {
      const nadacFill = nadacUnit * 30;
      if (acq > nadacFill) continue; // bought dear: a different branch, tested above
      const r = route(fill({ acquisitionCents: acq, ingredientPaidCents: ing, nadacPerUnitCents: nadacUnit, basisOfReimbursement: "03" }));
      assert.ok(ing < nadacFill, `acquisition ${acq} <= NADAC ${nadacFill} and ingredient ${ing} < acquisition`);
      assert.ok(["kansas_underpayment", "kansas_plan_unclassified", "contract_problem"].includes(r.remedy), r.remedy);
      assert.equal(r.alsoUnderNadac, true);
    }
  });
});

describe("what it refuses to route, and why that is the point", () => {
  test("a basis code nothing identifies is not guessed at", () => {
    /*
     * Bases 20 and 46 carry $5,384.80 of September's below-cost money between them — more than every
     * MAC appeal combined — and neither is in any list read so far. Filing the wrong form costs a
     * refusal on the record with a PBM this pharmacy has to keep filing with.
     */
    for (const basis of ["20", "46"]) {
      const r = route(fill({ acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: basis }));
      assert.equal(r.remedy, "basis_unknown", `basis ${basis}`);
      assert.match(r.says, new RegExp(`basis of reimbursement ${basis}`));
      assert.equal(r.shortfallCents, 200);
    }
  });

  test("a claim with no basis at all still routes on what the money did", () => {
    // Silence is not an unknown code. NADAC still says whether the price or the payment is wrong.
    const r = route(fill({ acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: null, inKansasScope: true }));
    assert.equal(r.remedy, "kansas_underpayment");
  });

  test("no NADAC means the price cannot be told from the payment, and neither letter is sent", () => {
    const r = route(fill({ acquisitionCents: 1_100, ingredientPaidCents: 900, nadacPerUnitCents: null }));
    assert.equal(r.remedy, "no_nadac");
    assert.equal(r.shortfallCents, 200);
  });

  test("no invoice means nothing can be judged, including the buying", () => {
    assert.equal(route(fill({ acquisitionCents: null })).remedy, "no_cost");
    assert.equal(route(fill({ acquisitionCents: 0 })).remedy, "no_cost");
  });

  test("a fill with no quantity cannot be put on a per-unit footing", () => {
    // A package compared with a unit is the mistake this site has made before.
    assert.equal(route(fill({ quantityThousandths: 0, acquisitionCents: 1_100, ingredientPaidCents: 900 })).remedy, "no_nadac");
  });
});

describe("the monthly price request to the buying group", () => {
  const dear = (n: number, qty: number, cost: number) =>
    fill({ claimId: `d${n}`, ndc11: "47781056601", drugName: "LISDEXAMFETAMINE 50 MG CAPSULE", quantityThousandths: qty, acquisitionCents: cost, ingredientPaidCents: Math.round(cost * 0.8), nadacPerUnitCents: 100 });

  test("it batches by NDC, because that is what the wholesaler can act on", () => {
    const rs = [dear(1, 30_000, 5_000), dear(2, 30_000, 5_000), dear(3, 60_000, 10_000)].map(route);
    const [p] = priceRequests(rs);
    assert.equal(p.ndc11, "47781056601");
    assert.equal(p.fills, 3);
    assert.equal(p.units, 120);
    assert.equal(p.paidCents, 20_000);
    assert.equal(p.nadacCents, 12_000);
    assert.equal(p.overCents, 8_000);
  });

  test("the floor is the month's total for the drug, not a single fill", () => {
    /*
     * Deliberately different from the $30 MAC appeal floor. That one protects his time, because
     * every Caremark submission costs a verification code typed by hand. A price request is one
     * form for the whole batch, so a drug three cents over on two hundred fills is a better ask
     * than a dollar over on one — and a per-claim threshold would throw exactly those away.
     */
    const many = Array.from({ length: 200 }, (_, i) => route(dear(i, 1_000, 103)));
    const [p] = priceRequests(many, 500);
    assert.equal(p.fills, 200);
    assert.equal(p.overCents, 600, "three cents a fill, two hundred fills");
    assert.equal(priceRequests([route(dear(1, 1_000, 103))], 500).length, 0, "one fill of the same drug is not worth a form");
  });

  test("nothing but bought-dear fills reach the form", () => {
    const notDear = route(fill({ acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "06" }));
    assert.equal(notDear.remedy, "mac_appeal");
    assert.equal(priceRequests([notDear]).length, 0);
  });

  test("it is ordered by what is over, not by what is short", () => {
    const a = route(dear(1, 100_000, 20_000)); // $100 over
    const b = route(fill({ claimId: "b", ndc11: "11111111111", drugName: "B", quantityThousandths: 10_000, acquisitionCents: 3_000, ingredientPaidCents: 100, nadacPerUnitCents: 100 })); // $20 over, $29 short
    const ps = priceRequests([b, a].map((x) => x));
    assert.equal(ps[0].ndc11, "47781056601");
  });
});

describe("the book a screen reads", () => {
  test("it separates what can be done from what is waiting on something", () => {
    const book = remedyBook([
      fill({ claimId: "a", acquisitionCents: 2_500, ingredientPaidCents: 1_400 }), // buy_better
      fill({ claimId: "b", acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "06" }), // mac
      fill({ claimId: "c", acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "46" }), // unknown basis
      fill({ claimId: "d", acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "09" }), // unclassified plan
      fill({ claimId: "e" }), // not below cost
    ]);
    const got = new Map(book.buckets.map((b) => [b.remedy, b]));
    assert.equal(got.get("buy_better")?.claims, 1);
    assert.equal(got.get("mac_appeal")?.claims, 1);
    assert.equal(got.get("basis_unknown")?.claims, 1);
    assert.equal(got.get("kansas_plan_unclassified")?.claims, 1);
    assert.equal(got.get("not_below_cost")?.claims, 1);
    assert.match(book.says, /waiting on a plan classification/);
  });

  test("every below-cost fill lands in exactly one bucket, and the money adds up", () => {
    // The property that keeps this honest: nothing is counted twice and nothing falls through.
    const fills = [
      fill({ claimId: "a", acquisitionCents: 2_500, ingredientPaidCents: 1_400 }),
      fill({ claimId: "b", acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "06" }),
      fill({ claimId: "c", acquisitionCents: 1_100, ingredientPaidCents: 900, basisOfReimbursement: "46" }),
      fill({ claimId: "d", acquisitionCents: null }),
      fill({ claimId: "e" }),
    ];
    const book = remedyBook(fills);
    assert.equal(book.routed.length, fills.length);
    assert.equal(
      book.buckets.reduce((n, b) => n + b.claims, 0),
      fills.length,
    );
    assert.equal(
      book.buckets.reduce((n, b) => n + b.shortfallCents, 0),
      book.routed.reduce((n, r) => n + r.shortfallCents, 0),
    );
  });

  test("it agrees with the MAC appeal gate on which bases are a MAC", async () => {
    /*
     * The two files keep their own copy of the MAC basis set on purpose — one decides whether an
     * appeal may be filed, the other which remedy a claim belongs to — but they must not drift
     * apart without somebody choosing to. If this fails, decide which is right.
     */
    const src = await import("node:fs/promises").then((fs) => fs.readFile("src/lib/mac-appeal-candidates.ts", "utf8"));
    const m = src.match(/MAC_BASES = new Set\(\[([^\]]*)\]\)/);
    assert.ok(m, "mac-appeal-candidates.ts no longer declares MAC_BASES the same way");
    const theirs = [...m[1].matchAll(/"(\d+)"/g)].map((x) => x[1]).sort();
    assert.deepEqual(theirs, ["06", "07"]);
  });
});
