import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitAgainstHeld } from "../src/lib/nadac";

/**
 * Whether a weekly file's three kinds of row are told apart.
 *
 * This is the correctness question underneath the whole floor check: NADAC is the benchmark that
 * decides whether a claim was underpaid, so a price the pharmacy holds that CMS has withdrawn is
 * worse than no price at all — everything downstream goes on working and is quietly wrong.
 */
const row = (ndc11: string, effectiveOn: string, unitMicros: number) => ({ ndc11, effectiveOn, unitMicros });

describe("what a weekly NADAC file changes", () => {
  test("a product CMS has not priced before is added", () => {
    const held = new Map<string, number>();
    const { fresh, changed } = splitAgainstHeld([row("00093342505", "2026-09-09", 100_000)], held);
    assert.equal(fresh.length, 1);
    assert.equal(changed.length, 0);
  });

  test("a price that changed arrives under a new effective date and is added, not overwritten", () => {
    // The old price still has to be there: a claim filled last month is priced against the figure
    // in force then, not the one in force now.
    const held = new Map([["00093342505|2026-08-05", 100_000]]);
    const { fresh, changed } = splitAgainstHeld([row("00093342505", "2026-09-09", 120_000)], held);
    assert.deepEqual(fresh.map((r) => r.effectiveOn), ["2026-09-09"]);
    assert.equal(changed.length, 0);
    assert.equal(held.get("00093342505|2026-08-05"), 100_000, "the earlier price must survive");
  });

  test("the same price republished week after week changes nothing", () => {
    const held = new Map([["00093342505|2026-08-05", 100_000]]);
    const { fresh, changed } = splitAgainstHeld([row("00093342505", "2026-08-05", 100_000)], held);
    assert.equal(fresh.length, 0);
    assert.equal(changed.length, 0);
  });

  test("a price CMS corrected for a date already held is caught, not silently dropped", () => {
    // The failure this exists to prevent: the unique index refuses the row, the pharmacy goes on
    // holding a figure CMS has withdrawn, and nothing anywhere says so.
    const held = new Map([["00093342505|2026-08-05", 100_000]]);
    const { fresh, changed } = splitAgainstHeld([row("00093342505", "2026-08-05", 112_000)], held);
    assert.equal(fresh.length, 0);
    assert.deepEqual(changed.map((r) => r.unitMicros), [112_000]);
  });

  test("a file that repeats a row does not count as correcting itself", () => {
    const held = new Map<string, number>();
    const { fresh, changed } = splitAgainstHeld(
      [row("00093342505", "2026-09-09", 100_000), row("00093342505", "2026-09-09", 100_000)],
      held,
    );
    assert.equal(fresh.length, 1);
    assert.equal(changed.length, 0);
  });

  test("one file carrying all three cases splits them correctly", () => {
    const held = new Map([
      ["A|2026-08-05", 100_000], // unchanged
      ["B|2026-08-05", 250_000], // will be corrected
    ]);
    const { fresh, changed } = splitAgainstHeld(
      [
        row("A", "2026-08-05", 100_000),
        row("B", "2026-08-05", 260_000),
        row("C", "2026-09-09", 999_000),
        row("A", "2026-09-09", 130_000),
      ],
      held,
    );
    assert.deepEqual(fresh.map((r) => `${r.ndc11}|${r.effectiveOn}`), ["C|2026-09-09", "A|2026-09-09"]);
    assert.deepEqual(changed.map((r) => r.ndc11), ["B"]);
  });
});
