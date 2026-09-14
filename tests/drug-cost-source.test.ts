import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { costCoverage, provableShare, type PricedRow } from "../src/lib/drug-cost-source";

/*
 * How much of what the pharmacy buys it can price, and on what evidence.
 *
 * This module used to decide what a drug cost. It does not any more: session 1 wired receipts into
 * `buildLedger` on 15 September and the ledger decides it, in the one place every buying screen
 * already reads. Two readers for one thing drift, and two readers where one of them is unused drift
 * silently — nothing tests the spare against reality, and the first person to reach for it gets a
 * different answer from the screen beside them. Deleting the duplicate was the fix.
 *
 * What is left is the question above the ledger, which nobody had asked: of everything bought, how
 * much can be priced at all, and how much of that could be produced to a plan.
 */

const row = (source: "invoice" | "catalogue" | "receipt" | null, ndc = "1"): PricedRow => ({
  ndc11: ndc,
  paid: source === null ? null : { source },
});

describe("what counts as priced", () => {
  test("an invoice and a receipt are both money that changed hands", () => {
    const c = costCoverage([row("invoice", "1"), row("receipt", "2")]);
    assert.equal(c.priced, 2);
    assert.equal(c.fromInvoice, 1);
    assert.equal(c.fromReceipt, 1);
    assert.equal(c.neverPriced, 0);
  });

  test("a catalogue price is not a price the pharmacy paid", () => {
    /*
     * It is what a supplier lists, and nobody has paid it. The ledger applies the same rule in
     * deciding what `paid` means, and counting it here would claim a cost the site does not know.
     */
    const c = costCoverage([row("catalogue", "1")]);
    assert.equal(c.priced, 0);
    assert.equal(c.neverPriced, 1);
    assert.match(c.says, /^0 of 1 drug have a cost this site can state/);
  });

  test("nothing on file at all is not priced", () => {
    const c = costCoverage([row(null, "1")]);
    assert.equal(c.neverPriced, 1);
    assert.match(c.says, /1 is not priced at all/);
  });

  test("counted in drugs, so one expensive drug hides nothing", () => {
    assert.match(costCoverage([row("invoice", "1")]).says, /1 of 1 drug have a cost/);
    assert.match(costCoverage([row("invoice", "1"), row("invoice", "2")]).says, /2 of 2 drugs/);
  });
});

describe("lines with no drug code", () => {
  test("they are said after the full stop, never inside the drug count", () => {
    /*
     * They are not drugs that failed to be priced — they were never candidates for the question.
     * Six on file: two McKesson front-end items and four Xymogen nutraceuticals, $429.45.
     */
    const c = costCoverage([row("invoice", "1")], 6);
    assert.equal(c.drugs, 1, "one drug was asked about, whatever else was on the delivery");
    assert.equal(c.noCode, 6);
    assert.match(c.says, /^1 of 1 drug have a cost/);
    assert.match(c.says, /Separately, 6 delivery lines carry no drug code/);
    assert.match(c.says, /outside every figure above rather than counted as unpriced/);
  });

  test("one line reads as one line", () => {
    assert.match(costCoverage([row("invoice", "1")], 1).says, /1 delivery line carries no drug code/);
  });

  test("no codeless lines means no sentence about them", () => {
    assert.doesNotMatch(costCoverage([row("invoice", "1")]).says, /Separately/);
  });

  test("nothing asked about still reports the codeless lines", () => {
    // Otherwise money on a delivery vanishes entirely on a day nothing was dispensed.
    const c = costCoverage([], 6);
    assert.match(c.says, /No drug was asked about\./);
    assert.match(c.says, /6 delivery lines carry no drug code/);
  });
});

describe("what could be produced to a plan", () => {
  test("only an invoice is a document, and the sentence says what the rest are", () => {
    const c = costCoverage([row("invoice", "1"), row("receipt", "2"), row("receipt", "3")]);
    const p = provableShare(c);
    assert.deepEqual([p.numerator, p.denominator], [1, 3]);
    assert.match(p.says, /1 of 3 priced drugs rest on an invoice the pharmacy could produce/);
    assert.match(p.says, /not a document to send a plan/);
  });

  test("all on invoices says so plainly rather than counting to itself", () => {
    const p = provableShare(costCoverage([row("invoice", "1"), row("invoice", "2")]));
    assert.match(p.says, /Every priced drug rests on a wholesaler's invoice/);
  });

  test("nothing priced is not nought out of nought", () => {
    const p = provableShare(costCoverage([row(null, "1")]));
    assert.match(p.says, /Nothing is priced, so nothing is evidenced either way/);
    assert.equal(p.denominator, 0);
  });
});

describe("the word missing appears nowhere", () => {
  test("in any of the sentences", () => {
    // "Missing" is not a state and must never be reported as one.
    const sentences = [
      costCoverage([]).says,
      costCoverage([], 6).says,
      costCoverage([row(null, "1")]).says,
      costCoverage([row("receipt", "1")], 2).says,
      provableShare(costCoverage([row("receipt", "1")])).says,
      provableShare(costCoverage([])).says,
    ];
    for (const s of sentences) assert.doesNotMatch(s, /missing/i, `"${s}" must not say missing`);
  });
});
