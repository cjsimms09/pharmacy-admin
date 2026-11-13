import { periodEnds, periodLabel } from "./periods";
import { fmtLong } from "./dates";

/**
 * Whether the pharmacy's own certificate on file shows a renewal duty done.
 *
 * "Renew the Kansas pharmacy registration" and "Renew the DEA registration" are done when the renewed certificate is in hand, and the
 * Licences page is where it is filed, either by changing the expiry date on the row that is there or by adding a new row with the new
 * date. The answer has to be the same both ways, so a period is covered when any certificate of the type on file runs past the end of
 * the period, or one is marked "does not expire". A row with no date that is not marked that way covers nothing: a blank date means
 * nobody entered one.
 *
 * Pure, no database, so the arithmetic that decides whether an inspector sees a gap can be checked on its own.
 */

export type HeldCertificate = { type: string; expiresOn: string | null; noExpiry: boolean };

export type RenewalReading = {
  /** A certificate of the type runs past the end of the period, or one that never expires is on file. */
  covered: boolean;
  /** Anything of the type is on file at all, dated or not. */
  onFile: boolean;
  /** The latest expiry date any certificate of the type carries; null when none carries one. */
  runsTo: string | null;
};

export function readRenewal(type: string, periodKey: string, held: HeldCertificate[]): RenewalReading {
  const mine = held.filter((c) => c.type === type);
  const dates = mine.flatMap((c) => (!c.noExpiry && c.expiresOn ? [c.expiresOn] : [])).sort();
  const runsTo = dates.length > 0 ? dates[dates.length - 1] : null;
  const covered = mine.some((c) => c.noExpiry) || (runsTo !== null && runsTo > periodEnds(periodKey));
  return { covered, onFile: mine.length > 0, runsTo };
}

/** What is still to do for a period the certificate on file does not cover, in the words he will read under the duty. */
export function renewalMissing(label: string, periodKey: string, r: RenewalReading): string {
  if (!r.onFile) return `No ${label} is on file. File it under Licences, with the date it expires.`;
  if (r.runsTo === null) return `The ${label} on file has no expiry date, so what it covers cannot be told. Add the date under Licences.`;
  return `The ${label} on file runs to ${fmtLong(r.runsTo)}. It has to run past the end of ${periodLabel(periodKey)} before this closes: file the renewed certificate under Licences, with its new expiry date.`;
}
