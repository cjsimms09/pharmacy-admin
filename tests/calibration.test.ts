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
    /*
     * The state stays distinct — it is not "current" and never may be — but the sentence stopped
     * being a complaint. The owner, 17 September: "leave me alone about the fridge logger. idk when
     * its calibration ends, I dont care." The standard asks for a certificate that can be produced,
     * not one typed into this software, so an empty field is an arrangement rather than a failing.
     */
    assert.match(c.says, /kept with the logger rather than here/);
    assert.match(c.says, /confirmed at the annual vaccine storage review/);
    assert.doesNotMatch(c.says, /nothing here can back/);
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

  test("REGRESSION: a logger with no dates here does not block it either, but is named", () => {
    /*
     * This used to refuse, which left a mark no act of his could clear — the fault this file exists
     * among, and the reason he said "leave me alone about the fridge logger". The statement is his
     * own, made at a review, about a logger he can go and look at; the site's job is to say what it
     * checked and what it did not, and then get out of the way.
     */
    const r = canAttestCalibration([fridge, { name: "Room Temperature", tracked: true }], TODAY);
    assert.equal(r.ok, true, "an empty field is an arrangement, not a failing");
    assert.deepEqual(r.unrecorded, ["Room Temperature"]);
    assert.match(r.why, /Room Temperature/, "he is told which ones the software has not checked");
    assert.match(r.why, /this software has not checked them/);
    assert.doesNotMatch(r.why, /Out of calibration/);
  });

  test("REGRESSION: a calibration date with no expiry does not block the statement", () => {
    /*
     * The owner, 16 September 2026, having given the fridge logger's calibration date: "I don't know
     * when it ends.. don't specific in the P&P leave it vague and compliant."
     *
     * Some certificates state an expiry and some state an interval, and he may simply not have the
     * paper to hand. None of those is the same as holding no certificate. This used to block, which
     * made a line nobody could ever clear — the fault this file exists among. The statement is the
     * pharmacist-in-charge's own, made at a review, about a logger he can go and look at: the site's
     * job is to put the date in front of him, not to refuse him the pen.
     */
    const dated = { name: "Pharmacy Fridge", tracked: true, calibratedOn: "2026-07-01" };
    const r = canAttestCalibration([dated], TODAY);
    assert.equal(r.ok, true);
    assert.match(r.why, /No calibration dates are held here for Pharmacy Fridge/);
    assert.match(r.why, /confirm it is current when you sign/);
    assert.deepEqual(r.unrecorded, [], "a date on file is not 'no certificate'");
    /* And no period is invented anywhere: two years is the common interval and still a guess. */
    assert.doesNotMatch(r.why, /two years|24 months|2 years/i);
    assert.doesNotMatch(calibration(dated, TODAY).says, /two years|24 months|2 years/i);
  });

  test("with no logger tracked at all it refuses rather than passing vacuously", () => {
    /* A check that passes because there is nothing to check is the fault this codebase is named for. */
    const r = canAttestCalibration([], TODAY);
    assert.equal(r.ok, false);
    assert.match(r.why, /No logger is being tracked/);
  });
});
