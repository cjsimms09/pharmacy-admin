import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * A resolved promise is not a delivered message.
 *
 * nodemailer throws when the conversation fails — bad password, refused connection, or every
 * recipient rejected. It does NOT throw when the server accepts the session and refuses only
 * *some* recipients: it resolves normally, with those addresses in `rejected`. The old code
 * discarded the whole result object and called any non-throw a success, so a partially refused
 * send reported "sent" and part of the pharmacy never heard about their training.
 *
 * These pin the decision itself, which is the part worth being sure of.
 */
type Info = { accepted?: string[]; rejected?: string[]; response?: string };
const isDelivered = (info: Info) => {
  const accepted = (info.accepted ?? []).map(String);
  const rejected = (info.rejected ?? []).map(String);
  return rejected.length === 0 && accepted.length > 0;
};

describe("deciding whether a message actually went", () => {
  test("accepted for the recipient counts as sent", () => {
    assert.equal(isDelivered({ accepted: ["kim@wwfppa.com"], rejected: [], response: "250 2.0.0 OK" }), true);
  });

  test("a refused recipient is not a successful send, however calm the promise was", () => {
    assert.equal(isDelivered({ accepted: [], rejected: ["kim@wwfppa.com"], response: "550 5.1.1 unknown" }), false);
  });

  test("a partial refusal is a failure, not a partial success", () => {
    assert.equal(isDelivered({ accepted: ["a@x.com"], rejected: ["b@x.com"] }), false);
  });

  test("accepted for nobody is not sent, even with nothing rejected", () => {
    assert.equal(isDelivered({ accepted: [], rejected: [] }), false);
  });

  test("a result object with nothing in it is not treated as success", () => {
    assert.equal(isDelivered({}), false);
  });
});
