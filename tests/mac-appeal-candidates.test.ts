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
    claim({ claimId: "a", pbmName: "CVS Caremark", dateFilled: "2026-09-01", paidCents: 5_000, acquisitionCents: 6_000 }),
    claim({ claimId: "b", pbmName: "CVS Caremark", dateFilled: "2026-09-09", paidCents: 1_000, acquisitionCents: 9_000 }),
    claim({ claimId: "c", pbmName: "Express Scripts", paidCents: 7_663, acquisitionCents: 16_816 }),
    claim({ claimId: "d", pbmName: "Blue Eagle Health", paidCents: 100, acquisitionCents: 5_000 }),
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
    assert.equal(psao?.cents, 4_900);
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
