import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asked, mustBeAsked, whoAsked, wasAsked, NotAsked } from "../src/lib/ai-gate";

/**
 * The owner: "nothing in our site should be using API unless I hit a button."
 *
 * The rule is default-deny, which is the only version that holds. A switch somebody has to remember
 * to check is a switch somebody forgets, and this codebase spent a night finding places where a
 * stated rule and its code had parted company.
 */

describe("nothing reaches the model on its own", () => {
  test("a call with nobody behind it is refused", () => {
    assert.throws(() => mustBeAsked("Reading an invoice"), NotAsked);
  });

  test("the refusal says what it was trying to do and what to press", () => {
    try {
      mustBeAsked("Reading an invoice");
      assert.fail("should have refused");
    } catch (e) {
      assert.ok(e instanceof NotAsked);
      assert.equal(e.what, "Reading an invoice");
      assert.match(e.message, /nothing calls it on its own/);
      assert.match(e.message, /press the button/);
    }
  });

  test("a scheduled sweep is not somebody", () => {
    assert.equal(wasAsked(), false);
    assert.equal(whoAsked(), null);
  });
});

describe("what a button press allows", () => {
  test("everything inside the press may reach the model", async () => {
    const r = await asked("Cory Simms", "Reading a return policy", async () => {
      const a = mustBeAsked("Reading a return policy");
      return a.who;
    });
    assert.equal(r, "Cory Simms");
  });

  test("who and why travel with it, so the bill reads as a list of presses", async () => {
    await asked("Cory Simms", "Auditing the manual", async () => {
      assert.deepEqual(whoAsked(), { who: "Cory Simms", why: "Auditing the manual" });
    });
  });

  test("it reaches through the whole call tree, however deep", async () => {
    const deep = async (n: number): Promise<string> => (n === 0 ? mustBeAsked("deep work").who : deep(n - 1));
    assert.equal(await asked("Cory Simms", "a long job", () => deep(20)), "Cory Simms");
  });

  /*
   * The case a module-level flag gets wrong. Two things running at once: one a button press, one a
   * scheduled sweep. The sweep must not borrow the press.
   */
  test("a sweep running alongside a press is still refused", async () => {
    let sweepRefused = false;
    const press = asked("Cory Simms", "Reading a CQI packet", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return mustBeAsked("Reading a CQI packet").who;
    });
    const sweep = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      try {
        mustBeAsked("The nightly manual audit");
      } catch {
        sweepRefused = true;
      }
    })();
    const [who] = await Promise.all([press, sweep]);
    assert.equal(who, "Cory Simms", "the press still worked");
    assert.equal(sweepRefused, true, "and the sweep beside it was still refused");
  });

  test("the permission ends when the press ends", async () => {
    await asked("Cory Simms", "one thing", async () => undefined);
    assert.equal(wasAsked(), false, "it does not leak into whatever runs next");
  });
});
