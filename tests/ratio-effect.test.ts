import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { projectRatio, tierEffect, lineEffect, bandAt, counts, type Position, type OrderLine, type Band } from "../src/lib/ratio-effect";

/**
 * The second price on every McKesson line: what it does to the compliance ratio, and what the
 * band the ratio picks is worth on the period's contract generics. Figures are round so the
 * arithmetic can be checked by hand.
 */
const LADDER: Band[] = [
  { thresholdPercent: 0, rebatePercent: 15 },
  { thresholdPercent: 20, rebatePercent: 25 },
  { thresholdPercent: 24, rebatePercent: 29 },
];

// $40,000 of Rx purchases so far this month at a 21% generic share: $8,400 of generics in it, of
// which $6,000 are OneStop — the base the band is paid on.
const pos = (over: Partial<Position> = {}): Position => ({ ratioPercent: 21, denominatorCents: 4_000_000, definition: "generics_over_rx", scrub: "statement", ...over });
const BASE = 600_000;
const line = (cents: number, kind: OrderLine["kind"], atPrimary = true): OrderLine => ({ cents, kind, atPrimary });

describe("what counts, under each definition", () => {
  test("the GCR is the generic share: every generic lifts it, brand drags it, OneStop is not special", () => {
    assert.deepEqual(counts("onestop_generic", "generics_over_rx"), { num: true, den: true });
    assert.deepEqual(counts("other_generic", "generics_over_rx"), { num: true, den: true });
    assert.deepEqual(counts("brand", "generics_over_rx"), { num: false, den: true });
    assert.deepEqual(counts("excluded", "generics_over_rx"), { num: false, den: false });
  });

  test("OS/Rx and OS/Gx are OneStop shares", () => {
    assert.deepEqual(counts("other_generic", "onestop_over_rx"), { num: false, den: true });
    assert.deepEqual(counts("brand", "onestop_over_rx"), { num: false, den: true });
    assert.deepEqual(counts("brand", "onestop_over_generics"), { num: false, den: false });
    assert.deepEqual(counts("onestop_generic", "onestop_over_generics"), { num: true, den: true });
  });
});

describe("where the ratio goes", () => {
  test("the position implies the numerator", () => {
    const p = projectRatio(pos(), []);
    assert.equal(p.numeratorCents, 840_000);
    assert.equal(p.denominatorCents, 4_000_000);
    assert.equal(p.afterPercent, 21);
  });

  test("a generic at the primary lifts the ratio, contract or not; a brand there drags it; anything elsewhere moves nothing", () => {
    assert.ok(projectRatio(pos(), [line(100_000, "onestop_generic")]).afterPercent > 21);
    assert.ok(projectRatio(pos(), [line(100_000, "other_generic")]).afterPercent > 21);
    assert.ok(projectRatio(pos(), [line(100_000, "brand")]).afterPercent < 21);
    assert.equal(projectRatio(pos(), [line(100_000, "other_generic", false), line(100_000, "brand", false)]).afterPercent, 21);
    assert.equal(projectRatio(pos(), [line(100_000, "excluded")]).afterPercent, 21);
  });

  test("the arithmetic: $1,000 of generics on $40,000 at 21% gives (8,400 + 1,000) / 41,000", () => {
    const p = projectRatio(pos(), [line(100_000, "other_generic")]);
    assert.ok(Math.abs(p.afterPercent - (940_000 / 4_100_000) * 100) < 1e-9);
  });
});

describe("what the band is worth", () => {
  test("the band before and after, and the rebate on the OneStop base", () => {
    const e = tierEffect(pos(), LADDER, [], BASE);
    assert.equal(e.before?.rebatePercent, 25);
    assert.equal(e.after?.rebatePercent, 25);
    assert.equal(e.rebateAfterCents, 150_000); // 25% of $6,000
    assert.equal(e.bandDeltaCents, 0);
  });

  test("how much generic purchasing reaches the next band, and what it is worth on the base", () => {
    const e = tierEffect(pos(), LADDER, [], BASE);
    // (8,400 + x) / (40,000 + x) = 0.24  →  x = (9,600 − 8,400) / 0.76 = 1,578.95
    assert.equal(e.next?.band.thresholdPercent, 24);
    assert.equal(e.next?.numeratorNeededCents, 157_895);
    assert.equal(e.next?.worthCents, Math.round(BASE * 0.04));
    const reached = tierEffect(pos(), LADDER, [line(e.next!.numeratorNeededCents, "other_generic")], BASE);
    assert.equal(reached.after?.thresholdPercent, 24);
  });

  test("headroom: how much brand at the primary loses the current band", () => {
    const e = tierEffect(pos(), LADDER, [], BASE);
    // N / (D + y) = 0.20  →  y = 8,400 / 0.2 − 40,000 = 2,000
    assert.equal(e.headroom?.denominatorRoomCents, 200_000);
    assert.ok(Math.abs(e.headroom!.percentPoints - 1) < 1e-9);
    const lost = tierEffect(pos(), LADDER, [line(200_001, "brand")], BASE);
    assert.equal(lost.after?.rebatePercent, 15);
    assert.ok(lost.bandDeltaCents < 0);
  });

  test("a band lost costs the difference on the whole base, not on the line", () => {
    const e = tierEffect(pos(), LADDER, [line(300_000, "brand")], BASE);
    assert.equal(e.before?.rebatePercent, 25);
    assert.equal(e.after?.rebatePercent, 15);
    assert.equal(e.bandDeltaCents, -Math.round(BASE * 0.1));
  });

  test("one line's effect, on its own and against the rest of the order", () => {
    const brand = lineEffect(pos(), LADDER, line(300_000, "brand"), BASE);
    assert.ok(brand.deltaPoints < 0);
    assert.ok(brand.bandLost);
    assert.equal(brand.bandDeltaCents, -60_000);
    const elsewhere = lineEffect(pos(), LADDER, line(300_000, "brand", false), BASE);
    assert.equal(elsewhere.deltaPoints, 0);
    assert.ok(!elsewhere.bandLost);
    // The same brand is safe once enough generic is in the order beside it.
    const covered = lineEffect(pos(), LADDER, line(300_000, "brand"), BASE, [line(400_000, "other_generic")]);
    assert.ok(!covered.bandLost);
  });

  test("below the lowest threshold there is no band", () => {
    assert.equal(bandAt([{ thresholdPercent: 10, rebatePercent: 5 }], 9.99), null);
    assert.equal(bandAt(LADDER, 24)?.rebatePercent, 29);
  });
});
