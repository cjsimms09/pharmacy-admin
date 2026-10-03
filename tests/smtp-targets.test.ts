import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { smtpTargets } from "../src/lib/send-mail";

/**
 * Reading a mailbox and sending from it are different servers, and the original code assumed
 * otherwise: it took the IMAP host, swapped a leading "imap." for "smtp.", and hard-coded port
 * 465. That is right for Gmail and wrong for most other things — and it failed in the worst
 * possible way, which is silently, because nothing here could send a test message.
 */
describe("where to try sending from", () => {
  test("an explicit setting wins outright", () => {
    const t = smtpTargets({ mail_smtp_host: "mail.example.org", mail_smtp_port: "587", mail_host: "imap.gmail.com", mail_user: "a@gmail.com" });
    assert.equal(t.length, 1);
    assert.deepEqual(t[0], { host: "mail.example.org", port: 587, secure: false });
  });

  test("465 is treated as SSL and anything else as STARTTLS", () => {
    assert.equal(smtpTargets({ mail_smtp_host: "h", mail_smtp_port: "465" })[0].secure, true);
    assert.equal(smtpTargets({ mail_smtp_host: "h", mail_smtp_port: "587" })[0].secure, false);
  });

  test("Gmail goes to smtp.gmail.com on 465", () => {
    const t = smtpTargets({ mail_user: "wwfrxadmin@gmail.com", mail_host: "imap.gmail.com" });
    assert.deepEqual(t[0], { host: "smtp.gmail.com", port: 465, secure: true });
  });

  test("Office 365 does not just get its IMAP host back", () => {
    // outlook.office365.com is not an SMTP server and never was. The old rule left it unchanged
    // because the name does not start with "imap.", so every send failed with a timeout.
    const t = smtpTargets({ mail_user: "pharmacy@example.com", mail_host: "outlook.office365.com" });
    assert.ok(t.some((x) => x.host === "smtp.office365.com"), "should try the real Office 365 sending host");
    assert.equal(t[0].host, "smtp.office365.com");
  });

  test("an unknown provider is tried on both ports before giving up", () => {
    const t = smtpTargets({ mail_user: "rx@bigpharmacy.org", mail_host: "imap.bigpharmacy.org" });
    const pairs = t.map((x) => `${x.host}:${x.port}`);
    assert.ok(pairs.includes("smtp.bigpharmacy.org:465"));
    assert.ok(pairs.includes("smtp.bigpharmacy.org:587"));
  });

  test("nothing is tried twice", () => {
    const t = smtpTargets({ mail_user: "rx@x.com", mail_host: "imap.x.com" });
    const pairs = t.map((x) => `${x.host}:${x.port}`);
    assert.equal(new Set(pairs).size, pairs.length);
  });

  test("no address and no host produces nothing rather than a bad guess", () => {
    assert.deepEqual(smtpTargets({}), []);
  });
});
