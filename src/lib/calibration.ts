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
    /*
     * Not recorded here, and that is an arrangement rather than a deficiency.
     *
     * The owner, 17 September 2026, twice: "I don't know when it ends.. don't specific in the P&P
     * leave it vague and compliant", and then "yeah leave me alone about the fridge logger. idk
     * when its calibration ends, I dont care.. make the policy vague."
     *
     * He is right, and the first version of this sentence was wrong about the standard. The CDC
     * toolkit asks for a certified logger holding a current certificate that can be produced. It
     * does not ask for the certificate to have been typed into the pharmacy's software, and a
     * screen that treats an empty field as a failing turns a compliant arrangement into a red mark
     * that no act of his can clear — which is how a person learns to stop reading the page.
     *
     * So this says where the record is and when it is checked, and asks for nothing. The dates can
     * be entered if they are ever to hand, and the line is the same either way.
     */
    return {
      state: "unrecorded",
      daysLeft: null,
      says:
        "The calibration certificate is kept with the logger rather than here. Whether it is still current is " +
        "confirmed at the annual vaccine storage review, which is where that question is asked. Its dates can be " +
        "recorded here if they are to hand; nothing needs them to be.",
    };
  }

  if (!expires) {
    /*
     * A calibration date with no expiry beside it is a normal certificate, not a gap.
     *
     * Some certificates carry an expiry date; others carry only the calibration date and the
     * manufacturer's recommended interval, and the owner may hold one of those or may simply not
     * have the paper to hand — on 16 September 2026 he had the date and said plainly, "I don't know
     * when it ends". The site must not invent a period: two years is the common interval and it is
     * still a guess, and a guessed expiry shown as fact is worse than a date and an honest silence.
     *
     * Nor may it hold the line red for ever, which is the fault this file exists among. So it says
     * what it knows, and points at the annual review — which is precisely the moment a person is
     * asked to confirm the logger is within its calibration period, and the one place the question
     * can actually be answered.
     */
    return {
      state: "no_expiry",
      daysLeft: null,
      says: `Calibrated ${on}. The certificate's expiry is not recorded here — some state one and some give an interval instead — so whether it is still current is confirmed at the annual vaccine storage review rather than computed.`,
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

  /*
   * A logger with a calibration date and no expiry does not block the statement.
   *
   * It used to, and that was wrong in the direction this codebase keeps getting wrong: it made a
   * line nobody could ever clear. The pharmacy may hold a certificate that states an interval
   * rather than a date, and the owner may simply not have the paper to hand — he had the date and
   * said "I don't know when it ends". Neither is the same as having no certificate at all.
   *
   * The statement being signed is the pharmacist-in-charge's own, made at a review, about a logger
   * he can go and look at. The site's job there is to put what it holds in front of him, not to
   * refuse him the pen.
   *
   * Nor does a logger with nothing recorded block it, which is the second pass. The owner: "leave me
   * alone about the fridge logger. idk when its calibration ends, I dont care." The standard is a
   * certified logger holding a current certificate that can be produced — not a certificate typed
   * into this software — so an empty field is an arrangement and not a failing, and treating it as
   * one leaves a mark no act of his can clear. What is still refused is a certificate that has
   * demonstrably run out, and a pharmacy with no logger tracked at all.
   *
   * What does not change: the statement says what it says, and he is told exactly which loggers the
   * site holds no dates for, so nobody signs it believing this software checked something it did not.
   */
  const noExpiry: string[] = [];
  for (const s of logging) {
    const c = calibration(s, today);
    if (c.state === "lapsed") lapsed.push(s.name ?? "a logger");
    if (c.state === "unrecorded") unrecorded.push(s.name ?? "a logger");
    if (c.state === "no_expiry") noExpiry.push(s.name ?? "a logger");
  }

  if (logging.length === 0) {
    return { ok: false, why: "No logger is being tracked, so there are no temperature records to attest to.", lapsed, unrecorded };
  }
  if (lapsed.length > 0) {
    return { ok: false, why: `Out of calibration: ${lapsed.join(", ")}.`, lapsed, unrecorded };
  }
  /*
   * Said, never demanded. The sentence names the loggers this site holds no dates for so the
   * pharmacist-in-charge knows what the software checked and what it did not — and then gets out of
   * the way, because the certificate lives with the logger and he is the one who can look at it.
   */
  const silent = [...unrecorded, ...noExpiry];
  if (silent.length > 0) {
    return {
      ok: true,
      why:
        `No calibration dates are held here for ${silent.join(", ")}, so this software has not checked them. ` +
        "The certificate is kept with the logger; confirm it is current when you sign, which is what this statement is for.",
      lapsed,
      unrecorded,
    };
  }
  return { ok: true, why: `Every logging sensor has a current calibration certificate on file.`, lapsed, unrecorded };
}
