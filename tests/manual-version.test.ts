import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { revisionOf, fingerprintOf, ackState, describeRevision } from "../src/lib/manual-version";
import type { Section } from "../src/lib/manual-store";

/**
 * Which manual somebody signed for.
 *
 * An acknowledgement is the pharmacy's evidence that its workforce was trained on the policies it
 * is held to — 45 CFR 164.530(b)(1), documented under (j)(1)(ii) — and that a sanction under
 * 164.530(e) could be defended against somebody who broke a rule. All of that turns on the person
 * having seen the rule, and the manual is edited in this system. A signature that cannot name its
 * version stops being true the first time a policy is rewritten, and nothing about the record
 * reveals that it has.
 */
const section = (over: Partial<Section>): Section =>
  ({
    id: "s1",
    sourceKey: null,
    source: "pharmacy",
    title: "Storage of controlled substances",
    level: 1,
    position: 100,
    body: "Schedule II stock is held in the safe.",
    reviewedOn: null,
    reviewedBy: null,
    retiredOn: null,
    managedBy: null,
    updatedBy: null,
    auditedOn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  }) as Section;

describe("identifying a revision of the manual", () => {
  test("the same text is the same revision, every time", () => {
    const a = revisionOf([section({}), section({ id: "s2", position: 200, title: "Returns" })]);
    const b = revisionOf([section({}), section({ id: "s2", position: 200, title: "Returns" })]);
    assert.equal(a.fingerprint, b.fingerprint);
  });

  test("changing a policy changes the revision", () => {
    const before = revisionOf([section({})]);
    const after = revisionOf([section({ body: "Schedule II stock is held in the dispensary." })]);
    assert.notEqual(before.fingerprint, after.fingerprint);
  });

  test("renaming a heading changes it too, because the heading is part of what was read", () => {
    assert.notEqual(revisionOf([section({})]).fingerprint, revisionOf([section({ title: "Safe storage" })]).fingerprint);
  });

  test("moving a sentence from one section into the next does not go unnoticed", () => {
    // Concatenating the bodies would give both of these the same answer, which is the mistake the
    // separator in the fingerprint exists to prevent.
    const split = revisionOf([
      section({ id: "a", position: 1, title: "T", body: "One." }),
      section({ id: "b", position: 2, title: "T", body: "Two." }),
    ]);
    const joined = revisionOf([
      section({ id: "a", position: 1, title: "T", body: "One. Two." }),
      section({ id: "b", position: 2, title: "T", body: "" }),
    ]);
    assert.notEqual(split.fingerprint, joined.fingerprint);
  });

  test("a section that was retired is not part of the manual any more", () => {
    const live = revisionOf([section({})]);
    const withRetired = revisionOf([section({}), section({ id: "old", position: 300, retiredOn: "2026-05-01" })]);
    assert.equal(live.fingerprint, withRetired.fingerprint);
    assert.equal(withRetired.sections, 1);
  });

  test("a chapter somebody else maintains still counts — it was handed over to be read", () => {
    const r = revisionOf([section({}), section({ id: "hr", position: 200, managedBy: "the medical practice" })]);
    assert.equal(r.sections, 2);
  });

  test("the revision reports what is in it, for printing on a form somebody signs", () => {
    const r = revisionOf([section({ body: "One two three four five." })]);
    assert.equal(r.words, 5);
    assert.equal(r.changedOn, "2026-09-01");
    assert.match(describeRevision(r), /^Revision [0-9a-f]{8} — 1 sections, last edited 2026-09-01$/);
  });

  test("an empty manual has a revision rather than a crash", () => {
    const r = revisionOf([]);
    assert.equal(r.sections, 0);
    assert.equal(r.changedOn, null);
    assert.equal(fingerprintOf([]).length, 8);
  });
});

describe("where a person's acknowledgement stands", () => {
  const current = revisionOf([section({})]);

  test("signed for this manual", () => {
    assert.equal(ackState(current.fingerprint, current), "current");
  });

  test("signed for an earlier one is its own state, not a failure to sign", () => {
    // The person did what was asked. The document they agreed to is not the one on the shelf.
    assert.equal(ackState("deadbeef", current), "superseded");
  });

  test("never signed", () => {
    assert.equal(ackState(null, current), "none");
    assert.equal(ackState(undefined, current), "none");
  });

  test("signed before versions were recorded is not silently treated as current", () => {
    assert.equal(ackState("legacy", current), "unknown");
  });
});

