import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isIdle } from "../src/lib/activity";

/**
 * "The login button never works."
 *
 * It did work. On 15 September every press of Sign in succeeded — thirteen `login.success` rows in
 * two minutes, the password right each time, a session created each time. He could not tell,
 * because two things combined:
 *
 *   - The warm-up that pre-computes the heavy readings runs inside the web server, and one step
 *     blocks every request for up to twelve seconds. It started only after ninety quiet seconds,
 *     but once running it checked between steps with a five-second rule. He pressed about every
 *     thirteen seconds, so each gap let the next heavy step start and his next press landed in it.
 *     The sign-in page itself measured 0.2s on one request and 12s on the next.
 *   - The button was a plain submit with no sign of working, so he pressed again — and each press
 *     cancelled the page the previous one was opening.
 *
 * Both halves are pinned here, because either alone brings the symptom back.
 */
const src = (p: string) => readFile(p, "utf8");

describe("the warm-up gets out of the way of a person by the same measure that let it start", () => {
  test("REGRESSION: the per-step check is never shorter than the one that let the warm-up start", async () => {
    /*
     * Pinned as the property rather than as one spelling of it. The guard was `isIdle(IDLE_SECONDS)` inline; since A's
     * warm policy (PR #26) it is the policy's own GAP_SECONDS, asked before every step along with the heap. What must
     * stay true either way is that the between-steps question is not a looser one than the question that started it —
     * five seconds there is what let a heavy step begin between two of his presses.
     */
    const text = await src("src/instrumentation.ts");
    const warm = text.slice(text.indexOf("const warmTick"), text.indexOf("const publicAccessTick"));
    const call = warm.split(/\r?\n/).find((l) => /^\s*await warmHeld\(/.test(l));
    assert.ok(call, "could not find the warm-up call");
    assert.doesNotMatch(call, /isIdle\(\s*\d+\s*\)/, "the warm-up checks idleness with a literal number again");

    const started = (await src("src/instrumentation.ts")).match(/const IDLE_SECONDS = (\d+);/);
    assert.ok(started, "IDLE_SECONDS is no longer declared as a plain number");
    if (/isIdle\(IDLE_SECONDS\)/.test(call)) return; // The inline spelling still satisfies it.

    const { GAP_SECONDS, LULL_SECONDS } = await import("../src/lib/warm-policy");
    assert.ok(
      GAP_SECONDS >= Number(started[1]),
      `the warm policy lets a step start after ${GAP_SECONDS}s while the warm-up itself waits ${started[1]}s — that gap is the sign-in stall`,
    );
    assert.ok(LULL_SECONDS >= GAP_SECONDS, "a deeper page's lull must not be shorter than an ordinary gap");
  });

  test("and IDLE_SECONDS is long enough to outlast a person between clicks", async () => {
    /*
     * He pressed about every thirteen seconds while waiting. Any threshold shorter than a
     * thoughtful pause lets a heavy step start between two actions of somebody actively using the
     * site. The other heavy jobs already chose ninety seconds for this reason.
     */
    const text = await src("src/instrumentation.ts");
    const m = text.match(/const IDLE_SECONDS = (\d+);/);
    assert.ok(m, "IDLE_SECONDS is no longer declared as a plain number");
    assert.ok(Number(m[1]) >= 60, `IDLE_SECONDS is ${m[1]}; a person pausing between clicks would keep restarting heavy work`);
  });

  test("a person who loaded a page thirteen seconds ago is not idle by ninety seconds, and is by five", async () => {
    // The two thresholds side by side on the gap he actually left between presses.
    const { noteRequest } = await import("../src/lib/activity");
    noteRequest();
    const thirteenSecondsLater = Date.now() + 13_000;
    assert.equal(isIdle(90, thirteenSecondsLater), false, "ninety seconds: still in use, the warm-up waits");
    assert.equal(isIdle(5, thirteenSecondsLater), true, "five seconds: 'idle', which is how a heavy step started between his presses");
  });
});

describe("the sign-in button admits it is working", () => {
  test("REGRESSION: the login form uses SubmitButton, which disables itself while pending", async () => {
    const text = await src("src/app/login/page.tsx");
    assert.match(text, /<SubmitButton[\s\S]*?pendingLabel=/, "the login page is back to a plain submit button");
    assert.doesNotMatch(text, /<button[^>]*type="submit"[^>]*>\s*Sign in\s*<\/button>/, "a plain Sign in button gives no sign it is working");
  });

  test("SubmitButton really does disable itself while the form is pending", async () => {
    const text = await src("src/components/submit-button.tsx");
    assert.match(text, /useFormStatus/);
    assert.match(text, /disabled=\{[^}]*pending/, "SubmitButton no longer disables on pending — a second press could start again");
  });
});
