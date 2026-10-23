import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { proveCogs, type CogsTerms } from "../src/lib/cogs-proof";

/** A window where all three documents are on file and whole. */
const whole: CogsTerms = {
  from: "2026-09-11",
  to: "2026-09-17",
  claimsCogsCents: 5_000_00,
  purchasesCents: 5_200_00,
  openingCents: 182_988_04,
  openingOn: "2026-09-11",
  closingCents: 185_200_73,
  closingOn: "2026-09-17",
  openingLines: 2240,
  closingLines: 2252,
  typicalLines: 2240,
};

describe("the two routes", () => {
  test("agreement is stated as agreement, to the cent", () => {
    const r = proveCogs({ ...whole, claimsCogsCents: 5_200_00 + 182_988_04 - 185_200_73 });
    assert.equal(r.gapCents, 0);
    assert.equal(r.ok, true);
    assert.match(r.says, /agree to the cent/);
  });

  test("the documents route is purchases plus opening less closing, and nothing from the claims", () => {
    const r = proveCogs(whole);
    assert.equal(r.documentsCents, 5_200_00 + 182_988_04 - 185_200_73);
    assert.equal(r.gapCents, whole.claimsCogsCents! - r.documentsCents!);
  });

  test("a gap is reported with its size and which route is higher, and still passes", () => {
    const r = proveCogs(whole);
    assert.equal(r.ok, true);
    assert.match(r.says, /differ by/);
    assert.match(r.says, /higher|lower/);
  });

  test("the gap's share of the claims figure is given for reading", () => {
    const r = proveCogs({ ...whole, claimsCogsCents: 10_000_00, purchasesCents: 10_000_00, openingCents: 100_00, closingCents: 100_00 });
    assert.equal(r.gapCents, 0);
    assert.equal(r.gapPercent, 0);
  });
});

describe("the one judgement it makes, which needs no invented tolerance", () => {
  test("a gap larger than everything bought is impossible and fails", () => {
    const r = proveCogs({ ...whole, claimsCogsCents: 900_000_00, purchasesCents: 5_200_00 });
    assert.equal(r.ok, false);
    assert.match(r.says, /larger than everything bought/);
    assert.match(r.says, /one of the three terms is wrong/);
  });

  test("a gap just inside the purchases is not called wrong", () => {
    const documents = 5_200_00 + 182_988_04 - 185_200_73;
    const r = proveCogs({ ...whole, claimsCogsCents: documents + 5_199_99 });
    assert.equal(r.ok, true);
  });
});

describe("what it refuses to answer, which is the point of it", () => {
  test("no opening shelf: the question cannot be asked, and it says which snapshot is absent", () => {
    const r = proveCogs({ ...whole, openingCents: null, openingOn: null });
    assert.equal(r.ok, false);
    assert.equal(r.documentsCents, null);
    assert.equal(r.gapCents, null);
    assert.match(r.cannot[0], /shelf valuation on or before 2026-09-11/);
  });

  test("no claims loaded is said as that, not as a zero cost of goods", () => {
    const r = proveCogs({ ...whole, claimsCogsCents: null });
    assert.equal(r.gapCents, null);
    assert.match(r.cannot[0], /No claims are loaded/);
  });

  test("no invoices is its own answer", () => {
    const r = proveCogs({ ...whole, purchasesCents: null });
    assert.match(r.cannot[0], /No supplier invoices/);
  });

  /*
   * A partial count refuses the question rather than qualifying the answer.
   *
   * A truncated Balance on Hand values a shelf that was not there, and the identity cannot tell a
   * bottle that was dispensed from a bottle whose line did not arrive. The gap it produces is a
   * number about a different shelf, and printing it with a footnote is how an untrustworthy figure
   * ends up quoted.
   */
  test("a truncated shelf count stops the proof and says so", () => {
    const r = proveCogs({ ...whole, closingLines: 1776, closingOn: "2026-09-17" });
    assert.equal(r.ok, false);
    assert.equal(r.gapCents, null, "no gap may be computed against a partial shelf");
    assert.ok(
      r.cannot.some((c) => /closing shelf count of 2026-09-17 has 1,776 lines against a usual 2,240/.test(c)),
      r.cannot.join(" | "),
    );
    assert.ok(r.cannot.some((c) => /nothing can be reconciled against it/.test(c)));
  });

  test("a count only slightly under the usual is still a whole shelf", () => {
    assert.equal(proveCogs({ ...whole, closingLines: 2100 }).ok, true);
  });
});

describe("the caveats, which are said whether or not it passes", () => {
  test("a snapshot counted on another day is named", () => {
    const r = proveCogs({ ...whole, openingOn: "2026-09-10" });
    assert.ok(r.caveats.some((c) => /counted on 2026-09-10, not 2026-09-11/.test(c)));
  });

  test("the difference in cost basis is always said, even on a clean pass", () => {
    const r = proveCogs({ ...whole, claimsCogsCents: 5_200_00 + 182_988_04 - 185_200_73 });
    assert.equal(r.ok, true);
    assert.ok(r.caveats.some((c) => /price a bottle differently/.test(c)));
  });

  test("the cost-basis caveat is given even when the proof cannot run at all", () => {
    const r = proveCogs({ ...whole, openingCents: null, openingOn: null });
    assert.equal(r.ok, false);
    assert.ok(r.caveats.some((c) => /price a bottle differently/.test(c)));
  });

  test("every reason it could not run is listed, not just the first", () => {
    const r = proveCogs({ ...whole, openingCents: null, openingOn: null, closingLines: 1776 });
    assert.equal(r.cannot.length, 2, r.cannot.join(" | "));
    assert.ok(r.cannot.some((c) => /shelf valuation on or before/.test(c)));
    assert.ok(r.cannot.some((c) => /not a whole shelf/.test(c)));
  });
});
