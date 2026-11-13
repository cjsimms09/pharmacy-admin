import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAuditDue, AUDIT_INTERVAL_DAYS } from "../src/lib/manual-audit";

/**
 * When a section needs reading again.
 *
 * The regulation asks for an annual review, which in practice is a signature on a date. This is
 * the other thing: the date something actually read the words against the requirements. The two
 * come apart, and the whole reason for tracking the second is that a manual can be signed off on
 * time for five years running and still describe a practice that stopped in year one.
 */
describe("when a manual section is due to be read again", () => {
  const today = "2026-09-04";

  test("a section never read is due, whatever else is true of it", () => {
    assert.equal(isAuditDue(null, today), true);
    assert.equal(isAuditDue(undefined, today), true);
    assert.equal(isAuditDue("", today), true);
  });

  test("read today is not due", () => {
    assert.equal(isAuditDue(today, today), false);
  });

  test("read a month ago is not due", () => {
    assert.equal(isAuditDue("2026-08-04", today), false);
  });

  test("read a year and a day ago is due", () => {
    assert.equal(isAuditDue("2025-09-03", today), true);
  });

  test("the interval is a year, so the deadline is the annual review's", () => {
    assert.equal(AUDIT_INTERVAL_DAYS, 365);
  });
});
