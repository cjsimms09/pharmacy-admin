import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runDailyCheck, summarise, type Facts } from "../src/lib/daily-check";
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
  remittanceRegisterRows: 51,
  remittanceRegisterOwed: 51,
  remittanceRegisterThrough: "2026-09-17",
  remittancePaymentsPosted: 1346,
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
    assert.match(c.observed, /9 remittances advised as paid and not banked/);
    assert.match(c.observed, /\$99,238\.84/);
    assert.match(c.difference!, /nothing the site holds says it was deposited/, "says what is known, not that the money arrived");
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
    assert.match(c.observed, /^1 remittance advised as paid and not banked, \$2,008\.00/);
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

  test("a remittance with no payment number is not counted as unbanked", () => {
    // ProviderPay writes "Not matched" until a deposit is tied to the remittance. That is the payer
    // saying the money has not moved, so there is nothing for the cash account to be missing.
    const c = check({}, "Money the payer says it has sent has reached the cash account");
    assert.equal(c.ok, true);
    assert.match(c.shouldBe, /not owed yet/);
  });

  /*
   * What the green line claims to have looked at.
   *
   * On 28 September it read "all 51 remittances with a payment number have their cash" when 46
   * carried one and the newest was eleven days old — the pull being monthly and by hand, which is
   * his decision and not a fault. The money was right; the sentence described a wider and more
   * recent look than had happened, and that is the sentence somebody acts on.
   */
  test("it counts the remittances it judges, not every row in the register", () => {
    const c = check({ remittanceRegisterRows: 51, remittanceRegisterOwed: 46 }, "Money the payer says it has sent has reached the cash account");
    assert.equal(c.ok, true);
    assert.match(c.observed, /all 46 remittances/);
    assert.match(c.observed, /5 more carry no payment number/);
  });

  test("it says how far back the last export reaches, so a green line cannot read as today's", () => {
    const c = check({ remittanceRegisterThrough: "2026-09-06", today: "2026-09-17" }, "Money the payer says it has sent has reached the cash account");
    assert.equal(c.ok, true, "a monthly pull is the design, so a gap is not a failure");
    assert.match(c.observed, /reading to 2026-09-06 \(11 days ago\)/);
  });

  test("an export read today says so rather than counting nought days", () => {
    const c = check({ remittanceRegisterThrough: "2026-09-17", today: "2026-09-17" }, "Money the payer says it has sent has reached the cash account");
    assert.match(c.observed, /reading to 2026-09-17 \(today\)/);
  });

  test("the horizon is named on a failing line too, not only a passing one", () => {
    const c = check(
      { remittancesNotBanked: 3, remittancesNotBankedCents: 250_000, remittanceRegisterThrough: "2026-09-06", today: "2026-09-17" },
      "Money the payer says it has sent has reached the cash account",
    );
    assert.equal(c.ok, false);
    assert.match(c.observed, /reading to 2026-09-06/);
  });
});

/*
 * The line he reads and the page it sends him to.
 *
 * 6 October 2026: three findings, one "See it" link, and it went to Money for all three, a page that shows none of them. The page that
 * shows a finding belongs to the check that found it, so the check carries it, and a finding that has a thing to look at names it.
 * Every name and amount below is invented.
 */
const SHORT = "Invoices add up to what they say they come to";
const BANKED = "Money the payer says it has sent has reached the cash account";
type Tie = Facts["unbankedRemittances"][number]["tie"];

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
      unbankedRemittances: [{ payer: "Invented Payer A", remitOn: "2026-09-15", amountCents: 200_800, tie: "amount in window" }],
      remittanceRegisterThrough: "2026-09-30",
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
  });

  test("an invoice whose supplier or date was never captured says so rather than naming nobody", () => {
    const c = check({ invoicesShort: 1, invoicesShortCents: 500, shortInvoices: [{ supplier: null, invoiceOn: null, shortCents: 500 }] }, SHORT);
    assert.equal(c.observed, "1 invoice short by $5.00 (supplier not captured, date not captured)");
    assert.equal(c.href, "/inventory/invoices");
  });
});

describe("a remittance not banked is named, with what the bank matcher says of it", () => {
  const advised = (tie: Tie, over: Partial<Facts["unbankedRemittances"][number]> = {}): Partial<Facts> => ({
    remittancesNotBanked: 1,
    remittancesNotBankedCents: 200_800,
    unbankedRemittances: [{ payer: "Invented Payer A", remitOn: "2026-09-15", amountCents: 200_800, tie, ...over }],
    remittanceRegisterThrough: "2026-09-30",
    today: "2026-10-06",
  });

  /*
   * This check ties a remittance to its cash by the payment number alone; the bank matcher and the Remits tab also accept a receipt of
   * exactly that amount near the advice date. Where only that weakest tie exists the other page shows the remittance as standing, so a
   * card that said only "not banked" would contradict it. It still FAILS: whether that receipt is this remittance or the next one cannot
   * be settled from the amount or the days, only from the payer record.
   */
  test("a receipt that stands for it by amount alone is said, and the check still fails", () => {
    const c = check(advised("amount in window"), BANKED);
    assert.equal(c.ok, false);
    assert.equal(
      c.observed,
      "1 remittance advised as paid and not banked, $2,008.00 (Invented Payer A, advised 2026-09-15: a receipt of exactly that amount, near the advice date, stands for it by amount alone and not by its payment number), reading to 2026-09-30 (6 days ago) — the last ProviderPay export",
    );
    assert.equal(c.href, "/remits");
    assert.equal(c.action, "See the remittances");
  });

  test("a receipt that names its remittance number is said", () => {
    assert.match(check(advised("remittance number"), BANKED).observed, /advised 2026-09-15: a receipt carries its remittance number, not its payment number\)/);
  });

  test("a receipt that carries its payment number in a form this check does not match is said", () => {
    assert.match(check(advised("payment number"), BANKED).observed, /advised 2026-09-15: a receipt carries its payment number, written in a way this check does not match\)/);
  });

  test("where the matcher finds nothing either, it says so in the three ways it looked", () => {
    assert.match(check(advised(null), BANKED).observed, /advised 2026-09-15: no receipt stands for it, by payment number, remittance number or amount\)/);
  });

  test("a payer or a date that was never captured is said, not left blank", () => {
    const c = check(advised(null, { payer: null, remitOn: null }), BANKED);
    assert.match(c.observed, /\(payer not captured, advised date not captured: /);
  });

  test("several are named largest first with their amounts, three at most, and the rest counted", () => {
    const c = check(
      {
        remittancesNotBanked: 5,
        remittancesNotBankedCents: 600_000,
        unbankedRemittances: [
          { payer: "Invented Payer A", remitOn: "2026-09-15", amountCents: 200_800, tie: "amount in window" },
          { payer: "Invented Payer D", remitOn: "2026-09-18", amountCents: 120_000, tie: null },
          { payer: "Invented Payer E", remitOn: "2026-09-12", amountCents: 90_000, tie: null },
          { payer: "Invented Payer C", remitOn: "2026-09-10", amountCents: 75_500, tie: null },
        ],
      },
      BANKED,
    );
    assert.match(c.observed, /^5 remittances advised as paid and not banked, \$6,000\.00 between them \(Invented Payer A, advised 2026-09-15, \$2,008\.00: /);
    assert.match(c.observed, /Invented Payer E, advised 2026-09-12, \$900\.00: no receipt stands for it[^;]*; and 2 more\)/);
    assert.doesNotMatch(c.observed, /Invented Payer C/, "the fourth is counted, not named");
  });
});
