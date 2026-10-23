import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { countFiles } from "../src/lib/mtf";

/**
 * The CLI's output format is not contractual, so the count is parsed defensively. The failure
 * that matters is overstating it: a count that reads high would make an empty mailbox look like
 * a working pipeline, and we would stop chasing refunds that were never arriving.
 */
describe("countFiles", () => {
  test("uses a stated count when the tool gives one", () => {
    assert.equal(countFiles("Search complete. 7 files found."), 7);
    assert.equal(countFiles("1 file found"), 1);
  });

  test("an explicit no-files message is zero, not a guess", () => {
    assert.equal(countFiles("No files found matching the search criteria."), 0);
    assert.equal(countFiles("no file found"), 0);
  });

  test("falls back to counting distinct filenames", () => {
    const out = "Found:\n  MTF_835_20260901.835\n  MTF_835_20260908.835\n";
    assert.equal(countFiles(out), 2);
  });

  test("a filename repeated in the output is counted once", () => {
    assert.equal(countFiles("MTF_835_20260901.835 ... downloading MTF_835_20260901.835"), 1);
  });

  test("output with nothing file-shaped in it is zero", () => {
    assert.equal(countFiles("Configuration loaded. Contacting server..."), 0);
    assert.equal(countFiles(""), 0);
  });

  test("a stated count wins over filenames that also appear", () => {
    assert.equal(countFiles("2 files found: a.835, b.835, c.835"), 2);
  });
});

import { keyAgeSays, keyDaysLeft, keyExpirySays, keyMadeOnProblem } from "../src/lib/feed-rules";

/**
 * CMS expires MTF keys 90 days after generation with no notice, so a scheduled pull would just
 * start failing. The count runs from the day on record for the key, which is the day it was pasted
 * in unless a day was entered by hand. A key pasted in some days after it was made really ends
 * sooner than the count says, so the count errs late by those days, not early (an earlier note here
 * said the opposite).
 */
describe("keyDaysLeft", () => {
  test("counts down from 90 days", () => {
    assert.equal(keyDaysLeft("2026-09-01", "2026-09-01"), 90);
    assert.equal(keyDaysLeft("2026-09-01", "2026-09-16"), 75);
  });

  test("the day it lapses is zero, not one", () => {
    assert.equal(keyDaysLeft("2026-09-01", "2026-11-30"), 0);
  });

  test("goes negative once expired, so an expired key cannot read as fine", () => {
    assert.ok(keyDaysLeft("2026-09-01", "2026-12-10")! < 0);
  });

  test("no stored date means no claim about expiry", () => {
    assert.equal(keyDaysLeft(null), null);
    assert.equal(keyDaysLeft(""), null);
    assert.equal(keyDaysLeft("not a date"), null);
  });

  test("a day that does not exist, or that has not come yet, is not a day to count from", () => {
    assert.equal(keyDaysLeft("2026-02-30", "2026-03-10"), null);
    assert.equal(keyDaysLeft("2026-13-01", "2026-03-10"), null);
    assert.equal(keyDaysLeft("2026-03-11", "2026-03-10"), null);
    assert.equal(keyDaysLeft("2026-03-10", "2026-03-10"), 90, "the day itself is a day to count from");
  });
});

describe("keyDaysLeft reads a stored date and a stored timestamp the same way", () => {
  test("a timestamp counts from its date, as the feed's own copy of this arithmetic did", () => {
    assert.equal(keyDaysLeft("2026-09-01T10:30:00.000Z", "2026-09-16"), 75);
  });
});

/**
 * What the facilitator feed says of its key. Found 7 October 2026 reading the feed's code: a key that had already lapsed was
 * reported as "The API key expires in -7 days.", the count printed as though it were still ahead. The sentence for a key that has
 * run out has to say so, and what to do, with no number that reads as a deadline.
 */
describe("keyExpirySays", () => {
  test("says nothing while more than two weeks are left, and nothing when there is no stored date", () => {
    assert.equal(keyExpirySays(null), null);
    assert.equal(keyExpirySays(90), null);
    assert.equal(keyExpirySays(15), null);
  });

  test("names the days in the last two weeks, one day in the singular", () => {
    assert.equal(keyExpirySays(14), "The API key expires in 14 days.");
    assert.equal(keyExpirySays(2), "The API key expires in 2 days.");
    assert.equal(keyExpirySays(1), "The API key expires in 1 day.");
  });

  test("the day it lapses says today", () => {
    assert.equal(keyExpirySays(0), "The API key expires today.");
  });

  test("REGRESSION: a key that has run out says so, and prints no negative count", () => {
    const says = keyExpirySays(-7)!;
    assert.match(says, /has run out/);
    assert.match(says, /dated 97 days ago/, "dated, not stored: the day on record may have been written in by hand");
    assert.match(says, /stored on the Connections page/);
    assert.doesNotMatch(says, /expires in/);
    assert.doesNotMatch(says, /-\d/);
  });
});

/**
 * Found 7 October 2026 reading the live settings: a key is stored and no day is on record for it (it was stored before the site
 * kept the day, or by a route that did not), so the key's sentence, which prints only in the last two weeks, could never print, and
 * the feed said nothing of a key whose age nobody had measured. A key in use with no day on record is "never measured", and says so.
 */
describe("keyAgeSays", () => {
  const today = "2026-10-18";

  test("with no key stored there is no age to say, whatever the day on record", () => {
    assert.equal(keyAgeSays(false, null, today), null);
    assert.equal(keyAgeSays(false, "2026-10-01", today), null);
  });

  test("a key with no usable day on record says so, and names both ways to settle it", () => {
    for (const setOn of [null, "", "not a date", "2026-02-30", "2026-10-19"]) {
      const says = keyAgeSays(true, setOn, today)!;
      assert.match(says, /^The day this key was made is not on record, so the site cannot say how long it has left\./, `for ${JSON.stringify(setOn)}`);
      assert.match(says, /CMS ends a key 90 days after it is made and gives no warning/);
      assert.match(says, /Enter the day on the Connections page, or make a new key at CMS and store it there, which records the day\.$/);
    }
  });

  test("a key with a day on record says nothing until two weeks are left, then what keyExpirySays says", () => {
    assert.equal(keyAgeSays(true, "2026-10-01", today), null);
    assert.equal(keyAgeSays(true, "2026-07-26", today), "The API key expires in 6 days.");
    assert.equal(keyAgeSays(true, "2026-07-20", today), "The API key expires today.");
    assert.equal(keyAgeSays(true, "2026-06-01", today), keyExpirySays(keyDaysLeft("2026-06-01", today)));
    assert.match(keyAgeSays(true, "2026-06-01", today)!, /has run out/);
  });

  test("a stored timestamp counts as its day", () => {
    assert.equal(keyAgeSays(true, "2026-07-26T10:30:00.000Z", today), "The API key expires in 6 days.");
  });
});

/** What may be typed into the "Day this key was made" box. The same function that counts from the day judges it, so the two cannot disagree. */
describe("keyMadeOnProblem", () => {
  const today = "2026-10-18";

  test("empty is allowed, because emptying the box clears the record", () => {
    assert.equal(keyMadeOnProblem("", today), null);
  });

  test("a real day that has come is allowed, today included", () => {
    assert.equal(keyMadeOnProblem("2026-08-15", today), null);
    assert.equal(keyMadeOnProblem("2026-10-18", today), null);
  });

  test("anything else is refused with one instruction that shows the shape", () => {
    for (const typed of ["yesterday", "08/15/2026", "2026-8-15", "2026-02-30", "2026-13-01", "2026-10-19", "2026-08-15T10:00:00Z", " 2026-08-15"]) {
      assert.match(keyMadeOnProblem(typed, today) ?? "", /^Write the day the key was made as year-month-day, for example 2026-01-31\./, `for ${JSON.stringify(typed)}`);
    }
  });
});
