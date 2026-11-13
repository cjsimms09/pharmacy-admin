import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { learnCadence } from "../src/lib/cadence-learn";

const every = (from: string, n: number, step: number): string[] => {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += step * 86_400_000;
  }
  return out;
};

describe("reading a sender's rhythm off its own arrivals", () => {
  test("a weekday feed is daily, and knows the pharmacy is shut on Sunday", () => {
    // Two weeks of Monday-to-Saturday arrivals.
    const days = every("2026-08-31", 14, 1).filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0);
    const r = learnCadence(days);
    assert.equal(r?.cadence.kind, "daily");
    assert.equal(r?.cadence.kind === "daily" && r.cadence.skipSundays, true);
  });

  test("a Monday file is weekly on Monday, named from the arrivals not from a setting", () => {
    const r = learnCadence(every("2026-07-06", 8, 7));
    assert.deepEqual(r?.cadence, { kind: "weekly", weekday: 1 });
    assert.match(r!.says, /100% of them on a Monday/);
  });

  test("the 10th and the 25th are read as twice a month", () => {
    const r = learnCadence(["2026-06-10", "2026-06-25", "2026-07-10", "2026-07-25", "2026-08-10", "2026-08-25"]);
    assert.deepEqual(r?.cadence, { kind: "semimonthly", days: [10, 25] });
  });

  test("a statement in the first week of each month is monthly, on the day it actually comes", () => {
    const r = learnCadence(["2026-05-04", "2026-06-03", "2026-07-06", "2026-08-04", "2026-09-03"]);
    assert.equal(r?.cadence.kind, "monthly");
    assert.equal(r?.cadence.kind === "monthly" && r.cadence.dayOfMonth, 4);
  });

  test("a sender with no pattern gets a range, not an invented date", () => {
    /*
     * This is the answer for a voucher remittance. Nobody promised a date, so none is invented — but
     * "usually 9 days, the longest 19" is a real statement about a real sender, and it is enough to
     * tell a quiet week from one that has stopped.
     */
    const r = learnCadence(["2026-06-02", "2026-06-11", "2026-06-30", "2026-07-08", "2026-07-20"]);
    assert.equal(r?.cadence.kind, "irregular");
    assert.equal(r?.cadence.kind === "irregular" && r.cadence.longestDays, 19);
  });

  test("a plausible average with one enormous gap is not given a calendar", () => {
    // Gaps of 4, 5, 6 and 100 days average to something that looks like a fortnightly sender and is nothing of the kind.
    const r = learnCadence(["2026-06-01", "2026-06-05", "2026-06-10", "2026-06-16", "2026-09-24"]);
    assert.equal(r?.cadence.kind, "irregular", "an average is exactly what produces a confident wrong date");
  });

  test("one freak silence in a long run does not make a daily feed irregular", () => {
    /*
     * The claims export, measured 16 September 2026: twenty-two gaps of one day and a single hole of
     * thirteen, which was the site not yet existing in August. It was reading as "no fixed date".
     * One hole in twenty-two is a startup, not a rhythm.
     */
    const days = [...every("2026-08-03", 3, 1), ...every("2026-08-19", 20, 1)];
    const r = learnCadence(days);
    assert.equal(r?.cadence.kind, "daily");
  });

  test("history older than the window is not evidence about now", () => {
    /*
     * NADAC's table holds CMS file dates back to 2022, and the newest sixty produced "usually every
     * 7 days, the longest gap 1106" — every word of it true, and about a question nobody asked.
     */
    const r = learnCadence(["2022-06-29", "2023-01-04", "2024-03-06", ...every("2026-08-05", 7, 7)]);
    assert.deepEqual(r?.cadence, { kind: "weekly", weekday: 3 });
    assert.equal(r?.from, "2026-08-05", "the measurement starts at the recent run, not at the oldest row on file");
    assert.equal(r?.n, 7);
  });
});

describe("what it refuses to claim", () => {
  test("three arrivals are not a pattern", () => {
    assert.equal(learnCadence(["2026-09-01", "2026-09-08", "2026-09-15"]), null);
  });

  test("nothing at all is not a pattern", () => {
    assert.equal(learnCadence([]), null);
    assert.equal(learnCadence([null, undefined, "not a date"]), null);
  });

  test("two documents on one day are one arrival", () => {
    // Otherwise a supplier sending four invoices in a morning reads as a sender with a zero-day rhythm.
    const r = learnCadence(["2026-09-07", "2026-09-07", "2026-09-14", "2026-09-14", "2026-09-21", "2026-09-28"]);
    assert.equal(r?.n, 4);
    assert.deepEqual(r?.cadence, { kind: "weekly", weekday: 1 });
  });

  test("timestamps and dates are the same thing to it", () => {
    const r = learnCadence(["2026-09-07T14:22:01.000Z", "2026-09-14T09:00:00.000Z", "2026-09-21T23:59:00.000Z", "2026-09-28T07:15:00.000Z"]);
    assert.deepEqual(r?.cadence, { kind: "weekly", weekday: 1 });
  });
});
