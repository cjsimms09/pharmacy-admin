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
    // Four months of statements in the first days of each month, and then nothing: a measured habit, broken.
    const arrivals = ["2026-04-04", "2026-05-05", "2026-06-03", "2026-07-04", "2026-07-31"];
    const r = judge(exp({ arrivals, lastAt: "2026-07-31", everCount: 200 }), "2026-09-16");
    assert.equal(r.basis, "measured");
    assert.equal(r.state, "overdue");
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

describe("what the sender's own arrivals say, against what was declared", () => {
  /*
   * The owner, 16 September 2026: "this tool needs to be smart and know when to expect things.. and
   * adjust as needed". A cadence typed into a file is a guess wearing a fact's clothes; the arrivals
   * are evidence. So the measurement wins wherever there is one, and the row says which it used.
   */
  test("a measured rhythm overrules the declared one", () => {
    // Declared monthly on the 5th; actually arrives every Monday, and has done eight times.
    const arrivals = ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"];
    const r = judge(exp({ cadence: { kind: "monthly", dayOfMonth: 5 }, arrivals, lastAt: "2026-08-24", everCount: 8, graceDays: 1 }), "2026-09-16");
    assert.deepEqual(r.using, { kind: "weekly", weekday: 1 });
    assert.equal(r.basis, "measured");
    assert.equal(r.state, "overdue", "judged against the Mondays it actually keeps, not the 5th nobody promised");
  });

  test("a sender with no measured habit is never accused of breaking one", () => {
    /*
     * The owner, 16 September 2026: "dont alert me we havent gotten an anda invoice in 7 days". To
     * say a sender has stopped is to say it broke its own habit, and a habit typed into a file is not
     * its habit. Two arrivals is not a habit, so the worst this may say is that something is due.
     */
    const r = judge(exp({ arrivals: ["2026-06-04", "2026-07-04"], lastAt: "2026-07-04", everCount: 2 }), "2026-09-16");
    assert.equal(r.basis, "declared");
    assert.equal(r.state, "due_now", "not overdue: nothing measured its habit, so nothing can say it broke one");
    assert.match(r.says, /has not sent often enough for the site to know its habits/);
  });

  test("a delivery with no invoice behind it is the alert, not days of silence", () => {
    /*
     * "we are getting receipts from pioneer. so for invoices it should use those for alerts.. but
     * only on companies that are set to receive invoices" — and the counted form is silent by
     * construction: a supplier that has not delivered owes nothing, however long it has been quiet.
     */
    const quiet = judge(exp({ label: "ANDA invoices", owing: { outstanding: 0, of: 3, says: "" }, lastAt: "2026-06-01", everCount: 3 }), "2026-09-16");
    assert.equal(quiet.state, "arriving");
    assert.match(quiet.says, /Nothing outstanding/);
    assert.equal(quiet.dueOn, null, "no date is invented for a thing counted in deliveries");

    const owing = judge(exp({ label: "ParMed invoices", owing: { outstanding: 4, of: 11, says: "Their invoices have been arriving since 4 September." }, lastAt: "2026-09-04", everCount: 11 }), "2026-09-16");
    assert.equal(owing.state, "overdue");
    assert.match(owing.says, /4 deliveries of 11 with no invoice behind them/);
  });

  test("a document that arrived and was refused never reads as one that never came", () => {
    /*
     * Veridikal sent both monthly reports on 15 September 2026 and the mailbox refused both for the
     * type their server declared. This page then said Veridikal had never sent anything: two true
     * sentences on one screen, inviting the owner to chase a sender who had done their part. The
     * fault is here, so it outranks every other verdict — including "never arrived", which is what
     * the row would otherwise be, since nothing ever landed.
     */
    const r = judge(
      exp({
        label: "Veridikal voucher report",
        from: "Veridikal",
        lastAt: null,
        everCount: 0,
        refused: { count: 2, last: "2026-09-15T21:08:00.000Z", why: "Nothing on this message was a type this reads." },
      }),
      "2026-09-16",
    );
    assert.equal(r.state, "overdue");
    assert.doesNotMatch(r.says, /Never arrived/);
    assert.match(r.says, /Nothing is wrong at their end/);
    /* The remedy has to be the one that works: the sweep skips a message id it has already recorded. */
    assert.match(r.says, /Forward the message/);
    assert.match(r.says, /marking the original unread will not work/);
  });

  test("too little history leaves the declared cadence in place, and says so", () => {
    const r = judge(exp({ arrivals: ["2026-08-04", "2026-09-04"], lastAt: "2026-09-04", everCount: 2 }), "2026-09-16");
    assert.equal(r.basis, "declared");
    assert.match(r.basisSays, /too few to read a rhythm from/);
  });

  test("a row that has never arrived says there is no rhythm to read", () => {
    const r = judge(exp({ arrivals: [], lastAt: null, everCount: 0 }), "2026-09-16");
    assert.equal(r.basis, "declared");
    assert.match(r.basisSays, /nothing has ever arrived/);
  });

  test("an irregular sender is quiet, not late, until it beats its own record", () => {
    // Gaps of 9, 19, 8, 12: usually about 10 days, never longer than 19.
    const arrivals = ["2026-08-02", "2026-08-11", "2026-08-30", "2026-09-07", "2026-09-19"];
    const quiet = judge(exp({ arrivals, lastAt: "2026-09-19", everCount: 5, graceDays: 0 }), "2026-10-02");
    assert.equal(quiet.using.kind, "irregular");
    assert.equal(quiet.state, "due_now", "13 days of silence from a sender that has gone 19 is not a fault");
    assert.match(quiet.says, /it normally stays within/);

    const stopped = judge(exp({ arrivals, lastAt: "2026-09-19", everCount: 5, graceDays: 0 }), "2026-10-12");
    assert.equal(stopped.state, "overdue");
    assert.match(stopped.says, /does not normally go beyond/);
  });

  test("an irregular sender inside its usual gap is simply arriving", () => {
    const arrivals = ["2026-08-02", "2026-08-11", "2026-08-30", "2026-09-07", "2026-09-19"];
    const r = judge(exp({ arrivals, lastAt: "2026-09-19", everCount: 5 }), "2026-09-24");
    assert.equal(r.state, "arriving");
    // Gaps of 9, 19, 8 and 12 days: the usual gap is 11, so the next is due 11 days after the last one.
    assert.equal(r.nextDueOn, "2026-09-30", "counted from the last arrival, not from a calendar");
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

describe("the clock, not just the calendar", () => {
  /*
   * The owner, 17 September 2026, looking at three rows marked Due: "whats wrong?? you havent gotten
   * claims?" Nothing was wrong. The Rx transaction report runs at 23:31 every night, so judged on the
   * day alone today's is due from one minute past midnight — amber through the whole working day,
   * every day, turning green after he has gone home. A row that is amber whenever anyone looks at it
   * is not telling anyone anything.
   */
  const nightly = (over: Partial<Expectation> = {}): Expectation =>
    exp({ cadence: { kind: "daily", skipSundays: true }, arrivesByHour: 23, lastAt: "2026-09-16T23:31:00.000Z", everCount: 20, graceDays: 1, ...over });

  test("before the hour it usually comes, yesterday's is the one that was owed", () => {
    const r = judge(nightly(), "2026-09-17", 9);
    assert.equal(r.state, "arriving", "at nine in the morning, last night's is the newest one owed");
  });

  test("after the hour, today's is owed and it says so", () => {
    const r = judge(nightly(), "2026-09-17", 23);
    assert.equal(r.dueOn, "2026-09-17");
  });

  test("a feed with no measurable hour is judged on the day, exactly as before", () => {
    const r = judge(nightly({ arrivesByHour: null }), "2026-09-17", 9);
    assert.equal(r.dueOn, "2026-09-17", "nothing is assumed about a feed whose hour was never measured");
  });

  test("the hour never rescues a feed that has actually stopped", () => {
    /*
     * Three days of silence from a nightly feed is still three days, whatever time it is — and it has
     * to be counted from the last arrival, because a daily feed is due every day and "days past the
     * due date" is never more than one. Judged that way a daily feed could never be called stopped at
     * all: the claims export could go quiet for a week and the row would read the same as any morning.
     */
    const arrivals = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"];
    const r = judge(nightly({ lastAt: "2026-09-13T23:31:00.000Z", arrivals }), "2026-09-17", 9);
    assert.equal(r.state, "overdue");
    assert.equal(r.daysLate, 3, "counted from the last one that came");
  });
});
