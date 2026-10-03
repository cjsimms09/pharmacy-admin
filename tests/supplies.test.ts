import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  usageRate, position, receivedBetween, daysBetween, addDays, urgencyOrder,
  DEFAULT_POLICY, RATE_WINDOW_DAYS, type Count, type Receipt,
} from "../src/lib/supplies";

const on = (d: string, quantity: number): Count => ({ on: d, quantity });

describe("the rate, from counts alone", () => {
  test("two counts with no delivery between them", () => {
    // 20 boxes on the 1st, 10 on the 11th: ten boxes over ten days.
    const r = usageRate([on("2026-09-01", 20), on("2026-09-11", 10)], [], "2026-09-11");
    assert.equal(r.perDay, 1);
    assert.equal(r.intervals, 1);
    assert.equal(r.daysObserved, 10);
  });

  test("a delivery in between is added, never subtracted away", () => {
    /*
     * The mistake this exists to prevent. 20 on the 1st, a delivery of 12, 20 again on the 11th:
     * subtracting the counts alone says nothing was used. Twelve were.
     */
    const r = usageRate([on("2026-09-01", 20), on("2026-09-11", 20)], [{ on: "2026-09-05", quantity: 12 }], "2026-09-11");
    assert.equal(r.all[0].used, 12);
    assert.equal(r.perDay, 1.2);
  });

  test("a delivery on the day of a count belongs to the interval that ends there", () => {
    // Counted after it was put away, so it is already in that count and must not be counted again.
    assert.equal(receivedBetween([{ on: "2026-09-11", quantity: 5 }], "2026-09-01", "2026-09-11"), 5);
    assert.equal(receivedBetween([{ on: "2026-09-01", quantity: 5 }], "2026-09-01", "2026-09-11"), 0);
  });

  test("a count that rises with no delivery logged is dropped, not averaged in as negative usage", () => {
    const r = usageRate([on("2026-09-01", 10), on("2026-09-11", 40)], [], "2026-09-11");
    assert.equal(r.perDay, null);
    assert.equal(r.intervals, 0);
    assert.match(r.all[0].excluded ?? "", /arriving unlogged/);
    assert.match(r.problems.join(" "), /no delivery logged/);
    assert.equal(r.all[0].used, 0, "never a negative quantity");
  });

  test("one count is a starting point, not a measurement", () => {
    const r = usageRate([on("2026-09-01", 20)], [], "2026-09-11");
    assert.equal(r.perDay, null);
    assert.equal(r.confidence, "none");
    assert.match(r.problems[0], /needs a second one/);
  });

  test("no counts at all says so", () => {
    assert.equal(usageRate([], [], "2026-09-11").perDay, null);
  });

  test("two counts on the same day say nothing", () => {
    const r = usageRate([on("2026-09-01", 20), on("2026-09-01", 18)], [], "2026-09-02");
    assert.equal(r.perDay, null);
    assert.match(r.all[0].excluded ?? "", /same day/);
  });

  test("longer intervals carry more weight than short ones", () => {
    /*
     * Total used over total days, which is what anybody checking by hand would work out. A plain
     * mean of the two per-day figures would give the one-day spike equal say and read 2.5/day.
     */
    const r = usageRate(
      [on("2026-09-01", 100), on("2026-10-01", 70), on("2026-10-02", 66)],
      [], "2026-10-02",
    );
    assert.equal(r.daysObserved, 31);
    assert.equal(r.perDay, 34 / 31);
    assert.ok(r.perDay < 2, "the four-in-a-day interval does not dominate a month of evidence");
  });

  test("counts older than the window are left out", () => {
    const old = addDays("2026-09-11", -(RATE_WINDOW_DAYS + 30));
    const r = usageRate([on(old, 100), on(addDays(old, 10), 50), on("2026-09-01", 20), on("2026-09-11", 10)], [], "2026-09-11");
    assert.equal(r.intervals, 1, "only the recent pair counts");
    assert.equal(r.perDay, 1);
  });

  test("counts arriving out of order are sorted before anything is worked out", () => {
    const r = usageRate([on("2026-09-11", 10), on("2026-09-01", 20)], [], "2026-09-11");
    assert.equal(r.perDay, 1);
  });

  test("using nothing over a real interval is a real answer, not a missing one", () => {
    const r = usageRate([on("2026-09-01", 20), on("2026-09-11", 20)], [], "2026-09-11");
    assert.equal(r.perDay, 0);
    assert.equal(r.intervals, 1);
  });

  test("confidence grows with evidence and is never overstated", () => {
    assert.equal(usageRate([on("2026-09-01", 20), on("2026-09-04", 17)], [], "2026-09-04").confidence, "weak");
    assert.equal(usageRate([on("2026-08-01", 60), on("2026-09-01", 30)], [], "2026-09-01").confidence, "fair");
    assert.equal(
      usageRate([on("2026-07-01", 90), on("2026-08-01", 60), on("2026-09-01", 30), on("2026-09-20", 20)], [], "2026-09-20").confidence,
      "good",
    );
  });
});

describe("where an item stands", () => {
  const rate = (perDay: number) =>
    usageRate([on("2026-09-01", 100), on("2026-09-11", 100 - perDay * 10)], [], "2026-09-11");

  test("stock is run down from the day it was counted, not from today", () => {
    /*
     * A count three weeks old against two a day is six boxes out of date. Ignoring that reports a
     * comfortable position on an empty shelf.
     */
    const p = position({ onHand: 30, countedOn: "2026-09-01", rate: rate(2), policy: DEFAULT_POLICY, today: "2026-09-11" });
    assert.equal(p.onHand, 10, "30 counted, twenty used in the ten days since");
  });

  test("order-by is the day the cushion starts being spent, not the day it runs out", () => {
    // 30 left, one a day: out in 30 days. Lead time 5 + safety 7 means send it on day 18.
    const p = position({ onHand: 30, countedOn: "2026-09-11", rate: rate(1), policy: DEFAULT_POLICY, today: "2026-09-11" });
    assert.equal(p.runsOutOn, "2026-10-11");
    assert.equal(p.orderBy, "2026-09-29");
    assert.equal(p.state, "ok");
  });

  test("inside the lead time and cushion it says order today", () => {
    const p = position({ onHand: 10, countedOn: "2026-09-11", rate: rate(1), policy: DEFAULT_POLICY, today: "2026-09-11" });
    assert.equal(p.state, "order now");
    assert.match(p.says, /Send it today/);
  });

  test("what to order brings the shelf to the target, in whole cases", () => {
    // One a day, 45-day target, 10 on hand: 35 needed, rounded up to whole cases of 10.
    const p = position({
      onHand: 10, countedOn: "2026-09-11", rate: rate(1),
      policy: { ...DEFAULT_POLICY, orderMultiple: 10 }, today: "2026-09-11",
    });
    assert.equal(p.suggested, 40);
  });

  test("what is already on order counts towards the decision", () => {
    const p = position({ onHand: 10, countedOn: "2026-09-11", rate: rate(1), policy: DEFAULT_POLICY, onOrder: 40, today: "2026-09-11" });
    assert.equal(p.state, "ok");
    assert.equal(p.suggested, 0, "nothing more is needed while that order is in transit");
  });

  test("nothing counted is unknown, and says which count is missing", () => {
    const p = position({ onHand: 0, countedOn: null, rate: usageRate([], [], "2026-09-11"), policy: DEFAULT_POLICY, today: "2026-09-11" });
    assert.equal(p.state, "unknown");
    assert.match(p.says, /Never counted/);
  });

  test("counted but no rate yet is unknown rather than a confident forever", () => {
    const p = position({ onHand: 20, countedOn: "2026-09-11", rate: usageRate([on("2026-09-11", 20)], [], "2026-09-11"), policy: DEFAULT_POLICY, today: "2026-09-11" });
    assert.equal(p.state, "unknown");
    assert.equal(p.daysRemaining, Infinity);
    assert.equal(p.suggested, 0, "never guess a quantity from no rate");
  });

  test("an empty shelf is out, whatever the rate says", () => {
    const p = position({ onHand: 0, countedOn: "2026-09-11", rate: rate(1), policy: DEFAULT_POLICY, today: "2026-09-11" });
    assert.equal(p.state, "out");
    assert.ok(p.suggested > 0);
  });

  test("stock never projects below zero", () => {
    const p = position({ onHand: 5, countedOn: "2026-08-01", rate: rate(2), policy: DEFAULT_POLICY, today: "2026-09-11" });
    assert.equal(p.onHand, 0);
  });

  test("the worst comes first", () => {
    const mk = (state: string, days: number) => ({ state, daysRemaining: days }) as never;
    const rows = [mk("ok", 40), mk("out", 0), mk("order soon", 15), mk("order now", 8)];
    assert.deepEqual(rows.sort(urgencyOrder).map((r: never) => (r as { state: string }).state), ["out", "order now", "order soon", "ok"]);
  });
});

describe("dates", () => {
  test("whole days, and adding across a month end", () => {
    assert.equal(daysBetween("2026-08-30", "2026-09-02"), 3);
    assert.equal(addDays("2026-08-30", 3), "2026-09-02");
    assert.equal(addDays("2026-09-02", -3), "2026-08-30");
  });
});
