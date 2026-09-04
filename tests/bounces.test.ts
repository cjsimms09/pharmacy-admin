import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isBounce, parseBounce, describeBounce } from "../src/lib/bounces";

/**
 * Real bounce shapes, because this is the message that explains why an email never arrived and it
 * was being thrown away. Getting it wrong in the other direction is worse: mistaking a member of
 * staff's genuine reply for a bounce would discard their attestation, so detection deliberately
 * needs more than a suspicious-looking sender.
 */

const GMAIL = `Delivery incomplete
There was a temporary problem delivering your message. Gmail will retry.

Final-Recipient: rfc822; kimberley@wwfrx.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.
Remote-MTA: dns; aspmx.l.google.com
`;

const POSTFIX = `This is the mail system at host mail.example.net.

I'm sorry to have to inform you that your message could not be delivered.

<trevor@wwfrx.com>: host mx.wwfrx.com[10.0.0.4] said: 550 5.1.1
    <trevor@wwfrx.com>: Recipient address rejected: User unknown in local
    recipient table (in reply to RCPT TO command)
`;

const DEFERRED = `Final-Recipient: rfc822; luis@wwfrx.com
Action: delayed
Status: 4.4.1
Diagnostic-Code: smtp; 421 4.4.1 Connection timed out
`;

describe("spotting a bounce", () => {
  test("a delivery-status report is recognised by its own fields", () => {
    assert.ok(isBounce({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", text: GMAIL }));
  });

  test("a postfix report with no machine fields is still recognised", () => {
    assert.ok(isBounce({ from: "MAILER-DAEMON@mail.example.net", subject: "Undelivered Mail Returned to Sender", text: POSTFIX }));
  });

  test("the MIME report type alone is enough", () => {
    assert.ok(isBounce({ from: "noreply@corp.example", subject: "Mail problem", text: "nothing structured", headers: 'Content-Type: multipart/report; report-type="delivery-status"' }));
  });

  test("a member of staff replying is never a bounce", () => {
    assert.ok(!isBounce({ from: "kimberly@wwfrx.com", subject: "Re: HIPAA privacy & security", text: "I COMPLETED THIS 8SS-LVR" }));
  });

  test("a daemon address alone is not enough to discard a message", () => {
    assert.ok(!isBounce({ from: "postmaster@wwfrx.com", subject: "Question about the training", text: "Which one is due?" }));
  });
});

describe("reading what went wrong", () => {
  test("names the address and the reason from a structured report", () => {
    const b = parseBounce({ from: "mailer-daemon@googlemail.com", subject: "Failure", text: GMAIL });
    assert.equal(b.recipient, "kimberley@wwfrx.com");
    assert.match(b.diagnostic, /does not exist/);
    assert.equal(b.permanent, true);
  });

  test("digs the address out of postfix prose", () => {
    const b = parseBounce({ from: "MAILER-DAEMON@mail.example.net", subject: "Undelivered Mail", text: POSTFIX });
    assert.equal(b.recipient, "trevor@wwfrx.com");
    assert.match(b.diagnostic, /550/);
    assert.equal(b.permanent, true);
  });

  test("a temporary defer is not reported as a permanent failure", () => {
    const b = parseBounce({ from: "mailer-daemon@x", subject: "Delayed", text: DEFERRED });
    assert.equal(b.permanent, false);
    assert.match(describeBounce(b), /deferred/);
  });

  test("the sentence names the address, because a typo is the usual cause", () => {
    const b = parseBounce({ from: "mailer-daemon@googlemail.com", subject: "Failure", text: GMAIL });
    assert.match(describeBounce(b), /kimberley@wwfrx\.com/);
    assert.match(describeBounce(b), /will not be retried/);
  });

  test("a report that names nobody still produces a usable sentence", () => {
    const b = parseBounce({ from: "mailer-daemon@x", subject: "Undeliverable", text: "no fields here at all" });
    assert.equal(b.recipient, null);
    assert.match(describeBounce(b), /did not name/);
  });
});
