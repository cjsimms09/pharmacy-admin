import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { noteRequest, isIdle, secondsSinceRequest } from "../src/lib/activity";

/**
 * The database connection is serialized, so a background job that runs while somebody is using
 * the site does not slow it down — it stops it. Idle detection is what keeps the two apart, and
 * the direction it must fail in is obvious: when in doubt, do not start.
 *
 * The first test in this file used to assert the opposite of that sentence — "before anything has
 * been served, the site is idle" — and that was one of three faults behind the login that "never
 * works" (15 September). See src/lib/activity.ts.
 */
describe("isIdle", () => {
  test("REGRESSION: straight after start, with nothing observed, the site is NOT assumed idle", () => {
    // Must run first in this file: the module has just been loaded and nothing has been noted.
    // After a restart the warm-up used to start at sixty seconds while he was signing back in.
    assert.equal(isIdle(90), false);
    assert.equal(isIdle(90, Date.now() + 91_000), true, "and it is idle once the full gap has passed with nothing served");
  });

  test("a page served just now means not idle", () => {
    noteRequest();
    assert.equal(isIdle(90), false);
  });

  test("idle again once the gap has passed", () => {
    noteRequest();
    assert.equal(isIdle(90, Date.now() + 91_000), true);
  });

  test("still busy one second short of the gap", () => {
    noteRequest();
    assert.equal(isIdle(90, Date.now() + 89_000), false);
  });

  test("reports how long it has been quiet", () => {
    noteRequest();
    const s = secondsSinceRequest(Date.now() + 30_000);
    assert.ok(s >= 29 && s <= 31, `got ${s}`);
  });
});

describe("one clock, however the site is bundled", () => {
  test("REGRESSION: the clock lives on globalThis, so the scheduler and the pages read the same one", async () => {
    /*
     * instrumentation.ts and the pages are separate bundles. A module-level variable is not
     * guaranteed to be shared between them, and if it is not, pages record activity the scheduler
     * never sees — the idle check would never have worked for anybody.
     */
    const text = await readFile("src/lib/activity.ts", "utf8");
    assert.match(text, /globalThis/);
    assert.doesNotMatch(text, /^let lastRequestAt/m, "the clock is a plain module variable again");
    noteRequest();
    const g = globalThis as { __pharmacyLastRequestAt?: number };
    assert.ok(g.__pharmacyLastRequestAt !== undefined && Date.now() - g.__pharmacyLastRequestAt < 1_000);
  });
});

describe("a person signing in counts as a person", () => {
  test("REGRESSION: the sign-in page notes a request when it renders", async () => {
    const text = await readFile("src/app/login/page.tsx", "utf8");
    const body = text.slice(text.indexOf("export default async function LoginPage"));
    assert.match(body.slice(0, 400), /noteRequest\(\)/, "the sign-in page no longer counts as activity");
  });

  test("REGRESSION: the sign-in action notes a request before it does anything else", async () => {
    const text = await readFile("src/lib/auth.ts", "utf8");
    const fn = text.slice(text.indexOf("export async function login("));
    const firstStatements = fn.slice(0, fn.indexOf("await dbReady"));
    assert.match(firstStatements, /noteRequest\(\)/, "a sign-in attempt no longer counts as activity");
  });
});
