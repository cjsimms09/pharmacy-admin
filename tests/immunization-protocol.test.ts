import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { protocolGaps, PROTOCOL_VACCINES, EMERGENCY_STEPS, type ProtocolContext } from "../src/lib/immunization-protocol";

/**
 * A protocol signed for somebody who is not qualified authorises nothing.
 *
 * K.S.A. 65-1635a conditions the authority on completed immunization training and a current CPR
 * certificate. Producing a clean-looking document for somebody holding neither, getting a
 * physician to sign it and filing it is worse than having no protocol at all: it reads as
 * compliant right up until an inspector checks the two things behind it. So the page says what is
 * missing before it is taken anywhere.
 */
const ctx = (over: Partial<ProtocolContext["subject"]> = {}, physician: string | null = "Larry Dircksen, MD"): ProtocolContext => ({
  pharmacy: "West Wichita Family Pharmacy",
  address: "8200 W Central Ave, Wichita, KS",
  physician,
  termYears: 2,
  subject: {
    personId: "p1",
    name: "Kimberly Ahn",
    role: "Pharmacy technician",
    licence: "T-61008",
    immunizationTraining: "APhA-2019",
    cpr: { number: "AHA-8812", expiresOn: "2099-01-01" },
    existing: null,
    administersVaccines: true,
    ...over,
  },
});

describe("what has to be true before a protocol is signed", () => {
  test("a fully qualified immunizer raises nothing", () => {
    assert.deepEqual(protocolGaps(ctx()), []);
  });

  test("no immunization training is a gap, because the statute conditions the authority on it", () => {
    const gaps = protocolGaps(ctx({ immunizationTraining: null }));
    assert.equal(gaps.length, 1);
    assert.match(gaps[0], /65-1635a/);
  });

  test("no CPR certificate is a gap for the same reason", () => {
    assert.match(protocolGaps(ctx({ cpr: null })).join(" "), /CPR/);
  });

  test("an expired CPR certificate is caught, not just a missing one", () => {
    const gaps = protocolGaps(ctx({ cpr: { number: "AHA-1", expiresOn: "2020-01-01" } }));
    assert.match(gaps.join(" "), /expired on 2020-01-01/);
  });

  test("no authorising physician is a gap — there is nobody to sign it", () => {
    assert.match(protocolGaps(ctx({}, null)).join(" "), /authorising physician/i);
  });

  test("a missing licence number is caught by name", () => {
    assert.match(protocolGaps(ctx({ licence: null })).join(" "), /Kimberly Ahn/);
  });
});

describe("the protocol's own content", () => {
  test("covers the vaccines the pharmacy's signed protocol lists", () => {
    const flat = PROTOCOL_VACCINES.flat().filter(Boolean);
    for (const v of ["COVID", "RSV", "Shingles (Shingrix/Zostavax)", "Yellow Fever (YF-Vax)", "Influenza Vaccine, inactive (IIV)"]) {
      assert.ok(flat.includes(v as never), `${v} is missing from the protocol`);
    }
  });

  test("the anaphylaxis steps start with 911 and give a real epinephrine dose", () => {
    assert.match(EMERGENCY_STEPS[0], /911/);
    assert.match(EMERGENCY_STEPS[1], /0\.3mL/);
    assert.match(EMERGENCY_STEPS[1], /1:1000/);
  });

  test("the steps run through to monitoring, not just the injection", () => {
    assert.match(EMERGENCY_STEPS.join(" "), /CPR/);
    assert.match(EMERGENCY_STEPS[EMERGENCY_STEPS.length - 1], /vital signs/);
  });
});

describe("who the protocol page is offered to", () => {
  test("somebody not yet marked as an immunizer is warned, not blocked", () => {
    const gaps = protocolGaps(ctx({ administersVaccines: false }));
    assert.match(gaps.join(" "), /does not say they administer vaccines/);
  });

  test("that warning names the person, so it is actionable", () => {
    assert.match(protocolGaps(ctx({ administersVaccines: false })).join(" "), /Kimberly Ahn/);
  });

  test("a marked immunizer with everything on file is still clean", () => {
    assert.deepEqual(protocolGaps(ctx({ administersVaccines: true })), []);
  });
});
