import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isStrandedReversal, claimCancelledBy, type Pairable } from "../src/lib/claims";

/**
 * Rx 331488, reproduced from the two files that actually produced it.
 *
 * It ran for sixty tablets at $1,204.25 on the 4th, was reversed, and re-ran for thirty at $607.38.
 * The pharmacy made $30.62. The site said $658.11.
 *
 * How: the daily file for the 5th carried only two of the three rows — the reversal and the rebill,
 * not the original run. The reversal matched nothing and was stored on its own. The wider file sent
 * later carried all three, so the original run arrived and was stored live — and by then the
 * reversal was already held, so it was skipped as a duplicate before it could pair with it. Both
 * runs counted, one bottle was billed twice, and nothing on any screen looked wrong.
 */
const claim = (over: Partial<Pairable>): Pairable => ({
  id: "x",
  rxNumber: "331488",
  fillNumber: 1,
  bin: "004336",
  ndc11: "81968004560",
  status: "paid",
  remitCents: 0,
  copayCents: 0,
  transactionKey: "k",
  reversalKey: null,
  ...over,
});

/* Stored on the first load: matched nothing, so it points at itself. */
const stranded = claim({ id: "rev", status: "reversed", remitCents: -120_425, copayCents: 0, transactionKey: "A", reversalKey: "A" });
/* The sixty-tablet run, which only arrived with the later file. */
const sixty = claim({ id: "p1", remitCents: 120_425, copayCents: 0, transactionKey: "P1" });
/* The thirty-tablet rebill that actually stands. */
const thirty = claim({ id: "p2", remitCents: 60_738, copayCents: 0, transactionKey: "P2" });

describe("a reversal held that never matched anything", () => {
  test("it is recognised as stranded, and an ordinary reversed claim is not", () => {
    assert.equal(isStrandedReversal(stranded), true);
    // A claim properly cancelled points at the reversal that cancelled it, not at itself.
    assert.equal(isStrandedReversal(claim({ status: "reversed", remitCents: -120_425, transactionKey: "P1", reversalKey: "A" })), false);
    assert.equal(isStrandedReversal(sixty), false, "a live claim is not a reversal");
  });

  test("it finds the run it cancels, and leaves the rebill alone", () => {
    const found = claimCancelledBy(stranded, [sixty, thirty]);
    assert.ok(found.hit, "the sixty-tablet run is cancelled");
    assert.equal(found.hit!.id, "p1");
    assert.notEqual(found.hit!.id, "p2", "the thirty-tablet rebill stands — it is what the pharmacy was paid for");
  });

  test("with the original never loaded, it cancels nothing and says why", () => {
    /*
     * The honest case: a reversal of a dispensing from before this feed began. Subtracting it would
     * invent a loss out of a correction to a figure the site never had.
     */
    const found = claimCancelledBy(stranded, [thirty]);
    assert.equal(found.hit, null);
    assert.match((found as { why: string }).why, /none has figures this exactly cancels/);
  });

  test("nothing at all held for that prescription is a different reason, and says so", () => {
    const found = claimCancelledBy(stranded, []);
    assert.equal(found.hit, null);
    assert.match((found as { why: string }).why, /before this feed began/);
  });

  test("two equally good candidates cancel neither", () => {
    /*
     * Cancelling the wrong run of a prescription deletes revenue that was really earned, and there
     * is nothing in the rows to say which. Refusing is the only safe answer.
     */
    const twin = claim({ id: "p1b", remitCents: 120_425, copayCents: 0, transactionKey: "P1B" });
    const found = claimCancelledBy(stranded, [sixty, twin]);
    assert.equal(found.hit, null);
    assert.match((found as { why: string }).why, /equally well/);
  });

  test("a reversal only cancels a claim on the same prescription, fill, BIN and drug", () => {
    const elsewhere = claim({ id: "other", rxNumber: "999999", remitCents: 120_425 });
    assert.equal(claimCancelledBy(stranded, [elsewhere]).hit, null);
    assert.equal(claimCancelledBy(stranded, [claim({ id: "d", ndc11: "00000000000", remitCents: 120_425 })]).hit, null);
  });
});
