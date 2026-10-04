import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CAUSES, causeInfo, classifyUntied, needsSays, tallyUntied, untiedHeadline, type TallyRow, type UntiedPayment } from "../src/lib/untied-payments";
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
    assert.deepEqual(CAUSES.filter((c) => causeInfo(c, FEED).needs === "nothing"), ["reversed_not_sold", "before_feed"]);
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
