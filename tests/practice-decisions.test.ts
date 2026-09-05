import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DECISIONS } from "../src/lib/practice-decisions";

/**
 * The questions the manual is waiting on.
 *
 * Every one of these exists because the policy reviewer raised it as a finding and refused to
 * invent the answer — correctly, since a manual is a standard an inspector holds the pharmacy to.
 * What matters here is that each question is answerable and that the sentence an answer produces is
 * fit to appear in the manual, because that sentence is what an inspector reads back.
 */
describe("the decisions the manual is waiting on", () => {
  test("each question is asked once, with a key of its own", () => {
    const keys = DECISIONS.map((d) => d.key);
    assert.equal(new Set(keys).size, keys.length, "two questions share a key");
    assert.ok(DECISIONS.length >= 8, "the findings raised more than a handful");
  });

  test("every question offers at least two real answers and names what it affects", () => {
    for (const d of DECISIONS) {
      assert.ok(d.choices.length >= 2, `${d.key} offers no choice`);
      assert.ok(d.affects.trim().length > 0, `${d.key} does not say which section it unblocks`);
      assert.ok(d.why.trim().length > 20, `${d.key} does not say why the manual needs it`);
    }
  });

  test("at most one answer per question is suggested, so the page never recommends two", () => {
    for (const d of DECISIONS) {
      assert.ok(d.choices.filter((c) => c.recommended).length <= 1, `${d.key} suggests more than one answer`);
    }
  });

  test("every answer produces a sentence written as the pharmacy's own practice", () => {
    for (const d of DECISIONS) {
      for (const c of d.choices) {
        assert.ok(c.sentence.length > 60, `${d.key}/${c.value} is too short to state a practice`);
        assert.ok(/\.$/.test(c.sentence.trim()), `${d.key}/${c.value} is not a finished sentence`);
        // The reviewer is told these are facts about the pharmacy. A sentence that instructs the
        // reader to decide something would put the original finding straight back into the manual.
        assert.ok(
          !/\b(should|must decide|establish a|develop a|as appropriate|such as monthly)\b/i.test(c.sentence),
          `${d.key}/${c.value} tells the reader to decide rather than stating what the pharmacy does`,
        );
      }
    }
  });

  test("the answers to one question are genuinely different from each other", () => {
    for (const d of DECISIONS) {
      const sentences = d.choices.map((c) => c.sentence);
      assert.equal(new Set(sentences).size, sentences.length, `${d.key} offers the same sentence twice`);
    }
  });

  test("where a rule is cited in an answer, it is cited exactly", () => {
    // A regulation attributed loosely is a finding the pharmacy wrote for itself.
    // The trailing full stop of the sentence is not part of the citation.
    const cited = DECISIONS.flatMap((d) => d.choices).flatMap((c) => c.sentence.match(/21 CFR \d+\.\d+(?:\([a-z0-9]+\))*/g) ?? []);
    for (const c of cited) {
      assert.match(c, /^21 CFR 1\d{3}\.\d+(\([a-z0-9]+\))*$/, `"${c}" is not a citation in the form parts 1300-1317 use`);
    }
  });
});
