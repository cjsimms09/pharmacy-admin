import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { owedByPayer, daysBetween, type Receivable, type Received } from "../src/lib/payer-owed";

/*
 * What a payer owes, and the three states this page exists to keep apart.
 *
 * The owner asked for it directly: "it should be easy to know how much a payer owes us for a
 * claim." The difficulty is not the arithmetic. It is that on the day it was written, $131,743.31
 * had been billed and nothing at all had been received — so the honest page and the broken page
 * look identical unless the difference is said out loud.
 *
 *   nothing to measure   a cash plan: never sends money, never will
 *   never measured       a real payer that has not remitted yet: unpaid, not late
 *   measured             a payer that has paid before: a balance worth chasing
 */

const TODAY = "2026-09-09";

const bill = (o: Partial<Receivable> = {}): Receivable => ({
  bin: "610011", name: "Caremark", dateFilled: "2026-09-01", cents: 10_000, cashPlan: false, ...o,
});
const paid = (o: Partial<Received> = {}): Received => ({
  bin: "610011", payer: "Caremark", cents: 10_000, receivedOn: "2026-09-08", matched: true, ...o,
});

describe("the three states", () => {
  test("a cash plan is not a debt, however much was billed through it", () => {
    // RxLocal: the copay is the money. Showing $418.22 owed would send somebody chasing nobody.
    const s = owedByPayer([bill({ bin: "028249", name: "RxLocal", cents: 41_822, cashPlan: true })], [], TODAY);
    assert.equal(s.lines[0].state, "cashPlan");
    assert.equal(s.lines[0].outstandingCents, 41_822, "the figure is still shown; it is the meaning that differs");
    assert.match(s.lines[0].says, /Nothing is owed/);
    assert.match(s.lines[0].says, /collected at the counter/);
  });

  test("a payer that has never remitted is unpaid, and is not called late", () => {
    /*
     * The sentence the page is for. No remittance cycle is on file for any payer, so "overdue"
     * would be a deadline this pharmacy invented — the same mistake as the 48 hours in the manual.
     */
    const s = owedByPayer([bill()], [], TODAY);
    assert.equal(s.lines[0].state, "waiting");
    assert.match(s.lines[0].says, /this is not late — it is unpaid, which is a different thing/);
    assert.match(s.lines[0].says, /No remittance cycle for this payer is on file/);
    assert.doesNotMatch(s.lines[0].says, /overdue|late payment|days late/i);
  });

  test("a payer that has paid before is the only one with a balance worth chasing", () => {
    const s = owedByPayer([bill({ cents: 30_000 })], [paid({ cents: 10_000 })], TODAY);
    assert.equal(s.lines[0].state, "owes");
    assert.equal(s.lines[0].outstandingCents, 20_000);
    assert.match(s.lines[0].says, /has remitted before/);
  });

  test("billed and received agreeing is square, and says so in three words", () => {
    const s = owedByPayer([bill()], [paid()], TODAY);
    assert.equal(s.lines[0].state, "settled");
    assert.equal(s.lines[0].outstandingCents, 0);
    assert.equal(s.lines[0].daysWaiting, null, "nothing is waiting, so no age is claimed");
  });

  test("more received than billed is its own state, not a negative debt", () => {
    const s = owedByPayer([bill()], [paid({ cents: 12_000 })], TODAY);
    assert.equal(s.lines[0].state, "overpaid");
    assert.equal(s.lines[0].outstandingCents, 0, "an overpayment must never read as money owed to us");
    assert.match(s.lines[0].says, /more than this pharmacy asked for/);
  });
});

describe("the day nothing has arrived, which is every day so far", () => {
  test("the headline explains the empty column instead of leaving it to look broken", () => {
    const s = owedByPayer(
      [bill({ cents: 100_00 }), bill({ bin: "004336", name: "Express Scripts", cents: 200_00 })],
      [],
      TODAY,
    );
    assert.equal(s.nothingHasArrived, true);
    assert.match(s.says, /nothing received from any of them yet/);
    assert.match(s.says, /not this page failing/);
    assert.match(s.says, /a true nought rather than a missing one/);
  });

  test("one payment from one payer ends that state for the whole page", () => {
    const s = owedByPayer([bill(), bill({ bin: "004336", name: "Express Scripts" })], [paid({ cents: 100 })], TODAY);
    assert.equal(s.nothingHasArrived, false);
    assert.match(s.says, /billed,.*received,.*outstanding/);
  });

  test("cash plans do not count as payers that have failed to pay", () => {
    // Otherwise a pharmacy billing only through its own plan would read as owed a fortune.
    const s = owedByPayer([bill({ bin: "028249", name: "RxLocal", cashPlan: true })], [], TODAY);
    assert.equal(s.nothingHasArrived, false, "there is no real payer here to be waiting on");
    assert.match(s.says, /Nothing is owed by anybody/);
  });

  test("nothing billed at all says so rather than showing an empty table", () => {
    const s = owedByPayer([], [], TODAY);
    assert.match(s.says, /No claims have been billed/);
    assert.equal(s.lines.length, 0);
  });
});

describe("money that belongs to no claim here", () => {
  test("payments matching nothing are counted apart, and named as not an error", () => {
    /*
     * The 24 facilitator payments on file, $5,808.33, for fills between January and August. The
     * claim history starts on 1 September, so they will never match. Counting them against a
     * payer's balance would settle a September debt with an August payment.
     */
    const s = owedByPayer([bill({ cents: 100_00 })], [paid({ cents: 580_833, matched: false })], TODAY);
    assert.equal(s.unattached.count, 1);
    assert.equal(s.unattached.cents, 580_833);
    assert.equal(s.lines[0].receivedCents, 0, "it must not settle anything");
    assert.equal(s.lines[0].outstandingCents, 100_00);
    assert.match(s.says, /this site does not hold/);
    assert.match(s.says, /counted nowhere on this page/);
  });

  test("a matched payment for a payer outside the period does not settle it either", () => {
    // An August payment must not square a September balance for a payer September never billed.
    const s = owedByPayer([bill()], [paid({ bin: "999999", payer: "Somebody else" })], TODAY);
    assert.equal(s.lines.length, 1);
    assert.equal(s.lines[0].receivedCents, 0);
    assert.equal(s.unattached.count, 0, "it matched a claim, so it is not unattached — just not here");
  });
});

describe("grouping and ordering", () => {
  test("payers are grouped on the BIN, which is what a remittance names", () => {
    const s = owedByPayer([bill(), bill({ name: "CAREMARK PCS" })], [], TODAY);
    assert.equal(s.lines.length, 1);
    assert.equal(s.lines[0].claims, 2);
    assert.equal(s.lines[0].billedCents, 20_000);
  });

  test("two payers nothing can name are still two payers", () => {
    const s = owedByPayer([bill({ bin: null, name: "One" }), bill({ bin: null, name: "Two" })], [], TODAY);
    assert.equal(s.lines.length, 2);
  });

  test("the largest outstanding is first, because that is the question being asked", () => {
    const s = owedByPayer(
      [bill({ cents: 100 }), bill({ bin: "004336", name: "Express Scripts", cents: 900_00 })],
      [],
      TODAY,
    );
    assert.equal(s.lines[0].name, "Express Scripts");
  });

  test("the oldest unsettled claim is the one aged, not the newest", () => {
    const s = owedByPayer([bill({ dateFilled: "2026-09-08" }), bill({ dateFilled: "2026-09-01" })], [], TODAY);
    assert.equal(s.lines[0].oldestOn, "2026-09-01");
    assert.equal(s.lines[0].daysWaiting, 8);
  });

  test("days are counted, not guessed at", () => {
    assert.equal(daysBetween("2026-09-01", "2026-09-09"), 8);
    assert.equal(daysBetween(null, "2026-09-09"), null);
    assert.equal(daysBetween("not a date", "2026-09-09"), null);
  });
});
