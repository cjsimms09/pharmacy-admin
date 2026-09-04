import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { subjectFor } from "../src/lib/training-email";
import type { TrainingType } from "../src/db/schema";

/**
 * The shape of a message decides whether it arrives.
 *
 * A test email with nothing attached reached the pharmacy; the same account's training email,
 * carrying seven text files and a Word document, did not — accepted by the sending server, then
 * dropped downstream with no bounce and nothing in any log. Everything here is about keeping the
 * training email the same shape as the message that is known to get through.
 */
const ctx = (replyCode: string | null, count = 1) => ({
  firstName: "Kimberly",
  pharmacy: "West Wichita Family Pharmacy",
  address: null,
  phone: null,
  picName: "Cory Simms",
  today: "2026-09-04",
  reminder: false,
  items: Array.from({ length: count }, (_, i) => ({
    type: "hipaa_privacy_security" as TrainingType,
    title: "HIPAA privacy & security",
    minutes: 15,
    dueOn: `2026-10-0${i + 1}`,
    url: "http://192.0.2.2:3100/t/abc",
    replyCode,
  })),
});

describe("the subject line", () => {
  test("carries the code so a quoted reply still matches", () => {
    assert.match(subjectFor(ctx("8SS-LVR")), /8SS-LVR/);
  });

  test("does not wrap the code in brackets — the oldest bulk-mail shape there is", () => {
    assert.ok(!/\[8SS-LVR\]/.test(subjectFor(ctx("8SS-LVR"))));
  });

  test("says what it is and when it is due", () => {
    const s = subjectFor(ctx("8SS-LVR"));
    assert.match(s, /HIPAA/);
    assert.match(s, /due/);
  });

  test("an assignment with no code produces no dangling separator", () => {
    const s = subjectFor(ctx(null));
    assert.ok(!s.includes("code"), s);
    assert.ok(!/[—-]\s*$/.test(s), s);
  });

  test("several trainings collapse to one subject rather than one email each", () => {
    assert.match(subjectFor(ctx("8SS-LVR", 3)), /3 required trainings/);
  });
});
