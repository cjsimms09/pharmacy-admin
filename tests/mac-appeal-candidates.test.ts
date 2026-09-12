import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { judge, worklist, type Candidate, type PayerTerms } from "../src/lib/mac-appeal-candidates";

const TODAY = "2026-09-11";

const claim = (over: Partial<Candidate> = {}): Candidate => ({
  claimId: "c1",
  rxNumber: "336548",
  fillNumber: 0,
  dateFilled: "2026-09-08",
  ndc11: "47781056601",
  drugName: "LISDEXAMFETAMINE 50 MG",
  bin: "610014",
  pcn: null,
  groupNumber: "RXBCADI",
  pbmName: "Express Scripts",
  paidCents: 7_663,
  acquisitionCents: 16_816,
  quantityThousandths: 30_000,
  daysSupply: 30,
  /* MAC-priced, so the default fixture reaches the gates each test is actually about. */
  basisOfReimbursement: "07",
  /* Well below the paid figure, so the NADAC test is not what these tests are about. */
  nadacPerUnitCents: 1_000,
  classification: "G",
  ...over,
});

const terms = (over: Partial<PayerTerms> = {}): PayerTerms => ({
  pbmName: "Express Scripts",
  whoFiles: "pharmacy",
  appealWindowDays: null,
  windowBasis: null,
  channel: "portal",
  target: "prc.express-scripts.com",
  ...over,
});

describe("which claims can be appealed", () => {
  test("a generic paid below cost, by a payer we may file with, is an appeal", () => {
    const j = judge(claim(), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
    assert.equal(j.shortfallCents, 9_153);
  });

  test("a brand is not a MAC appeal", () => {
    /*
     * The first version of this returned a list that was almost entirely Wegovy and Zepbound. MAC
     * lists price generics; a brand paid below cost is a buying or contract question.
     */
    const j = judge(claim({ classification: "B" }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "not_generic");
    assert.ok(j.says.includes("brand"));
  });

  test("an NDC NADAC does not price says so, rather than being assumed generic", () => {
    const j = judge(claim({ classification: null }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "not_generic");
    assert.ok(j.says.includes("NADAC"));
  });

  test("a claim the plan paid nothing on is a deductible, not an underpayment", () => {
    // These were the largest apparent losses in the raw data and none of them is appealable.
    const j = judge(claim({ paidCents: 0 }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "paid_nothing");
  });

  test("no invoice means nothing to evidence it with", () => {
    const j = judge(claim({ acquisitionCents: null }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "no_invoice");
  });

  test("paid at or above cost is left alone", () => {
    assert.equal(judge(claim({ paidCents: 16_816 }), terms(), new Set(), TODAY).verdict, "paid_enough");
    assert.equal(judge(claim({ paidCents: 20_000 }), terms(), new Set(), TODAY).verdict, "paid_enough");
  });

  test("already filed is never filed again", () => {
    // The owner: "it also should record once filed so that it doesnt duplicate request or alerts".
    const j = judge(claim(), terms(), new Set(["c1"]), TODAY);
    assert.equal(j.verdict, "already_filed");
  });

  test("already-filed outranks everything, so a re-run cannot resurrect one", () => {
    const j = judge(claim({ classification: "B", paidCents: 0 }), terms(), new Set(["c1"]), TODAY);
    assert.equal(j.verdict, "already_filed");
  });
});

describe("who is allowed to file", () => {
  test("a payer whose contract routes through the PSAO is not ours to file", () => {
    const j = judge(claim({ pbmName: "Blue Eagle Health" }), terms({ pbmName: "Blue Eagle Health", whoFiles: "psao" }), new Set(), TODAY);
    assert.equal(j.verdict, "psao_files");
    assert.ok(j.says.includes("AccessHealth"));
    assert.equal(j.shortfallCents, 9_153, "the money is still counted, it just goes to somebody else");
  });

  test("a payer with no MAC appeal process at all", () => {
    const j = judge(claim({ pbmName: "OptumRx" }), terms({ pbmName: "OptumRx", whoFiles: "none" }), new Set(), TODAY);
    assert.equal(j.verdict, "no_route");
  });

  test("a payer whose agreement was never read is not guessed at", () => {
    const j = judge(claim({ pbmName: "Maxor Plus" }), null, new Set(), TODAY);
    assert.equal(j.verdict, "payer_unknown");
    assert.ok(j.says.includes("no agreement has been read"));
  });

  test("'either' is filable by the pharmacy", () => {
    assert.equal(judge(claim(), terms({ whoFiles: "either" }), new Set(), TODAY).verdict, "appeal");
  });
});

describe("the window", () => {
  const caremark = terms({ pbmName: "CVS Caremark", appealWindowDays: 10, windowBasis: "initial_claim" });

  test("inside the window, with the days left counted", () => {
    const j = judge(claim({ pbmName: "CVS Caremark", dateFilled: "2026-09-08" }), caremark, new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
    assert.equal(j.deadline, "2026-09-18");
    assert.equal(j.daysLeft, 7);
  });

  test("the last day is still a day", () => {
    const j = judge(claim({ pbmName: "CVS Caremark", dateFilled: "2026-09-01" }), caremark, new Set(), TODAY);
    assert.equal(j.deadline, "2026-09-11");
    assert.equal(j.daysLeft, 0);
    assert.equal(j.verdict, "appeal");
    assert.ok(j.says.includes("last day"));
  });

  test("a day past is too late, and says when it ran out", () => {
    const j = judge(claim({ pbmName: "CVS Caremark", dateFilled: "2026-08-31" }), caremark, new Set(), TODAY);
    assert.equal(j.verdict, "too_late");
    assert.equal(j.daysLeft, -1);
    assert.ok(j.says.includes("2026-09-10"));
  });

  test("no window on file is not the same as expired", () => {
    /*
     * Reporting an unknown deadline as expired would quietly drop money. Eighteen of twenty payers
     * had no window recorded when this was written.
     */
    const j = judge(claim(), terms({ appealWindowDays: null }), new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
    assert.equal(j.deadline, null);
    assert.ok(j.says.includes("no filing deadline"));
  });

  test("a window whose basis is not the fill date is not computed from the fill date", () => {
    // Better to say "no clock" than to count down from a date the contract did not mean.
    const j = judge(claim(), terms({ appealWindowDays: 60, windowBasis: "payment_date" }), new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
    assert.equal(j.deadline, null);
  });
});

describe("the worklist", () => {
  const mixed: Candidate[] = [
    claim({ claimId: "a", pbmName: "CVS Caremark", dateFilled: "2026-09-01", paidCents: 5_000, acquisitionCents: 12_000 }),
    claim({ claimId: "b", pbmName: "CVS Caremark", dateFilled: "2026-09-09", paidCents: 1_000, acquisitionCents: 9_000 }),
    claim({ claimId: "c", pbmName: "Express Scripts", paidCents: 7_663, acquisitionCents: 16_816 }),
    claim({ claimId: "d", pbmName: "Blue Eagle Health", paidCents: 100, acquisitionCents: 9_000 }),
    claim({ claimId: "e", pbmName: "CVS Caremark", classification: "B" }),
  ];
  const allTerms: PayerTerms[] = [
    terms({ pbmName: "CVS Caremark", appealWindowDays: 10, windowBasis: "initial_claim", channel: "portal" }),
    terms({ pbmName: "Express Scripts" }),
    terms({ pbmName: "Blue Eagle Health", whoFiles: "psao" }),
  ];

  test("batched by payer, because that is how they are filed", () => {
    const w = worklist(mixed, allTerms, new Set(), TODAY);
    assert.deepEqual(w.batches.map((b) => b.pbmName), ["CVS Caremark", "Express Scripts"]);
    assert.equal(w.batches[0].claims.length, 2);
    assert.equal(w.totalClaims, 3);
  });

  test("the most urgent batch comes first, not the biggest", () => {
    // A large batch with three weeks left can wait behind a small one expiring tonight.
    const w = worklist(mixed, allTerms, new Set(), TODAY);
    assert.equal(w.batches[0].pbmName, "CVS Caremark");
    assert.equal(w.batches[0].daysLeft, 0, "its oldest claim expires today");
    assert.equal(w.batches[1].daysLeft, null, "ESI has no clock, so it sorts last");
  });

  test("within a batch the soonest deadline is first", () => {
    const w = worklist(mixed, allTerms, new Set(), TODAY);
    assert.deepEqual(w.batches[0].claims.map((j) => j.candidate.claimId), ["a", "b"]);
  });

  test("what is set aside is counted and explained, not silently dropped", () => {
    const w = worklist(mixed, allTerms, new Set(), TODAY);
    const psao = w.setAside.find((s) => s.verdict === "psao_files");
    assert.equal(psao?.claims, 1);
    // $89.00: the Blue Eagle fixture's shortfall was raised to clear the $30 filing floor, so that
    // this suite goes on testing batching rather than testing the floor by accident.
    assert.equal(psao?.cents, 8_900);
    assert.ok(w.setAside.some((s) => s.verdict === "not_generic"));
  });

  test("an empty worklist says so plainly", () => {
    const w = worklist([], allTerms, new Set(), TODAY);
    assert.equal(w.says, "No MAC appeals to file.");
    assert.equal(w.totalCents, 0);
  });

  test("filing one removes it from the next run", () => {
    const before = worklist(mixed, allTerms, new Set(), TODAY);
    const after = worklist(mixed, allTerms, new Set(["a", "b"]), TODAY);
    assert.equal(before.totalClaims, 3);
    assert.equal(after.totalClaims, 1);
    assert.equal(after.batches.length, 1, "Caremark's batch is gone entirely");
  });

  test("the headline names the money and the soonest deadline", () => {
    const w = worklist(mixed, allTerms, new Set(), TODAY);
    assert.ok(w.says.includes("3 claims"));
    assert.ok(w.says.includes("CVS Caremark"));
  });
});

/**
 * Whether a MAC list priced the claim at all, which is the question a PBM asks first.
 *
 * Caremark rejected the first appeal this pharmacy ever filed as a "non MAC claim". Rx 333968,
 * amphetamine ER 12.5mg ODT, $192.24 below cost, came back with basis of reimbursement 03 —
 * ingredient cost reduced to AWP less a percentage. No MAC list priced it, so there was no MAC to
 * appeal, and nothing the form could have said would have changed the answer.
 *
 * Every gate written before this one asked whether the claim lost money and whether the pharmacy
 * was allowed to file. None asked the prior question, and the plan had been answering it on every
 * claim in NCPDP field 522-FM all along.
 */
describe("a MAC appeal needs a MAC", () => {
  test("06 and 07 are the MAC bases, and they pass", () => {
    for (const basis of ["06", "07", "6", "7"]) {
      const j = judge(claim({ basisOfReimbursement: basis }), terms(), new Set(), TODAY);
      assert.equal(j.verdict, "appeal", `basis ${basis} should be appealable`);
    }
  });

  test("REGRESSION: basis 03 is AWP less a discount, and is refused", () => {
    // The actual claim, with its actual figures.
    const j = judge(
      claim({ rxNumber: "333968", drugName: "AMPHETAMINE ER 12.5 MG ODT", basisOfReimbursement: "03", pbmName: "CVS Caremark", paidCents: 1_000, acquisitionCents: 20_224 }),
      terms({ pbmName: "CVS Caremark" }),
      new Set(),
      TODAY,
    );
    assert.equal(j.verdict, "not_mac_priced");
    assert.match(j.says, /AWP less a percentage/);
    assert.match(j.says, /non-MAC claim/);
  });

  test("every other benchmark is refused, and named so the refusal can be checked", () => {
    const cases: [string, RegExp][] = [
      ["13", /wholesale acquisition cost/],
      ["09", /acquisition cost pricing/],
      ["08", /contract pricing/],
      ["04", /usual and customary/],
      ["16", /coupon/],
    ];
    for (const [basis, names] of cases) {
      const j = judge(claim({ basisOfReimbursement: basis }), terms(), new Set(), TODAY);
      assert.equal(j.verdict, "not_mac_priced", `basis ${basis}`);
      assert.match(j.says, names, `basis ${basis} should be named in the reason`);
    }
  });

  test("a code nobody has a meaning for is quoted back, not guessed at", () => {
    // Inventing a meaning for an unknown code would be the same fault as the appeal this prevents.
    const j = judge(claim({ basisOfReimbursement: "20" }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "not_mac_priced");
    assert.match(j.says, /basis of reimbursement 20/);
  });

  test("a claim that does not say how it was priced is not appealed", () => {
    const j = judge(claim({ basisOfReimbursement: null }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "not_mac_priced");
    assert.match(j.says, /does not say how the plan priced it/);
  });

  test("the gate is asked before the money, because it settles the claim outright", () => {
    // A non-MAC claim miles below cost is still not a MAC appeal. Were the order the other way
    // round the worklist would show it as appealable and the shortfall would look recoverable.
    const j = judge(claim({ basisOfReimbursement: "13", paidCents: 34, acquisitionCents: 50_000 }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "not_mac_priced");
    assert.equal(j.shortfallCents, 0);
  });

  test("but already-filed still wins, so a rejection is never re-sent", () => {
    const c = claim({ basisOfReimbursement: "03" });
    assert.equal(judge(c, terms(), new Set([c.claimId]), TODAY).verdict, "already_filed");
  });
});

/**
 * Whether a MAC priced it, or the national average did.
 *
 * The owner, before submitting a batch: "is there a way to verify it is a mac claim and not nadac
 * before submitting". There is, and it is independent of the basis code: the basis code is the plan
 * *saying* it used a MAC, while the paid amount is what the money did. A great many MAC lists are
 * built off NADAC, so a plan can return 06 and still have paid the national average — and an appeal
 * asking it to reprice at NADAC a claim already paid at NADAC asks for nothing.
 *
 * Where the two disagree, the money wins.
 */
describe("a MAC below the national average, or the national average itself", () => {
  // 30 units, so paid-per-unit is paidCents / 30.
  const atNadac = (over: Partial<Candidate> = {}) => claim({ paidCents: 3_000, nadacPerUnitCents: 100, ...over });

  test("paid at NADAC is not appealed, whatever the basis code says", () => {
    for (const basis of ["06", "07"]) {
      const j = judge(atNadac({ basisOfReimbursement: basis }), terms(), new Set(), TODAY);
      assert.equal(j.verdict, "paid_at_nadac", `basis ${basis}`);
      assert.match(j.says, /priced this off the national average/);
    }
  });

  test("three percent either way counts as at NADAC, because NADAC moves weekly", () => {
    // A plan pricing off last week's file lands near the figure rather than on it.
    assert.equal(judge(atNadac({ paidCents: 2_940 }), terms(), new Set(), TODAY).verdict, "paid_at_nadac");
    assert.equal(judge(atNadac({ paidCents: 3_060 }), terms(), new Set(), TODAY).verdict, "paid_at_nadac");
    // And outside it does not.
    assert.equal(judge(atNadac({ paidCents: 2_800 }), terms(), new Set(), TODAY).verdict, "appeal");
  });

  test("paid below NADAC is the strong case and carries no caveat", () => {
    const j = judge(claim({ paidCents: 1_500, nadacPerUnitCents: 100 }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
    assert.equal(j.aboveNadac, false);
    assert.doesNotMatch(j.says, /buying gap/);
  });

  test("paid above NADAC is still filable, and says it is the weaker argument", () => {
    /*
     * This is the buying gap, not a MAC underpayment: it asks the PBM to beat the national average
     * on a drug bought above it. Allowed through because the owner may still want it — the ask is
     * then cost plus a dispensing fee — but never silently, because ten verification codes spent on
     * these is ten spent on declines.
     */
    const j = judge(claim({ paidCents: 6_000, acquisitionCents: 12_000, nadacPerUnitCents: 100 }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
    assert.equal(j.aboveNadac, true);
    assert.match(j.says, /buying gap rather than a MAC underpayment/);
    assert.match(j.says, /national average/);
  });

  test("no NADAC for the NDC leaves the claim judged on the basis code alone", () => {
    // Not refused: the generic gate already required NADAC to classify it, so this is the rare NDC
    // priced in one file and not the other, and the basis code is still evidence.
    const j = judge(claim({ nadacPerUnitCents: null }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
    assert.equal(j.aboveNadac, false);
  });

  test("a claim with no quantity cannot be compared, and is not refused for it", () => {
    const j = judge(claim({ quantityThousandths: null }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
  });
});

/**
 * A floor under what is worth filing.
 *
 * The owner, on seeing what a full Caremark run came to: "thats not worth it, rather chase other
 * things wrong with site.. lets set a limit for mac claims (have to lose more than $30)".
 *
 * The arithmetic he was reacting to: of 117 below-NADAC Caremark claims worth $645.74, only 38 could
 * be proved with an invoice, and those came to $95.85 with the largest at $6.78. Every Caremark
 * submission costs a verification code typed by hand, so that is 38 interruptions for two and a half
 * dollars each. He had already declined a $49.71 batch on the same grounds.
 *
 * It is a judgement about his time, not about entitlement — so the money stays counted, and these
 * tests hold that as firmly as they hold the threshold.
 */
describe("too small to be worth filing", () => {
  test("under $30 is not put on the worklist", () => {
    const j = judge(claim({ paidCents: 1_000, acquisitionCents: 3_999 }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "too_small");
    assert.match(j.says, /not more than the \$30\.00 this pharmacy files above/);
  });

  test("$30 exactly is still too small; a penny more is not", () => {
    /*
     * "more than $30": thirty dollars exactly does not clear it, thirty dollars and a cent does.
     * Paid has to be above nought or the earlier `paid_nothing` gate answers first — a deductible
     * claim is not an underpayment however far below cost it looks.
     */
    assert.equal(judge(claim({ paidCents: 100, acquisitionCents: 3_100 }), terms(), new Set(), TODAY).verdict, "too_small");
    assert.equal(judge(claim({ paidCents: 100, acquisitionCents: 3_101 }), terms(), new Set(), TODAY).verdict, "appeal");
  });

  test("the money is still counted, because it is still owed", () => {
    /*
     * The part that must not drift. A $4 underpayment is as wrong as a $40 one and the pharmacy is
     * as entitled to it; what the threshold decides is only whether it goes on a list headed "do
     * this today". A verdict that zeroed the shortfall would quietly write the money off.
     */
    const j = judge(claim({ paidCents: 1_000, acquisitionCents: 3_999 }), terms(), new Set(), TODAY);
    assert.equal(j.shortfallCents, 2_999);
    assert.match(j.says, /Still owed and still counted/);
  });

  test("it is asked after the gates that say the claim is not appealable at all", () => {
    // A brand short by $5 is not_generic, not too_small: "we do not appeal brands" is the truer
    // reason, and a screen explaining the wrong one sends somebody to look at the wrong thing.
    assert.equal(
      judge(claim({ classification: "B", paidCents: 1_000, acquisitionCents: 1_500 }), terms(), new Set(), TODAY).verdict,
      "not_generic",
    );
    assert.equal(
      judge(claim({ basisOfReimbursement: "03", paidCents: 1_000, acquisitionCents: 1_500 }), terms(), new Set(), TODAY).verdict,
      "not_mac_priced",
    );
  });

  test("and before the payer and window gates, which cost nothing to skip", () => {
    // A $2 shortfall on a payer with no agreement read is too_small either way; naming the money
    // is the more useful answer than naming a missing contract.
    const j = judge(claim({ paidCents: 1_000, acquisitionCents: 1_200 }), terms({ whoFiles: null }), new Set(), TODAY);
    assert.equal(j.verdict, "too_small");
  });

  test("a big shortfall still files exactly as before", () => {
    const j = judge(claim({ paidCents: 7_663, acquisitionCents: 16_816 }), terms(), new Set(), TODAY);
    assert.equal(j.verdict, "appeal");
    assert.equal(j.shortfallCents, 9_153);
  });
});
