import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isOutOfBooks, monthIsOutOfBooks, SITE_STARTS_ON } from "../src/lib/books-start";

/**
 * A payment that names a fill these books never loaded.
 *
 * The rule was: money arriving on or after 1 September is in the books, whatever it settles. Its
 * stated reasoning — *"a September remittance settling an August fill is real money in these
 * books"* — is true only if the fill is in these books, and on 14 September fourteen Medicare
 * Transaction Facilitator refunds proved it was not.
 *
 * $1,572.90, received between 1 and 14 September, for fills dated 10 to 24 August. Not one of the
 * claims they settle exists in this site at all: not in the books, not out of them, never imported,
 * because the claims feed starts on 1 September. They credited September with revenue whose fill it
 * had never recorded, against a cost it had never carried, and could never match anything.
 *
 * The owner, when the unmatched payments were put to him: *"the mtf payments are probably for claims
 * before when we started this site.. that is okay.. they should match going forward."* He was right
 * about all 34 — the latest fill among them is 24 August. What he had not been told is that fourteen
 * were inside the books while being unmatchable.
 */
describe("a payment is judged on the fill it settles, where it names one", () => {
  test("REGRESSION: an August fill refunded in September is out, not in", () => {
    // The real shape: rx 313103, filled 2026-08-24, $96.89 received 2026-09-14.
    assert.equal(isOutOfBooks("2026-09-14", "2026-08-24"), true);
    assert.equal(isOutOfBooks("2026-09-01", "2026-08-10"), true);
  });

  test("a September fill paid in September is in, which is the whole point of the books", () => {
    assert.equal(isOutOfBooks("2026-09-20", "2026-09-04"), false);
  });

  test("a September fill paid in October is still in — the fill decides, not the money", () => {
    /*
     * The mirror of the regression, and the reason this is a fill-date rule rather than a
     * both-must-be-September rule. MTF refunds lag about three weeks, so September's own refunds
     * land in October and every one of them belongs here.
     */
    assert.equal(isOutOfBooks("2026-10-08", "2026-09-28"), false);
    assert.equal(isOutOfBooks("2027-03-01", "2026-09-30"), false);
  });

  test("the day the books open is in them", () => {
    assert.equal(isOutOfBooks("2026-09-01", SITE_STARTS_ON), false);
    assert.equal(isOutOfBooks("2026-09-01", "2026-08-31"), true);
  });
});

describe("a fill date after the money arrived is not a fill date", () => {
  /*
   * Caught by dry-running the repair rather than by the reasoning behind it.
   *
   * 58 ProviderPay payments carry a fill date of 2026-12-31 — a placeholder — received on 27 August.
   * Read literally that is "filled after 1 September, therefore in the books", and it would have
   * pulled $580 of August test money in: the same fault being fixed here, pointing the other way.
   *
   * Nobody is paid for a fill that has not happened, so the check is against the received date and
   * needs no clock.
   */
  test("REGRESSION: a placeholder fill date falls back to the day the money arrived", () => {
    assert.equal(isOutOfBooks("2026-08-27", "2026-12-31"), true, "August money stays out, whatever the fill date claims");
  });

  test("the fallback keeps working in both directions", () => {
    assert.equal(isOutOfBooks("2026-09-27", "2026-12-31"), false, "September money stays in");
  });

  test("a fill on the same day the money arrived is credible", () => {
    assert.equal(isOutOfBooks("2026-08-24", "2026-08-24"), true);
    assert.equal(isOutOfBooks("2026-09-04", "2026-09-04"), false);
  });

  test("a fill date with no received date is taken at face value", () => {
    // Nothing to check it against, and the callers that pass only a fill date rely on this.
    assert.equal(isOutOfBooks(null, "2026-08-24"), true);
    assert.equal(isOutOfBooks(null, "2026-09-24"), false);
  });
});

describe("what the change deliberately leaves alone", () => {
  test("a payment naming no fill still goes on the date the money arrived", () => {
    /*
     * Unchanged, and for the reason the original rule gives: a remittance with no date is far more
     * likely to be this month's than a deliberate pull of an old one, and silently dropping real
     * revenue is the failure that matters there.
     */
    assert.equal(isOutOfBooks("2026-09-14"), false);
    assert.equal(isOutOfBooks("2026-08-14"), true);
    assert.equal(isOutOfBooks("2026-09-14", null), false);
    assert.equal(isOutOfBooks("2026-08-14", undefined), true);
  });

  test("no date of any kind stays in the books", () => {
    // An unknown date is treated as in. Anything pulled as a test comes with its dates.
    assert.equal(isOutOfBooks(null), false);
    assert.equal(isOutOfBooks(undefined, null), false);
  });

  test("the month rule for the cash side is untouched", () => {
    assert.equal(monthIsOutOfBooks("2026-08"), true);
    assert.equal(monthIsOutOfBooks("2026-09"), false);
    assert.equal(monthIsOutOfBooks(null), false);
  });
});

describe("the callers that pass a fill date already, and must keep working", () => {
  test("a reversal and a MAC appeal both ask about a fill date in the first argument", () => {
    /*
     * `claims.ts` and `mac-appeal-store.ts` call this with a *fill* date as the only argument, which
     * the new second parameter must not disturb. Both still answer on that date.
     */
    assert.equal(isOutOfBooks("2026-08-20"), true, "an August fill is out of books");
    assert.equal(isOutOfBooks("2026-09-20"), false, "a September fill is in");
  });
});
