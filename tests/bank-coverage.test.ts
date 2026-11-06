import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bankCoverage, TOLERANCE_DAYS } from "../src/lib/bank-coverage";

/*
 * October 2026's only bank record runs 2 to 15 October and nothing later exists. "All 70 bank lines are accounted for" must not read as a
 * statement about the whole month, and the month must not wait for a file that cannot be had. Every date here is invented to that shape.
 */
describe("what stretch of a month the bank lines cover", () => {
  test("a statement that stops half way says where, and what is not proved", () => {
    const c = bankCoverage("2026-10", ["2026-10-02", "2026-10-09", "2026-10-15"], "2026-10-31");
    assert.ok(c);
    assert.equal(c!.coversMonth, false);
    assert.equal(c!.says, "2 Oct to 15 Oct; there is no bank record after 15 Oct, so 16 Oct to 31 Oct is not proved against the bank");
  });

  test("a statement that reaches the last days covers the month, even if the last posting is a few days early", () => {
    assert.equal(bankCoverage("2026-09", ["2026-09-01", "2026-09-30"], "2026-09-30")!.coversMonth, true);
    assert.equal(bankCoverage("2026-09", ["2026-09-01", `2026-09-${30 - TOLERANCE_DAYS}`], "2026-09-30")!.coversMonth, true);
    assert.equal(bankCoverage("2026-09", ["2026-09-01", `2026-09-${30 - TOLERANCE_DAYS - 1}`], "2026-09-30")!.coversMonth, false);
  });

  test("lines from other months are ignored, and no lines at all is null", () => {
    assert.equal(bankCoverage("2026-10", ["2026-09-30", "2026-11-02"], "2026-10-31"), null);
    assert.equal(bankCoverage("2026-10", [], "2026-10-31"), null);
    assert.equal(bankCoverage("2026-10", ["2026-09-30", "2026-10-05"], "2026-10-31")!.first, "2026-10-05");
  });

  test("a single-day statement is a stretch of one day, said plainly", () => {
    assert.match(bankCoverage("2026-10", ["2026-10-14"], "2026-10-31")!.says, /^14 Oct to 14 Oct; there is no bank record after 14 Oct/);
  });
});
