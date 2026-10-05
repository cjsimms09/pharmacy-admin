import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chooseClaimForRemittance, claimsOfThisFill, verdictOnPrescription, type ClaimCandidate, type ClaimOnFile, type TiedPayment } from "../src/lib/match-remittance";

/**
 * The owner: "We will be able to match remits with 835s?"
 *
 * The case that decides it is a fill billed to two payers — September has 37 — where both claim
 * rows carry the same prescription number, fill number, date and NDC. Everything the matcher used
 * to look at is identical on both.
 */
const primary: ClaimCandidate = { id: "primary", fillNumber: 0, dateFilled: "2026-09-03", ndc11: "00093505698", bin: "610455", remitCents: 6_000 };
const secondary: ClaimCandidate = { id: "secondary", fillNumber: 0, dateFilled: "2026-09-03", ndc11: "00093505698", bin: "004336", remitCents: 2_500 };
const line = { fillNumber: 0, dateFilled: "2026-09-03", ndc11: "00093505698", amountCents: 2_500, bin: "004336" };

describe("one payer on the fill", () => {
  test("the claim is found", () => {
    const r = chooseClaimForRemittance([primary], { ...line, amountCents: 6_000, bin: "610455" });
    assert.equal(r.claim?.id, "primary");
    assert.equal(r.ambiguous, null);
  });

  test("a prescription the site has never seen is not an error, just no match", () => {
    const r = chooseClaimForRemittance([], line);
    assert.equal(r.claim, null);
    assert.equal(r.ambiguous, null);
  });

  /*
   * A credit memo names the drug and the day but not the fill number, and a remittance may be a day
   * out on the date. Loosening one condition at a time is what keeps those matched.
   */
  test("a line with no fill number still matches on drug and day", () => {
    const r = chooseClaimForRemittance([primary], { ...line, fillNumber: null, amountCents: 6_000, bin: null });
    assert.equal(r.claim?.id, "primary");
  });

  test("a line whose date is a day out still matches on the drug", () => {
    const r = chooseClaimForRemittance([primary], { ...line, dateFilled: "2026-09-04", amountCents: 6_000, bin: null });
    assert.equal(r.claim?.id, "primary");
  });
});

describe("two payers on one fill", () => {
  /*
   * The bug. Every field the matcher looked at is the same on both rows, so it loosened to a level
   * where two claims fitted and took whichever came back first. An 835 from the secondary could be
   * filed against the primary — which makes two claims wrong at once: the primary looks paid twice
   * and the secondary ages unsettled.
   */
  test("the BIN decides it, whichever order the claims come back in", () => {
    assert.equal(chooseClaimForRemittance([primary, secondary], line).claim?.id, "secondary");
    assert.equal(chooseClaimForRemittance([secondary, primary], line).claim?.id, "secondary");
  });

  test("the primary's own 835 finds the primary", () => {
    const r = chooseClaimForRemittance([primary, secondary], { ...line, amountCents: 6_000, bin: "610455" });
    assert.equal(r.claim?.id, "primary");
  });

  test("a BIN written with punctuation still matches", () => {
    const r = chooseClaimForRemittance([primary, secondary], { ...line, bin: "00-4336" });
    assert.equal(r.claim?.id, "secondary");
  });

  test("with no BIN, the amount decides it", () => {
    const r = chooseClaimForRemittance([primary, secondary], { ...line, bin: null, amountCents: 6_000 });
    assert.equal(r.claim?.id, "primary");
  });

  /*
   * And where nothing separates them, no answer. A payment attached to nothing is unmatched and gets
   * chased; a payment attached to the wrong claim is invisible and wrong twice over.
   */
  test("neither BIN nor amount separates them: it refuses and says why", () => {
    const r = chooseClaimForRemittance([primary, secondary], { ...line, bin: null, amountCents: 9_999 });
    assert.equal(r.claim, null);
    assert.equal(r.ambiguous?.count, 2);
    assert.match(r.ambiguous?.why ?? "", /none of them was paid exactly this amount/);
    assert.match(r.ambiguous?.why ?? "", /by hand/);
  });

  test("two claims paid the identical amount are not guessed between", () => {
    const twin = { ...secondary, id: "twin", bin: "004336", remitCents: 6_000 };
    const r = chooseClaimForRemittance([primary, twin], { ...line, bin: null, amountCents: 6_000 });
    assert.equal(r.claim, null);
    assert.match(r.ambiguous?.why ?? "", /2 of them were paid exactly this amount/);
  });

  test("a line with no amount and no BIN refuses rather than picking the first", () => {
    const r = chooseClaimForRemittance([primary, secondary], { ...line, bin: null, amountCents: null });
    assert.equal(r.claim, null);
    assert.match(r.ambiguous?.why ?? "", /does not name a payer BIN/);
    assert.match(r.ambiguous?.why ?? "", /gives no amount/);
  });

  test("a BIN that matches neither claim falls back to the amount rather than refusing", () => {
    const r = chooseClaimForRemittance([primary, secondary], { ...line, bin: "999999", amountCents: 2_500 });
    assert.equal(r.claim?.id, "secondary", "the payer is unknown to us but the figure is not");
  });
});

describe("three payers", () => {
  const third: ClaimCandidate = { id: "third", fillNumber: 0, dateFilled: "2026-09-03", ndc11: "00093505698", bin: "610502", remitCents: 800 };

  test("each payer's 835 finds its own claim", () => {
    assert.equal(chooseClaimForRemittance([primary, secondary, third], { ...line, bin: "610502", amountCents: 800 }).claim?.id, "third");
    assert.equal(chooseClaimForRemittance([primary, secondary, third], { ...line, bin: "610455", amountCents: 6_000 }).claim?.id, "primary");
  });
});

describe("a payment never settles a different fill of the same prescription", () => {
  const claim = (id: string, dateFilled: string) => ({ id, fillNumber: null, dateFilled, ndc11: "00000000001", bin: "610011", remitCents: 1_000 });
  test("REGRESSION: April's payment does not attach to September's refill when April's claim is not on file", () => {
    const c = chooseClaimForRemittance([claim("sep", "2026-09-10")], { fillNumber: null, dateFilled: "2026-04-10", ndc11: "00000000001", amountCents: 1_000, bin: "610011" });
    assert.equal(c.claim, null);
  });
  test("a remittance a day or two off the fill date still finds its claim", () => {
    const c = chooseClaimForRemittance([claim("sep", "2026-09-10")], { fillNumber: null, dateFilled: "2026-09-11", ndc11: null, amountCents: 1_000, bin: null });
    assert.equal(c.claim?.id, "sep");
  });
});

describe("what the site makes of a payment, given every claim it holds for the prescription", () => {
  const held = (id: string, status: "paid" | "reversed", dateFilled: string, o: Partial<ClaimOnFile> = {}): ClaimOnFile => ({
    id, status, fillNumber: 1, dateFilled, ndc11: "00000000001", bin: "610011", remitCents: 1_000, soldOn: null, ...o,
  });
  const pays = { fillNumber: 1, dateFilled: "2026-09-10", ndc11: "00000000001", amountCents: 1_000, bin: null };

  test("a prescription the site holds nothing for", () => {
    assert.deepEqual(verdictOnPrescription([], pays), { kind: "no_claim_on_file" });
  });

  test("a paid claim for the fill ties it, and is returned whole", () => {
    const v = verdictOnPrescription([held("a", "paid", "2026-09-10", { soldOn: "2026-09-10" })], pays);
    assert.equal(v.kind, "tied");
    assert.equal(v.kind === "tied" && v.claim.soldOn, "2026-09-10");
  });

  test("only reversed claims: the verdict names those that are for this fill", () => {
    const v = verdictOnPrescription([held("this", "reversed", "2026-09-10"), held("other", "reversed", "2026-08-10", { fillNumber: 0 })], pays);
    assert.equal(v.kind, "only_reversed");
    assert.deepEqual(v.kind === "only_reversed" ? v.fill.map((c) => c.id) : null, ["this"]);
  });

  test("only reversed claims, all for other fills: none is for this one", () => {
    const v = verdictOnPrescription([held("other", "reversed", "2026-08-10", { fillNumber: 0 })], pays);
    assert.deepEqual(v.kind === "only_reversed" ? v.fill : null, []);
  });

  test("a reversed claim for this fill beside a paid claim for another is no fit, and the verdict still names the reversed one", () => {
    const v = verdictOnPrescription([held("this", "reversed", "2026-09-10"), held("refill", "paid", "2026-10-10", { fillNumber: 2 })], pays);
    assert.equal(v.kind, "no_fit");
    assert.deepEqual(v.kind === "no_fit" ? v.reversedFill.map((c) => c.id) : null, ["this"]);
  });

  test("paid claims for other fills only: no fit, and no reversed claim for this fill", () => {
    const v = verdictOnPrescription([held("refill", "paid", "2026-10-10", { fillNumber: 2 })], pays);
    assert.deepEqual(v, { kind: "no_fit", reversedFill: [] });
  });

  test("two paid claims fitting equally are ambiguous, and say how many", () => {
    const v = verdictOnPrescription([held("a", "paid", "2026-09-10", { bin: "610011", remitCents: 500 }), held("b", "paid", "2026-09-10", { bin: "004336", remitCents: 700 })], pays);
    assert.equal(v.kind, "ambiguous");
    assert.equal(v.kind === "ambiguous" && v.count, 2);
  });

  test("a reversed twin is not offered, so it does not make a paid claim ambiguous", () => {
    const v = verdictOnPrescription([held("paid", "paid", "2026-09-10"), held("gone", "reversed", "2026-09-10")], pays);
    assert.equal(v.kind === "tied" && v.claim.id, "paid");
  });

  test("the claims of a fill are those at the strictest level that finds any", () => {
    const same = held("same", "reversed", "2026-09-10");
    const near = held("near", "reversed", "2026-09-12", { fillNumber: 7 });
    assert.deepEqual(claimsOfThisFill([same, near], pays).map((c) => c.id), ["same"]);
    assert.deepEqual(claimsOfThisFill([near], pays).map((c) => c.id), ["near"]);
    assert.deepEqual(claimsOfThisFill([held("month", "reversed", "2026-10-10")], pays), []);
  });
});

describe("a take-back is read by what is already tied to the claims it could belong to", () => {
  /*
   * A fill billed to two payers is two claims with the same fill, date and drug. A take-back of $41.50 can never equal a remit (a remit is
   * what a claim is owed), so the amount cannot choose between them. What can: one of the two was paid exactly $41.50, and the take-back
   * is that payment's.
   */
  const back = 4_150;
  const paid = (amountCents: number, source = "plan"): TiedPayment => ({ amountCents, source });
  const two = (tiedToPrimary: TiedPayment[] | undefined, tiedToSecondary: TiedPayment[] | undefined = undefined): ClaimCandidate[] => [
    { ...primary, remitCents: back, tied: tiedToPrimary },
    { ...secondary, remitCents: 1_900, tied: tiedToSecondary },
  ];
  const takes = { ...line, bin: null, amountCents: -back, source: "plan" };

  test("it belongs to the claim whose remit it equals and that was paid that amount", () => {
    const r = chooseClaimForRemittance(two([paid(back), paid(back)]), takes);
    assert.equal(r.claim?.id, "primary");
    assert.equal(r.ambiguous, null);
  });

  test("where nothing says what is tied, no take-back is matched to either claim", () => {
    const r = chooseClaimForRemittance(two(undefined), takes);
    assert.equal(r.claim, null);
    assert.equal(r.ambiguous?.count, 2);
  });

  test("it must be the whole of a remit: a take-back no claim's remit equals belongs to neither", () => {
    const r = chooseClaimForRemittance(two([paid(back), paid(back)]), { ...takes, amountCents: -3_300 });
    assert.equal(r.claim, null);
    assert.equal(r.ambiguous?.count, 2);
    assert.match(r.ambiguous?.why ?? "", /it takes money back, and none of them was paid exactly that amount in full by this source/);
  });

  test("it must be the whole of a remit: a take-back of a payment that was only part of one is not tied either", () => {
    const part: ClaimCandidate[] = [
      { ...primary, remitCents: 6_000, tied: [paid(back)] },
      { ...secondary, remitCents: 1_900, tied: [] },
    ];
    const r = chooseClaimForRemittance(part, takes);
    assert.equal(r.claim, null);
    assert.equal(r.ambiguous?.count, 2);
    assert.match(r.ambiguous?.why ?? "", /takes money back/);
  });

  test("a line of nothing is no take-back, though a claim of nothing was paid nothing", () => {
    const none: ClaimCandidate[] = [
      { ...primary, remitCents: 0, tied: [paid(0)] },
      { ...secondary, remitCents: 0, tied: [] },
    ];
    assert.equal(chooseClaimForRemittance(none, { ...takes, amountCents: 0 }).claim, null);
  });

  test("a claim that was paid something else, or nothing, is not the one being taken from", () => {
    assert.equal(chooseClaimForRemittance(two([]), takes).claim, null);
    assert.equal(chooseClaimForRemittance(two([paid(1_900), paid(back + 100)]), takes).claim, null);
  });

  test("a take-back reverses a payment of its own source and of no other", () => {
    const secondaryPaid = two([paid(back, "secondary")]);
    assert.equal(chooseClaimForRemittance(secondaryPaid, takes).claim, null);
    assert.equal(chooseClaimForRemittance(secondaryPaid, { ...takes, source: "secondary" }).claim?.id, "primary");
    assert.equal(chooseClaimForRemittance(two([paid(back)]), { ...takes, source: null }).claim, null);
    assert.equal(chooseClaimForRemittance(two([paid(back)]), { ...takes, source: undefined }).claim, null);
  });

  test("a claim already taken back to nothing has nothing left to take back", () => {
    assert.equal(chooseClaimForRemittance(two([paid(back), paid(-back)]), takes).claim, null);
  });

  test("paid three times and taken back twice, it can be taken back once more and then no more", () => {
    const x3 = [paid(back), paid(back), paid(back)];
    assert.equal(chooseClaimForRemittance(two([...x3]), takes).claim?.id, "primary");
    assert.equal(chooseClaimForRemittance(two([...x3, paid(-back)]), takes).claim?.id, "primary");
    assert.equal(chooseClaimForRemittance(two([...x3, paid(-back), paid(-back)]), takes).claim?.id, "primary");
    assert.equal(chooseClaimForRemittance(two([...x3, paid(-back), paid(-back), paid(-back)]), takes).claim, null);
  });

  test("a payment of exactly the amount is needed, not merely enough in total", () => {
    assert.equal(chooseClaimForRemittance(two([paid(2_075), paid(2_075), paid(2_075)]), takes).claim, null);
  });

  test("two claims equally entitled to it stay ambiguous: neither is chosen over the other", () => {
    const both: ClaimCandidate[] = [
      { ...primary, remitCents: back, tied: [paid(back)] },
      { ...secondary, remitCents: back, tied: [paid(back)] },
    ];
    const r = chooseClaimForRemittance(both, takes);
    assert.equal(r.claim, null);
    assert.equal(r.ambiguous?.count, 2);
    assert.match(r.ambiguous?.why ?? "", /it takes money back, and 2 of them were paid exactly that amount in full by this source/);
  });

  test("a take-back whose own payment is waiting beside it is not given to the other claim that holds an equal payment", () => {
    const waiting = chooseClaimForRemittance(two([paid(back)]), { ...takes, partnerWaiting: true });
    assert.equal(waiting.claim, null);
    assert.match(waiting.ambiguous?.why ?? "", /itself waiting to be attached, so the two cancel/);
    assert.equal(chooseClaimForRemittance(two([paid(back)]), { ...takes, partnerWaiting: false }).claim?.id, "primary");
  });

  test("a payment is not read this way: only a take-back is", () => {
    const r = chooseClaimForRemittance(two([paid(back)]), { ...takes, amountCents: 3_300 });
    assert.equal(r.claim, null);
    assert.doesNotMatch(r.ambiguous?.why ?? "", /takes money back/);
  });

  test("a claim the pharmacy reversed is never offered, whatever is tied to it", () => {
    const held = (id: string, status: "paid" | "reversed", o: Partial<ClaimOnFile> = {}): ClaimOnFile => ({
      id, status, fillNumber: 0, dateFilled: "2026-09-03", ndc11: "00093505698", bin: "610455", remitCents: back, soldOn: null, tied: [paid(back)], ...o,
    });
    const v = verdictOnPrescription([held("reversed", "reversed"), held("paid-a", "paid"), held("paid-b", "paid", { remitCents: 1_900, tied: [] })], takes);
    assert.equal(v.kind === "tied" && v.claim.id, "paid-a");
  });
});
