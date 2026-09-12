import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseFormula, expectedCents } from "../src/lib/rate-formula";

/** Contract sentences into arithmetic, and a claim priced on them. Round figures, checked by hand. */
describe("reading the sentence", () => {
  test("AWP-15% + $1.00", () => {
    const f = parseFormula("AWP-15% + $1.00");
    assert.equal(f.kind, "priced");
    assert.deepEqual(f.legs, [{ benchmark: "AWP", discountPercent: 15 }]);
    assert.equal(f.feeCents, 100);
    assert.equal(f.lesserOf, false);
  });
  test("Lesser of (MAC or AWP-25%) + $1.00 is two legs", () => {
    const f = parseFormula("Lesser of (MAC or AWP-25%) + $1.00");
    assert.equal(f.lesserOf, true);
    assert.deepEqual(f.legs, [{ benchmark: "MAC", discountPercent: 0 }, { benchmark: "AWP", discountPercent: 25 }]);
    assert.equal(f.feeCents, 100);
  });
  test("the words people write: minus, plus, dispensing fee, WAC markup, lowest of three", () => {
    assert.deepEqual(parseFormula("AWP minus 16 percent plus $0.75 dispensing fee").legs, [{ benchmark: "AWP", discountPercent: 16 }]);
    assert.equal(parseFormula("AWP minus 16 percent plus $0.75 dispensing fee").feeCents, 75);
    assert.deepEqual(parseFormula("WAC+2% + $0.75").legs, [{ benchmark: "WAC", discountPercent: -2 }]);
    const three = parseFormula("the lowest of MAC, AWP-20%, or U&C, plus $2.00");
    assert.deepEqual(three.legs.map((l) => l.benchmark), ["MAC", "AWP", "UC"]);
    assert.equal(three.feeCents, 200);
  });
  test("NADAC + $10.50 is the Kansas floor shape", () => {
    const f = parseFormula("NADAC + $10.50");
    assert.deepEqual(f.legs, [{ benchmark: "NADAC", discountPercent: 0 }]);
    assert.equal(f.feeCents, 1050);
  });
  test("a sentence with no benchmark is unknown and keeps its words", () => {
    const f = parseFormula("Per the PBM's then-current schedule");
    assert.equal(f.kind, "unknown");
    assert.equal(f.text, "Per the PBM's then-current schedule");
    assert.equal(parseFormula(null).kind, "unknown");
  });
});

describe("pricing a claim", () => {
  test("AWP-15% + $1.00 on 30 units at AWP $2.00: $51.00 + $1.00", () => {
    const e = expectedCents(parseFormula("AWP-15% + $1.00"), 30_000, { awpMicros: 2_000_000 });
    assert.equal(e.ingredientCents, 5_100);
    assert.equal(e.totalCents, 5_200);
    assert.equal(e.atMost, false);
  });
  test("lesser-of with the MAC not held prices on AWP and says it is a ceiling", () => {
    const e = expectedCents(parseFormula("Lesser of (MAC or AWP-25%) + $1.00"), 30_000, { awpMicros: 2_000_000 });
    assert.equal(e.totalCents, 4_600);
    assert.equal(e.atMost, true);
    assert.match(e.why, /MAC leg is not held/);
  });
  test("lesser-of with both legs held takes the lower", () => {
    const e = expectedCents(parseFormula("Lesser of (MAC or AWP-25%) + $1.00"), 30_000, { awpMicros: 2_000_000, macMicros: 1_000_000 });
    assert.equal(e.ingredientCents, 3_000);
    assert.equal(e.leg?.benchmark, "MAC");
    assert.equal(e.atMost, false);
  });
  test("U&C is a total, not a per-unit figure", () => {
    const e = expectedCents(parseFormula("Lower of AWP-20% or U&C + $1.50"), 30_000, { awpMicros: 2_000_000, usualAndCustomaryCents: 2_000 });
    assert.equal(e.ingredientCents, 2_000);
    assert.equal(e.totalCents, 2_150);
  });
  test("no benchmark held: nothing is priced, and the reason says which", () => {
    const e = expectedCents(parseFormula("AWP-15% + $1.00"), 30_000, {});
    assert.equal(e.totalCents, null);
    assert.match(e.why, /No AWP held/);
  });
});
