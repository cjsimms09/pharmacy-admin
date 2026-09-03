import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { noteRequest, isIdle, secondsSinceRequest } from "../src/lib/activity";

/**
 * The database connection is serialized, so a background job that runs while somebody is using
 * the site does not slow it down — it stops it. Idle detection is what keeps the two apart, and
 * the direction it must fail in is obvious: when in doubt, do not start.
 */
describe("isIdle", () => {
  test("before anything has been served, the site is idle", () => {
    assert.equal(isIdle(90), true);
  });

  test("a page served just now means not idle", () => {
    noteRequest();
    assert.equal(isIdle(90), false);
  });

  test("idle again once the gap has passed", () => {
    noteRequest();
    const later = Date.now() + 91_000;
    assert.equal(isIdle(90, later), true);
  });

  test("still busy one second short of the gap", () => {
    noteRequest();
    assert.equal(isIdle(90, Date.now() + 89_000), false);
  });

  test("reports how long it has been quiet", () => {
    noteRequest();
    const s = secondsSinceRequest(Date.now() + 30_000);
    assert.ok(s !== null && s >= 29 && s <= 31, `got ${s}`);
  });
});
