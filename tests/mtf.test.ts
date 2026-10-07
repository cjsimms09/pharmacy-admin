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

import { keyDaysLeft, keyExpirySays } from "../src/lib/feed-rules";

/**
 * CMS expires MTF keys 90 days after generation with no notice, so a scheduled pull would just
 * start failing. The count is deliberately measured from when the key was pasted in — if it was
 * generated earlier the real deadline is earlier, so this warns too early rather than too late.
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
    assert.match(says, /stored 97 days ago/);
    assert.doesNotMatch(says, /expires in/);
    assert.doesNotMatch(says, /-\d/);
  });
});
