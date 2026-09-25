import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isOutOfBooks, SITE_STARTS_ON } from "../src/lib/books-start";

/**
 * The rule that decides whether a pull of claims from PioneerRx is a test.
 *
 * It is judged on the newest fill the pull actually returned, not on the range that was asked for.
 * This mirrors the arithmetic in `claims-backfill.ts` so the decision itself is tested rather than
 * only the code around it.
 */
const isTestPull = (fills: { filledOn: string | null }[]) => {
  const newest = fills.reduce((m, f) => (f.filledOn && f.filledOn > m ? f.filledOn : m), "");
  return newest !== "" && isOutOfBooks(newest);
};

const on = (...dates: (string | null)[]) => dates.map((d) => ({ filledOn: d }));

describe("a pull of claims is a test, or it is the books", () => {
  test("a month wholly before the books begin is a test", () => {
    assert.equal(isTestPull(on("2026-08-01", "2026-08-15", "2026-08-31")), true);
    assert.equal(isTestPull(on("2026-04-02", "2026-04-29")), true);
  });

  test("a pull straddling the boundary is NOT a test", () => {
    /*
     * The case worth protecting. A range asked for as "August onwards" that returns September fills
     * holds real claims, and flagging the import would take real revenue out of the books — the same
     * mistake as keying a payment on its fill date instead of when the money arrived.
     */
    assert.equal(isTestPull(on("2026-08-28", "2026-08-31", "2026-09-02")), false);
    assert.equal(isTestPull(on("2026-08-31", SITE_STARTS_ON)), false);
  });

  test("the first day of the books is in the books", () => {
    assert.equal(isTestPull(on(SITE_STARTS_ON)), false);
    assert.equal(isTestPull(on("2026-08-31")), true);
  });

  test("a pull that returned nothing is not a test, and not anything", () => {
    // No rows means no import to flag. Flagging on an empty pull would mark a row that, the next
    // time the same stamp came round, would silently swallow real claims.
    assert.equal(isTestPull([]), false);
    assert.equal(isTestPull(on(null, null)), false);
  });

  test("a range running to today counts by what came back, not what was asked", () => {
    // Asked for August to today; PioneerRx returned nothing after August. Still a test.
    assert.equal(isTestPull(on("2026-08-04", "2026-08-22")), true);
  });
});
