import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { calibration, canAttestCalibration, CALIBRATION_WARNING_DAYS } from "../src/lib/calibration";

/*
 * The logger's calibration certificate.
 *
 * The annual vaccine storage obligation has the pharmacist-in-charge attest that "the data logger
 * is within its calibration period". Nothing held a certificate, so it was signed from memory.
 * These cases are mostly about one distinction: a logger nobody has recorded a certificate for is
 * not a logger in calibration, and it is not a logger out of calibration either.
 */

const TODAY = "2026-09-16";

describe("what the certificate says about today", () => {
  test("a certificate with months left is current", () => {
    const c = calibration({ calibratedOn: "2026-01-10", calibrationExpiresOn: "2027-01-10" }, TODAY);
    assert.equal(c.state, "current");
    assert.equal(c.daysLeft, 116);
  });

  test("inside the warning window it says so, because re-certification takes weeks", () => {
    const c = calibration({ calibratedOn: "2024-11-01", calibrationExpiresOn: "2026-11-01" }, TODAY);
    assert.equal(c.state, "expiring");
    assert.equal(c.daysLeft, 46);
    assert.ok(c.daysLeft !== null && c.daysLeft <= CALIBRATION_WARNING_DAYS);
  });

  test("the day before expiry is still in date, and the day after is not", () => {
    assert.equal(calibration({ calibrationExpiresOn: "2026-09-17" }, TODAY).state, "expiring");
    assert.equal(calibration({ calibrationExpiresOn: "2026-09-16" }, TODAY).state, "expiring", "expiring today has not expired yet");
    assert.equal(calibration({ calibrationExpiresOn: "2026-09-15" }, TODAY).state, "lapsed");
  });

  test("a lapsed certificate says what it means for the readings taken since", () => {
    const c = calibration({ calibratedOn: "2023-09-01", calibrationExpiresOn: "2025-09-01" }, TODAY);
    assert.equal(c.state, "lapsed");
    assert.equal(c.daysLeft, -380);
    assert.match(c.says, /not backed by a current certificate/);
  });
});

describe("the states that are not judgements about the logger", () => {
  test("REGRESSION: nothing recorded is its own state, and never reads as in calibration", () => {
    const c = calibration({ name: "Pharmacy Fridge" }, TODAY);
    assert.equal(c.state, "unrecorded");
    assert.equal(c.daysLeft, null);
    assert.match(c.says, /not a finding about the logger/);
  });

  test("a calibration date with no expiry cannot answer for today", () => {
    const c = calibration({ calibratedOn: "2026-02-01" }, TODAY);
    assert.equal(c.state, "no_expiry");
    assert.equal(c.daysLeft, null);
  });

  test("an unreadable expiry is not silently treated as in date", () => {
    assert.equal(calibration({ calibrationExpiresOn: "soon" }, TODAY).state, "no_expiry");
  });
});

describe("whether the annual statement can honestly be signed", () => {
  const fridge = { name: "Pharmacy Fridge", tracked: true, calibratedOn: "2026-01-10", calibrationExpiresOn: "2027-01-10" };
  const room = { name: "Room Temperature", tracked: true, calibratedOn: "2026-01-10", calibrationExpiresOn: "2027-01-10" };

  test("it can, when every logging sensor has a current certificate", () => {
    const r = canAttestCalibration([fridge, room], TODAY);
    assert.equal(r.ok, true);
    assert.deepEqual(r.lapsed, []);
  });

  test("REGRESSION: a sensor nobody logs is somebody else's fridge and is not asked about", () => {
    /* This pharmacy's iMonnit account carries seven sensors and logs two; the other five are not its problem. */
    const other = { name: "Building C North", tracked: false };
    const r = canAttestCalibration([fridge, room, other], TODAY);
    assert.equal(r.ok, true, "an untracked sensor with no certificate must not block the attestation");
  });

  test("it cannot, when one has lapsed — and it names which", () => {
    const r = canAttestCalibration([fridge, { ...room, calibrationExpiresOn: "2026-08-01" }], TODAY);
    assert.equal(r.ok, false);
    assert.deepEqual(r.lapsed, ["Room Temperature"]);
    assert.match(r.why, /Room Temperature/);
  });

  test("it cannot, when one has no certificate on file — and says that, not that it is out of calibration", () => {
    const r = canAttestCalibration([fridge, { name: "Room Temperature", tracked: true }], TODAY);
    assert.equal(r.ok, false);
    assert.deepEqual(r.unrecorded, ["Room Temperature"]);
    assert.match(r.why, /No certificate on file/);
    assert.doesNotMatch(r.why, /Out of calibration/);
  });

  test("with no logger tracked at all it refuses rather than passing vacuously", () => {
    /* A check that passes because there is nothing to check is the fault this codebase is named for. */
    const r = canAttestCalibration([], TODAY);
    assert.equal(r.ok, false);
    assert.match(r.why, /No logger is being tracked/);
  });
});
