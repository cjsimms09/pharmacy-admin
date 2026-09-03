import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeReplyCode, REPLY_PHRASE } from "../src/lib/training-replies";

/**
 * The reply route is the one place in this system where something is accepted on the strength of
 * an email header, so its matching rules are the thing worth testing hardest. Two failures matter
 * and they fail in opposite directions: a code that is ambiguous closes the wrong training, and a
 * match that is too strict silently ignores a reply somebody genuinely sent and then chases them
 * for a fortnight about training they have done.
 */
describe("reply codes", () => {
  test("carry no characters that get misread aloud or in a screenshot", () => {
    // O/0 and I/1 are the whole reason this alphabet exists: these codes get read over the
    // counter and typed back by hand.
    for (let i = 0; i < 300; i++) {
      const code = makeReplyCode();
      assert.match(code, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/, `bad code: ${code}`);
      assert.ok(!/[O0I1]/.test(code), `ambiguous character in ${code}`);
    }
  });

  test("do not collide in any batch a pharmacy could plausibly generate", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(makeReplyCode());
    // 32^6 is about a billion; a handful of collisions in five thousand would mean the generator
    // is not actually random.
    assert.ok(seen.size > 4990, `${5000 - seen.size} collisions in 5000 codes`);
  });

  test("the phrase is something a person will actually type", () => {
    assert.ok(REPLY_PHRASE.length < 25, "too long to retype");
    assert.match(REPLY_PHRASE, /^[A-Z ]+$/, "the phrase must survive being shouted by a mail client");
  });
});
