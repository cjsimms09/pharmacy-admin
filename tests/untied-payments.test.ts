import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CAUSES, cancellingPairs, causeInfo, classifyUntied, claimBesideSays, groupsSay, hasWaitingPartner, namesSays, needsPhrase, needsSays, partnerSays, sourceSays, sourceToDo, takeBacksWithPartner, tallyByNeeds, tallyUntied, tiedSays, unattachedSays, unattachedTail, untiedCardRow, untiedHeadline, type ClaimBeside, type TallyRow, type UntiedCause, type UntiedPayment } from "../src/lib/untied-payments";
import type { ClaimOnFile } from "../src/lib/match-remittance";

/*
 * Why a payment is tied to no claim. Every identifier and figure here is invented. What is pinned is the order the reasons are
 * given in, because the first that applies is the one a person is told.
 */
const FEED = "2026-09-01";
const pay = (o: Partial<UntiedPayment> = {}): UntiedPayment => ({
  id: "p", source: "plan", payer: "Invented Plan", receivedOn: "2026-09-20", amountCents: 1_000, rxNumber: "900801", fillNumber: 1, dateFilled: "2026-09-10", ndc11: "00000000001", reference: "EFT-INVENTED", ...o,
});
const held = (id: string, status: "paid" | "reversed", dateFilled: string, o: Partial<ClaimOnFile> = {}): ClaimOnFile => ({
  id, status, fillNumber: 1, dateFilled, ndc11: "00000000001", bin: "610011", remitCents: 1_000, soldOn: null, ...o,
});
const why = (p: UntiedPayment, onFile: ClaimOnFile[], fromProgramme = false, feedFrom: string | null = FEED) => classifyUntied(p, onFile, feedFrom, fromProgramme);

describe("a fill from before the claims feed", () => {
  test("is that where the site holds no claim for the fill, whatever else it holds for the prescription", () => {
    const early = pay({ dateFilled: "2026-08-14" });
    assert.deepEqual(why(early, []), { cause: "before_feed", claimIds: [] });
    assert.deepEqual(why(early, [held("refill", "paid", "2026-09-10", { fillNumber: 2 })]), { cause: "before_feed", claimIds: [] });
    assert.deepEqual(why(early, [held("older", "reversed", "2026-07-10", { fillNumber: 0 })]), { cause: "before_feed", claimIds: [] });
  });

  test("is read by its claim where one for the fill came in a later report", () => {
    const early = pay({ dateFilled: "2026-08-14" });
    assert.deepEqual(why(early, [held("a", "paid", "2026-08-14")]), { cause: "will_attach", claimIds: ["a"] });
    assert.deepEqual(why(early, [held("r", "reversed", "2026-08-14")]), { cause: "reversed_not_sold", claimIds: ["r"] });
    assert.deepEqual(why(early, [held("r", "reversed", "2026-08-14", { soldOn: "2026-08-20" })]), { cause: "reversed_sold", claimIds: ["r"] });
    const two = [held("a", "paid", "2026-08-14", { bin: "610011", remitCents: 500 }), held("b", "paid", "2026-08-14", { bin: "004336", remitCents: 700 })];
    assert.deepEqual(why(early, two), { cause: "fits_several", claimIds: ["a", "b"] });
  });

  test("a reversed claim for the fill beside a paid claim for another is still a reversed claim for the fill", () => {
    const early = pay({ dateFilled: "2026-08-14" });
    assert.deepEqual(why(early, [held("r", "reversed", "2026-08-14"), held("refill", "paid", "2026-09-10", { fillNumber: 2 })]), { cause: "reversed_not_sold", claimIds: ["r"] });
  });

  test("needs a fill date: a payment with none is not for a fill from before the feed", () => {
    assert.equal(why(pay({ dateFilled: null }), []).cause, "no_claim_yet");
  });

  test("needs a feed: where no claims have been loaded, nothing is from before it", () => {
    assert.equal(why(pay({ dateFilled: "2026-08-14" }), [], false, null).cause, "no_claim_yet");
  });
});

describe("a fill inside the feed", () => {
  test("a prescription the site holds no claim for", () => {
    assert.deepEqual(why(pay(), []), { cause: "no_claim_yet", claimIds: [] });
  });

  test("a line naming no drug and no fill, for a prescription the site holds no claim for, is not a fill at all", () => {
    assert.deepEqual(why(pay({ ndc11: null, fillNumber: null, dateFilled: "2026-12-31" }), []), { cause: "not_a_fill", claimIds: [] });
  });

  test("the same line for a prescription the site does hold claims for is read by those claims, as the drug-and-fill line is", () => {
    const bare = pay({ ndc11: null, fillNumber: null, dateFilled: "2026-09-10" });
    assert.deepEqual(why(bare, [held("r", "reversed", "2026-09-10")]), { cause: "reversed_not_sold", claimIds: ["r"] });
    assert.deepEqual(why(bare, [held("r", "reversed", "2026-09-10", { soldOn: "2026-09-10" })]), { cause: "reversed_sold", claimIds: ["r"] });
    const two = [held("a", "paid", "2026-09-10", { bin: "610011", remitCents: 500 }), held("b", "paid", "2026-09-10", { bin: "004336", remitCents: 700 })];
    assert.deepEqual(why(bare, two), { cause: "fits_several", claimIds: ["a", "b"] });
    assert.deepEqual(why({ ...bare, dateFilled: "2026-12-31" }, [held("a", "paid", "2026-09-10")]), { cause: "other_fills_only", claimIds: ["a"] });
  });

  test("but where the matcher would attach it anyway, that is what is said", () => {
    const bare = pay({ ndc11: null, fillNumber: null, dateFilled: "2026-09-10" });
    assert.deepEqual(why(bare, [held("a", "paid", "2026-09-10")]), { cause: "will_attach", claimIds: ["a"] });
  });

  test("a paid claim it fits: it attaches at the next load", () => {
    assert.deepEqual(why(pay(), [held("a", "paid", "2026-09-10")]), { cause: "will_attach", claimIds: ["a"] });
  });

  test("two paid claims fitting equally: it fits several, and both are named", () => {
    const two = [held("a", "paid", "2026-09-10", { bin: "610011", remitCents: 500 }), held("b", "paid", "2026-09-10", { bin: "004336", remitCents: 700 })];
    assert.deepEqual(why(pay(), two), { cause: "fits_several", claimIds: ["a", "b"] });
  });

  test("a voucher programme's payment is put to the one claim carrying a voucher, as attaching it would", () => {
    const two = [held("plan", "paid", "2026-09-10", { remitCents: 500 }), held("voucher", "paid", "2026-09-10", { remitCents: 700, carriesVoucher: true })];
    assert.equal(why(pay(), two).cause, "fits_several");
    assert.deepEqual(why(pay(), two, true), { cause: "will_attach", claimIds: ["voucher"] });
  });

  test("a reversed claim for the fill and nothing paid: nothing sold, or sold", () => {
    assert.deepEqual(why(pay(), [held("r", "reversed", "2026-09-10")]), { cause: "reversed_not_sold", claimIds: ["r"] });
    assert.deepEqual(why(pay(), [held("r", "reversed", "2026-09-10", { soldOn: "2026-09-10" })]), { cause: "reversed_sold", claimIds: ["r"] });
  });

  test("a reversed claim for the fill beside a paid claim for another fill is still a reversed claim", () => {
    const v = why(pay(), [held("r", "reversed", "2026-09-10"), held("refill", "paid", "2026-10-10", { fillNumber: 2 })]);
    assert.deepEqual(v, { cause: "reversed_not_sold", claimIds: ["r"] });
  });

  test("claims for other fills only, paid or reversed", () => {
    assert.deepEqual(why(pay(), [held("refill", "paid", "2026-10-10", { fillNumber: 2 })]), { cause: "other_fills_only", claimIds: ["refill"] });
    assert.deepEqual(why(pay(), [held("old", "reversed", "2026-08-10", { fillNumber: 0 })]), { cause: "other_fills_only", claimIds: ["old"] });
  });
});

describe("the count by cause", () => {
  const list = [
    { cause: "before_feed" as const, amountCents: 700 },
    { cause: "fits_several" as const, amountCents: 1_000 },
    { cause: "fits_several" as const, amountCents: -1_500 },
    { cause: "before_feed" as const, amountCents: 50 },
  ];

  test("is in the order a person should read it, and has only the causes that occur", () => {
    assert.deepEqual(tallyUntied(list), [
      { cause: "fits_several", count: 2, cents: -500 },
      { cause: "before_feed", count: 2, cents: 750 },
    ]);
    assert.deepEqual(tallyUntied([]), []);
  });

  test("puts every payment in exactly one row: the rows add back to the whole", () => {
    const rows = tallyUntied(list);
    assert.equal(rows.reduce((n, r) => n + r.count, 0), list.length);
    assert.equal(rows.reduce((n, r) => n + r.cents, 0), list.reduce((n, p) => n + p.amountCents, 0));
  });
});

describe("what each cause says", () => {
  test("every cause has a label, what it asks, and why, and none calls anything missing", () => {
    for (const c of CAUSES) {
      const i = causeInfo(c, FEED);
      for (const text of [i.label, i.asks, i.why, i.short[0], i.short[1]]) {
        assert.ok(text.trim().length > 0, `${c} has words`);
        assert.doesNotMatch(text, /\bmissing\b/i, `${c} is a state, not a missing thing`);
      }
      assert.ok(needsSays(i.needs).length > 0);
    }
  });

  test("the feed's first day is said in the words that depend on it", () => {
    assert.match(causeInfo("before_feed", FEED).label, /Sep 1, 2026/);
    assert.match(causeInfo("no_claim_yet", FEED).why, /Sep 1, 2026/);
    assert.match(causeInfo("no_claim_yet", null).why, /first day of the claims feed/);
  });

  test("a sale date is a sale date, not a claim that it was picked up, and the site says it cannot tell", () => {
    const i = causeInfo("reversed_sold", FEED);
    assert.match(i.why, /carries a sale date/);
    assert.match(i.why, /^Every claim the site holds for this fill was reversed/);
    assert.match(i.why, /cannot tell which/);
    assert.equal(i.needs, "decide");
  });

  test("what needs a decision and what needs nothing", () => {
    assert.deepEqual(CAUSES.filter((c) => causeInfo(c, FEED).needs === "decide"), ["fits_several", "reversed_sold"]);
    assert.deepEqual(CAUSES.filter((c) => causeInfo(c, FEED).needs === "nothing"), ["reversed_not_sold", "cancels_out", "before_feed"]);
  });

  test("a pair that cancels asks nothing of anyone, and says why the site ties neither to a claim", () => {
    const i = causeInfo("cancels_out", FEED);
    assert.equal(i.needs, "nothing");
    assert.match(i.asks, /^Nothing/);
    assert.match(i.why, /together they move no claim's balance/);
    assert.match(i.why, /does not tie them to a claim they fit/);
  });
});

describe("payments that cancel one another", () => {
  const cand = (id: string, amountCents: number, o: Partial<UntiedPayment> & { cause?: UntiedCause } = {}) => ({ ...pay({ id, amountCents }), cause: "fits_several" as UntiedCause, ...o });
  const partners = (list: ReturnType<typeof cand>[]) => [...cancellingPairs(list)].sort();

  test("a payment and a take-back of exactly its amount for one fill are each other's partner, whichever arrived first", () => {
    assert.deepEqual(partners([cand("a", 1_080, { receivedOn: "2026-09-20" }), cand("b", -1_080, { receivedOn: "2026-09-27" })]), [["a", "b"], ["b", "a"]]);
    assert.deepEqual(partners([cand("a", 1_080, { receivedOn: "2026-09-27" }), cand("b", -1_080, { receivedOn: "2026-09-20" })]), [["a", "b"], ["b", "a"]]);
  });

  test("anything that makes them two fills, two payers or two amounts makes them no pair", () => {
    const apart: Partial<UntiedPayment>[] = [{ rxNumber: "900802" }, { fillNumber: 2 }, { dateFilled: "2026-09-11" }, { ndc11: "00000000002" }, { source: "mtf" }, { payer: "Another Plan" }, { amountCents: -1_079 }];
    for (const o of apart) assert.equal(cancellingPairs([cand("a", 1_080), cand("b", -1_080, o)]).size, 0, JSON.stringify(o));
  });

  test("two payments of one sign are no pair, and a lone payment is none", () => {
    assert.equal(cancellingPairs([cand("a", 1_080), cand("b", 1_080)]).size, 0);
    assert.equal(cancellingPairs([cand("a", -1_080), cand("b", -1_080)]).size, 0);
    assert.equal(cancellingPairs([cand("a", 1_080)]).size, 0);
    assert.equal(cancellingPairs([]).size, 0);
  });

  test("only a payment tied to no claim for a fill it names can be cancelled: one that will attach, one from before the feed and one naming no fill are already said where they belong", () => {
    for (const cause of ["will_attach", "before_feed", "not_a_fill"] as const) {
      assert.equal(cancellingPairs([cand("a", 1_080, { cause }), cand("b", -1_080, { cause })]).size, 0, cause);
    }
    for (const cause of ["fits_several", "reversed_sold", "no_claim_yet", "other_fills_only", "reversed_not_sold"] as const) {
      assert.equal(cancellingPairs([cand("a", 1_080, { cause }), cand("b", -1_080, { cause })]).size, 2, cause);
    }
    assert.equal(cancellingPairs([cand("a", 1_080, { cause: "will_attach" }), cand("b", -1_080)]).size, 0, "the half that will attach settles its claim, and is no partner");
  });

  test("a line that names neither a fill number nor a fill date is never paired: the drug alone does not tell two refills apart", () => {
    assert.equal(cancellingPairs([cand("a", 1_080, { fillNumber: null, dateFilled: null }), cand("b", -1_080, { fillNumber: null, dateFilled: null })]).size, 0);
    assert.equal(cancellingPairs([cand("a", 1_080, { fillNumber: null }), cand("b", -1_080, { fillNumber: null })]).size, 2);
    assert.equal(cancellingPairs([cand("a", 1_080, { dateFilled: null }), cand("b", -1_080, { dateFilled: null })]).size, 2);
  });

  test("a payment of nothing is neither a payment nor a take-back", () => {
    assert.equal(cancellingPairs([cand("a", 0), cand("b", 0)]).size, 0);
  });

  test("each take-back cancels one payment, the oldest first: three payments and one take-back leave two", () => {
    const list = [
      cand("p3", 1_000, { receivedOn: "2026-09-20" }),
      cand("t1", -1_000, { receivedOn: "2026-09-25" }),
      cand("p1", 1_000, { receivedOn: "2026-09-01" }),
      cand("p2", 1_000, { receivedOn: "2026-09-10" }),
    ];
    assert.deepEqual(partners(list), [["p1", "t1"], ["t1", "p1"]]);
    assert.deepEqual(partners([...list].reverse()), partners(list), "the order they are given in changes nothing");
    assert.deepEqual(partners([...list, cand("t2", -1_000, { receivedOn: "2026-09-26" })]), [["p1", "t1"], ["p2", "t2"], ["t1", "p1"], ["t2", "p2"]]);
  });

  test("a payment of another fill does not stand in the way of the pair beside it", () => {
    const list = [cand("a", 1_080), cand("other", 1_080, { fillNumber: 2 }), cand("b", -1_080)];
    assert.deepEqual(partners(list), [["a", "b"], ["b", "a"]]);
  });
});

describe("a take-back is read by what is tied to the claims beside it", () => {
  const takes = pay({ id: "tb", amountCents: -4_150, receivedOn: "2026-10-02" });
  const claims = (tiedToA: { amountCents: number; source: string }[]): ClaimOnFile[] => [
    held("a", "paid", "2026-09-10", { bin: "610011", remitCents: 4_150, tied: tiedToA }),
    held("b", "paid", "2026-09-10", { bin: "004336", remitCents: 1_900, tied: [] }),
  ];
  const planPaid = { amountCents: 4_150, source: "plan" };

  test("one that takes back the whole of a claim's remit, paid to it, will attach to it", () => {
    assert.deepEqual(why(takes, claims([planPaid, planPaid])), { cause: "will_attach", claimIds: ["a"] });
  });

  test("one that no claim was paid is one of several, and names both claims", () => {
    assert.deepEqual(why(takes, claims([])), { cause: "fits_several", claimIds: ["a", "b"] });
    assert.deepEqual(why(takes, claims([{ amountCents: 4_150, source: "secondary" }])), { cause: "fits_several", claimIds: ["a", "b"] });
  });

  test("with its own payment waiting beside it, it is one of several, so that the two can cancel", () => {
    assert.deepEqual(classifyUntied(takes, claims([planPaid]), FEED, false, true), { cause: "fits_several", claimIds: ["a", "b"] });
    assert.deepEqual(classifyUntied(takes, claims([planPaid]), FEED, false, false), { cause: "will_attach", claimIds: ["a"] });
  });

  const cand = (id: string, amountCents: number, o: Partial<UntiedPayment> & { cause?: UntiedCause } = {}) => ({ ...pay({ id, amountCents }), cause: "fits_several" as UntiedCause, ...o });

  test("a take-back has a payment of its own waiting where one of the opposite amount for the fill is tied to no claim and not about to attach", () => {
    assert.deepEqual([...takeBacksWithPartner([cand("p", 4_150), cand("t", -4_150, { cause: "will_attach" })])], ["t"]);
    assert.deepEqual([...takeBacksWithPartner([cand("p", 4_150, { cause: "reversed_sold" }), cand("t", -4_150)])], ["t"]);
    assert.equal(takeBacksWithPartner([cand("p", 4_150, { cause: "will_attach" }), cand("t", -4_150)]).size, 0, "a payment about to attach is not waiting");
    assert.equal(takeBacksWithPartner([cand("p", 4_150, { cause: "before_feed" }), cand("t", -4_150)]).size, 0);
  });

  test("anything that makes them two fills, two payers, two sources or two amounts leaves it with none", () => {
    const apart: Partial<UntiedPayment>[] = [{ rxNumber: "900802" }, { fillNumber: 2 }, { dateFilled: "2026-09-11" }, { ndc11: "00000000002" }, { source: "mtf" }, { payer: "Another Plan" }, { amountCents: -4_149 }];
    for (const o of apart) assert.equal(takeBacksWithPartner([cand("p", 4_150), cand("t", -4_150, o)]).size, 0, JSON.stringify(o));
    assert.equal(takeBacksWithPartner([cand("p", 4_150, { fillNumber: null, dateFilled: null }), cand("t", -4_150, { fillNumber: null, dateFilled: null })]).size, 0, "a line naming no fill is never paired");
  });

  test("a payment, and a payment beside a payment, is not a take-back", () => {
    assert.equal(takeBacksWithPartner([cand("p", 4_150), cand("q", 4_150)]).size, 0);
  });

  test("the matcher reads the same payments from the table: tied to no claim, positive, for the fill", () => {
    const own = { source: "plan", payer: "Invented Plan", amountCents: -4_150, rxNumber: "900801", fillNumber: 1, dateFilled: "2026-09-10", ndc11: "00000000001" };
    const sibling = { ...own, amountCents: 4_150 };
    assert.equal(hasWaitingPartner(own, [sibling]), true);
    assert.equal(hasWaitingPartner(own, []), false);
    assert.equal(hasWaitingPartner(own, [{ ...sibling, amountCents: 4_000 }, { ...sibling, source: "mtf" }, { ...sibling, fillNumber: 2 }]), false);
    assert.equal(hasWaitingPartner(sibling, [sibling]), false, "only a take-back has a payment to cancel");
  });
});

describe("the facilitator's refund is read by the refund each claim promised", () => {
  /* The Medicare Transaction Facilitator pays no remit. A fill billed to a Part D plan and then to the Medicare Prescription Payment Plan is two claims, and the refund is the first one's. */
  const refund = 6_235;
  const refunds = pay({ id: "mtf", source: "mtf", payer: "Medicare Transaction Facilitator", amountCents: refund });
  const claims = (promisedA: number | null, promisedB: number | null): ClaimOnFile[] => [
    held("a", "paid", "2026-09-10", { bin: "610011", remitCents: 14_800, facilitatorCents: promisedA }),
    held("b", "paid", "2026-09-10", { bin: "004336", remitCents: 2_100, facilitatorCents: promisedB }),
  ];

  test("one that is exactly what one of two claims promised will attach to that claim, and names it", () => {
    assert.deepEqual(why(refunds, claims(refund, 0)), { cause: "will_attach", claimIds: ["a"] });
    assert.deepEqual(why(refunds, claims(0, refund)), { cause: "will_attach", claimIds: ["b"] });
  });

  test("two claims that promised it, or neither, or no figure at all, leave it one of several", () => {
    assert.deepEqual(why(refunds, claims(refund, refund)), { cause: "fits_several", claimIds: ["a", "b"] });
    assert.deepEqual(why(refunds, claims(7_000, 0)), { cause: "fits_several", claimIds: ["a", "b"] });
    assert.deepEqual(why(refunds, claims(null, null)), { cause: "fits_several", claimIds: ["a", "b"] });
  });

  test("a plan's payment of that figure is read by the remits, and what a claim promised the facilitator is no part of it", () => {
    assert.deepEqual(why({ ...refunds, source: "plan" }, claims(refund, 0)), { cause: "fits_several", claimIds: ["a", "b"] });
    assert.deepEqual(why({ ...refunds, source: "plan", amountCents: 2_100 }, claims(refund, 0)), { cause: "will_attach", claimIds: ["b"] });
  });

  test("a refund the facilitator takes back will attach to the claim it refunded, once that refund is tied to it", () => {
    const back = { ...refunds, id: "mtf-back", amountCents: -refund };
    const refunded = (tied: { amountCents: number; source: string }[]) => [{ ...claims(refund, 0)[0], tied }, { ...claims(refund, 0)[1], tied: [] }];
    assert.deepEqual(why(back, refunded([{ amountCents: refund, source: "mtf" }])), { cause: "will_attach", claimIds: ["a"] });
    assert.deepEqual(why(back, refunded([{ amountCents: refund, source: "plan" }])), { cause: "fits_several", claimIds: ["a", "b"] });
    assert.deepEqual(why(back, refunded([])), { cause: "fits_several", claimIds: ["a", "b"] });
  });
});

describe("what a line says of the payment that cancels it", () => {
  test("a take-back says whom it takes back, and a payment says that it was taken back, each with the date the other was received", () => {
    assert.equal(partnerSays({ amountCents: -1_080 }, { id: "a", amountCents: 1_080, receivedOn: "2026-09-20" }), "Takes back in full the $10.80 received Sep 20, 2026.");
    assert.equal(partnerSays({ amountCents: 1_080 }, { id: "b", amountCents: -1_080, receivedOn: "2026-09-27" }), "Taken back in full: -$10.80 received Sep 27, 2026.");
  });

  test("says it plainly where the other has no received date", () => {
    assert.equal(partnerSays({ amountCents: 1_080 }, { id: "b", amountCents: -1_080, receivedOn: null }), "Taken back in full: -$10.80 with no received date.");
  });
});

describe("the one sentence", () => {
  const rows: TallyRow[] = [
    { cause: "fits_several", count: 2, cents: -500 },
    { cause: "not_a_fill", count: 1, cents: 300 },
    { cause: "before_feed", count: 40, cents: 1_234_567 },
  ];

  test("leads with the payments that can matter, each figure beside what it is, and puts the fills from before the feed after", () => {
    assert.equal(
      untiedHeadline(rows, FEED, FEED),
      "3 payments received since Sep 1, 2026 (net -$2.00) are tied to no claim: 2 payments (net -$5.00) that fit two or more claims equally; " +
        "1 payment ($3.00) that names no drug and no fill. A further 40 payments (net $12,345.67) are for fills from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.",
    );
  });

  test("agrees with itself for one payment of each kind", () => {
    assert.equal(
      untiedHeadline([{ cause: "not_a_fill", count: 1, cents: 300 }, { cause: "before_feed", count: 1, cents: 450 }], FEED, FEED),
      "1 payment received since Sep 1, 2026 ($3.00) is tied to no claim: 1 payment ($3.00) that names no drug and no fill. " +
        "A further 1 payment ($4.50) is for a fill from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.",
    );
  });

  test("where only fills from before the feed are tied to nothing, says that every other one is tied", () => {
    assert.equal(
      untiedHeadline([{ cause: "before_feed", count: 2, cents: 900 }], FEED, FEED),
      "Every payment received since Sep 1, 2026 is tied to a claim, except 2 payments (net $9.00) for fills from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.",
    );
    assert.equal(
      untiedHeadline([{ cause: "before_feed", count: 1, cents: 450 }], FEED, FEED),
      "Every payment received since Sep 1, 2026 is tied to a claim, except 1 payment ($4.50) for a fill from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.",
    );
  });

  test("says so when every payment is tied", () => {
    assert.equal(untiedHeadline([], FEED, FEED), "Every payment received since Sep 1, 2026 is tied to a claim.");
  });
});

describe("the groups of a person's attention", () => {
  const rows: TallyRow[] = [
    { cause: "reversed_not_sold", count: 179, cents: 459_821 },
    { cause: "fits_several", count: 23, cents: -16_384 },
    { cause: "reversed_sold", count: 10, cents: 218_131 },
    { cause: "not_a_fill", count: 12, cents: 11_000 },
    { cause: "will_attach", count: 3, cents: 900 },
    { cause: "before_feed", count: 3_597, cents: 38_722_277 },
  ];

  test("are counted from the ones that need a decision to the ones that need nothing, and leave out the fills from before the feed", () => {
    assert.deepEqual(tallyByNeeds(rows), [
      { needs: "decide", count: 33, cents: 201_747 },
      { needs: "look", count: 12, cents: 11_000 },
      { needs: "wait", count: 3, cents: 900 },
      { needs: "nothing", count: 179, cents: 459_821 },
    ]);
  });

  test("leave out a group nothing is in, and add up to the payments that are not from before the feed", () => {
    assert.deepEqual(tallyByNeeds([{ cause: "not_a_fill", count: 2, cents: 300 }, { cause: "before_feed", count: 9, cents: 9_999 }]), [{ needs: "look", count: 2, cents: 300 }]);
    assert.deepEqual(tallyByNeeds([{ cause: "before_feed", count: 9, cents: 9_999 }]), []);
    assert.equal(tallyByNeeds(rows).reduce((n, r) => n + r.count, 0), rows.filter((r) => r.cause !== "before_feed").reduce((n, r) => n + r.count, 0));
  });

  test("a pair that cancels is counted with the others that need nothing", () => {
    assert.deepEqual(tallyByNeeds([{ cause: "cancels_out", count: 18, cents: 0 }, { cause: "reversed_not_sold", count: 31, cents: 100 }]), [{ needs: "nothing", count: 49, cents: 100 }]);
  });

  test("are said in a line a person can read at a glance", () => {
    assert.equal(needsPhrase(tallyByNeeds(rows)), "33 need a decision, 12 are worth a look, 3 will attach at the next claims load, 179 need nothing");
    assert.equal(
      needsPhrase([{ needs: "decide", count: 1, cents: 5 }, { needs: "look", count: 1, cents: 5 }, { needs: "nothing", count: 1, cents: 5 }]),
      "1 needs a decision, 1 is worth a look, 1 needs nothing",
    );
    assert.equal(needsPhrase([]), "");
  });
});

describe("who paid, in the site's own words", () => {
  test("every source the site files a payment under has words, and one it does not know is shown as stored", () => {
    for (const s of ["plan", "mtf", "copay_card", "rxrescue", "dir", "secondary", "manual"]) assert.notEqual(sourceSays(s), s);
    assert.equal(sourceSays("mtf"), "Medicare Transaction Facilitator");
    assert.equal(sourceSays("a_new_one"), "a_new_one");
  });
});

describe("what a line says of itself and of the claims beside it", () => {
  test("says what a payment does not name, in words, and never as a bare dash", () => {
    assert.equal(namesSays(pay({ fillNumber: 2, dateFilled: "2026-09-10", ndc11: "00000000001" })), "fill 2 · Sep 10, 2026 · NDC 00000000001");
    assert.equal(namesSays(pay({ fillNumber: null, dateFilled: null, ndc11: null })), "no fill number · no fill date · no drug");
    assert.equal(namesSays(pay({ fillNumber: 0, ndc11: null })), "fill 0 · Sep 10, 2026 · no drug");
  });

  const claim = (o: Partial<ClaimBeside> = {}): ClaimBeside => ({ id: "c", payerLabel: "Invented Plan", itemName: "Invented Drug", status: "paid", fillNumber: 1, dateFilled: "2026-09-10", remitCents: 4_250, soldOn: null, ...o });

  test("names the payer first and then what tells the claim from its twin", () => {
    assert.deepEqual(claimBesideSays(claim()), { who: "Invented Plan", rest: "Invented Drug · fill 1, Sep 10, 2026 · paid · claim amount $42.50" });
  });

  test("says a reversal with and without a sale date, and what the claim does not carry", () => {
    assert.equal(claimBesideSays(claim({ status: "reversed", soldOn: "2026-09-11", remitCents: -4_250 })).rest, "Invented Drug · fill 1, Sep 10, 2026 · reversed, sale date Sep 11, 2026 · claim amount -$42.50");
    assert.equal(claimBesideSays(claim({ status: "reversed" })).rest.includes("reversed, no sale date"), true);
    assert.deepEqual(claimBesideSays(claim({ payerLabel: null, itemName: null, fillNumber: null, remitCents: null })), {
      who: "no payer name",
      rest: "no drug name · no fill number, Sep 10, 2026 · paid · no amount on the claim",
    });
  });
});

describe("the line the Claims page shows", () => {
  const rows: TallyRow[] = [
    { cause: "fits_several", count: 23, cents: -16_384 },
    { cause: "reversed_sold", count: 10, cents: 218_131 },
    { cause: "not_a_fill", count: 12, cents: 11_000 },
    { cause: "reversed_not_sold", count: 179, cents: 459_821 },
    { cause: "before_feed", count: 3_597, cents: 38_722_277 },
  ];

  test("says the money and the count, what each group asks of a person, and the fills from before the feed in the same sentence", () => {
    const r = untiedCardRow(rows, "2026-09-01", FEED)!;
    assert.equal(r.amount, "net $6,725.68");
    assert.equal(r.tone, "warn");
    assert.equal(
      r.title,
      "is tied to no claim — 224 payments received since Sep 1, 2026: 33 need a decision, 12 are worth a look, 179 need nothing; a further 3,597 (net $387,222.77) are for fills from before the claims feed began, which the site holds no claim for",
    );
    assert.equal(r.why, untiedHeadline(rows, "2026-09-01", FEED));
  });

  test("the amount is the money of the groups the sentence counts, to the cent, and the fills from before the feed are not in it", () => {
    const r = untiedCardRow(rows, "2026-09-01", FEED)!;
    const rest = rows.filter((x) => x.cause !== "before_feed");
    assert.equal(r.amount, `net $${(rest.reduce((n, x) => n + x.cents, 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
    assert.match(r.title, new RegExp(`${rest.reduce((n, x) => n + x.count, 0)} payments received`));
  });

  test("is an amber line only where something is for a person to decide or to look at", () => {
    assert.equal(untiedCardRow([{ cause: "reversed_not_sold", count: 4, cents: 8_000 }], "2026-09-01", FEED)!.tone, "ok");
    assert.equal(untiedCardRow([{ cause: "will_attach", count: 4, cents: 8_000 }], "2026-09-01", FEED)!.tone, "ok");
    assert.equal(untiedCardRow([{ cause: "other_fills_only", count: 1, cents: 800 }], "2026-09-01", FEED)!.tone, "warn");
    assert.equal(untiedCardRow([{ cause: "fits_several", count: 1, cents: 800 }], "2026-09-01", FEED)!.tone, "warn");
  });

  test("one payment is said as one payment, without 'net'", () => {
    const r = untiedCardRow([{ cause: "not_a_fill", count: 1, cents: 1_000 }], "2026-09-01", FEED)!;
    assert.equal(r.amount, "$10.00");
    assert.equal(r.title, "is tied to no claim — 1 payment received since Sep 1, 2026: 1 is worth a look");
  });

  test("where all of it is for fills from before the feed, says so and asks for nothing", () => {
    const r = untiedCardRow([{ cause: "before_feed", count: 2, cents: 5_000 }], "2026-09-01", FEED)!;
    assert.equal(r.tone, "ok");
    assert.equal(r.amount, "net $50.00");
    assert.equal(r.title, "is tied to no claim — 2 payments received since Sep 1, 2026, all for fills from before the claims feed began, which the site holds no claim for");
  });

  test("is no line at all where every payment is tied", () => {
    assert.equal(untiedCardRow([], "2026-09-01", FEED), null);
  });
});

describe("one source's payments, said on the money list", () => {
  test("how many are tied to the claim each paid, in the words of a count", () => {
    assert.equal(tiedSays(0, 0), "");
    assert.equal(tiedSays(1, 1), "Its one payment is tied to the claim it paid.");
    assert.equal(tiedSays(3_000, 3_000), "All 3,000 of its payments are tied to the claim each paid.");
    assert.equal(tiedSays(0, 1), "Its one payment is tied to no claim.");
    assert.equal(tiedSays(0, 4), "None of its 4 payments is tied to a claim.");
    assert.equal(tiedSays(1, 5), "1 of its 5 payments is tied to the claim it paid.");
    assert.equal(tiedSays(12, 33), "12 of its 33 payments are tied to the claim each paid.");
  });

  test("nothing is said where nothing is tied to none", () => {
    assert.equal(sourceToDo([], FEED), "");
  });

  test("each group is worded as the page words it, in the page's order whatever order it was given, then what it asks", () => {
    const rows: TallyRow[] = [
      { cause: "before_feed", count: 7, cents: 81_240 },
      { cause: "fits_several", count: 2, cents: 9_310 },
    ];
    assert.equal(
      sourceToDo(rows, FEED),
      "2 payments (net $93.10) that fit two or more claims equally. Attach each to the claim it paid. The site has no way to do that by hand yet. " +
        "7 payments (net $812.40) for fills from before the claims feed begins on Sep 1, 2026, which the site holds no claim for. Needs nothing.",
    );
  });

  test("where no group asks anything, says so once, first, and asks nothing of each", () => {
    assert.equal(
      sourceToDo([{ cause: "before_feed", count: 1, cents: 4_000 }], FEED),
      "Nothing to do. 1 payment ($40.00) for a fill from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.",
    );
    assert.equal(
      sourceToDo([{ cause: "reversed_not_sold", count: 3, cents: 6_000 }, { cause: "before_feed", count: 1, cents: 4_000 }], FEED),
      "Nothing to do. 3 payments (net $60.00) on claims that were reversed, none carrying a sale date. " +
        "1 payment ($40.00) for a fill from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.",
    );
  });

  test("a group that only waits is not said as nothing to do: it says it clears by itself", () => {
    assert.equal(sourceToDo([{ cause: "will_attach", count: 1, cents: 1_000 }], FEED), "1 payment ($10.00) whose claim is on file now. Nothing. It attaches by itself at the next claims load.");
  });

  test("none of it tells a person to load days: for no cause is that a thing that can be done", () => {
    for (const cause of CAUSES) assert.doesNotMatch(sourceToDo([{ cause, count: 2, cents: 100 }], FEED), /load the days/i, cause);
  });
});

describe("what the balance screens say of the payments tied to no claim", () => {
  const total = (rows: TallyRow[]) => ({ count: rows.reduce((n, r) => n + r.count, 0), cents: rows.reduce((n, r) => n + r.cents, 0) });
  const mixed: TallyRow[] = [
    { cause: "before_feed", count: 7, cents: 81_240 },
    { cause: "fits_several", count: 2, cents: 9_310 },
    { cause: "reversed_not_sold", count: 1, cents: -240 },
  ];

  test("says nothing where nothing is tied to none", () => {
    assert.equal(unattachedSays({ count: 0, cents: 0 }, [], FEED, FEED), "");
    assert.equal(unattachedTail({ count: 0, cents: 0 }, [], FEED), "");
  });

  test("says that none of it is in any payer's balance, and why, group by group in the page's order, with the one thing that can leave a claim showing too much", () => {
    assert.equal(
      unattachedSays(total(mixed), mixed, FEED, FEED),
      "10 payments (net $903.10) received since Sep 1, 2026 are tied to no claim, so they are in no payer's balance: " +
        "2 payments (net $93.10) that fit two or more claims equally; 1 payment (-$2.40) on claims that were reversed, none carrying a sale date; " +
        "7 payments (net $812.40) for fills from before the claims feed begins on Sep 1, 2026, which the site holds no claim for. " +
        "Until each payment that fits claims on file is attached, the claims it could settle show a balance without it.",
    );
  });

  test("words each group as the Claims page does, so that no two screens can say it differently", () => {
    for (const cause of CAUSES) {
      const one: TallyRow[] = [{ cause, count: 2, cents: 2_000 }];
      assert.ok(unattachedSays(total(one), one, FEED, FEED).includes(causeInfo(cause, FEED).short[1]), cause);
    }
  });

  test("a payment that leaves a claim showing a balance without it is the only reason to say so", () => {
    for (const cause of CAUSES) {
      const one: TallyRow[] = [{ cause, count: 1, cents: 1_000 }];
      const leaves = cause === "fits_several" || cause === "will_attach";
      assert.equal(/show a balance without it/.test(unattachedSays(total(one), one, FEED, FEED)), leaves, cause);
    }
  });

  test("where the reasons are not known, says only what is: it is tied to no claim and in no balance", () => {
    assert.equal(unattachedSays({ count: 5, cents: 580_833 }, null, FEED, FEED), "5 payments (net $5,808.33) received since Sep 1, 2026 are tied to no claim, so they are in no payer's balance.");
    assert.equal(unattachedSays({ count: 1, cents: 4_500 }, null, FEED, FEED), "1 payment ($45.00) received since Sep 1, 2026 is tied to no claim, so it is in no payer's balance.");
    assert.equal(unattachedTail({ count: 5, cents: 580_833 }, null, FEED), " Separately, 5 payments (net $5,808.33) are tied to no claim, so they are in no payer's balance.");
  });

  test("the sentence under the page's title gives how much is for fills from before the feed and points to the card for the rest", () => {
    assert.equal(
      unattachedTail(total(mixed), mixed, FEED),
      " Separately, 10 payments (net $903.10) are tied to no claim, so they are in no payer's balance. " +
        "7 of them are for fills from before the claims feed begins on Sep 1, 2026, which the site holds no claim for. The card below says why for the other 3.",
    );
    const early: TallyRow[] = [{ cause: "before_feed", count: 7, cents: 81_240 }];
    assert.equal(
      unattachedTail(total(early), early, FEED),
      " Separately, 7 payments (net $812.40) are tied to no claim, so they are in no payer's balance. All of them are for fills from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.",
    );
    const one: TallyRow[] = [{ cause: "before_feed", count: 1, cents: 4_000 }, { cause: "reversed_sold", count: 1, cents: 1_000 }];
    assert.match(unattachedTail(total(one), one, FEED), /1 of them is for a fill from before the claims feed begins on Sep 1, 2026, which the site holds no claim for\. The card below says why for the other one\.$/);
    const rest: TallyRow[] = [{ cause: "not_a_fill", count: 3, cents: 9_000 }];
    assert.equal(unattachedTail(total(rest), rest, FEED), " Separately, 3 payments (net $90.00) are tied to no claim, so they are in no payer's balance. The card below says why.");
  });

  test("never calls the money real, says it is not an error, or says there is nothing to fix: having no claim does not show that", () => {
    for (const cause of CAUSES) {
      const one: TallyRow[] = [{ cause, count: 2, cents: 2_000 }];
      for (const said of [unattachedSays(total(one), one, FEED, FEED), unattachedTail(total(one), one, FEED)]) {
        assert.doesNotMatch(said, /not an error|nothing to fix|real money|not a defect|does not hold/i, `${cause}: ${said}`);
      }
    }
  });

  test("every group of a tally is said in the words of the card and in the order of the causes, so no line can say one differently", () => {
    const rows: TallyRow[] = [
      { cause: "before_feed", count: 7, cents: 81_240 },
      { cause: "fits_several", count: 1, cents: -3_000 },
      { cause: "not_a_fill", count: 2, cents: 2_000 },
    ];
    assert.equal(
      groupsSay(rows, FEED),
      "1 payment (-$30.00) that fits two or more claims equally; 2 payments (net $20.00) that name no drug and no fill; 7 payments (net $812.40) for fills from before the claims feed begins on Sep 1, 2026, which the site holds no claim for",
    );
    assert.equal(groupsSay([], FEED), "");
  });
});
