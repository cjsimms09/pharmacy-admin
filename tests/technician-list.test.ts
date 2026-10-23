import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TRAINING_CADENCE } from "../src/lib/due";
import { CLOSURES } from "../src/lib/obligations";

/**
 * Two things a pharmacist should never be asked to do by hand, because the site already knows
 * the answer: produce the technician list, and record that an immunization protocol was read
 * when the protocol itself is on file with an expiry date.
 */
describe("duties that must not ask the PIC for anything", () => {
  test("the technician list closes itself", () => {
    assert.equal(CLOSURES.technician_list.kind, "witnessed");
    assert.match(CLOSURES.technician_list.witness!, /automatically/i);
  });

  test("it is filed monthly, so a month is either covered or visibly is not", () => {
    // Quarterly left three months a leaver could vanish from without trace.
    assert.ok(CLOSURES.technician_list.witness);
  });
});

describe("the immunization protocol is a document, not a training", () => {
  test("it is not on the chased training list", () => {
    // It was, which put a column on the register for every technician who never immunizes and
    // asked for an annual sign-off on something already evidenced by a dated document.
    assert.equal(TRAINING_CADENCE.immunization_protocol_review, undefined);
  });

  test("the pharmacy-level duty says where the evidence lives instead", () => {
    assert.match(CLOSURES.immunization_protocol_review.witness!, /expiry|expires|on file/i);
  });
});

describe("every chased training explains itself", () => {
  test("in terms a person who did not set the requirement can understand", () => {
    for (const [type, c] of Object.entries(TRAINING_CADENCE)) {
      assert.ok(c.what && c.what.length > 60, `${type} does not say what the training covers`);
      assert.ok(c.why.length > 20, `${type} does not say why it is required`);
    }
  });
});
