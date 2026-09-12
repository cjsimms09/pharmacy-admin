/**
 * Reading the 2D barcode on a drug package.
 *
 * Since DSCSA, manufacturers print a GS1 DataMatrix on every saleable package carrying four
 * things: the product identifier, the serial number, the lot, and the expiry date. That is
 * exactly the set this pharmacy has been unable to get any other way — the dispensing system
 * records lot and expiry only if somebody types them, which means in practice it records them
 * sometimes.
 *
 * Scanning the package instead removes the dependency entirely. It is also more trustworthy: the
 * lot on the box is the lot in the bottle, whereas the lot in a text field is whatever somebody
 * read off a box while the phone was ringing.
 *
 * ── What this file is careful about ──
 *
 * Variable-length fields. The lot (AI 10) and the serial (AI 21) have no fixed length, so they
 * are terminated by a group separator — ASCII 29, which scanners emit for the FNC1 character in
 * the symbol. A scanner configured to strip it produces a lot number with the serial glued onto
 * the end, and nothing about that looks wrong: it is a plausible string in a field that accepts
 * plausible strings. So an unterminated variable field at anything but the end of the data is
 * reported as a problem rather than accepted, because a wrong lot number silently recorded is
 * worse than a scan that refuses.
 *
 * The NDC. A GTIN carries the ten-digit NDC, and ten digits cannot say where the hyphens went:
 * 4-4-2, 5-3-2 and 5-4-1 all pad to a different eleven-digit billing NDC. Guessing produces a
 * number that looks exactly like a real one and matches the wrong product. So this returns every
 * candidate and never picks one — the caller resolves it against something that knows, or asks.
 *
 * Unknown application identifiers. An AI this does not have a length for makes every field after
 * it unreadable, because the parser no longer knows where the next one starts. It stops and says
 * so rather than carrying on and producing values that are offset by a few characters.
 */

/** ASCII 29, the group separator scanners emit for FNC1. */
export const GS = "\x1d";

/**
 * Application identifiers with a fixed length, so they need no separator after them.
 *
 * Only the ones a drug package actually carries. An AI outside this table and outside the
 * variable list below stops the parse, which is the safe direction.
 */
const FIXED: Record<string, number> = {
  "00": 18, // SSCC, on a shipping container
  "01": 14, // GTIN — the product identifier
  "02": 14, // GTIN of contained trade items
  "11": 6, // production date
  "12": 6, // due date
  "13": 6, // packaging date
  "15": 6, // best before
  "16": 6, // sell by
  "17": 6, // expiry — YYMMDD
  "20": 2, // variant
};

/** Variable-length application identifiers, with the maximum GS1 allows. */
const VARIABLE: Record<string, number> = {
  "10": 20, // lot or batch
  "21": 20, // serial number
  "30": 8, // count of items
  "37": 8, // count of trade items in a logistic unit
  "240": 30, // additional product identification
  "241": 30, // customer part number
  "710": 20, // national healthcare reimbursement number
  "711": 20,
  "712": 20,
  "713": 20,
  "714": 20,
};

export type Gs1Element = { ai: string; value: string };

export type ScannedPackage = {
  /** The 14-digit GTIN as printed, where one was present and its check digit was right. */
  gtin: string | null;
  /**
   * The packaging level the GTIN describes. "0" is a saleable each — the bottle on the shelf.
   * Anything else is a case or a pallet, and scanning one of those tells you nothing about the
   * serial numbers inside it.
   */
  packagingLevel: string | null;
  /** The ten-digit NDC carried in the GTIN, unhyphenated. */
  ndc10: string | null;
  /**
   * Every eleven-digit NDC the ten-digit one could be, because it cannot be known from the digits.
   * One candidate means it is unambiguous; more than one has to be resolved elsewhere.
   */
  ndc11Candidates: string[];
  lot: string | null;
  /** ISO date. A GS1 expiry of day "00" means the last day of that month, and is read as such. */
  expiry: string | null;
  serial: string | null;
  /** Anything else read, in the order it appeared. */
  extras: Gs1Element[];
  /** Everything that could not be read, and why. Never empty when something was skipped. */
  problems: string[];
  /** True where all four DSCSA elements are present: identifier, serial, lot and expiry. */
  complete: boolean;
};

/** The GS1 modulo-10 check digit, computed over the first 13 digits of a GTIN-14. */
export function gtinCheckDigit(first13: string): number {
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    // Weights alternate 3,1,3,1… from the left for a 14-digit GTIN.
    sum += Number(first13[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function validGtin(gtin: string): boolean {
  return /^\d{14}$/.test(gtin) && gtinCheckDigit(gtin.slice(0, 13)) === Number(gtin[13]);
}

/**
 * The ten-digit NDC inside a GTIN.
 *
 * A US drug GTIN is the indicator digit, then "03", then the ten-digit NDC, then the check digit.
 * Anything not shaped that way is not a US drug package identifier and returns nothing rather
 * than ten digits taken from the middle of something else.
 */
export function ndcFromGtin(gtin: string): { ndc10: string; packagingLevel: string } | null {
  if (!validGtin(gtin)) return null;
  if (gtin.slice(1, 3) !== "03") return null;
  return { ndc10: gtin.slice(3, 13), packagingLevel: gtin[0] };
}

/**
 * Every eleven-digit NDC a ten-digit one could be.
 *
 * Ten digits are one of 4-4-2, 5-3-2 or 5-4-1, and each pads to 5-4-2 differently. Nothing in the
 * digits says which, so all of them are returned. Where two configurations happen to produce the
 * same string it appears once.
 */
export function ndc11Candidates(ndc10: string): string[] {
  if (!/^\d{10}$/.test(ndc10)) return [];
  const d = ndc10;
  return [...new Set([
    `0${d.slice(0, 4)}${d.slice(4, 8)}${d.slice(8, 10)}`, // 4-4-2
    `${d.slice(0, 5)}0${d.slice(5, 8)}${d.slice(8, 10)}`, // 5-3-2
    `${d.slice(0, 5)}${d.slice(5, 9)}0${d.slice(9, 10)}`, // 5-4-1
  ])];
}

/** A GS1 YYMMDD date as ISO. Day "00" means the last day of the month, which GS1 allows. */
export function gs1Date(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  if (month < 1 || month > 12) return null;
  const dayField = Number(yymmdd.slice(4, 6));
  const lastOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = dayField === 0 ? lastOfMonth : dayField;
  if (day > lastOfMonth) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Strips the symbology identifier a scanner prefixes, and any leading separator. */
function stripPrefix(raw: string): string {
  let s = raw.replace(/^\]\w\d/, "");
  while (s.startsWith(GS)) s = s.slice(1);
  return s;
}

/**
 * Reads the elements out of a scanned string.
 *
 * Stops at the first thing it cannot account for. A parser that skips what it does not understand
 * and keeps going is the one that returns a serial number in the lot field.
 */
export function parseGs1Elements(raw: string): { elements: Gs1Element[]; problems: string[] } {
  const s = stripPrefix(raw ?? "");
  const elements: Gs1Element[] = [];
  const problems: string[] = [];
  let i = 0;

  while (i < s.length) {
    if (s[i] === GS) {
      i++;
      continue;
    }
    // Application identifiers are two, three or four digits. Two covers everything on a drug
    // package; the longer ones are tried so an unexpected symbol is reported rather than
    // mis-sliced.
    const two = s.slice(i, i + 2);
    const three = s.slice(i, i + 3);
    let ai: string | null = null;
    if (FIXED[two] !== undefined || VARIABLE[two] !== undefined) ai = two;
    else if (VARIABLE[three] !== undefined) ai = three;

    if (!ai) {
      problems.push(
        `Stopped at "${s.slice(i, i + 6)}": that is not an application identifier this knows, and everything after ` +
          `it would be read from the wrong place.`,
      );
      break;
    }
    i += ai.length;

    const fixed = FIXED[ai];
    if (fixed !== undefined) {
      const value = s.slice(i, i + fixed);
      if (value.length < fixed) {
        problems.push(`(${ai}) was cut short — expected ${fixed} characters and the data ended.`);
        break;
      }
      elements.push({ ai, value });
      i += fixed;
      continue;
    }

    // Variable length: runs to the next separator, or to the end of the data.
    const end = s.indexOf(GS, i);
    const value = end === -1 ? s.slice(i) : s.slice(i, end);
    const max = VARIABLE[ai];
    if (end === -1 && i + value.length < s.length) {
      problems.push(`(${ai}) has no separator after it, so where it ends cannot be known.`);
      break;
    }
    if (value.length > max) {
      problems.push(
        `(${ai}) read as ${value.length} characters, longer than the ${max} GS1 allows. The scanner is probably not ` +
          `sending the separator between fields, which glues two of them together.`,
      );
      break;
    }
    elements.push({ ai, value });
    i = end === -1 ? s.length : end + 1;
  }

  return { elements, problems };
}

/** Everything a drug package's barcode says, or an honest account of why it does not. */
export function parseGs1(raw: string): ScannedPackage {
  const { elements, problems } = parseGs1Elements(raw);
  const find = (ai: string) => elements.find((e) => e.ai === ai)?.value ?? null;

  const rawGtin = find("01");
  let gtin: string | null = null;
  let ndc10: string | null = null;
  let packagingLevel: string | null = null;

  if (rawGtin) {
    if (!validGtin(rawGtin)) {
      problems.push(`The product identifier ${rawGtin} does not check out — it was misread or it is not a GTIN.`);
    } else {
      gtin = rawGtin;
      const parts = ndcFromGtin(rawGtin);
      if (parts) {
        ndc10 = parts.ndc10;
        packagingLevel = parts.packagingLevel;
        if (packagingLevel !== "0") {
          problems.push(
            `This is a case or outer carton, not a single package. Its serial number identifies the case; the ` +
              `bottles inside have their own.`,
          );
        }
      } else {
        problems.push(`${rawGtin} is a valid GTIN but not a US drug identifier, so it carries no NDC.`);
      }
    }
  }

  const rawExpiry = find("17");
  const expiry = rawExpiry ? gs1Date(rawExpiry) : null;
  if (rawExpiry && !expiry) problems.push(`The expiry date "${rawExpiry}" is not a date.`);

  /*
   * A scanner that is not sending the separator at all.
   *
   * This is the failure worth spending code on, because it is the one that produces a plausible
   * wrong answer instead of an obvious one. Strip the separators from a DSCSA barcode and
   * "10ABC123<GS>21SN00099" becomes "10ABC12321SN00099", which parses cleanly as a lot number of
   * ABC12321SN00099 — the right shape, the right character set, and wrong. It would be stored,
   * backed up, and produced during a recall as though somebody had read it off the box.
   *
   * It cannot be unscrambled: the data is genuinely ambiguous, because a lot number is allowed to
   * contain digits and there is no way to know where it ended. So it is refused rather than
   * guessed. A correctly configured scan of a package carrying both a lot and a serial always has
   * at least one separator in it, so the absence of any is the signal.
   *
   * A package with a lot and no serial legitimately has no separator — and is also not a complete
   * DSCSA identifier, so saying so costs nothing.
   */
  const hasSeparator = (raw ?? "").includes(GS);
  const variableSeen = elements.filter((e) => VARIABLE[e.ai] !== undefined);
  const runTogether = !hasSeparator && variableSeen.length > 0;
  if (runTogether) {
    problems.push(
      `No separator was found between fields, so where each one ends cannot be known — ` +
        variableSeen.map((e) => `(${e.ai}) read as "${e.value}"`).join(", ") +
        `. Those values are not being kept. Set the scanner to transmit the GS1 group separator ` +
        `(ASCII 29) and scan it again.`,
    );
  }

  const lot = runTogether ? null : find("10");
  const serial = runTogether ? null : find("21");
  const known = new Set(["01", "10", "17", "21"]);

  return {
    gtin,
    packagingLevel,
    ndc10,
    ndc11Candidates: ndc10 ? ndc11Candidates(ndc10) : [],
    lot,
    expiry,
    serial,
    extras: runTogether ? [] : elements.filter((e) => !known.has(e.ai)),
    problems,
    complete: Boolean(gtin && lot && expiry && serial),
  };
}
