import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { judgeFeed, missingDays, agoWords } from "../src/lib/feed-rules";

const now = new Date("2026-09-07T15:00:00Z"); // a Monday

describe("judging a feed by its newest arrival", () => {
  test("a daily report is on time yesterday and stopped after two days and a bit", () => {
    assert.equal(judgeFeed({ maxQuietHours: 56, lastAt: "2026-09-06", now, enabled: true }), "on_time");
    assert.equal(judgeFeed({ maxQuietHours: 56, lastAt: "2026-09-05", now, enabled: true }), "on_time", "a closed Sunday is not an alarm");
    assert.equal(judgeFeed({ maxQuietHours: 56, lastAt: "2026-09-04", now, enabled: true }), "late");
  });

  test("a bare date counts to the end of its day, a timestamp to the minute", () => {
    assert.equal(judgeFeed({ maxQuietHours: 24, lastAt: "2026-09-06", now, enabled: true }), "on_time");
    assert.equal(judgeFeed({ maxQuietHours: 24, lastAt: "2026-09-06T10:00:00Z", now, enabled: true }), "late");
  });

  test("off is off, and nothing yet is never, whatever the clock says", () => {
    assert.equal(judgeFeed({ maxQuietHours: 24, lastAt: null, now, enabled: false }), "off");
    assert.equal(judgeFeed({ maxQuietHours: 24, lastAt: "2026-09-07", now, enabled: false }), "off");
    assert.equal(judgeFeed({ maxQuietHours: 24, lastAt: null, now, enabled: true }), "never");
    assert.equal(judgeFeed({ maxQuietHours: 24, lastAt: "not a date", now, enabled: true }), "never");
  });
});

describe("the days a daily feed skipped", () => {
  test("lists open days with nothing and leaves Sundays out", () => {
    // 2026-08-31 is a Monday; the 6th is a Sunday.
    const present = ["2026-08-31", "2026-09-01", "2026-09-03", "2026-09-04", "2026-09-05"];
    assert.deepEqual(missingDays(present, "2026-08-31", "2026-09-06"), ["2026-09-02"]);
  });
  test("a timestamp counts for its day", () => {
    assert.deepEqual(missingDays(["2026-09-01T18:30:00Z"], "2026-09-01", "2026-09-01"), []);
  });
});

describe("in words", () => {
  test("today, yesterday, days, weeks, months", () => {
    assert.equal(agoWords("2026-09-07", now), "today");
    assert.equal(agoWords("2026-09-06", now), "yesterday");
    assert.equal(agoWords("2026-09-01", now), "6 days ago");
    assert.equal(agoWords("2026-08-10", now), "4 weeks ago");
    assert.equal(agoWords("2026-05-01", now), "4 months ago");
    assert.equal(agoWords(null, now), "never");
  });
});
