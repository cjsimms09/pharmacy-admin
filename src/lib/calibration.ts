/**
 * Whether a data logger's calibration certificate is current, and how long is left of it.
 *
 * The annual vaccine storage obligation has the pharmacist-in-charge attest that "the data logger
 * is within its calibration period". On 16 September 2026 nothing in this system held a
 * certificate, an expiry, or the make of the logger — zero documents and zero settings mentioned
 * calibration — so that sentence was signed from memory. This is what it should have been resting
 * on.
 *
 * The standard: the CDC Vaccine Storage and Handling Toolkit and the VFC programme both want a
 * certified digital data logger with a current certificate of calibration testing, traceable to a
 * recognised standard, re-certified on the interval the certificate itself names — commonly one or
 * two years. The certificate names the interval; this does not invent one.
 *
 * Five states, because "missing" is not a state. The one that matters is `unrecorded`: a logger
 * whose certificate nobody has entered is not a logger out of calibration, and it is not a logger
 * in calibration either. Reporting it as either would be inventing a fact about a piece of paper
 * nobody here has seen.
 */

export type CalibrationState =
  /** A certificate is on file and has not expired. */
  | "current"
  /** On file, in date, but inside the warning window — order the re-certification now. */
  | "expiring"
  /** On file and past its expiry. The logger's readings are no longer backed by a certificate. */
  | "lapsed"
  /** A calibration date is recorded but no expiry, so nothing can be said about today. */
  | "no_expiry"
  /** Nothing recorded. Not a judgement about the logger — a judgement about this system. */
  | "unrecorded";

/** How long before expiry the site starts asking. A certificate takes weeks to replace. */
export const CALIBRATION_WARNING_DAYS = 60;

export type Calibration = {
  state: CalibrationState;
  /** Days until expiry; negative once lapsed. Null where there is no expiry to count to. */
  daysLeft: number | null;
  /** One sentence for a screen, saying what is true rather than what is wrong. */
  says: string;
};

const DAY = 86_400_000;

/** Whole days from `from` to `to`, both ISO dates. Positive means `to` is in the future. */
function daysApart(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY);
}

export function calibration(
  sensor: { name?: string; calibratedOn?: string | null; calibrationExpiresOn?: string | null },
  today: string,
): Calibration {
  const on = (sensor.calibratedOn ?? "").trim();
  const expires = (sensor.calibrationExpiresOn ?? "").trim();

  if (!on && !expires) {
    return {
      state: "unrecorded",
      daysLeft: null,
      says:
        "No calibration certificate is recorded for this logger. That is not a finding about the logger — it is that " +
        "nothing here can back the annual statement that it is within its calibration period.",
    };
  }

  if (!expires) {
    return {
      state: "no_expiry",
      daysLeft: null,
      says: `Calibrated ${on}, but the certificate's expiry is not recorded, so nothing here can say whether it is still current.`,
    };
  }

  const daysLeft = daysApart(today, expires);
  if (daysLeft === null) {
    return { state: "no_expiry", daysLeft: null, says: `The calibration expiry on file (${expires}) is not a date that can be read.` };
  }

  if (daysLeft < 0) {
    return {
      state: "lapsed",
      daysLeft,
      says: `The calibration certificate expired on ${expires}, ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} ago. Readings since then are not backed by a current certificate.`,
    };
  }

  if (daysLeft <= CALIBRATION_WARNING_DAYS) {
    return {
      state: "expiring",
      daysLeft,
      says: `The calibration certificate expires on ${expires}, in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Re-certification or replacement takes weeks, so it is worth starting now.`,
    };
  }

  return {
    state: "current",
    daysLeft,
    says: `Calibrated ${on}; the certificate runs to ${expires}, ${daysLeft} days from today.`,
  };
}

/**
 * Whether the annual attestation can honestly be signed, over every logger that is actually logging.
 *
 * An untracked sensor is somebody else's fridge on the same iMonnit account — this pharmacy's
 * account carries seven and logs two — so it is not asked about. The answer is deliberately not a
 * boolean: "no certificate is on file" and "the certificate has expired" are different sentences to
 * put in front of a person about to sign something.
 */
export function canAttestCalibration(
  sensors: { name?: string; tracked?: boolean; calibratedOn?: string | null; calibrationExpiresOn?: string | null }[],
  today: string,
): { ok: boolean; why: string; lapsed: string[]; unrecorded: string[] } {
  const logging = sensors.filter((s) => s.tracked !== false);
  const lapsed: string[] = [];
  const unrecorded: string[] = [];

  for (const s of logging) {
    const c = calibration(s, today);
    if (c.state === "lapsed") lapsed.push(s.name ?? "a logger");
    if (c.state === "unrecorded" || c.state === "no_expiry") unrecorded.push(s.name ?? "a logger");
  }

  if (logging.length === 0) {
    return { ok: false, why: "No logger is being tracked, so there are no temperature records to attest to.", lapsed, unrecorded };
  }
  if (lapsed.length > 0) {
    return { ok: false, why: `Out of calibration: ${lapsed.join(", ")}.`, lapsed, unrecorded };
  }
  if (unrecorded.length > 0) {
    return {
      ok: false,
      why: `No certificate on file for ${unrecorded.join(", ")}. The statement says the logger is within its calibration period; nothing here can show that.`,
      lapsed,
      unrecorded,
    };
  }
  return { ok: true, why: `Every logging sensor has a current calibration certificate on file.`, lapsed, unrecorded };
}
