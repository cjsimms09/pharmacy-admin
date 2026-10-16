import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { judgeFeed, missingDays, agoWords, arrivalCounts, arrivalSaid, liveChecksSaid } from "../src/lib/feed-rules";

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

describe("the figures over the list of feeds", () => {
  test("a row nothing is expected to arrive on is counted beside the others, not among those that did not arrive", () => {
    const c = arrivalCounts(["on_time", "on_time", "late", "never", "off", "unproven"]);
    assert.deepEqual(c, { onTime: 2, expected: 4, notProved: 1, off: 1 });
    assert.equal(c.expected + c.notProved + c.off, 6, "every row is in one of the three");
  });

  test("with none of them unproven the figure is what it always was: on time, out of those switched on", () => {
    assert.deepEqual(arrivalCounts(["on_time", "late", "off"]), { onTime: 1, expected: 2, notProved: 0, off: 1 });
    assert.deepEqual(arrivalCounts([]), { onTime: 0, expected: 0, notProved: 0, off: 0 });
  });
});

describe("what stands under the number that arrived", () => {
  test("says how many were expected, and puts the ones nothing could prove beside that count, not inside it", () => {
    assert.equal(arrivalSaid({ expected: 4, notProved: 0 }), "of 4 switched on");
    assert.equal(arrivalSaid({ expected: 4, notProved: 1 }), "of 4 switched on; 1 more is not proved");
    assert.equal(arrivalSaid({ expected: 4, notProved: 2 }), "of 4 switched on; 2 more are not proved");
  });
});

describe("what the notice after a live check says it ran", () => {
  test("names the rows that were checked, however many", () => {
    assert.equal(liveChecksSaid(["NADAC prices"]), "A live check ran against NADAC prices. What it said is on its row. No other row was checked live.");
    assert.equal(liveChecksSaid(["NADAC prices", "Mailbox"]), "Live checks ran against NADAC prices and Mailbox. What each said is on its row. No other row was checked live.");
    assert.match(liveChecksSaid(["A", "B", "C"]), /^Live checks ran against A, B and C\. /);
  });

  test("says so when none was, and then names nothing", () => {
    assert.equal(liveChecksSaid([]), "No live check ran, so no row was checked live.");
  });
});

describe("the feeds page words both from its rows", () => {
  const page = fs.readFileSync("src/app/(app)/settings/feeds/page.tsx", "utf8").replace(/\r\n/g, "\n");

  test("the notice after a live check is built from the rows that have a check result, not from a list of services", () => {
    assert.match(page, /liveChecksSaid\(feeds\.filter\(\(f\) => f\.probe\)\.map\(\(f\) => f\.label\)\)/);
    assert.doesNotMatch(page, /Live checks ran against CMS/);
  });

  test("the line under the number that arrived is worded by the one function, from the same counts", () => {
    assert.match(page, /sub=\{arrivalSaid\(\{ expected, notProved \}\)\}/);
    assert.doesNotMatch(page, /switched on\$\{/);
  });

  test("the counts over the list come from the one function, and no other count of the list is left in the page", () => {
    assert.match(page, /arrivalCounts\(feeds\.map\(\(f\) => f\.state\)\)/);
    assert.doesNotMatch(page, /feeds\.length - off/);
    assert.doesNotMatch(page, /state === "on_time"\)\.length/);
  });
});
