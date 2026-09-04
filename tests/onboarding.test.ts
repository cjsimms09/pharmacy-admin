import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startedOn, licenceFor, trainingsFor, credentialsFor } from "../src/lib/onboarding";

/**
 * What a new starter owes depends on two things, and getting either wrong is silent.
 *
 * The start date lives in a different column for an employee than for a student on rotation, and
 * reading only one of them excluded actual employees from the list of unfinished new starters —
 * the feature quietly not working for the people it exists for. And what is required follows from
 * the role and from whether they will be immunizing, which is a judgement the pharmacy makes once
 * and the checklist should not ask again.
 */
describe("who owes what on their first day", () => {
  const base = { engagement: "staff", hiredOn: null as string | null, startsOn: null as string | null };

  test("an employee's start date is their hire date", () => {
    assert.equal(startedOn({ ...base, hiredOn: "2026-03-01" }), "2026-03-01");
  });

  test("a rotation student's is the window they are present for", () => {
    assert.equal(startedOn({ engagement: "rotation", startsOn: "2026-04-06", hiredOn: null }), "2026-04-06");
  });

  test("either column will do rather than reporting no date at all", () => {
    assert.equal(startedOn({ ...base, startsOn: "2026-03-01" }), "2026-03-01");
    assert.equal(startedOn({ engagement: "rotation", startsOn: null, hiredOn: "2026-03-01" }), "2026-03-01");
  });

  test("nobody with no date recorded is given one", () => {
    assert.equal(startedOn(base), null);
  });

  test("the licence required follows the role", () => {
    assert.equal(licenceFor("pharmacist"), "pharmacist_license");
    assert.equal(licenceFor("technician"), "technician_registration");
    assert.equal(licenceFor("intern"), "intern_registration");
  });

  test("an immunizer owes three documents a non-immunizer does not", () => {
    const plain = credentialsFor({ role: "technician", administersVaccines: false });
    const jab = credentialsFor({ role: "pharmacist", administersVaccines: true });
    assert.deepEqual(plain, ["technician_registration"]);
    for (const t of ["cpr", "immunization_training", "immunization_protocol"]) assert.ok(jab.includes(t as never), t);
  });

  test("the immunization protocol review is only asked of immunizers", () => {
    assert.ok(!trainingsFor({ administersVaccines: false }).includes("immunization_protocol_review"));
  });

  test("everyone owes the annual set on day one", () => {
    const t = trainingsFor({ administersVaccines: false });
    for (const required of ["hipaa_privacy_security", "fwa_general_compliance", "osha_bloodborne", "policy_manual_acknowledgement"]) {
      assert.ok(t.includes(required as never), required);
    }
  });
});
