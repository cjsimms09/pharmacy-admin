import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitSuperseded } from "../src/lib/superseded";

/**
 * The distinction this exists for: replaced is not the same as lapsed.
 *
 * Getting it wrong in one direction buries this year's problem under five years of history. Getting
 * it wrong in the other hides the licence that ran out last week and was never renewed, which is
 * the whole reason anybody opens the page.
 */
type Row = { id: string; type: string; ends: string | null };
const on = { key: (r: Row) => r.type, endsOn: (r: Row) => r.ends };
const TODAY = "2026-09-05";

describe("superseded, not merely expired", () => {
  test("an expired credential that was renewed is history", () => {
    const rows: Row[] = [
      { id: "old", type: "licence", ends: "2025-06-30" },
      { id: "new", type: "licence", ends: "2027-06-30" },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.deepEqual(s.current.map((r) => r.id), ["new"]);
    assert.deepEqual(s.history.map((r) => r.id), ["old"]);
  });

  test("an expired credential that was NOT renewed stays on the page", () => {
    // The one that must never be hidden. This is a live gap, not history.
    const rows: Row[] = [{ id: "lapsed", type: "cpr", ends: "2025-01-01" }];
    const s = splitSuperseded(rows, TODAY, on);
    assert.deepEqual(s.current.map((r) => r.id), ["lapsed"]);
    assert.equal(s.history.length, 0);
  });

  test("a renewal that has also expired keeps the newest one visible", () => {
    // Two dead licences: the older is history, the newest is the live gap.
    const rows: Row[] = [
      { id: "older", type: "licence", ends: "2023-06-30" },
      { id: "newer", type: "licence", ends: "2025-06-30" },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.deepEqual(s.current.map((r) => r.id), ["newer"]);
    assert.deepEqual(s.history.map((r) => r.id), ["older"]);
  });

  test("a credential with no expiry outranks a dated one", () => {
    const rows: Row[] = [
      { id: "dated", type: "cert", ends: "2025-01-01" },
      { id: "forever", type: "cert", ends: null },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.deepEqual(s.current.map((r) => r.id), ["forever"]);
    assert.deepEqual(s.history.map((r) => r.id), ["dated"]);
  });

  test("different kinds never supersede each other", () => {
    const rows: Row[] = [
      { id: "licence", type: "licence", ends: "2024-06-30" },
      { id: "cpr", type: "cpr", ends: "2027-06-30" },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.equal(s.history.length, 0, "a current CPR card does not replace a lapsed licence");
    assert.equal(s.current.length, 2);
  });

  test("a future renewal already supersedes the one still running", () => {
    // Renewed early, both in force today. The old one is still the one that will lapse, so it is
    // not hidden until it actually has.
    const rows: Row[] = [
      { id: "current", type: "licence", ends: "2026-12-31" },
      { id: "renewal", type: "licence", ends: "2028-12-31" },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.equal(s.history.length, 0);
    assert.equal(s.current.length, 2);
  });

  test("nothing is ever dropped", () => {
    const rows: Row[] = [
      { id: "a", type: "x", ends: "2020-01-01" },
      { id: "b", type: "x", ends: "2021-01-01" },
      { id: "c", type: "x", ends: "2030-01-01" },
      { id: "d", type: "y", ends: null },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.equal(s.current.length + s.history.length, rows.length);
  });
});
