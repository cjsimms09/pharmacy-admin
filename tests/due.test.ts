import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { addMonths, TRAINING_CADENCE } from "../src/lib/due";

/**
 * The due list is the only place the pharmacy looks, so a date computed wrongly here is a
 * deadline nobody sees. The month arithmetic in particular has to survive month-end, which is
 * where naive date maths silently rolls into the following month.
 */
describe("addMonths", () => {
  test("the ordinary case", () => {
    assert.equal(addMonths("2026-01-15", 12), "2027-01-15");
    assert.equal(addMonths("2026-03-01", 6), "2026-09-01");
  });

  test("the 31st of a month clamps rather than rolling into the next month", () => {
    // Naive maths turns 31 January plus one month into 3 March.
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2026-08-31", 1), "2026-09-30");
  });

  test("29 February in a leap year clamps to the 28th a year later", () => {
    assert.equal(addMonths("2024-02-29", 12), "2025-02-28");
  });

  test("crossing a year boundary", () => {
    assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
    assert.equal(addMonths("2026-11-30", 12), "2027-11-30");
  });

  test("a training completed on 29 February is still due annually", () => {
    const due = addMonths("2024-02-29", 12);
    assert.ok(due > "2025-02-01" && due < "2025-03-01", `got ${due}`);
  });
});

describe("training cadence", () => {
  test("every chased training states why it is chased", () => {
    for (const [type, c] of Object.entries(TRAINING_CADENCE)) {
      assert.ok(c.months > 0, `${type} has no interval`);
      assert.ok(c.why.length > 20, `${type} does not say why it is required`);
    }
  });

  test("the annual federal and OSHA requirements are all present", () => {
    for (const t of ["fwa_general_compliance", "hipaa_privacy_security", "osha_bloodborne", "osha_hazard_communication"]) {
      assert.ok(TRAINING_CADENCE[t as keyof typeof TRAINING_CADENCE], `${t} is not being chased`);
    }
  });

  test("nothing is chased more often than annually — noise trains people to ignore the list", () => {
    for (const [type, c] of Object.entries(TRAINING_CADENCE)) {
      assert.ok(c.months >= 12, `${type} is chased every ${c.months} months`);
    }
  });
});
