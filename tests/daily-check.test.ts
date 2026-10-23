import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runDailyCheck, summarise, sortMarks, wrongAlarmsSaid, checkCouldNotRun, type Check, type Facts, type History, type Mark } from "../src/lib/daily-check";
import { isRetired } from "../src/lib/retired";

/** A day on which everything is as it should be. Each test spoils exactly one thing. */
const wellRun: Facts = {
  inboxRows: 180,
  inboxArrivals: 180,
  invoiceDocumentRows: 64,
  invoiceDocumentFiles: 64,
  standingRebatePeriodTo: "2026-08-31",
  invoicesShort: 0,
  invoicesShortCents: 0,
  shortInvoices: [],
  lastSweptAt: "2026-09-17T16:29:00.000Z",
  lastSweepResult: "0 stored, 0 rejected, 0 ignored",
  bookedWithNoDocument: 0,
  offsetsWithPaymentDates: 0,
  offsetsWithPaymentDatesCents: 0,
  doubledRebateLadders: 0,
  paymentsCountedTwice: 0,
  paymentsCountedTwiceCents: 0,
  remittancesNotBanked: 0,
  remittancesNotBankedCents: 0,
  unbankedRemittances: [],
  remittancesBankedBySweep: 0,
  remittancesBankedByRemitNumber: 0,
  remittanceRegisterRows: 51,
  remittancesNumbered: 51,
  remittancesNotPositive: 0,
  remittancesUnnumberedStanding: 0,
  remittancesWaiting: [],
  remittanceRegisterThrough: "2026-09-17",
  remittanceRegisterReadOn: "2026-09-17",
  remittancePaymentsPosted: 1346,
  today: "2026-09-17",
  now: "2026-09-17T17:00:00.000Z",
};

const check = (f: Partial<Facts>, what: string) => {
  const c = runDailyCheck({ ...wellRun, ...f }).find((x) => x.what === what);
  assert.ok(c, `no check named ${what}`);
  return c;
};

const SHORT = "Invoices add up to what they say they come to";
const BANKED = "Money the payer says it has sent has reached the cash account";
type Tie = Facts["unbankedRemittances"][number]["tie"];

describe("a well-run day", () => {
  test("nothing fails, and every check still states what it looked for", () => {
    const checks = runDailyCheck(wellRun);
    assert.equal(checks.filter((c) => !c.ok).length, 0);
    for (const c of checks) {
      assert.ok(c.shouldBe.length > 40, `${c.what} has no rule written`);
      assert.equal(c.difference, null);
    }
    assert.match(summarise(checks), /^All 10 checks pass\.$/);
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
    assert.equal(c.observed, "4 invoices short by $7.68 in total");
    assert.equal(c.href, "/inventory/invoices", "no list of which, so the whole list of invoices");
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
  test("ten of them, and a new one cannot be added without this noticing", () => {
    assert.equal(runDailyCheck(wellRun).length, 10);
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

  test("a sweep inside the hour is said so, and one hour is not 'hours'", () => {
    assert.equal(check({ lastSweptAt: "2026-09-17T16:29:00.000Z" }, "The mailbox is being swept").observed, "last swept within the hour");
    assert.equal(check({ lastSweptAt: "2026-09-17T16:00:00.000Z" }, "The mailbox is being swept").observed, "last swept 1 hour ago");
  });

  test("never swept is said as never, not as zero", () => {
    const c = check({ lastSweptAt: null, lastSweepResult: null }, "The mailbox is being swept");
    assert.equal(c.ok, false);
    assert.equal(c.observed, "never swept");
  });

  /*
   * 6 October 2026: "Found: last swept 7 hours ago" on a morning the sweep had run twenty-three minutes before and found nothing to
   * store. The check was reading when the newest email arrived, which is a fact about the post and not about the sweep.
   */
  test("seven quiet hours from a sweep that ran minutes ago is an empty mailbox, not a dead sweep", () => {
    const c = check({ lastSweptAt: "2026-09-17T16:40:00.000Z", lastSweepResult: "0 stored, 0 rejected, 0 ignored" }, "The mailbox is being swept");
    assert.equal(c.ok, true);
    assert.equal(c.observed, "last swept within the hour");
    assert.equal(c.difference, null);
  });

  test("a sweep that ran a moment ago and ended in an error has not collected the post", () => {
    const c = check({ lastSweptAt: "2026-09-17T16:40:00.000Z", lastSweepResult: "0 stored, 0 rejected, 0 ignored, 1 error(s) — the mailbox refused the password" }, "The mailbox is being swept");
    assert.equal(c.ok, false);
    assert.equal(c.observed, "last swept within the hour, and that run ended with an error");
    assert.match(c.difference!, /ended with an error/);
  });

  test("an error after other mail was filed still counts, because the message that failed is sitting unread", () => {
    const c = check({ lastSweptAt: "2026-09-17T15:00:00.000Z", lastSweepResult: "3 stored, 0 rejected, 1 ignored, 2 error(s) — one attachment would not open" }, "The mailbox is being swept");
    assert.equal(c.ok, false);
    assert.equal(c.observed, "last swept 2 hours ago, and that run ended with an error");
  });

  test("a stale sweep that also ended in an error is said as nothing arriving", () => {
    const c = check({ lastSweptAt: "2026-09-16T17:00:00.000Z", lastSweepResult: "0 stored, 0 rejected, 0 ignored, 1 error(s) — timed out" }, "The mailbox is being swept");
    assert.equal(c.ok, false);
    assert.match(c.difference!, /Nothing is arriving/);
  });

  test("the sweep still writes ', N error(s)' into its result, which is the only way a failed run can be told from a clean one", () => {
    assert.match(fs.readFileSync("src/lib/mailbox.ts", "utf8"), /\$\{result\.errors\.length\} error\(s\)/);
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
    assert.match(s, /^2 of 10 failing\. Should be: /, "a rule said bare after 'failing:' reads as though it held");
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

  /*
   * The other half of the same absence, and the reason both checks exist rather than one. On 18
   * September the accrual side carried $28,645.57 that was never earned twice and the cash side
   * was missing $99,238.84 that had genuinely arrived — one overstating profit, one understating
   * it, neither visible anywhere.
   */
  test("a remittance the payer has paid and nothing has banked is a failure in money", () => {
    const c = check(
      { remittancesNotBanked: 9, remittancesNotBankedCents: 9_923_884 },
      "Money the payer says it has sent has reached the cash account",
    );
    assert.equal(c.ok, false);
    assert.equal(c.kind, "money");
    assert.match(c.observed, /^9 of the 51 remittances with a payment number, advised since the books began, are advised as paid and not banked, \$99,238\.84 between them/);
    assert.match(c.observed, /\$99,238\.84/);
    assert.match(c.difference!, /^\$99,238\.84 is advised as paid and no receipt carries its payment number\. Two causes look the same here/, "says what is known, not that the money arrived");
    assert.match(c.difference!, /or the payer has advised it and not yet paid it/, "names the cause that is not the site's gap");
    assert.match(c.difference!, /Payments export/, "names the file that fixes it");
    assert.match(c.difference!, /unless that deposit already stands for another remittance of the same amount/, "two remittances of one amount are two deposits: a deposit of that amount settles it only when it is not already the other one's");
  });

  test("one remittance is said as one, with no 'between them'", () => {
    const c = check(
      { remittancesNotBanked: 1, remittancesNotBankedCents: 200_800 },
      "Money the payer says it has sent has reached the cash account",
    );
    assert.equal(c.ok, false);
    assert.match(c.observed, /^1 of the 51 remittances with a payment number, advised since the books began, is advised as paid and not banked, \$2,008\.00/);
    assert.doesNotMatch(c.observed, /between them/);
  });

  test("an empty register with remittances posted is a failure, not a clean bill", () => {
    /*
     * Exactly what this check did on the day it was written. The import had already run, the
     * register was built afterwards, and "every remittance has its cash" was true because no
     * remittance was known — the reassuring sentence, from no evidence at all. Pre-flight question
     * eight, in a test: could the check pass for the wrong reason?
     */
    const c = check(
      { remittanceRegisterRows: 0, remittancePaymentsPosted: 1346 },
      "Money the payer says it has sent has reached the cash account",
    );
    assert.equal(c.ok, false, "a check measuring nothing must not report success");
    assert.match(c.observed, /register holds none of them/);
    assert.match(c.difference!, /measuring nothing/);
  });

  test("an empty register with nothing posted says so rather than failing", () => {
    // Never measured is a state of its own: there is genuinely nothing to compare yet.
    const c = check(
      { remittanceRegisterRows: 0, remittancePaymentsPosted: 0 },
      "Money the payer says it has sent has reached the cash account",
    );
    assert.equal(c.ok, true);
    assert.match(c.observed, /nothing to compare/);
  });

  /*
   * ProviderPay writes "Not matched" until it has tied a remittance to a payment. That is not the payer saying the money has not moved:
   * a cheque payer's remittance never gets a number and its cash is banked at the counter. So the check cannot look for such a
   * remittance by number, does not count it as unbanked, and does not call it "not owed" either; it says each one apart, by what
   * stands for it.
   */
  test("a remittance with no payment number is not counted as unbanked, and is not called not owed", () => {
    const c = check({ remittancesNumbered: 40, remittancesUnnumberedStanding: 1 }, BANKED);
    assert.equal(c.ok, true);
    assert.match(c.shouldBe, /One with no payment number cannot be looked for by number: ProviderPay has not matched it to a payment yet, or its payer pays by cheque and never will\. It is said apart from the count, with what stands for it/);
    assert.doesNotMatch(c.shouldBe, /not owed/);
    assert.doesNotMatch(c.observed, /owed/);
  });

  /*
   * What the green line claims to have looked at.
   *
   * On 28 September it read "all 51 remittances with a payment number have their cash" when 46 carried one and the newest was eleven
   * days old: the pull being monthly and by hand, which is his decision and not a fault. On 6 October it read "all 62" when 22 of them
   * were advised before the books began, which the figure it was compared with did not count. The money was right; the sentence
   * described a wider and more recent look than had happened, and that is the sentence somebody acts on.
   */
  test("it counts the remittances it judges, not every row in the register", () => {
    const c = check({ remittanceRegisterRows: 69, remittancesNumbered: 40 }, BANKED);
    assert.equal(c.ok, true);
    assert.match(c.observed, /^all 40 remittances with a payment number, advised since the books began, have their cash/);
    assert.doesNotMatch(c.observed, /69/, "the size of the register is not the population judged");
  });

  test("the rows with no payment number are said apart, by what stands for each, and not netted out of the count", () => {
    const c = check(
      {
        remittanceRegisterRows: 69,
        remittancesNumbered: 40,
        remittancesUnnumberedStanding: 4,
        remittancesWaiting: [
          { payer: "Invented Payer B", remitOn: "2026-09-30", amountCents: 2_700_000 },
          { payer: "Invented Payer A", remitOn: "2026-09-23", amountCents: 150_000 },
        ],
        remittanceRegisterThrough: "2026-09-30",
        remittanceRegisterReadOn: "2026-10-01",
        today: "2026-10-06",
      },
      BANKED,
    );
    assert.equal(c.ok, true, "a remittance that cannot be looked for by number does not fail the check");
    assert.equal(
      c.observed,
      "all 40 remittances with a payment number, advised since the books began, have their cash; 6 other remittances carry no payment number yet: 4 have a receipt standing for them, by remittance number or amount, and 2 have nothing standing for them yet and are waiting (Invented Payer B, advised 2026-09-30, $27,000.00; Invented Payer A, advised 2026-09-23, $1,500.00); the last ProviderPay export was read 2026-10-01 (5 days ago) and holds advice to 2026-09-30",
    );
  });

  test("one with a receipt standing for it, and one waiting, are each said in the singular", () => {
    const stands = check({ remittancesNumbered: 40, remittancesUnnumberedStanding: 1 }, BANKED).observed;
    assert.match(stands, /; 1 other remittance carries no payment number yet: 1 has a receipt standing for it, by remittance number or amount; the last ProviderPay export/);
    const waits = check({ remittancesNumbered: 40, remittancesWaiting: [{ payer: "Invented Payer A", remitOn: "2026-09-23", amountCents: 150_000 }] }, BANKED).observed;
    assert.match(waits, /; 1 other remittance carries no payment number yet: 1 has nothing standing for it yet and is waiting \(Invented Payer A, advised 2026-09-23, \$1,500\.00\); the last ProviderPay export/);
  });

  test("with none standing and none waiting it says nothing about remittances without a number", () => {
    assert.doesNotMatch(check({ remittancesNumbered: 40 }, BANKED).observed, /no payment number yet/);
  });

  test("a waiting remittance whose payer or date was never captured is said, not left blank", () => {
    const c = check({ remittancesWaiting: [{ payer: null, remitOn: null, amountCents: 150_000 }] }, BANKED);
    assert.match(c.observed, /\(payer not captured, advised date not captured, \$1,500\.00\)/);
  });

  test("more waiting than it names are counted: the first three in the order given, and how many it left out", () => {
    const waiting = [4, 3, 2, 1].map((n) => ({ payer: `Invented Payer ${n}`, remitOn: `2026-09-2${n}`, amountCents: n * 100_000 }));
    const c = check({ remittancesWaiting: waiting }, BANKED);
    assert.match(
      c.observed,
      /; 4 other remittances carry no payment number yet: 4 have nothing standing for them yet and are waiting \(Invented Payer 4, advised 2026-09-24, \$4,000\.00; Invented Payer 3, advised 2026-09-23, \$3,000\.00; Invented Payer 2, advised 2026-09-22, \$2,000\.00; and 1 more\)/,
    );
    assert.doesNotMatch(c.observed, /Invented Payer 1,/, "the fourth is counted, not named");
  });

  test("where no remittance since the books began carries a payment number it says there is nothing to compare, and what the rest are", () => {
    const waiting = [
      { payer: "Invented Payer A", remitOn: "2026-09-23", amountCents: 150_000 },
      { payer: "Invented Payer B", remitOn: "2026-09-30", amountCents: 90_000 },
    ];
    const c = check({ remittancesNumbered: 0, remittancesWaiting: waiting }, BANKED);
    assert.match(
      c.observed,
      /^no remittance advised since the books began carries a payment number, so there is nothing for this check to compare; 2 remittances carry no payment number yet: 2 have nothing standing for them yet and are waiting \(/,
    );
    assert.doesNotMatch(c.observed, /other remittances/, "there is no other kind for these to be other than");
    assert.equal(c.ok, true, "waiting for a number is not a failure: how long an advice may wait before it is late is the owner's to say, and this check does not guess");
  });

  /*
   * An advice of $0.00 or less is not money sent. Counted among the remittances with a payment number it would be "advised as paid and not
   * banked" for ever, because no bank line holds nothing; so it is left out of every count and said apart, in whichever sentence the check
   * ends up saying, and it is not a failure.
   */
  test("an advice of nothing or less is said apart in every branch, is in no count, and is not a failure", () => {
    const apart = /; 2 advices of nothing or less are not money sent and are not judged/;
    assert.match(check({ remittancesNotPositive: 2 }, BANKED).observed, apart, "everything else banked");
    assert.match(check({ remittancesNumbered: 0, remittancesNotPositive: 2 }, BANKED).observed, apart, "no other advice carries a number");
    const unbanked = check(
      {
        remittancesNotBanked: 1,
        remittancesNotBankedCents: 150_000,
        unbankedRemittances: [{ payer: "Invented Payer A", remitOn: "2026-09-20", amountCents: 150_000, tie: null, history: { state: "none" } }],
        remittancesNumbered: 40,
        remittancesNotPositive: 2,
      },
      BANKED,
    );
    assert.match(unbanked.observed, apart, "one unbanked");
    assert.match(unbanked.observed, /^1 of the 40 remittances with a payment number/, "the two are not in the 40");
    assert.match(check({ remittancesNotPositive: 1 }, BANKED).observed, /; 1 advice of nothing or less is not money sent and is not judged/);
    assert.doesNotMatch(check({}, BANKED).observed, /of nothing or less/, "said only where there is one");
    assert.equal(check({ remittancesNotPositive: 2 }, BANKED).ok, true, "being advised nothing is not a failure");
  });

  test("it says when the last export was read and how far its advice reaches, so a green line cannot read as today's", () => {
    const c = check({ remittanceRegisterThrough: "2026-09-06", remittanceRegisterReadOn: "2026-09-10", today: "2026-09-17" }, BANKED);
    assert.equal(c.ok, true, "a monthly pull is the design, so a gap is not a failure");
    assert.match(c.observed, /; the last ProviderPay export was read 2026-09-10 \(7 days ago\) and holds advice to 2026-09-06$/);
  });

  test("an export read today, or yesterday, says so rather than counting nought days", () => {
    assert.match(check({ remittanceRegisterReadOn: "2026-09-17", today: "2026-09-17" }, BANKED).observed, /was read 2026-09-17 \(today\)/);
    assert.match(check({ remittanceRegisterReadOn: "2026-09-16", today: "2026-09-17" }, BANKED).observed, /was read 2026-09-16 \(yesterday\)/);
  });

  test("the horizon is named on a failing line too, not only a passing one", () => {
    const c = check(
      { remittancesNotBanked: 3, remittancesNotBankedCents: 250_000, remittanceRegisterThrough: "2026-09-06", remittanceRegisterReadOn: "2026-09-10", today: "2026-09-17" },
      BANKED,
    );
    assert.equal(c.ok, false);
    assert.match(c.observed, /; the last ProviderPay export was read 2026-09-10 \(7 days ago\) and holds advice to 2026-09-06$/);
  });

  test("a date it was never given is not invented: only the one it has, or neither", () => {
    assert.match(check({ remittanceRegisterReadOn: null, remittanceRegisterThrough: "2026-09-06" }, BANKED).observed, /; the last ProviderPay export holds advice to 2026-09-06$/);
    assert.match(check({ remittanceRegisterReadOn: "2026-09-10", remittanceRegisterThrough: null, today: "2026-09-17" }, BANKED).observed, /; the last ProviderPay export was read 2026-09-10 \(7 days ago\)$/);
    assert.doesNotMatch(check({ remittanceRegisterReadOn: null, remittanceRegisterThrough: null }, BANKED).observed, /ProviderPay export/);
  });
});

/*
 * The line he reads and the page it sends him to.
 *
 * 6 October 2026: three findings, one "See it" link, and it went to Money for all three, a page that shows none of them. The page that
 * shows a finding belongs to the check that found it, so the check carries it, and a finding that has a thing to look at names it.
 * Every name and amount below is invented.
 */
describe("where each finding sends him", () => {
  test("every check names a page that exists and has not been retired", () => {
    for (const c of runDailyCheck(wellRun)) {
      const where = c.href.split("?")[0];
      assert.match(c.href, /^\//, c.what + " sends nowhere");
      assert.ok(c.action.length > 8, c.what + " has no words on its button");
      assert.equal(isRetired(where), false, c.what + " sends to a retired page, " + where);
      assert.ok(fs.existsSync("src/app/(app)" + where + "/page.tsx"), c.what + " sends to " + where + ", which is not a page");
    }
  });

  test("the three findings of 6 October 2026 go to three different pages", () => {
    const failing = runDailyCheck({
      ...wellRun,
      today: "2026-10-06",
      now: "2026-10-06T13:00:00.000Z",
      lastSweptAt: "2026-10-05T10:00:00.000Z",
      invoicesShort: 1,
      invoicesShortCents: 2031,
      shortInvoices: [{ supplier: "Invented Wholesale Co", invoiceOn: "2026-10-06", shortCents: 2031 }],
      remittancesNotBanked: 1,
      remittancesNotBankedCents: 200_800,
      unbankedRemittances: [{ payer: "Invented Payer A", remitOn: "2026-09-15", amountCents: 200_800, tie: "amount in window", history: { state: "none" } }],
      remittanceRegisterThrough: "2026-09-30",
      remittanceRegisterReadOn: "2026-10-01",
    }).filter((c) => !c.ok);
    assert.equal(failing.length, 3);
    assert.deepEqual(failing.map((c) => c.href.split("?")[0]).sort(), ["/inventory/invoices", "/remits", "/settings/email"]);
  });

  test("the dashboard gives each failing check its own link and no longer guesses one from the words of the findings", () => {
    const src = fs.readFileSync("src/app/(app)/dashboard/page.tsx", "utf8");
    assert.match(src, /href: c\.href/);
    assert.match(src, /action: c\.action/);
    assert.doesNotMatch(src, /remit\|payment\|banked/, "the guess that sent the remittance finding to Money for want of a word");
  });
});

describe("a short invoice is named, so it can be found in a drawer", () => {
  const lone = { invoicesShort: 1, invoicesShortCents: 2031, shortInvoices: [{ supplier: "Invented Wholesale Co", invoiceOn: "2026-10-06", shortCents: 2031 }] };

  test("one is named by who billed it and the day on it, and the link finds it", () => {
    const c = check(lone, SHORT);
    assert.equal(c.ok, false);
    assert.equal(c.observed, "1 invoice short by $20.31 (Invented Wholesale Co, 2026-10-06)");
    assert.equal(c.href, "/inventory/invoices?supplier=Invented+Wholesale+Co&on=2026-10-06");
    assert.equal(c.action, "See the invoice");
  });

  test("a name with an ampersand in it is encoded, or the link finds nothing", () => {
    const c = check({ ...lone, shortInvoices: [{ supplier: "Q&A Invented Supply", invoiceOn: "2026-10-06", shortCents: 2031 }] }, SHORT);
    assert.equal(c.href, "/inventory/invoices?supplier=Q%26A+Invented+Supply&on=2026-10-06");
  });

  test("several are named largest first, three at most, with how many it left out", () => {
    const five = [
      { supplier: "Invented Wholesale Co", invoiceOn: "2026-10-06", shortCents: 2031 },
      { supplier: "Other Invented Supply", invoiceOn: "2026-10-02", shortCents: 500 },
      { supplier: "Invented Wholesale Co", invoiceOn: "2026-09-28", shortCents: 300 },
      { supplier: "Third Invented Supply", invoiceOn: "2026-09-20", shortCents: 200 },
      { supplier: "Fourth Invented Supply", invoiceOn: "2026-09-15", shortCents: 100 },
    ];
    const c = check({ invoicesShort: 7, invoicesShortCents: 3_300, shortInvoices: five }, SHORT);
    assert.equal(
      c.observed,
      "7 invoices short by $33.00 in total (Invented Wholesale Co, 2026-10-06, $20.31 short; Other Invented Supply, 2026-10-02, $5.00 short; Invented Wholesale Co, 2026-09-28, $3.00 short; and 4 more)",
    );
    assert.equal(c.href, "/inventory/invoices?supplier=Invented+Wholesale+Co&on=2026-10-06", "the link goes to the one that costs the most");
    assert.equal(c.action, "See the invoices");
    assert.match(c.reads, /Up to 3 are named, the largest shortfall first\./, "what the line says it names is what it names");
    assert.equal((c.fingerprint!.match(/@/g) ?? []).length, 5, "the fingerprint tells apart the five the store gathers, though the sentence names three");
  });

  test("an invoice whose supplier or date was never captured says so rather than naming nobody", () => {
    const c = check({ invoicesShort: 1, invoicesShortCents: 500, shortInvoices: [{ supplier: null, invoiceOn: null, shortCents: 500 }] }, SHORT);
    assert.equal(c.observed, "1 invoice short by $5.00 (supplier not captured, date not captured)");
    assert.equal(c.href, "/inventory/invoices");
  });
});

describe("a remittance not banked is named, with what the bank matcher says of it", () => {
  const NO_HISTORY: History = { state: "none" };
  const advised = (tie: Tie, over: Partial<Facts["unbankedRemittances"][number]> = {}): Partial<Facts> => ({
    remittancesNotBanked: 1,
    remittancesNotBankedCents: 200_800,
    unbankedRemittances: [{ payer: "Invented Payer A", remitOn: "2026-09-15", amountCents: 200_800, tie, history: NO_HISTORY, ...over }],
    remittancesNumbered: 40,
    remittanceRegisterThrough: "2026-09-30",
    remittanceRegisterReadOn: "2026-10-01",
    today: "2026-10-06",
  });

  /*
   * The card judges a remittance banked by the computation the Remits tab uses (engine/remit-standing.ts), except that a receipt of exactly
   * its amount near its advice date does not count: two remittances of one amount are two deposits, and one receipt cannot be both. Where
   * only that weakest tie exists the Remits tab shows the remittance as standing, so a card that said only "not banked" would contradict
   * it. It still FAILS, and says what stands for it.
   */
  test("a receipt that stands for it by amount alone is said, and the check still fails", () => {
    const c = check(advised("amount in window"), BANKED);
    assert.equal(c.ok, false);
    assert.equal(
      c.observed,
      "1 of the 40 remittances with a payment number, advised since the books began, is advised as paid and not banked, $2,008.00 (Invented Payer A, advised 2026-09-15: a receipt of exactly that amount, near the advice date, stands for it by amount alone and not by its payment number, and no ProviderPay account history is on file to look in); the last ProviderPay export was read 2026-10-01 (5 days ago) and holds advice to 2026-09-30",
    );
    assert.equal(c.href, "/remits");
    assert.equal(c.action, "See the remittances");
  });

  /*
   * A receipt of the same amount cannot say whose money it is; the account history can, because it names each deposit by its payment
   * number. So a remittance that only an amount stands for says what the history holds as well, or the card tells him there is a question
   * and not where the answer is. None of these makes it banked (the history would have banked it), so each still fails.
   */
  test("a receipt that stands for it by amount alone also says what the account history holds", () => {
    const cases: [History, RegExp][] = [
      [{ state: "reaches past", through: "2026-09-30" }, /by its payment number, and ProviderPay's account history on file \(to 2026-09-30\) holds no deposit under its payment number\)/],
      [{ state: "holds a deposit", on: "2026-09-24" }, /by its payment number, and ProviderPay's account history holds a deposit under its payment number, dated 2026-09-24, that is not shown reaching a bank line already placed\)/],
      [{ state: "ends too soon", through: "2026-09-24" }, /by its payment number, and the newest ProviderPay account history on file ends 2026-09-24, too soon after it was advised to show its deposit either way\)/],
      [{ state: "has a gap", month: "2026-09" }, /by its payment number, and no ProviderPay account history on file covers 2026-09, so it cannot show its deposit either way\)/],
    ];
    for (const [history, words] of cases) {
      const c = check(advised("amount in window", { history }), BANKED);
      assert.equal(c.ok, false, history.state);
      assert.match(c.observed, words, history.state);
    }
  });

  test("a payer or a date that was never captured is said, not left blank", () => {
    const c = check(advised(null, { payer: null, remitOn: null }), BANKED);
    assert.match(c.observed, /\(payer not captured, advised date not captured: /);
  });

  /*
   * "No receipt stands for it" is four different things, and the card used to say one of them for all four. On 6 October 2026 the
   * remittance advised on the 15th had its deposit in ProviderPay's September account history under its own payment number, and the
   * card said no history showed it. Each sentence below is what is true of that state and no other.
   */
  test("where nothing stands for it and no account history is on file, it says there is none to look in", () => {
    assert.match(
      check(advised(null, { history: { state: "none" } }), BANKED).observed,
      /advised 2026-09-15: no receipt stands for it, by payment number, remittance number or amount, and no ProviderPay account history is on file to look in\)/,
    );
  });

  test("where the newest history ends too soon after the advice, it says so rather than that nothing was found", () => {
    assert.match(
      check(advised(null, { history: { state: "ends too soon", through: "2026-09-24" } }), BANKED).observed,
      /and the newest ProviderPay account history on file ends 2026-09-24, too soon after it was advised to show its deposit either way\)/,
    );
  });

  test("where no history on file covers the month the deposit would fall in, it says there is a gap and not that nothing was found", () => {
    const c = check(advised(null, { history: { state: "has a gap", month: "2026-08" } }), BANKED);
    assert.match(c.observed, /and no ProviderPay account history on file covers 2026-08, so it cannot show its deposit either way\)/);
    assert.doesNotMatch(c.observed, /holds no deposit|too soon|is on file to look in/, "a month with no file is not a month with nothing in it");
    assert.equal(c.ok, false);
  });

  test("where the history reaches past the advice and holds nothing under its payment number, it says that", () => {
    assert.match(
      check(advised(null, { history: { state: "reaches past", through: "2026-09-30" } }), BANKED).observed,
      /and ProviderPay's account history on file \(to 2026-09-30\) holds no deposit under its payment number\)/,
    );
  });

  test("where the history holds the deposit and no placed bank line was shown to carry it, it says the deposit is there", () => {
    const c = check(advised(null, { history: { state: "holds a deposit", on: "2026-09-24" } }), BANKED);
    assert.match(c.observed, /and ProviderPay's account history holds a deposit under its payment number, dated 2026-09-24, that is not shown reaching a bank line already placed\)/);
    assert.doesNotMatch(c.observed, /holds no deposit|too soon|no ProviderPay account history is on file/, "it must not also say the history does not show it");
  });

  test("several are named largest first with their amounts, three at most, and the rest counted", () => {
    const here = (payer: string, remitOn: string, amountCents: number, tie: Tie) => ({ payer, remitOn, amountCents, tie, history: NO_HISTORY });
    const c = check(
      {
        remittancesNotBanked: 5,
        remittancesNotBankedCents: 600_000,
        remittancesNumbered: 40,
        unbankedRemittances: [
          here("Invented Payer A", "2026-09-15", 200_800, "amount in window"),
          here("Invented Payer D", "2026-09-18", 120_000, null),
          here("Invented Payer E", "2026-09-12", 90_000, null),
          here("Invented Payer C", "2026-09-10", 75_500, null),
        ],
      },
      BANKED,
    );
    assert.match(c.observed, /^5 of the 40 remittances with a payment number, advised since the books began, are advised as paid and not banked, \$6,000\.00 between them \(Invented Payer A, advised 2026-09-15, \$2,008\.00: /);
    assert.match(c.observed, /Invented Payer E, advised 2026-09-12, \$900\.00: no receipt stands for it[^;]*; and 2 more\)/);
    assert.doesNotMatch(c.observed, /Invented Payer C/, "the fourth is counted, not named");
  });
});

describe("a remittance banked by the account history is said, so the evidence is not hidden by the count", () => {
  /*
   * ProviderPay's account history can show a remittance's deposit reaching a placed bank line when no receipt carries its payment number
   * (a deposit labelled with the next remittance of the same amount). Those are banked, so they are in neither count; the card has to
   * say how it knew, because "all 46 have their cash" would otherwise read as receipts when it is a file.
   */
  const through = { remittanceRegisterRows: 51, remittancesNumbered: 46, remittanceRegisterThrough: "2026-09-30", remittanceRegisterReadOn: "2026-10-01", today: "2026-10-06" };
  const unbanked = (over: Partial<Facts> = {}): Partial<Facts> => ({
    ...through,
    remittancesNotBanked: 1,
    remittancesNotBankedCents: 150_000,
    unbankedRemittances: [{ payer: "Invented Payer B", remitOn: "2026-09-20", amountCents: 150_000, tie: null, history: { state: "reaches past", through: "2026-09-30" } }],
    ...over,
  });

  test("one swept remittance passes, and the line says it was the account history", () => {
    const c = check({ ...through, remittancesBankedBySweep: 1 }, BANKED);
    assert.equal(c.ok, true);
    assert.equal(
      c.observed,
      "all 46 remittances with a payment number, advised since the books began, have their cash; 1 of them is shown banked by ProviderPay's account history, not by a receipt carrying the payment number; the last ProviderPay export was read 2026-10-01 (5 days ago) and holds advice to 2026-09-30",
    );
  });

  test("several swept remittances are said in the plural", () => {
    assert.match(check({ ...through, remittancesBankedBySweep: 3 }, BANKED).observed, /; 3 of them are shown banked by ProviderPay's account history, not by a receipt carrying the payment number;/);
  });

  test("none swept says nothing about the account history, so a passing line does not claim evidence it does not have", () => {
    assert.doesNotMatch(check({ ...through, remittancesBankedBySweep: 0 }, BANKED).observed, /account history/);
    assert.doesNotMatch(check({}, BANKED).observed, /account history/);
  });

  test("swept remittances do not hide one that is still not banked, and the card counts them apart", () => {
    const c = check(unbanked({ remittancesBankedBySweep: 1 }), BANKED);
    assert.equal(c.ok, false);
    assert.equal(
      c.observed,
      "1 of the 46 remittances with a payment number, advised since the books began, is advised as paid and not banked, $1,500.00 (Invented Payer B, advised 2026-09-20: no receipt stands for it, by payment number, remittance number or amount, and ProviderPay's account history on file (to 2026-09-30) holds no deposit under its payment number); 1 other is shown banked by ProviderPay's account history, not by a receipt carrying the payment number; the last ProviderPay export was read 2026-10-01 (5 days ago) and holds advice to 2026-09-30",
    );
    assert.match(check(unbanked({ remittancesBankedBySweep: 2 }), BANKED).observed, /; 2 others are shown banked by ProviderPay's account history, not by a receipt/);
  });

  test("the rule names what banks a remittance and says an amount alone is not enough", () => {
    const c = check(unbanked(), BANKED);
    assert.match(
      c.shouldBe,
      /a receipt carrying that number; or, where the receipt was banked under another remittance of the same amount, ProviderPay's account history showing the deposit under that number swept to a bank line of the same amount; or a receipt keyed to the remittance's own number\. A receipt of the same amount near the advice date is not enough for one that has a payment number, because two remittances of one amount are two deposits\./,
    );
  });

  test("the way out says what settles it, and says only what the site does", () => {
    const c = check(unbanked(), BANKED);
    assert.match(
      c.difference!,
      /ProviderPay's account history for the month shows each deposit by its payment number and each sweep to the bank; where it shows this remittance's deposit reaching a bank line, the remittance is banked and leaves this list, so one that is on it is one the history on file does not show, or does not yet reach\./,
    );
    assert.match(c.difference!, /the site can refuse its receipt as the same money as a receipt it already holds of that amount within a week, so where one is already there the account history is what settles it\./);
    assert.match(c.difference!, /Each remittance named above says what stands for it and what the history can show\.$/);
    assert.doesNotMatch(c.difference!, /settles it by payment number/, "the old way out promised a history that may already be on file");
    assert.doesNotMatch(c.difference!, /Payments export[^.]*\bties\b/, "the old way out promised the Payments export would tie the deposit; the site can refuse its receipt");
  });
});

describe("a remittance banked by a receipt keyed to its remittance number is said, as the swept ones are", () => {
  /*
   * When the register first holds a remittance without its payment number the bank matcher keys the receipt it makes to the remittance
   * number; ProviderPay's later export gives the remittance its payment number and no receipt carries that number. The money is in the cash
   * account and the evidence is a key, so a passing line that only said "have their cash" would hide how it was known.
   */
  const through = { remittanceRegisterRows: 51, remittancesNumbered: 46, remittanceRegisterThrough: "2026-09-30", remittanceRegisterReadOn: "2026-10-01", today: "2026-10-06" };

  test("one such remittance passes, and the line says how it was known", () => {
    const c = check({ ...through, remittancesBankedByRemitNumber: 1 }, BANKED);
    assert.equal(c.ok, true);
    assert.equal(
      c.observed,
      "all 46 remittances with a payment number, advised since the books began, have their cash; 1 of them is banked by a receipt keyed to the remittance number, not the payment number; the last ProviderPay export was read 2026-10-01 (5 days ago) and holds advice to 2026-09-30",
    );
  });

  test("several are said in the plural", () => {
    assert.match(check({ ...through, remittancesBankedByRemitNumber: 3 }, BANKED).observed, /; 3 of them are banked by a receipt keyed to the remittance number, not the payment number;/);
  });

  test("none says nothing about it, so a passing line does not claim evidence it does not have", () => {
    assert.doesNotMatch(check({ ...through, remittancesBankedByRemitNumber: 0 }, BANKED).observed, /remittance number/);
    assert.doesNotMatch(check({}, BANKED).observed, /remittance number/);
  });

  test("both kinds are said together with their own counts, and neither hides one still not banked", () => {
    const both = check({ ...through, remittancesBankedBySweep: 1, remittancesBankedByRemitNumber: 2 }, BANKED);
    assert.equal(both.ok, true);
    assert.match(
      both.observed,
      /have their cash; 1 of them is shown banked by ProviderPay's account history, not by a receipt carrying the payment number; 2 of them are banked by a receipt keyed to the remittance number, not the payment number; the last/,
    );
    const failing = check(
      {
        ...through,
        remittancesBankedByRemitNumber: 1,
        remittancesNotBanked: 1,
        remittancesNotBankedCents: 150_000,
        unbankedRemittances: [{ payer: "Invented Payer B", remitOn: "2026-09-20", amountCents: 150_000, tie: null, history: { state: "reaches past", through: "2026-09-30" } }],
      },
      BANKED,
    );
    assert.equal(failing.ok, false);
    assert.match(failing.observed, /; 1 other is banked by a receipt keyed to the remittance number, not the payment number; the last ProviderPay export/);
  });
});

describe("a morning check that could not run says so, and does not read as all clear", () => {
  test("it is one failing check that says nothing was measured, with the reason", () => {
    const r = checkCouldNotRun(new Error("no such table: invented_table"), "2026-10-07T12:00:00.000Z");
    assert.equal(r.checks.length, 1);
    assert.equal(r.failing, 1);
    assert.equal(r.ranAt, "2026-10-07T12:00:00.000Z");
    assert.deepEqual(r.open, r.checks, "the card is built from the open checks, so it must be on the card");
    assert.deepEqual(r.setAside, []);
    assert.deepEqual(r.wrongAlarms, { notMeasured: "check did not run" }, "the count of wrong alarms was never tried, and is not a count of none");
    assert.match(wrongAlarmsSaid(r.wrongAlarms)!, /not measured just now, because the morning check could not run\./);
    const c = r.checks[0];
    assert.equal(c.key, "check-ran");
    assert.equal(c.fingerprint, null, "no fingerprint, so no press can ever set it aside");
    assert.equal(c.ok, false);
    assert.equal(c.what, "The morning check runs");
    assert.match(c.observed, /^not measured: the check could not run \(no such table: invented_table\)/);
    assert.equal(c.href, "/");
    assert.equal(c.action, "Try again");
    assert.doesNotMatch(r.says, /pass|all clear|nothing/i, "what it says must not read as a pass");
  });

  test("only the first line of the reason is shown, long digit runs are masked, and it is cut at 160 characters", () => {
    const masked = checkCouldNotRun(new Error("failed on 123456789012 and 4821\nat internal stack line"));
    assert.match(masked.checks[0].observed, /failed on ##### and 4821\)/);
    assert.doesNotMatch(masked.checks[0].observed, /123456789012|stack line/);
    const long = checkCouldNotRun(new Error("x".repeat(500)));
    assert.match(long.checks[0].observed, /\(x{160}\)/);
    assert.doesNotMatch(long.checks[0].observed, /x{161}/);
  });

  test("a reason that is not an error still says it did not run, and does not invent a cause", () => {
    for (const reason of [undefined, null, 42, {}]) {
      const c = checkCouldNotRun(reason).checks[0];
      assert.equal(c.ok, false);
      assert.equal(c.observed, "not measured: the check could not run, so nothing it looks at was looked at just now");
    }
    assert.match(checkCouldNotRun("plain text reason").checks[0].observed, /\(plain text reason\)/);
  });

  test("Today shows it: the dashboard turns a failed run into this and no longer into an empty list", () => {
    const src = fs.readFileSync("src/app/(app)/dashboard/page.tsx", "utf8");
    assert.match(src, /dailyCheck\(\)\.catch\(\(e\) => checkCouldNotRun\(e\)\)/);
    assert.doesNotMatch(src, /checks: \[\], failing: 0/, "an empty list with none failing is what a check that never ran looked like");
    assert.match(src, /for \(const c of health\.open\)/, "the card is built from the open checks, which include this one");
  });
});

/**
 * What he can say about a finding (rule 4 of CLAUDE.md).
 *
 * A press on a line of the card is kept against the check's key and what the finding found (its fingerprint). These pin the two things a
 * press stands on: that every check has a name that is never reworded, and that its fingerprint is the finding. It moves when the
 * things found move, so a press never covers a finding he has not seen; it does not move with the totals the finding is read against
 * (an ordinary delivery, a routine import), so a press survives them; and it moves with the clock only where the finding is worse for
 * the time passing (whole days since a sweep, 30-day steps of a statement's age). What no test can fail is whether a line's `reads`
 * sentence is true of the code: that is read by a person, which is why the line carries it on the screen.
 */
const KEYS = [
  "inbox-rows",
  "invoice-documents",
  "rebate-statement",
  "invoices-short",
  "mailbox-swept",
  "booked-no-document",
  "offsets-dated-paid",
  "doubled-ladders",
  "payments-counted-twice",
  "remittances-banked",
];

describe("every check can be named, says what it reads, and can be set aside", () => {
  test("ten keys that must not be reworded, each with a sentence on what it reads, a page to look at and a fingerprint", () => {
    const checks = runDailyCheck(wellRun);
    assert.deepEqual(checks.map((c) => c.key).sort(), [...KEYS].sort());
    for (const c of checks) {
      assert.ok(c.reads.length > 60, `${c.key} says nothing of what it reads`);
      assert.match(c.href, /^\/[a-z]/, `${c.key} has no page to look at`);
      assert.ok(c.fingerprint !== null && c.fingerprint.length > 0, `${c.key} cannot be set aside`);
    }
  });
});

const byKey = (key: string, f: Partial<Facts>): Check => {
  const c = runDailyCheck({ ...wellRun, ...f }).find((x) => x.key === key);
  assert.ok(c, `no check keyed ${key}`);
  return c;
};

const LATER: Partial<Facts> = { today: "2026-09-19", now: "2026-09-19T17:00:00.000Z" };
const REMIT = { payer: "Invented Payer B", remitOn: "2026-09-20", amountCents: 150_000, tie: null as Tie, history: { state: "reaches past", through: "2026-09-30" } as History };
const unbanked = (r: Partial<typeof REMIT>): Partial<Facts> => {
  const x = { ...REMIT, ...r };
  return { remittancesNotBanked: 1, remittancesNotBankedCents: x.amountCents, unbankedRemittances: [x] };
};
const SHORT_ONE: Partial<Facts> = {
  invoicesShort: 1,
  invoicesShortCents: 2031,
  shortInvoices: [{ supplier: "Invented Wholesale Co", invoiceOn: "2026-10-06", shortCents: 2031 }],
};

type Case = {
  key: string;
  fail: Partial<Facts>;
  later: Partial<Facts>;
  /** Facts that move without the finding moving: a press made on the base finding must still cover these. */
  same?: { why: string; facts: Partial<Facts> }[];
  changed: { why: string; facts: Partial<Facts> }[];
};

const CASES: Case[] = [
  {
    key: "inbox-rows",
    fail: { inboxRows: 200 },
    later: LATER,
    // The finding is the surplus (20 rows over their deliveries), not the totals: an ordinary delivery adds a row and an arrival together.
    same: [{ why: "an ordinary delivery adds a row and an arrival together", facts: { inboxRows: 201, inboxArrivals: 181 } }],
    changed: [
      { why: "one more row", facts: { inboxRows: 201 } },
      { why: "fewer arrivals for the same rows", facts: { inboxArrivals: 170 } },
    ],
  },
  {
    key: "invoice-documents",
    fail: { invoiceDocumentRows: 70 },
    later: LATER,
    same: [{ why: "a new invoice adds a record and a file together", facts: { invoiceDocumentRows: 71, invoiceDocumentFiles: 65 } }],
    changed: [{ why: "one more duplicate", facts: { invoiceDocumentRows: 71 } }],
  },
  {
    key: "rebate-statement",
    fail: { standingRebatePeriodTo: "2026-06-01" },
    later: LATER,
    // 2026-06-01 to 2026-09-17 is 108 days, the third 30-day step; the third step ends on the 119th day and the fourth begins on the 120th.
    same: [{ why: "the same statement on the last day of its 30-day step", facts: { today: "2026-09-28" } }],
    changed: [
      { why: "a different, still old statement is standing", facts: { standingRebatePeriodTo: "2026-06-30" } },
      { why: "no statement standing is not an old one", facts: { standingRebatePeriodTo: null } },
      { why: "the same statement on the first day of its next 30-day step", facts: { today: "2026-09-29" } },
    ],
  },
  {
    key: "invoices-short",
    fail: SHORT_ONE,
    later: LATER,
    changed: [
      {
        why: "a second invoice is short",
        facts: {
          invoicesShort: 2,
          invoicesShortCents: 2531,
          shortInvoices: [...SHORT_ONE.shortInvoices!, { supplier: "Other Invented Supply", invoiceOn: "2026-10-02", shortCents: 500 }],
        },
      },
      { why: "the same total on a different invoice", facts: { shortInvoices: [{ supplier: "Other Invented Supply", invoiceOn: "2026-10-06", shortCents: 2031 }] } },
      { why: "the same invoice short by another amount", facts: { invoicesShortCents: 2100, shortInvoices: [{ supplier: "Invented Wholesale Co", invoiceOn: "2026-10-06", shortCents: 2100 }] } },
    ],
  },
  {
    key: "mailbox-swept",
    fail: { lastSweptAt: "2026-09-17T05:00:00.000Z" },
    later: { now: "2026-09-17T22:00:00.000Z" },
    // 12 hours since the sweep at the base reading: the line is the same through the 23rd hour, and another from the 24th.
    same: [{ why: "the same sweep seen late in the same day of silence", facts: { now: "2026-09-18T04:00:00.000Z" } }],
    changed: [
      { why: "the same sweep a day and more later is a longer silence", facts: { now: "2026-09-18T17:00:00.000Z" } },
      { why: "the same sweep exactly one day on", facts: { now: "2026-09-18T05:00:00.000Z" } },
      { why: "the last run ended with an error", facts: { lastSweepResult: "0 stored, 1 error(s)" } },
      { why: "never swept is not a sweep gone stale", facts: { lastSweptAt: null } },
    ],
  },
  { key: "booked-no-document", fail: { bookedWithNoDocument: 2 }, later: LATER, changed: [{ why: "one more", facts: { bookedWithNoDocument: 3 } }] },
  {
    key: "offsets-dated-paid",
    fail: { offsetsWithPaymentDates: 1, offsetsWithPaymentDatesCents: 5000 },
    later: LATER,
    changed: [
      { why: "another offset", facts: { offsetsWithPaymentDates: 2, offsetsWithPaymentDatesCents: 5000 } },
      { why: "the same offset for more money", facts: { offsetsWithPaymentDatesCents: 7000 } },
    ],
  },
  { key: "doubled-ladders", fail: { doubledRebateLadders: 1 }, later: LATER, changed: [{ why: "a second basket", facts: { doubledRebateLadders: 2 } }] },
  {
    key: "payments-counted-twice",
    fail: { paymentsCountedTwice: 3, paymentsCountedTwiceCents: 4500 },
    later: LATER,
    changed: [
      { why: "one more payment", facts: { paymentsCountedTwice: 4 } },
      { why: "the same payments for more money", facts: { paymentsCountedTwiceCents: 4600 } },
    ],
  },
  {
    key: "remittances-banked",
    fail: unbanked({}),
    // The day the export was read, the newest day it holds and the history's reach all move with every export: none is the finding.
    later: { ...LATER, remittanceRegisterReadOn: "2026-09-19", remittanceRegisterThrough: "2026-10-05", ...unbanked({ history: { state: "reaches past", through: "2026-10-05" } }) },
    changed: [
      { why: "another amount", facts: unbanked({ amountCents: 150_100 }) },
      { why: "another advice date", facts: unbanked({ remitOn: "2026-09-21" }) },
      { why: "another payer", facts: unbanked({ payer: "Invented Payer C" }) },
      { why: "an amount in the window now stands near it", facts: unbanked({ tie: "amount in window" }) },
      { why: "the history now ends too soon to say", facts: unbanked({ history: { state: "ends too soon", through: "2026-09-22" } }) },
      { why: "the history has a gap in a month", facts: unbanked({ history: { state: "has a gap", month: "2026-09" } }) },
      { why: "there is no history to look in", facts: unbanked({ history: { state: "none" } }) },
      {
        why: "a second remittance is not banked",
        facts: { remittancesNotBanked: 2, remittancesNotBankedCents: 170_000, unbankedRemittances: [REMIT, { ...REMIT, payer: "Invented Payer D", amountCents: 20_000 }] },
      },
      {
        why: "an empty register is not a register with nothing unbanked",
        facts: { remittanceRegisterRows: 0, remittancePaymentsPosted: 12, remittancesNotBanked: 0, remittancesNotBankedCents: 0, unbankedRemittances: [] },
      },
    ],
  },
];

describe("a finding's fingerprint is the finding: it moves when what was found moves, not with the totals around it, and with the clock only in whole days or 30-day steps", () => {
  test("there is a case for every check, so a check added later cannot go without one", () => {
    assert.deepEqual(CASES.map((c) => c.key).sort(), [...KEYS].sort());
  });
  for (const c of CASES) {
    test(`${c.key}: the same finding read later, or among larger totals, has the same fingerprint, and each change to what was found has another`, () => {
      const base = byKey(c.key, c.fail);
      assert.equal(base.ok, false, "the fixture must fail, or this proves nothing");
      assert.ok(base.fingerprint !== null);
      const later = byKey(c.key, { ...c.fail, ...c.later });
      assert.equal(later.ok, false, "still failing later");
      assert.equal(later.fingerprint, base.fingerprint, "only the clock moved, so a press made this morning must still cover it");
      for (const s of c.same ?? []) {
        const unmoved = byKey(c.key, { ...c.fail, ...s.facts });
        assert.equal(unmoved.ok, false, `${s.why}: the fixture must still fail`);
        assert.equal(unmoved.fingerprint, base.fingerprint, `${s.why}: what was found has not moved, so a press made on it must still cover it`);
      }
      for (const ch of c.changed) {
        const other = byKey(c.key, { ...c.fail, ...ch.facts });
        assert.equal(other.ok, false, `${ch.why}: the fixture must still fail`);
        assert.notEqual(other.fingerprint, base.fingerprint, `${ch.why}: a press made on the first finding must not cover this one`);
      }
    });
  }

  test("no fingerprint carries a payment number or any run of nine digits: it is kept in a table", () => {
    for (const c of CASES) assert.doesNotMatch(byKey(c.key, c.fail).fingerprint!, /\d{9,}/, c.key);
  });
});

describe("the mailbox line's fingerprint tells one sweep error from another, and never holds what the error said", () => {
  const ended = (summary: string, error: string): Partial<Facts> => ({ lastSweptAt: wellRun.lastSweptAt, lastSweepResult: `${summary} — ${error}` });
  const fpOf = (error: string, summary = "3 stored, 0 rejected, 0 ignored, 1 error(s)") => byKey("mailbox-swept", ended(summary, error)).fingerprint!;

  test("the same error with other numbers in it, or in a different summary, is one finding; a different error is another", () => {
    const base = fpOf("could not log in to the mailbox after 3 tries");
    assert.equal(fpOf("could not log in to the mailbox after 5 tries"), base, "a count inside the error is not a different error");
    assert.equal(fpOf("could not log in to the mailbox after 3 tries", "9 stored, 2 rejected, 0 ignored, 2 error(s)"), base, "the summary's counts are not the error");
    assert.notEqual(fpOf("could not read the folder INBOX"), base, "a different error is a different finding, so a press on the first does not cover it");
  });

  test("it is kept for good, so what the error said (an address, a server) is not in it", () => {
    const f = fpOf("login refused for invented.sender@example.test by mail.invented.example");
    assert.doesNotMatch(f, /invented|example|@|login/i);
    assert.match(f, /^recent\|error\|0\|[0-9a-f]{8}$/);
  });

  test("an error that came with no words is still an error, and is not a clean run", () => {
    const c = byKey("mailbox-swept", { lastSweptAt: wellRun.lastSweptAt, lastSweepResult: "0 stored, 1 error(s)" });
    assert.equal(c.ok, false);
    assert.match(c.fingerprint!, /^recent\|error\|0\|[0-9a-f]{8}$/);
    assert.notEqual(c.fingerprint, byKey("mailbox-swept", {}).fingerprint);
  });
});

const failingDay = (): Check[] => runDailyCheck({ ...wellRun, ...SHORT_ONE, lastSweptAt: "2026-09-17T05:00:00.000Z" });
const named = (checks: Check[], key: string) => checks.find((c) => c.key === key)!;
const markOf = (c: Check, o: Partial<Mark> = {}): Mark => ({
  id: `mark-${c.key}`,
  key: c.key,
  fingerprint: c.fingerprint ?? "",
  verdict: "settled",
  note: null,
  by: "Invented Owner",
  at: "2026-09-17T16:00:00.000Z",
  ...o,
});
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);

describe("what he has said of a finding covers that finding and no other", () => {
  test("a mark whose facts still hold sets its check aside, and leaves the others open", () => {
    const checks = failingDay();
    const r = sortMarks(checks, [markOf(named(checks, "invoices-short"))]);
    assert.deepEqual(r.open.map((c) => c.key), ["mailbox-swept"]);
    assert.deepEqual(r.setAside.map((s) => s.check.key), ["invoices-short"]);
    assert.equal(r.setAside[0].mark.id, "mark-invoices-short");
    assert.deepEqual(r.toEnd, []);
  });

  test("when what it found changes the check is open again, and the mark ends as changed", () => {
    const checks = failingDay();
    const r = sortMarks(checks, [markOf(named(checks, "invoices-short"), { fingerprint: "1|2031|Invented Wholesale Co@2026-10-05=2031" })]);
    assert.deepEqual(r.open.map((c) => c.key).sort(), ["invoices-short", "mailbox-swept"]);
    assert.deepEqual(r.setAside, []);
    assert.deepEqual(r.toEnd, [{ id: "mark-invoices-short", how: "changed" }]);
  });

  test("when the check passes the mark ends as passed, and nothing is open", () => {
    const passing = runDailyCheck(wellRun);
    const r = sortMarks(passing, [markOf(named(passing, "invoices-short"), { fingerprint: "1|2031|x" })]);
    assert.deepEqual(r.open, []);
    assert.deepEqual(r.setAside, []);
    assert.deepEqual(r.toEnd, [{ id: "mark-invoices-short", how: "passed" }]);
  });

  test("of two marks on one check the newest speaks, in whatever order they arrive, and the older ends as replaced", () => {
    const checks = failingDay();
    const short = named(checks, "invoices-short");
    const older = markOf(short, { id: "older", verdict: "wrong", at: "2026-09-17T15:00:00.000Z" });
    const newer = markOf(short, { id: "newer", verdict: "settled", at: "2026-09-17T16:00:00.000Z" });
    for (const order of [[older, newer], [newer, older]]) {
      const r = sortMarks(checks, order);
      assert.equal(r.setAside[0].mark.id, "newer");
      assert.deepEqual(r.toEnd, [{ id: "older", how: "replaced" }]);
    }
  });

  test("a newest mark that no longer fits is not rescued by an older one that does", () => {
    const checks = failingDay();
    const short = named(checks, "invoices-short");
    const older = markOf(short, { id: "older", at: "2026-09-17T15:00:00.000Z" });
    const newer = markOf(short, { id: "newer", fingerprint: "1|99|elsewhere", at: "2026-09-17T16:00:00.000Z" });
    const r = sortMarks(checks, [older, newer]);
    assert.deepEqual(r.setAside, []);
    assert.ok(r.open.some((c) => c.key === "invoices-short"));
    assert.deepEqual([...r.toEnd].sort(byId), [{ id: "newer", how: "changed" }, { id: "older", how: "replaced" }]);
  });

  test("a mark for a check that is not there is left alone", () => {
    const checks = failingDay();
    const r = sortMarks(checks, [markOf(named(checks, "invoices-short"), { id: "gone", key: "no-such-check" })]);
    assert.deepEqual(r.toEnd, []);
    assert.deepEqual(r.open.map((c) => c.key).sort(), ["invoices-short", "mailbox-swept"]);
    assert.deepEqual(r.setAside, []);
  });

  test("two marks for a check that is not there are both left alone, and are not sorted into newer and replaced", () => {
    const checks = failingDay();
    const short = named(checks, "invoices-short");
    const r = sortMarks(checks, [
      markOf(short, { id: "gone-1", key: "no-such-check", at: "2026-09-17T15:00:00.000Z" }),
      markOf(short, { id: "gone-2", key: "no-such-check", at: "2026-09-17T16:00:00.000Z" }),
    ]);
    assert.deepEqual(r.toEnd, []);
  });

  test("a finding that cannot be set aside is never covered, whatever a mark says", () => {
    const ran = checkCouldNotRun("no such table: invented_table").checks;
    for (const fingerprint of ["", "-", "check-ran"]) {
      const r = sortMarks(ran, [markOf(ran[0], { fingerprint })]);
      assert.deepEqual(r.open, ran, `a mark carrying "${fingerprint}" covered a check that could not run`);
      assert.deepEqual(r.setAside, []);
    }
  });

  test("sorting reads the marks and the checks and changes neither", () => {
    const checks = failingDay();
    const short = named(checks, "invoices-short");
    const marks = [markOf(short, { id: "older", at: "2026-09-17T15:00:00.000Z" }), markOf(short, { id: "newer", at: "2026-09-17T16:00:00.000Z" })];
    const before = JSON.stringify({ checks, marks });
    sortMarks(checks, marks);
    assert.equal(JSON.stringify({ checks, marks }), before);
  });
});

describe("the line the night stores says how many failing findings are set aside, and is never quieter than the truth", () => {
  const rule = "Should be: invoices add up to what they say they come to; the mailbox is being swept.";

  test("a set-aside finding is still counted as failing, and said to be set aside", () => {
    const checks = failingDay();
    assert.equal(summarise(checks), `2 of 10 failing. ${rule}`);
    assert.equal(summarise(checks, ["invoices-short"]), `2 of 10 failing (1 set aside). ${rule}`);
    assert.equal(summarise(checks, ["invoices-short", "mailbox-swept"]), `2 of 10 failing (2 set aside). ${rule}`);
  });

  test("a key that is not failing is not a set-aside finding, and a day that passes says it passes", () => {
    assert.equal(summarise(failingDay(), ["inbox-rows"]), `2 of 10 failing. ${rule}`);
    assert.equal(summarise(runDailyCheck(wellRun), ["invoices-short"]), "All 10 checks pass.");
  });
});

describe("how many times he has pressed \"This is wrong\" is said on Today, and not read as none when it could not be read", () => {
  test("a count that could not be read is said as not measured, with that reason, and shows no number", () => {
    const said = wrongAlarmsSaid({ notMeasured: "record unreadable" })!;
    assert.equal(said, "Times you have pressed “This is wrong”: not measured just now, because that record could not be read.");
    assert.doesNotMatch(said, /\d/);
  });

  test("a count that was never tried, because the check did not run, says that and not the other", () => {
    const said = wrongAlarmsSaid({ notMeasured: "check did not run" })!;
    assert.equal(said, "Times you have pressed “This is wrong”: not measured just now, because the morning check could not run.");
    assert.doesNotMatch(said, /\d/);
  });

  test("none pressed is left unsaid, so the line is not on every morning's screen", () => {
    assert.equal(wrongAlarmsSaid({ total: 0, lastThirtyDays: 0, since: null }), null);
  });

  test("a count is said with both numbers and the day the first was pressed, in the words the page chooses", () => {
    const w = { total: 7, lastThirtyDays: 3, since: "2026-10-07T14:00:00.000Z" };
    assert.match(wrongAlarmsSaid(w)!, /^Times you have pressed “This is wrong”: 3 in the last 30 days, 7 in all since 2026-10-07\. /);
    assert.match(wrongAlarmsSaid(w, () => "Oct 7, 2026")!, /7 in all since Oct 7, 2026\. /);
    assert.doesNotMatch(wrongAlarmsSaid({ ...w, since: null })!, /since/);
  });
});

describe("the press on the card is wired to its two actions (read from the source files, not run)", () => {
  const page = fs.readFileSync("src/app/(app)/dashboard/page.tsx", "utf8");
  const actions = fs.readFileSync("src/app/(app)/_actions/check-marks.ts", "utf8");

  test("each form carries every field its action reads, and the forms exist", () => {
    for (const field of ["key", "fingerprint", "verdict", "note", "back", "id"]) {
      assert.ok(actions.includes(`fd.get("${field}")`), `an action does not read ${field}`);
      assert.ok(page.includes(`name="${field}"`), `no form on Today carries ${field}`);
    }
    assert.match(page, /name="verdict" value="wrong"/);
    assert.match(page, /name="verdict" value="settled"/);
    assert.match(page, /<form action=\{markCheckAction\}/);
    assert.match(page, /<form action=\{putBackAction\}/);
  });

  test("a line that cannot be set aside has no press, and every line says what it reads", () => {
    assert.match(page, /a\.check\.fingerprint !== null && \(\s*<form action=\{markCheckAction\}/);
    assert.match(page, /Reads: \{a\.check\.reads\}/);
    assert.match(page, /Reads: \{check\.reads\}/, "the set-aside block says what each reads too");
  });

  test("the buttons are shown only to the roles the actions accept, and the note cannot make Enter record a verdict", () => {
    const auth = fs.readFileSync("src/lib/auth.ts", "utf8");
    const rule = auth.slice(auth.indexOf("export async function requireManager"));
    assert.match(rule, /u\.role !== "owner" && u\.role !== "pic"/, "the roles an action accepts");
    assert.match(page, /const canPress = user\.role === "owner" \|\| user\.role === "pic";/, "the roles the page shows the buttons to must be the same");
    assert.match(page, /\{canPress && a\.check\.fingerprint !== null && \(\s*<form action=\{markCheckAction\}/);
    assert.match(page, /\{canPress && \(\s*<form action=\{putBackAction\}/);
    assert.match(page, /<textarea\s+name="note"/);
    assert.doesNotMatch(page, /<input[^>]*name="note"/, "in a one-line field Enter presses the first button, which records wrong");
  });

  test("the older page that lists the checks says all pass only when none fails, whatever has been set aside", () => {
    const old = fs.readFileSync("src/app/(app)/tools/check/page.tsx", "utf8");
    assert.match(old, /const failing = r\.checks\.filter\(\(c\) => !c\.ok\);/);
    assert.match(old, /failing\.length === 0 \? \(\s*<Notice kind="ok">/);
    assert.doesNotMatch(old, /r\.failing === 0/, "r.failing counts only the open ones, so a finding he set aside would read as a pass");
  });

  test("both actions ask who is pressing before they touch the record", () => {
    for (const [action, touch] of [["markCheckAction", "markShown("], ["putBackAction", "putBack("]]) {
      const body = actions.slice(actions.indexOf(`export async function ${action}`));
      const asks = body.indexOf("requireManager()");
      const acts = body.indexOf(touch);
      assert.ok(asks > -1 && acts > -1 && asks < acts, `${action} does not ask who is pressing before it records`);
    }
  });
});
