import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reviewStartDeadline, reviewCompleteDeadline, isThin } from "../src/lib/cqi-rules";
import { daysBetween } from "../src/lib/dates";

/**
 * The automation exists so a pharmacist writes down what happened and nothing else. What it must
 * never do is miss a deadline set by K.A.R. 68-19-1, or overwrite something a person wrote.
 */
describe("the seven-day review clock", () => {
  test("the deadline is seven days from the report", () => {
    assert.equal(reviewStartDeadline("2026-09-01"), "2026-09-08");
    assert.equal(daysBetween("2026-09-01", reviewStartDeadline("2026-09-01")), 7);
  });

  test("drafting at day five leaves two days of margin", () => {
    // Held back so a note added to an hour later is not analysed in its first version, but never
    // so late that a missed run eats the deadline.
    const DRAFT_AFTER_DAYS = 5;
    const reported = "2026-09-01";
    const drafts = "2026-09-06";
    assert.equal(daysBetween(reported, drafts), DRAFT_AFTER_DAYS);
    assert.ok(drafts < reviewStartDeadline(reported), "drafting must happen before the deadline");
    assert.ok(daysBetween(drafts, reviewStartDeadline(reported)) >= 2, "there must be margin for a missed run");
  });

  test("the thirty-day completion clock is separate and longer", () => {
    assert.equal(reviewCompleteDeadline("2026-09-01"), "2026-10-01");
    assert.ok(reviewCompleteDeadline("2026-09-01") > reviewStartDeadline("2026-09-01"));
  });

  test("a month boundary does not shorten either clock", () => {
    assert.equal(daysBetween("2026-08-28", reviewStartDeadline("2026-08-28")), 7);
    assert.equal(daysBetween("2026-12-29", reviewStartDeadline("2026-12-29")), 7);
  });
});

describe("what counts as needing to be written", () => {
  test("nothing written at all", () => {
    assert.equal(isThin(null, null), true);
    assert.equal(isThin("", ""), true);
  });

  test("a real analysis is left alone", () => {
    const rca = "A".repeat(450);
    const cap = "B".repeat(450);
    assert.equal(isThin(rca, cap), false);
  });

  test("one half written and the other empty still needs work", () => {
    assert.equal(isThin("A".repeat(450), null), true);
    assert.equal(isThin(null, "B".repeat(450)), true);
  });

  test("a one-line note is not an analysis", () => {
    assert.equal(isThin("Wrong drug given.", "Told the tech to be careful."), true);
  });
});
