import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COURSES, courseFor } from "../src/lib/courses";
import { packetText, courseVersion, packetFileName } from "../src/lib/course-packet";
import type { TrainingType } from "../src/db/schema";
import { TRAINING_CADENCE } from "../src/lib/due";
import { STATEMENTS } from "../src/lib/training-assignments";

/**
 * These are the checks that stop the training from being decorative.
 *
 * The failure mode is not a crash. It is a course that ships with a quiz whose answer index is
 * off by one, or a training everyone is chased for annually with no material behind it — both of
 * which produce a full set of green certificates attesting to nothing, and neither of which is
 * visible from the screen.
 */
describe("courses", () => {
  const entries = Object.entries(COURSES) as [TrainingType, NonNullable<ReturnType<typeof courseFor>>][];

  test("every course is reachable by its own type", () => {
    for (const [type, course] of entries) {
      assert.equal(course.type, type, `${type} is filed under the wrong key`);
      assert.equal(courseFor(type)?.title, course.title);
    }
  });

  test("every answer index points at a real option", () => {
    for (const [type, course] of entries) {
      course.questions.forEach((q, i) => {
        assert.ok(
          q.answer >= 0 && q.answer < q.options.length,
          `${type} question ${i + 1} answers option ${q.answer} of ${q.options.length}`,
        );
      });
    }
  });

  test("no question has duplicate options", () => {
    // Two identical options mean one of them is right and marked wrong, and the person who reads
    // carefully is the one who fails.
    for (const [type, course] of entries) {
      course.questions.forEach((q, i) => {
        assert.equal(new Set(q.options).size, q.options.length, `${type} question ${i + 1} repeats an option`);
      });
    }
  });

  test("every course has substance rather than a heading", () => {
    for (const [type, course] of entries) {
      assert.ok(course.sections.length >= 3, `${type} has only ${course.sections.length} sections`);
      assert.ok(course.questions.length >= 3, `${type} has only ${course.questions.length} questions`);
      assert.ok(course.authority.length > 40, `${type} does not say what it satisfies`);
      for (const s of course.sections) {
        assert.ok(s.body.length > 0, `${type} section "${s.heading}" is empty`);
        for (const p of s.body) assert.ok(p.length > 20, `${type} has a stub paragraph: "${p}"`);
      }
    }
  });

  test("every wrong answer is explained", () => {
    // The explanation is the only teaching that happens at the moment somebody is actually paying
    // attention. A blank one turns a comprehension check into a guessing game.
    for (const [type, course] of entries) {
      course.questions.forEach((q, i) => {
        assert.ok(q.why.length > 40, `${type} question ${i + 1} has no real explanation`);
      });
    }
  });

  test("bloodborne is the one that needs live questions, and says so", () => {
    assert.equal(COURSES.osha_bloodborne?.liveQuestionsRequired, true);
    assert.match(String(COURSES.osha_bloodborne?.authority), /1910\.1030/);
    // Nothing else claims it, because claiming it would mean asking staff to tick a box for a
    // requirement that does not exist.
    for (const [type, course] of entries) {
      if (type !== "osha_bloodborne") {
        assert.notEqual(course.liveQuestionsRequired, true, `${type} should not require live questions`);
      }
    }
  });

  test("everything chased annually has either a course or material the pharmacy holds", () => {
    // Two trainings deliberately have no course written into the site, because their material is
    // a document belonging to this pharmacy that cannot live in the software: the physician-signed
    // immunization protocol, and the policy and procedure manual. Both are attached to the email
    // instead. Anything else chased annually with nothing behind it is a requirement nobody can
    // actually meet, which is worse than not chasing it.
    const materialFromTheVault: TrainingType[] = ["immunization_protocol_review", "policy_manual_acknowledgement"];
    for (const type of Object.keys(TRAINING_CADENCE) as TrainingType[]) {
      if (materialFromTheVault.includes(type)) {
        // Still has to have something to sign, or it is a chase with no closing move.
        assert.ok(STATEMENTS[type], `${type} has no course and nothing to sign either`);
        continue;
      }
      assert.ok(courseFor(type), `${type} is chased annually with no material behind it`);
    }
  });

  test("every course has attestation wording to sign", () => {
    for (const [type] of entries) {
      assert.ok(STATEMENTS[type], `${type} has a course but nothing to sign`);
    }
  });

  /*
   * A statement that says only "I did the training" is worth nothing.
   *
   * The certificate quotes this wording back, so it is the whole of what the employee is on
   * record as having understood. Hazard communication shipped attesting to knowledge alone — where
   * the safety data sheets are, how to read a label — while the course itself spends a section on
   * spills, splashes and the duty to report every exposure, and 29 CFR 1910.1200(h)(3)(iii)
   * requires exactly that. The certificate therefore claimed less than the training delivered,
   * which is a strange document to hand an inspector. Checking only that a statement exists is
   * what let it through.
   */
  test("every statement carries an obligation, not just a claim to have attended", () => {
    for (const [type, statement] of Object.entries(STATEMENTS) as [TrainingType, string][]) {
      assert.match(statement, /I (confirm|acknowledge)/, `${type} does not say what was completed`);
      assert.match(statement, /I understand/, `${type} attests to attendance without understanding`);
      assert.match(
        statement,
        /report|what to do|expected|I must|my duty|obligation|has to be/,
        `${type} places no duty on the person signing it — it is a receipt, not an attestation`,
      );
    }
  });
});

describe("the packet", () => {
  test("carries the questions and their answers", () => {
    const c = COURSES.hipaa_privacy_security!;
    const text = packetText(c, "West Wichita Family Pharmacy");
    assert.match(text, /WEST WICHITA FAMILY PHARMACY/);
    assert.match(text, /CHECK YOUR UNDERSTANDING/);
    assert.match(text, /ANSWERS/);
    // The packet is hard-wrapped, so compare on the words rather than the line breaks.
    const flat = text.replace(/\s+/g, " ");
    for (const q of c.questions) {
      assert.ok(flat.includes(q.q.replace(/\s+/g, " ")), `a question is missing from the packet: ${q.q}`);
      for (const o of q.options) {
        assert.ok(flat.includes(o.replace(/\s+/g, " ")), `an option is missing from the packet: ${o}`);
      }
    }
  });

  test("wraps to something printable", () => {
    const text = packetText(COURSES.fwa_general_compliance!, "A Pharmacy");
    for (const line of text.split("\n")) {
      assert.ok(line.length <= 80, `a line is ${line.length} characters: ${line.slice(0, 40)}…`);
    }
  });

  test("the version changes when the content does, and not otherwise", () => {
    const c = COURSES.hipaa_privacy_security!;
    assert.equal(courseVersion(c), courseVersion(c), "the version is not stable");
    const edited = { ...c, sections: [...c.sections, { heading: "Extra", body: ["Something new."] }] };
    assert.notEqual(courseVersion(c), courseVersion(edited), "an edit did not change the version");
  });

  test("the version is short enough to compare by eye", () => {
    for (const c of Object.values(COURSES)) {
      assert.ok(courseVersion(c!).length <= 9, `version ${courseVersion(c!)} is too long to read off a certificate`);
    }
  });

  test("the file name is safe and names the version", () => {
    const name = packetFileName(COURSES.osha_bloodborne!);
    assert.match(name, /^[a-z0-9-]+-v[A-Z0-9]+\.txt$/);
    assert.ok(name.includes(courseVersion(COURSES.osha_bloodborne!)));
  });
});
