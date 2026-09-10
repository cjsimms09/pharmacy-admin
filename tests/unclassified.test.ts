import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { unclassified, totalOf, rowFor, stateOf, UNCLASSIFIED, type UnclassifiedCount } from "../src/lib/unclassified";

/**
 * Money the site has seen and cannot place, and the one rule that makes the figure worth having.
 *
 * The number itself is easy. What is not easy, and what these tests are about, is that an
 * incomplete total must never present itself as a total — because a page that says "$412.60 is
 * unplaced" when one whole kind has never been counted is more dangerous than a page that says
 * nothing at all. It reads as an answer.
 */

const at = "2026-09-10";
const count = (key: string, rows: number, cents: number | null, measuredAt: string | null = at): UnclassifiedCount => ({ key, rows, cents, measuredAt });

describe("a pot nobody has counted is not a pot of nothing", () => {
  test("never measured is its own state, and says so", () => {
    const r = rowFor(UNCLASSIFIED[0], undefined);
    assert.equal(r.state, "unmeasured");
    assert.match(r.says, /nobody has looked, so this is not nought/);
    assert.equal(r.cents, null);
  });

  test("measured and empty is a different state, and a good one", () => {
    const r = rowFor(UNCLASSIFIED[0], count(UNCLASSIFIED[0].key, 0, 0));
    assert.equal(r.state, "clear");
    assert.match(r.says, /nothing is unplaced/);
  });

  test("and the two are never the same answer", () => {
    assert.notEqual(stateOf({ rows: 0, measuredAt: null }), stateOf({ rows: 0, measuredAt: at }));
  });
});

describe("a total is a floor unless every part of it was measured", () => {
  test("one uncounted kind turns the whole figure into 'at least'", () => {
    // Two kinds counted and one never looked at. The arithmetic is right; the sentence must not be.
    const { total } = unclassified([count("provider-adjustments", 3, 41260), count("payments-no-claim", 2, 8000)]);
    assert.equal(total.cents, 49260);
    assert.equal(total.floor, true);
    assert.match(total.says, /^At least \$492\.60 across 5 rows/);
    assert.match(total.says, /so the real figure is larger\.$/);
    assert.ok(total.missing.includes("invoice-no-lines"));
  });

  test("rows whose money is unknown still count as rows, and still make it a floor", () => {
    // Sixteen payments matching no claim are sixteen findings whether or not anybody summed them.
    const rows = UNCLASSIFIED.map((s) => count(s.key, 0, 0));
    const withUnknown = rows.map((c) => (c.key === "payments-no-claim" ? count(c.key, 16, null) : c));
    const { total } = unclassified(withUnknown);
    assert.equal(total.rows, 16);
    assert.equal(total.cents, 0);
    assert.equal(total.floor, true);
    assert.deepEqual(total.missing, ["payments-no-claim"]);
  });

  test("every kind counted, and the figure is stated plainly", () => {
    const rows = UNCLASSIFIED.map((s) => count(s.key, 0, 0));
    const one = rows.map((c) => (c.key === "remit-held" ? count(c.key, 1, 12500) : c));
    const { total } = unclassified(one);
    assert.equal(total.floor, false);
    assert.equal(total.says, "$125.00 across 1 row is money this site has seen and cannot put under a heading.");
  });

  test("all clear is claimed only when everything has been looked at", () => {
    const { total } = unclassified(UNCLASSIFIED.map((s) => count(s.key, 0, 0)));
    assert.equal(total.floor, false);
    assert.match(total.says, /Every dollar this site has seen is under a heading/);
  });

  test("nothing counted at all is no figure, not a clean bill", () => {
    const { total } = unclassified([]);
    assert.equal(total.cents, 0);
    assert.match(total.says, /no figure — which is not the same as nothing being unplaced/);
    assert.doesNotMatch(total.says, /under a heading\.$/);
  });
});

describe("every kind carries what would resolve it", () => {
  test("each has a cause and an instruction, not just a symptom", () => {
    for (const s of UNCLASSIFIED) {
      assert.ok(s.why.length > 20, `${s.key} has no reason`);
      assert.ok(s.resolvedBy.length > 20, `${s.key} says nothing about how to clear it`);
      assert.ok(s.where.startsWith("/"), `${s.key} does not say where the rows are`);
    }
  });

  test("the keys are unique, because a row keeps its history by key", () => {
    assert.equal(new Set(UNCLASSIFIED.map((s) => s.key)).size, UNCLASSIFIED.length);
  });
});

describe("the arithmetic", () => {
  test("only held rows are summed — unmeasured and clear contribute nothing", () => {
    const rows = [
      rowFor(UNCLASSIFIED[0], count(UNCLASSIFIED[0].key, 2, 5000)),
      rowFor(UNCLASSIFIED[1], count(UNCLASSIFIED[1].key, 0, 0)),
      rowFor(UNCLASSIFIED[2], undefined),
    ];
    const t = totalOf(rows);
    assert.equal(t.cents, 5000);
    assert.equal(t.rows, 2);
    assert.deepEqual(t.missing, [UNCLASSIFIED[2].key]);
  });
});
