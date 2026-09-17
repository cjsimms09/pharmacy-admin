import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runDailyCheck, summarise, type Facts } from "../src/lib/daily-check";

/** A day on which everything is as it should be. Each test spoils exactly one thing. */
const wellRun: Facts = {
  inboxRows: 180,
  inboxArrivals: 180,
  invoiceDocumentRows: 64,
  invoiceDocumentFiles: 64,
  standingRebatePeriodTo: "2026-08-31",
  invoicesShort: 0,
  invoicesShortCents: 0,
  lastSweptAt: "2026-09-17T16:29:00.000Z",
  bookedWithNoDocument: 0,
  today: "2026-09-17",
  now: "2026-09-17T17:00:00.000Z",
};

const check = (f: Partial<Facts>, what: string) => {
  const c = runDailyCheck({ ...wellRun, ...f }).find((x) => x.what === what);
  assert.ok(c, `no check named ${what}`);
  return c;
};

describe("a well-run day", () => {
  test("nothing fails, and every check still states what it looked for", () => {
    const checks = runDailyCheck(wellRun);
    assert.equal(checks.filter((c) => !c.ok).length, 0);
    for (const c of checks) {
      assert.ok(c.shouldBe.length > 40, `${c.what} has no rule written`);
      assert.equal(c.difference, null);
    }
    assert.match(summarise(checks), /^All 6 checks pass\.$/);
  });
});

/**
 * Each fault of 17 September 2026, with the numbers it actually had.
 *
 * This is the point of the suite. A check that cannot be shown to fire on the day it was written
 * for is a check nobody should trust on any other day.
 */
describe("the faults of 17 September 2026, as they actually were", () => {
  test("1,822 inbox rows for 180 deliveries", () => {
    const c = check({ inboxRows: 1822 }, "One inbox row per delivered attachment");
    assert.equal(c.ok, false);
    assert.match(c.observed, /1,822 rows for 180 arrivals/);
    assert.match(c.difference!, /1,642 rows more/);
  });

  test("599 invoice records for 64 invoices", () => {
    const c = check({ invoiceDocumentRows: 599 }, "One record per invoice in the archive");
    assert.equal(c.ok, false);
    assert.match(c.difference!, /535 duplicate records/);
  });

  test("a May 2025 statement standing on 17 September 2026", () => {
    const c = check({ standingRebatePeriodTo: "2025-05-31" }, "The rebate statement standing is a current one");
    assert.equal(c.ok, false);
    assert.match(c.observed, /2025-05-31/);
    assert.match(c.difference!, /474 days old/);
  });

  test("four ParMed invoices short by $7.68 between them", () => {
    const c = check({ invoicesShort: 4, invoicesShortCents: 768 }, "Invoices add up to what they say they come to");
    assert.equal(c.ok, false);
    assert.match(c.observed, /4 short by \$7\.68/);
  });

  test("a rebate expense booked with no document behind it", () => {
    const c = check({ bookedWithNoDocument: 1 }, "Money booked off a statement points at the statement");
    assert.equal(c.ok, false);
    assert.match(c.difference!, /1 figure on the books/);
  });
});

describe("the sweep, which is how nearly everything arrives", () => {
  test("six hours of silence is still fine", () => {
    assert.equal(check({ lastSweptAt: "2026-09-17T11:30:00.000Z" }, "The mailbox is being swept").ok, true);
  });

  test("a day of silence is not", () => {
    const c = check({ lastSweptAt: "2026-09-16T17:00:00.000Z" }, "The mailbox is being swept");
    assert.equal(c.ok, false);
    assert.match(c.observed, /24 hours ago/);
  });

  test("never swept is said as never, not as zero", () => {
    const c = check({ lastSweptAt: null }, "The mailbox is being swept");
    assert.equal(c.ok, false);
    assert.equal(c.observed, "never swept");
  });
});

describe("what it says when it cannot say", () => {
  test("no rebate statement at all is a failure with its own words, not a stale one", () => {
    const c = check({ standingRebatePeriodTo: null }, "The rebate statement standing is a current one");
    assert.equal(c.ok, false);
    assert.equal(c.observed, "no statement is standing");
    assert.match(c.difference!, /working without one/);
  });

  test("a statement exactly sixty days old still passes; sixty-one does not", () => {
    assert.equal(check({ standingRebatePeriodTo: "2026-07-19" }, "The rebate statement standing is a current one").ok, true);
    assert.equal(check({ standingRebatePeriodTo: "2026-07-18" }, "The rebate statement standing is a current one").ok, false);
  });

  test("summarise names what failed rather than counting silently", () => {
    const s = summarise(runDailyCheck({ ...wellRun, inboxRows: 1822, invoicesShort: 4, invoicesShortCents: 768 }));
    assert.match(s, /2 of 6 failing/);
    assert.match(s, /one inbox row per delivered attachment/);
  });
});
