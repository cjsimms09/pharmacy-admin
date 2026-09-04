import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseJob, isStale, isRunning, ago, summarise, type ManualJob } from "../src/lib/manual-job";
import type { PutRightResult } from "../src/lib/manual-audit";

/**
 * A long job, made visible.
 *
 * The failure this exists to prevent is not a crash. It is a button that works perfectly and
 * looks broken: the work took minutes inside the press, the browser's router waited on it, every
 * other link stopped responding, and the honest report was "the site is frozen" followed by "is
 * it running? is it working?". Both were true observations of a working system.
 *
 * So the state has to survive the request, survive a restart, and never leave the button
 * permanently unpressable — a pharmacy computer gets switched off at the end of the day, sometimes
 * with a pass in flight.
 */
const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const running = (minsAgo: number): ManualJob => ({
  state: "running",
  runId: "abc-123",
  startedAt: at(minsAgo + 1),
  finishedAt: at(minsAgo),
  by: "Cory Simms",
  step: "Reading “Storage of controlled substances” against the rules",
  done: 3,
  total: 40,
});

describe("whether a pass is actually going", () => {
  test("one that reported a moment ago is running", () => {
    assert.equal(isRunning(running(1)), true);
    assert.equal(isStale(running(1)), false);
  });

  test("one that has said nothing for half an hour is presumed dead", () => {
    // Otherwise a computer switched off mid-pass leaves a button that can never be pressed again.
    assert.equal(isStale(running(30)), true);
    assert.equal(isRunning(running(30)), false);
  });

  test("a finished pass is not running, however recent", () => {
    const done: ManualJob = { ...running(1), state: "done", step: "Finished" };
    assert.equal(isRunning(done), false);
    assert.equal(isStale(done), false);
  });

  test("no job at all is not a running job", () => {
    assert.equal(isRunning(null), false);
    assert.equal(isStale(null), false);
  });
});

describe("reading the stored job", () => {
  test("comes back as it went in", () => {
    const j = running(2);
    assert.deepEqual(parseJob(JSON.stringify(j)), j);
  });

  test("nothing stored means no job", () => {
    assert.equal(parseJob(undefined), null);
    assert.equal(parseJob(""), null);
  });

  test("a job written before presses were identified still reads", () => {
    // Older rows have no runId. They must still parse — the alternative is a manual page that
    // will not render until somebody clears a setting by hand.
    const legacy = '{"state":"running","startedAt":"2026-09-04T10:00:00.000Z","by":"Cory","step":"x","done":0,"total":0}';
    assert.equal(parseJob(legacy)?.state, "running");
  });

  test("a corrupt record means no job rather than an error page", () => {
    // The manual page must render even if this setting is nonsense.
    assert.equal(parseJob("{not json"), null);
    assert.equal(parseJob("[]"), null);
    assert.equal(parseJob('{"foo":1}'), null);
  });
});

describe("saying when it happened", () => {
  test("in units somebody would use out loud", () => {
    assert.equal(ago(new Date().toISOString()), "just now");
    assert.equal(ago(at(1)), "a minute ago");
    assert.equal(ago(at(20)), "20 minutes ago");
    assert.equal(ago(at(60)), "an hour ago");
    assert.equal(ago(at(60 * 5)), "5 hours ago");
    assert.equal(ago(at(60 * 24)), "yesterday");
  });

  test("a clock that has gone backwards does not produce a negative", () => {
    assert.equal(ago(new Date(Date.now() + 10_000).toISOString()), "just now");
    assert.equal(ago(undefined), "");
  });
});

describe("what the pass did, in one sentence", () => {
  const result = (over: Partial<PutRightResult>): PutRightResult => ({
    regenerated: 0,
    pointed: 0,
    drafted: 0,
    markersRemoved: 0,
    audited: 0,
    raised: 0,
    remaining: 0,
    stillEmpty: 0,
    problems: [],
    ...over,
  });

  test("says what changed and what is left", () => {
    const s = summarise(result({ drafted: 3, audited: 12, raised: 2, remaining: 40 }));
    assert.match(s, /3 policies drafted/);
    assert.match(s, /12 sections read against the rules/);
    assert.match(s, /Left: 40 sections still to read/);
  });

  test("one of a thing is not one of a things", () => {
    const s = summarise(result({ drafted: 1, raised: 1, stillEmpty: 1 }));
    assert.match(s, /1 policy drafted/);
    assert.match(s, /1 finding raised/);
    assert.match(s, /1 heading still to write/);
  });

  test("a pass with nothing to do reads like success, because it is", () => {
    // Once the manual is in order this is what the button should say most of the time.
    assert.equal(summarise(result({})), "Nothing needed doing");
  });
});
