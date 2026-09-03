import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchDue } from "../src/lib/nadac-fetch";

/**
 * CMS publishes weekly, on a Wednesday. Checking twice a week catches a new file within a couple
 * of days without asking for the same download repeatedly, and being a day late costs nothing —
 * a price effective this week is still that price when it arrives on Friday.
 */
describe("fetchDue", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();

  test("never fetched means fetch", () => {
    assert.equal(fetchDue(null, now), true);
    assert.equal(fetchDue("", now), true);
  });

  test("an unreadable timestamp is treated as never, not as recent", () => {
    // Failing closed here would silently stop the collection forever.
    assert.equal(fetchDue("not a date", now), true);
  });

  test("checked yesterday is not due again", () => {
    assert.equal(fetchDue(ago(1), now), false);
    assert.equal(fetchDue(ago(3), now), false);
  });

  test("due again after three and a half days", () => {
    assert.equal(fetchDue(ago(4), now), true);
    assert.equal(fetchDue(ago(8), now), true);
  });

  test("checked a moment ago is not due", () => {
    assert.equal(fetchDue(new Date(now - 60_000).toISOString(), now), false);
  });
});
