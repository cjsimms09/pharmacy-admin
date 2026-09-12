import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chooseClaimForRemittance, type ClaimCandidate } from "../src/lib/match-remittance";

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
