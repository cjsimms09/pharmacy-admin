import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { textFor, htmlFor, type EmailContext } from "../src/lib/training-email";
import type { TrainingType } from "../src/db/schema";

/**
 * What the email says about the material has to be what the email carries.
 *
 * The wording claimed the material was attached to every training. It was attached to the six
 * that are written courses and to none of the two that are not — including the policy manual
 * acknowledgement, which every member of staff is sent. So the training most people received was
 * an email with an empty paperclip and a sentence insisting otherwise, which is how somebody
 * decides the whole system is broken and stops opening any of it.
 */

const ctx = (items: { type: TrainingType; title: string; attachment: string | null }[]): EmailContext => ({
  firstName: "Kimberly",
  pharmacy: "West Wichita Family Pharmacy",
  address: null,
  phone: null,
  picName: "Cory Simms",
  today: "2026-09-04",
  reminder: false,
  attachmentsOn: true,
  items: items.map((i, n) => ({
    type: i.type,
    title: i.title,
    minutes: 15,
    dueOn: `2026-10-0${n + 1}`,
    url: `https://example.test/t/tok${n}`,
    replyCode: "8SS-LVR",
    attachment: i.attachment,
  })),
});

const HIPAA = { type: "hipaa_privacy_security" as TrainingType, title: "HIPAA privacy & security", attachment: "hipaa.pdf" };
const MANUAL = { type: "policy_manual_acknowledgement" as TrainingType, title: "Policy and Procedure Manual", attachment: null };

describe("what the email says is attached", () => {
  test("says the material is attached when it is", () => {
    const body = textFor(ctx([HIPAA]));
    assert.match(body, /attached to this email/i);
  });

  test("does not claim an attachment when nothing could be attached", () => {
    const body = textFor(ctx([{ ...MANUAL, attachment: null }]));
    assert.ok(!/is attached to this email/i.test(body), body);
    assert.match(body, /Nothing is attached/i);
  });

  test("names which ones are attached when only some are", () => {
    const body = textFor(ctx([HIPAA, MANUAL]));
    assert.match(body, /Attached to this email as PDFs/i);
    assert.match(body, /HIPAA privacy & security/);
    assert.ok(!/Policy and Procedure Manual\n/.test(body.split("Attached to this email as PDFs")[1] ?? ""), body);
  });

  test("the per-item block names the file, so the paperclip can be matched to the training", () => {
    assert.match(textFor(ctx([HIPAA])), /Attached: hipaa\.pdf/);
  });

  test("the HTML version says the same thing as the plain text one", () => {
    const none = htmlFor(ctx([MANUAL]));
    assert.match(none, /Nothing is attached/i);
    assert.ok(!/full material for each one is attached/i.test(none), none);
  });
});
