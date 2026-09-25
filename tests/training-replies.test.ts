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

import fs from "node:fs";

/**
 * The reply route has two ends and both have to exist. Somebody is told to reply; something has
 * to read the reply; and they have to hear back, or the next instruction they get is one they
 * assume does not work either.
 */
describe("the loop actually closes", () => {
  const email = fs.readFileSync("src/lib/training-email.ts", "utf8");
  const replies = fs.readFileSync("src/lib/training-replies.ts", "utf8");
  const page = fs.readFileSync("src/app/(app)/compliance/training/page.tsx", "utf8");

  test("the email says the words to send and where to send them from", () => {
    assert.match(email, /REPLY_PHRASE/);
    assert.match(email, /from this address/i, "must say the reply has to come from their own address");
    assert.match(email, /reply code|Reply code/, "must show them the code");
  });

  test("both the plain-text and HTML versions carry the instruction", () => {
    // A client that strips markup must not strip the only copy of how to reply.
    const text = email.slice(email.indexOf("export function textFor"), email.indexOf("export function htmlFor"));
    const html = email.slice(email.indexOf("export function htmlFor"));
    assert.match(text, /REPLY_PHRASE/, "plain text lost the instruction");
    assert.match(html, /REPLY_PHRASE/, "HTML lost the instruction");
  });

  test("a matched reply produces a training record and a certificate to point at", () => {
    assert.match(replies, /schema\.trainings/, "must write the training record");
    assert.match(replies, /trainingId/, "must link the record to the assignment");
    assert.match(replies, /\/certificate/, "must send them their certificate");
  });

  test("the acknowledgement can never lose the record it is acknowledging", () => {
    const ack = replies.slice(replies.indexOf("async function acknowledge"));
    assert.match(ack, /try \{/, "sending must be guarded");
    assert.match(ack, /catch/, "a mail failure must not undo a written record");
  });

  test("the screen says so when nothing is reading the mailbox", () => {
    // Offering the reply route with no sweep running is worse than not offering it.
    assert.match(page, /mail_enabled === "yes"/);
    assert.match(page, /never be seen/i);
  });
});
