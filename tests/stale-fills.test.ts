import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { staleAgainstDispensing, type FillRow } from "../src/lib/claims";

/**
 * A live claim for a drug the pharmacy never dispensed.
 *
 * A daily report can list one transaction twice. The transaction key ends in an occurrence number to
 * allow that, because it is sometimes real — the same drug at the same price to two patients on one
 * day is two fills. But when a listing is repeated and only one reversal arrives, the reversal
 * cancels occurrence #1 and occurrence #2 stands as live revenue for ever. Five September fills were
 * in that state: $276.99 of revenue against $48.32 of cost, $228.67 of profit on drugs that never
 * left the shelf.
 *
 * PioneerRx settles it, because it is the pharmacy's own record of what was dispensed. The risk is
 * the opposite mistake — taking revenue off a fill that really happened — so every guard here is
 * about refusing to act rather than about acting.
 */
const row = (over: Partial<FillRow> = {}): FillRow => ({
  id: "c1",
  rxNumber: "337352",
  fillNumber: 0,
  bin: "610279",
  ndc11: "45802006535",
  status: "paid",
  remitCents: 900,
  copayCents: 0,
  ...over,
});

describe("what the dispensing record contradicts", () => {
  test("the real case: two paid rows, PioneerRx names one", () => {
    const held = [
      row({ id: "real", ndc11: "45802006535" }),
      row({ id: "stale", ndc11: "67877031815" }),
    ];
    const r = staleAgainstDispensing(held, new Map([["337352|0", new Set(["45802006535"])]]));
    assert.equal(r.stale.length, 1);
    assert.equal(r.stale[0].row.id, "stale");
    assert.deepEqual(r.keep.map((k) => k.id), ["real"]);
    assert.match(r.stale[0].why, /holds no standing claim for NDC 67877031815/);
    assert.match(r.stale[0].why, /listed this transaction twice/);
  });

  test("GUARD: a fill PioneerRx has never booked is left alone", () => {
    /*
     * The third state. "We have not been told" is not "it did not happen", and an invoice arriving
     * ahead of its own receiving record is ordinary — the next pull settles it.
     */
    const r = staleAgainstDispensing([row({ ndc11: "99999999999" })], new Map());
    assert.deepEqual(r.stale, []);
    assert.equal(r.keep.length, 1);
  });

  test("GUARD: an empty set of dispensed NDCs settles nothing either", () => {
    const r = staleAgainstDispensing([row({ ndc11: "99999999999" })], new Map([["337352|0", new Set<string>()]]));
    assert.deepEqual(r.stale, []);
  });

  test("GUARD: never the last live row on a fill", () => {
    /*
     * If the site and PioneerRx disagree about *every* row on a fill, that is a question for a
     * person. Reversing them all would take a fill that really happened off the books entirely.
     */
    const r = staleAgainstDispensing(
      [row({ id: "only", ndc11: "67877031815" })],
      new Map([["337352|0", new Set(["45802006535"])]]),
    );
    assert.deepEqual(r.stale, []);
    assert.deepEqual(r.keep.map((k) => k.id), ["only"]);
  });

  test("a row already reversed is not counted again", () => {
    const r = staleAgainstDispensing(
      [row({ id: "real" }), row({ id: "done", ndc11: "67877031815", status: "reversed" })],
      new Map([["337352|0", new Set(["45802006535"])]]),
    );
    assert.deepEqual(r.stale, []);
  });

  test("a two-payer fill keeps both rows, because both are the dispensed drug", () => {
    // 62 of September's 2,484 fills are two-payer: same NDC, different BIN. Neither is stale.
    const r = staleAgainstDispensing(
      [row({ id: "primary", bin: "610279" }), row({ id: "secondary", bin: "019158" })],
      new Map([["337352|0", new Set(["45802006535"])]]),
    );
    assert.deepEqual(r.stale, []);
    assert.equal(r.keep.length, 2);
  });

  test("a row with no NDC is neither confirmed nor contradicted", () => {
    const r = staleAgainstDispensing(
      [row({ id: "real" }), row({ id: "blank", ndc11: null })],
      new Map([["337352|0", new Set(["45802006535"])]]),
    );
    assert.deepEqual(r.stale, []);
  });

  test("fills are judged apart, so one prescription cannot settle another", () => {
    const r = staleAgainstDispensing(
      [row({ id: "a", rxNumber: "111", ndc11: "11111111111" }), row({ id: "b", rxNumber: "222", ndc11: "22222222222" })],
      new Map([["111|0", new Set(["33333333333"])]]),
    );
    // 111 disagrees but has no confirmed row, so it is left; 222 has no opinion at all.
    assert.deepEqual(r.stale, []);
  });
});
