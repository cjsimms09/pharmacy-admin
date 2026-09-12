import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mailTone } from "../src/lib/mail-health";

/**
 * The distinction this exists to make.
 *
 * "Configured" and "working" were treated as the same thing everywhere, and they are not: a Gmail
 * address saved with the account password rather than an app password is fully configured, cannot
 * send a single message, and satisfied every check the site made. That is precisely the state a
 * pharmacist-in-charge sits in while believing the training emails are going out.
 */
describe("mail health tone", () => {
  test("never sent is not the same as sending fine", () => {
    assert.equal(mailTone("unproven"), "warn");
    assert.notEqual(mailTone("unproven"), mailTone("ok"));
  });

  test("configured but refused is as serious as not configured at all", () => {
    assert.equal(mailTone("failing"), "crit");
    assert.equal(mailTone("off"), "crit");
  });

  test("only a message that actually went through reads as fine", () => {
    assert.equal(mailTone("ok"), "ok");
  });
});
