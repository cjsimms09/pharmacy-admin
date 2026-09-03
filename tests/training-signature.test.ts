import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { STATEMENTS } from "../src/lib/training-assignments";
import { TRAINING_CADENCE } from "../src/lib/due";
import type { TrainingType } from "../src/db/schema";

/**
 * What a member of staff signs is the evidence. A roster records that somebody wrote their name;
 * these record what they were agreeing to when they did, which is the difference between a
 * signature that means something at inspection and one that does not.
 */
describe("attestation wording", () => {
  test("every recurring training a person can be assigned has wording", () => {
    // Anything chased annually must be assignable, or the loop cannot be closed for it.
    const chased = Object.keys(TRAINING_CADENCE) as TrainingType[];
    const missing = chased.filter((t) => t !== "immunization_protocol_review" && !STATEMENTS[t]);
    assert.deepEqual(missing, [], `no wording for: ${missing.join(", ")}`);
  });

  test("each statement is written in the first person, as a signature must be", () => {
    for (const [type, s] of Object.entries(STATEMENTS)) {
      assert.ok(s!.startsWith("I confirm"), `${type} does not read as something a person says`);
    }
  });

  test("each states what was understood, not merely that something was completed", () => {
    // "I did the training" is worth very little. What matters is what they now know they must do.
    for (const [type, s] of Object.entries(STATEMENTS)) {
      assert.ok(/I understand|I know/.test(s!), `${type} records completion without comprehension`);
      assert.ok(s!.length > 150, `${type} is too thin to be worth signing`);
    }
  });

  test("the reporting duty is named in the trainings that turn on it", () => {
    for (const t of ["fwa_general_compliance", "hipaa_privacy_security", "controlled_substance_diversion"] as const) {
      assert.match(STATEMENTS[t]!, /report/i, `${t} must state the duty to report`);
    }
  });

  test("fraud training states that reporting carries no retaliation", () => {
    assert.match(STATEMENTS.fwa_general_compliance!, /without fear of\s+retaliation/i);
  });

  test("HIPAA training states the obligation outlives employment", () => {
    assert.match(STATEMENTS.hipaa_privacy_security!, /after my employment ends/i);
  });

  test("CQI training says reporting is expected rather than punished", () => {
    assert.match(STATEMENTS.cqi_program_review!, /rather than held against me/i);
  });
});

import { parseMaterials } from "../src/lib/training-assignments";

/**
 * A bad link in a compliance email is worse than none: staff cannot do the training and the PIC
 * does not find out until somebody asks. So anything that is not plainly a web address is
 * dropped rather than sent.
 */
describe("training material links", () => {
  test("reads the lines a person would write", () => {
    const m = parseMaterials("fwa_general_compliance = https://example.org/fwa\nhipaa_privacy_security=https://example.org/hipaa");
    assert.equal(m.fwa_general_compliance, "https://example.org/fwa");
    assert.equal(m.hipaa_privacy_security, "https://example.org/hipaa");
  });

  test("blank lines and comments are skipped", () => {
    assert.deepEqual(parseMaterials("\n# the CMS one\n\n"), {});
  });

  test("anything that is not a web address is dropped, not passed through", () => {
    // "ask Sarah" in an email as though it were a link is exactly the failure to avoid.
    assert.deepEqual(parseMaterials("fwa_general_compliance = ask Sarah"), {});
    assert.deepEqual(parseMaterials("fwa_general_compliance = www.example.org"), {});
    assert.deepEqual(parseMaterials("fwa_general_compliance = javascript:alert(1)"), {});
  });

  test("a line with no separator is ignored", () => {
    assert.deepEqual(parseMaterials("https://example.org/fwa"), {});
  });
});
