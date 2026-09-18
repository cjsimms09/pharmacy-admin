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
  offsetsWithPaymentDates: 0,
  offsetsWithPaymentDatesCents: 0,
  doubledRebateLadders: 0,
  paymentsCountedTwice: 0,
  paymentsCountedTwiceCents: 0,
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
    assert.match(summarise(checks), /^All 9 checks pass\.$/);
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

  /*
   * The most expensive of the day, and the only one that moved a profit figure.
   *
   * Two rebate expenses carried the wholesaler's payment date, so the cash account had each of them
   * twice — as the receipt's revenue and as this row's negative cost. $10,697.24 on September alone.
   */
  test("two rebate expenses dated as paid, putting $20,403.76 on the cash account twice", () => {
    const c = check(
      { offsetsWithPaymentDates: 2, offsetsWithPaymentDatesCents: 2_040_376 },
      "No revenue offset is dated as paid",
    );
    assert.equal(c.ok, false);
    assert.match(c.observed, /2 dated as paid, \$20,403\.76/);
    assert.match(c.difference!, /counted twice on the cash account/);
    assert.match(c.difference!, /gross profit is that much better/);
  });

  /*
   * The one that cost the most and would have been cheapest to catch.
   *
   * Two current ladders on the contract basket and two on brand, because a programme had been
   * renamed and the old name stayed live. The rates are summed, so the contract rate read 60%
   * against a statement saying 30%, and September's estimated rebate — a cost-of-goods line — came
   * out at double. About $5,000 of accrual profit that was not there.
   */
  test("two baskets each carrying two current ladders, which doubles every rate", () => {
    const c = check({ doubledRebateLadders: 2 }, "No supplier pays on the same basket twice");
    assert.equal(c.ok, false);
    assert.match(c.observed, /2 baskets with more than one current ladder/);
    assert.match(c.difference!, /added twice/);
  });
});

describe("the summary counts every rule", () => {
  test("eight of them, and a new one cannot be added without this noticing", () => {
    assert.equal(runDailyCheck(wellRun).length, 9);
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
    assert.match(s, /2 of 9 failing/);
    assert.match(s, /one inbox row per delivered attachment/);
  });
});

describe("money earned and money arriving", () => {
  /*
   * The check written for a shape rather than a bug. Three faults in two days were all the same
   * one — a rebate expense dated as paid, two ladders on one basket, and a fortnight of
   * remittances posted as new revenue — and every one had correct arithmetic and passing tests.
   */
  test("a payment equal to the claim's own figure and still counted is a failure in money", () => {
    const c = check(
      { paymentsCountedTwice: 496, paymentsCountedTwiceCents: 2_864_557 },
      "Money earned and money arriving are counted once, not twice",
    );
    assert.equal(c.ok, false);
    assert.equal(c.kind, "money");
    assert.match(c.observed, /496 payments/);
    assert.match(c.observed, /\$28,645\.57/);
    assert.match(c.difference!, /exists only because a remittance was read/);
    assert.match(c.difference!, /revenueCents/, "says what to change, not just that something is wrong");
  });

  test("it passes when nothing is being added to the figure it settles", () => {
    const c = check({}, "Money earned and money arriving are counted once, not twice");
    assert.equal(c.ok, true);
    assert.equal(c.difference, null);
    assert.match(c.shouldBe, /same money arriving rather than more of it/);
  });
});
