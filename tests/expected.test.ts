import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dueDates, judge, judgeAll, cadenceWords, expectedSummary, type Expectation } from "../src/lib/expected";

const exp = (over: Partial<Expectation>): Expectation => ({
  key: "x",
  label: "A document",
  from: "somebody",
  whyItMatters: "it matters",
  cadence: { kind: "monthly", dayOfMonth: 5 },
  graceDays: 7,
  lastAt: null,
  everCount: 0,
  expected: true,
  href: "/",
  ...over,
});

describe("when a thing is next owed", () => {
  test("monthly: the due date in this month if it has passed, otherwise last month's", () => {
    assert.deepEqual(dueDates({ kind: "monthly", dayOfMonth: 5 }, "2026-09-16"), { last: "2026-09-05", next: "2026-10-05" });
    assert.deepEqual(dueDates({ kind: "monthly", dayOfMonth: 5 }, "2026-09-03"), { last: "2026-08-05", next: "2026-09-05" });
  });

  test("monthly: a day the month does not have lands on its last day", () => {
    assert.equal(dueDates({ kind: "monthly", dayOfMonth: 31 }, "2027-03-01").last, "2027-02-28");
  });

  test("twice monthly: IPD's 10th and 25th", () => {
    assert.deepEqual(dueDates({ kind: "semimonthly", days: [10, 25] }, "2026-09-16"), { last: "2026-09-10", next: "2026-09-25" });
    assert.deepEqual(dueDates({ kind: "semimonthly", days: [10, 25] }, "2026-09-02"), { last: "2026-08-25", next: "2026-09-10" });
  });

  test("weekly: back to the last one of that weekday, which may be today", () => {
    // 2026-09-16 is a Wednesday.
    assert.deepEqual(dueDates({ kind: "weekly", weekday: 3 }, "2026-09-16"), { last: "2026-09-16", next: "2026-09-23" });
    assert.equal(dueDates({ kind: "weekly", weekday: 1 }, "2026-09-16").last, "2026-09-14");
  });

  test("daily, skipping the day the pharmacy is shut", () => {
    // 2026-09-13 is a Sunday: the last day owed is Saturday, and the next is Monday.
    assert.deepEqual(dueDates({ kind: "daily", skipSundays: true }, "2026-09-13"), { last: "2026-09-12", next: "2026-09-14" });
  });

  test("an event has no calendar at all", () => {
    assert.deepEqual(dueDates({ kind: "on_event", says: "with each delivery" }, "2026-09-16"), { last: null, next: null });
  });
});

describe("the bank statement, which is the case this page was asked for", () => {
  /*
   * The owner, 16 September 2026: "shouldnt expect bank statement until end of month". A statement covering September
   * does not exist on the 16th, and a screen that spends three weeks in four calling it late is a screen that has
   * taught its reader to skip the red.
   */
  test("August's statement, read on 16 September, is arriving — not late", () => {
    const r = judge(exp({ label: "Bank statement", lastAt: "2026-09-04", everCount: 312 }), "2026-09-16");
    assert.equal(r.state, "arriving");
    assert.equal(r.nextDueOn, "2026-10-05");
  });

  test("arriving early still counts for the date it was early for", () => {
    // The August statement on 3 September is two days ahead of the 5th, not a month behind it.
    const r = judge(exp({ lastAt: "2026-09-03", everCount: 312 }), "2026-09-16");
    assert.equal(r.state, "arriving", "an early arrival satisfies the due date it preceded");
  });

  test("nothing since July, judged in the middle of September, has stopped", () => {
    const r = judge(exp({ lastAt: "2026-07-31", everCount: 200 }), "2026-09-16");
    assert.equal(r.state, "overdue");
    assert.equal(r.daysLate, 11);
    assert.match(r.says, /has stopped or it is going somewhere else/);
  });

  test("inside the days the sender usually takes, it is due, not overdue", () => {
    const r = judge(exp({ lastAt: "2026-08-04", everCount: 200, graceDays: 7 }), "2026-09-09");
    assert.equal(r.state, "due_now");
  });
});

describe("the states that are not lateness", () => {
  test("a document that has never once arrived is not reported as late", () => {
    const r = judge(exp({ label: "Veridikal voucher report", from: "Veridikal", lastAt: null, everCount: 0 }), "2026-09-16");
    assert.equal(r.state, "never_arrived");
    assert.equal(r.daysLate, 11, "the date is still shown; what changes is what it is called");
    assert.match(r.says, /Never arrived/);
    assert.doesNotMatch(r.says, /days ago/, "there is no 'since' to measure from, so none is invented");
  });

  test("arranged but not started yet is its own state", () => {
    const r = judge(exp({ startsOn: "2026-10-01", note: "IPD moves to ACH on 1 October." }), "2026-09-16");
    assert.equal(r.state, "not_yet_due");
  });

  test("a thing the pharmacy does not receive cannot be late, however old", () => {
    const r = judge(exp({ expected: false, lastAt: "2024-01-01", everCount: 3, note: "Not used here." }), "2026-09-16");
    assert.equal(r.state, "not_expected");
    assert.equal(r.says, "Not used here.");
  });

  test("an event-driven document is never late, only last seen", () => {
    const r = judge(exp({ cadence: { kind: "on_event", says: "with each delivery" }, lastAt: "2026-06-01", everCount: 40 }), "2026-09-16");
    assert.equal(r.state, "arriving");
    assert.equal(r.dueOn, null);
    assert.match(r.says, /no date to be late against/);
  });
});

describe("the order things are read in", () => {
  test("what stopped comes above what never started", () => {
    /*
     * A monthly report that stopped in August is news this week; one nobody has ever set up is a task for a quiet
     * afternoon. Sorting the permanent list to the top of the screen is how the screen stops being read.
     */
    const rows = judgeAll(
      [
        exp({ key: "never", label: "Never", lastAt: null, everCount: 0 }),
        exp({ key: "stopped", label: "Stopped", lastAt: "2026-06-30", everCount: 10 }),
        exp({ key: "fine", label: "Fine", lastAt: "2026-09-06", everCount: 10 }),
      ],
      "2026-09-16",
    );
    assert.deepEqual(rows.map((r) => r.key), ["stopped", "never", "fine"]);
  });

  test("the summary counts each state and never says 'missing'", () => {
    const rows = judgeAll([exp({ key: "a", lastAt: null, everCount: 0 }), exp({ key: "b", lastAt: "2026-09-06", everCount: 4 })], "2026-09-16");
    const s = expectedSummary(rows);
    assert.equal(s.never, 1);
    assert.equal(s.arriving, 1);
    assert.doesNotMatch(s.says, /missing/i);
  });
});

describe("the cadence, in words a person reads", () => {
  test("each kind says itself", () => {
    assert.equal(cadenceWords({ kind: "monthly", dayOfMonth: 5 }), "monthly, due about the 5th");
    assert.equal(cadenceWords({ kind: "semimonthly", days: [10, 25] }), "twice a month, the 10th and the 25th");
    assert.equal(cadenceWords({ kind: "weekly", weekday: 3 }), "every Wednesday");
    assert.equal(cadenceWords({ kind: "daily", skipSundays: true }), "every day the pharmacy is open");
    assert.equal(cadenceWords({ kind: "on_event", says: "with each delivery" }), "with each delivery");
  });

  test("the awkward ordinals", () => {
    assert.equal(cadenceWords({ kind: "monthly", dayOfMonth: 1 }), "monthly, due about the 1st");
    assert.equal(cadenceWords({ kind: "monthly", dayOfMonth: 2 }), "monthly, due about the 2nd");
    assert.equal(cadenceWords({ kind: "monthly", dayOfMonth: 3 }), "monthly, due about the 3rd");
    assert.equal(cadenceWords({ kind: "monthly", dayOfMonth: 11 }), "monthly, due about the 11th");
    assert.equal(cadenceWords({ kind: "monthly", dayOfMonth: 21 }), "monthly, due about the 21st");
  });
});
