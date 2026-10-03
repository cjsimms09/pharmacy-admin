import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MONTHLY_CAP } from "../src/lib/ai-spend";

/**
 * What blank and zero mean, which the settings page got backwards.
 *
 * The field said blank meant no ceiling. Blank means "nobody has set one", which falls back to the
 * built-in fifty — so clearing the box to remove the limit put the limit straight back, and the
 * page then failed against it and blamed the connection. Zero is the value that means no ceiling.
 *
 * `monthlyCap()` itself reads the database, so what is pinned here is the rule it applies.
 */
function capFrom(typed: string): { cap: number | null; isDefault: boolean } {
  const raw = Number(typed.trim());
  const t = typed.trim();
  return {
    cap: t === "" ? DEFAULT_MONTHLY_CAP : Number.isFinite(raw) && raw > 0 ? raw : null,
    isDefault: t === "",
  };
}

describe("the monthly ceiling", () => {
  test("blank is the built-in ceiling, not the absence of one", () => {
    assert.deepEqual(capFrom(""), { cap: DEFAULT_MONTHLY_CAP, isDefault: true });
  });

  test("zero is how somebody says no ceiling, deliberately", () => {
    assert.deepEqual(capFrom("0"), { cap: null, isDefault: false });
  });

  test("a number is that number, and is no longer the default", () => {
    assert.deepEqual(capFrom("250"), { cap: 250, isDefault: false });
  });

  test("nonsense is treated as no ceiling rather than as zero spending allowed", () => {
    // The safe direction: a typo must not silently stop every reader in the building.
    assert.equal(capFrom("abc").cap, null);
    assert.equal(capFrom("-5").cap, null);
  });
});
