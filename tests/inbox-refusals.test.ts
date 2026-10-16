import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { refusalsWorthReporting, wasDeclined, type SweptMessage } from "../src/lib/inbox-refusals";

const msg = (over: Partial<SweptMessage>): SweptMessage => ({
  fromAddress: "dashboard@veridikal.com",
  subject: "eVoucher Program - Client Summary",
  receivedAt: "2026-09-15T21:04:00.000Z",
  reason: "Nothing on this message was a type this reads: eVoucher Program - Client Summary.xlsx (sent as application/x-msexcel).",
  status: "ignored",
  ...over,
});

describe("what counts as a message being turned away", () => {
  test("an attachment declined for its type is a refusal", () => {
    assert.equal(wasDeclined(msg({})), true);
  });

  test("a message with nothing attached is not, and that is most email", () => {
    /*
     * The first version of this alert opened with "7 messages arrived and were turned away". Five
     * were a shipment notification, a login, two postage confirmations and a training reply — nothing
     * offered, nothing refused. An alert that calls that a fault is an alert about having an inbox.
     */
    assert.equal(wasDeclined(msg({ reason: "No attachment on this message." })), false);
    assert.equal(wasDeclined(msg({ reason: "No report attachment on this message." })), false);
  });

  test("anything the store itself rejected counts however it was worded", () => {
    assert.equal(wasDeclined(msg({ status: "rejected", reason: "over the size ceiling" })), true);
  });
});

describe("a refusal stops being reported the moment it is fixed", () => {
  test("the same document forwarded from another address supersedes it", () => {
    /*
     * Veridikal is why the sender alone is not enough: their reports were refused from their own
     * address, and what fixed it was the owner forwarding them from his. Nothing from Veridikal was
     * ever stored, so a sender-keyed test would have gone on reporting a fault that was fixed and paid.
     */
    const fixed = refusalsWorthReporting(
      [msg({})],
      [msg({ fromAddress: "wwfrxadmin@gmail.com", subject: "Fwd: eVoucher Program - Client Summary", receivedAt: "2026-09-16T15:55:00.000Z", status: "stored", reason: null })],
    );
    assert.deepEqual(fixed, []);
  });

  test("a later message from the same sender supersedes it too", () => {
    const fixed = refusalsWorthReporting([msg({})], [msg({ subject: "eVoucher Program - Client Summary", receivedAt: "2026-10-15T21:04:00.000Z", status: "stored", reason: null })]);
    assert.deepEqual(fixed, []);
  });

  test("an earlier success does not supersede a later refusal", () => {
    const still = refusalsWorthReporting([msg({})], [msg({ receivedAt: "2026-09-01T09:00:00.000Z", subject: "something else entirely", status: "stored", reason: null })]);
    assert.equal(still.length, 1, "the refusal is newer, so it still stands");
  });

  test("a short subject is never taken as proof two messages are the same document", () => {
    /* "Invoice" would match half the mailbox, and a false supersede hides a real refusal. */
    const still = refusalsWorthReporting(
      [msg({ subject: "Invoice" })],
      [msg({ fromAddress: "someone@else.com", subject: "Invoice 9000012345", receivedAt: "2026-09-16T00:00:00.000Z", status: "stored", reason: null })],
    );
    assert.equal(still.length, 1);
  });

  test("a bounce is the mail system talking about our own post, not a sender refused", () => {
    assert.deepEqual(refusalsWorthReporting([msg({ fromAddress: "mailer-daemon@googlemail.com" })], []), []);
  });

  test("an unfixed refusal is still reported, which is the whole point", () => {
    assert.equal(refusalsWorthReporting([msg({})], []).length, 1);
  });
});
