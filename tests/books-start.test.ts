import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SITE_STARTS_ON, isOutOfBooks, monthIsOutOfBooks } from "../src/lib/books-start";

describe("the day the books begin", () => {
  test("the boundary is the 1st of October 2026, and the 1st itself is in", () => {
    /*
     * The one place the day is pinned; every other test derives its dates from the constant. It was
     * 1 September until the owner moved it on 15 September: "books start on 10/01 but we need to do a
     * complete dry run this month to troubleshoot EVERYTHING and make sure everything works starting
     * 10/01". Moving it again needs his words, and migration 0124's re-flag repeated for the new date.
     */
    assert.equal(SITE_STARTS_ON, "2026-10-01");
    assert.equal(isOutOfBooks("2026-10-01"), false, "the first day counts as in the books");
    assert.equal(isOutOfBooks("2026-09-30"), true, "the day before does not");
  });

  test("the months the owner pulled as tests, and the dry run, are all out", () => {
    // "let's download claims for April so we can do a test run", then June; September was the dry run.
    for (const d of ["2026-04-01", "2026-04-30", "2026-06-15", "2026-08-29", "2026-09-01", "2026-09-15"]) {
      assert.equal(isOutOfBooks(d), true, `${d} is a test month and must not be counted`);
    }
  });

  test("money received after the books begin is in, whatever month the fill was", () => {
    /*
     * The case this rule exists to protect. An October remittance settling a September fill is real
     * money in these books. Keying on the fill date instead would throw it away — losing revenue in
     * the name of tidiness, which is the expensive direction to get this wrong.
     */
    assert.equal(isOutOfBooks("2026-10-04"), false);
    assert.equal(isOutOfBooks("2026-12-31"), false);
    assert.equal(isOutOfBooks("2027-01-02"), false);
  });

  test("a missing date is treated as in the books, not out", () => {
    /*
     * Deliberate. A remittance carrying no date is far likelier to be the one being read right now
     * than a deliberate pull of an old month — and the failure that costs money is silently dropping
     * real revenue, not showing a test payment that has to be removed by hand.
     */
    assert.equal(isOutOfBooks(null), false);
    assert.equal(isOutOfBooks(undefined), false);
    assert.equal(isOutOfBooks(""), false);
  });

  test("the month form agrees with the day form at the boundary", () => {
    assert.equal(monthIsOutOfBooks("2026-08"), true);
    assert.equal(monthIsOutOfBooks("2026-09"), true);
    assert.equal(monthIsOutOfBooks("2026-10"), false);
    assert.equal(monthIsOutOfBooks("2026-11"), false);
    assert.equal(monthIsOutOfBooks(null), false);
  });

  test("the copay reader and the new module name the same day", async () => {
    // It used to be declared inside copay-remit, where only that reader could see it — which is why
    // remittance import and payment-report import both went on counting money from before the start.
    const copay = await import("../src/lib/copay-remit");
    assert.equal(copay.SITE_STARTS_ON, SITE_STARTS_ON);
  });
});
