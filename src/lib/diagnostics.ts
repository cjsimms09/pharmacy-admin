import { createHash } from "node:crypto";

/**
 * Taking a page's own data off the screen and into a file somebody can send for diagnosis.
 *
 * Nearly every arithmetic error this site has had was found the same way: the pharmacist read a
 * figure, knew the real answer, and said so. Then came the slow part — working out *which* figure,
 * from a screenshot, by asking questions. This is that loop closed. One button hands over exactly
 * what the page computed, and the reply can be about the row rather than about what the row might
 * have been.
 *
 * ── The part that has to be right ──
 *
 * A file that leaves the pharmacy is a disclosure. The ingest gate (phi-gate.ts) already refuses a
 * report carrying patient names, dates of birth, addresses, phone numbers or member IDs, so those
 * were never stored and cannot be exported. What *is* held, and is an identifier under Safe
 * Harbour all the same, is the prescription number: unique, and with the pharmacy and the date it
 * points at one person.
 *
 * So prescription numbers are pseudonymised by default. Not removed — a diagnosis usually turns on
 * "these three rows are one fill", which needs the numbers to match each other without meaning
 * anything outside the file. A per-export salt makes them meaningless outside it, and makes two
 * exports of the same day disagree on purpose, so nothing can be joined across files later.
 *
 * The pharmacist can turn that off, because sometimes the question *is* about Rx 331488 by name.
 * It is off by default, it is stated in the file, and it is stated on the button.
 *
 * ── And what it will not do ──
 *
 * A key this does not recognise is not assumed to be safe. Anything matching a known identifier
 * shape is dropped and counted, whatever page it came from, so a column added to a report in a
 * year's time cannot ride out in an export nobody re-read.
 *
 * Pure.
 */

/** Keys that are identifiers in their own right. Dropped outright — no diagnosis needs them. */
const FORBIDDEN = [
  /*
   * A bare "name" is not one of these, and treating it as one guts the file.
   *
   * Supplier name, drug name, category name, vendor name — a diagnosis is unreadable without them,
   * and the ingest gate already refuses any report carrying a patient name column, so one cannot
   * be sitting in a bare `name` field to begin with. What is caught is a name that says whose:
   * a patient prefix, or a first/last/middle/full qualifier.
   */
  /^(patient|pt)_?(first|last|middle|full)?_?name$/i,
  /^(first|last|middle|full)_?name$/i,
  /^(patient|pt)?_?(dob|dateofbirth|birthdate)$/i,
  /^(patient|pt|home|cell|mobile)?_?(phone|telephone)(number)?$/i,
  /^(patient|pt|home|mailing)?_?address[12]?$/i,
  /^(patient|pt)?_?e?mail(address)?$/i,
  /^(member|cardholder|subscriber)_?(id|number)$/i,
  /^personcode$/i,
  /^(patient|pt)_?(id|number)$/i,
  /^ssn$|^socialsecurity/i,
  /^(patient|pt)_?(gender|sex)$/i,
];

/** Keys carrying a prescription number. Pseudonymised rather than dropped, so rows still join up. */
const PRESCRIPTION = /^(rx_?number|rxno|prescription_?number|rx)$/i;

const norm = (k: string) => k.replace(/[\s_-]/g, "").toLowerCase();

export function isForbiddenKey(key: string): boolean {
  const n = norm(key);
  return FORBIDDEN.some((re) => re.test(n));
}

export function isPrescriptionKey(key: string): boolean {
  return PRESCRIPTION.test(norm(key));
}

/**
 * A short, stable stand-in for one prescription number.
 *
 * Salted per export, so the same prescription is one value inside a file and a different value in
 * the next one. That is deliberate: it keeps a diagnosis workable and stops a series of exports
 * being reassembled into a history of one patient.
 */
export function pseudonym(value: string, salt: string): string {
  return "rx-" + createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 8);
}

export type RedactionReport = {
  /** How many values were replaced with a stand-in, and how many distinct ones there were. */
  prescriptionsPseudonymised: number;
  distinctPrescriptions: number;
  /** Keys dropped entirely, with a count each. Named so a surprise is visible. */
  dropped: Record<string, number>;
  /** Whether real prescription numbers were deliberately kept. */
  identifiersIncluded: boolean;
};

export type RedactOptions = {
  salt: string;
  /** True only where the pharmacist has asked for real prescription numbers. */
  includeIdentifiers?: boolean;
  /** Longest array to keep whole. Beyond it, the middle is dropped and the fact is recorded. */
  maxArray?: number;
};

/**
 * Walks anything and returns a copy that is safe to send, plus a report of what it did.
 *
 * Cycles are broken rather than followed — a page's data can hold the same object twice — and very
 * long arrays are trimmed at both ends, because a diagnosis needs the shape and the extremes, not
 * four thousand middling rows.
 */
export function redact(input: unknown, opts: RedactOptions): { data: unknown; report: RedactionReport } {
  const report: RedactionReport = {
    prescriptionsPseudonymised: 0,
    distinctPrescriptions: 0,
    dropped: {},
    identifiersIncluded: opts.includeIdentifiers === true,
  };
  const seenRx = new Set<string>();
  const stack = new Set<object>();
  const maxArray = opts.maxArray ?? 2000;

  const walk = (v: unknown, key: string | null): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v !== "object") {
      if (key !== null && isPrescriptionKey(key) && !opts.includeIdentifiers) {
        const s = String(v);
        seenRx.add(s);
        report.prescriptionsPseudonymised++;
        return pseudonym(s, opts.salt);
      }
      return v;
    }
    if (stack.has(v as object)) return "[circular]";
    stack.add(v as object);
    try {
      if (Array.isArray(v)) {
        if (v.length > maxArray) {
          const half = Math.floor(maxArray / 2);
          return [
            ...v.slice(0, half).map((x) => walk(x, key)),
            `[${v.length - maxArray} rows omitted from the middle — the ends are kept because that is where the extremes are]`,
            ...v.slice(v.length - half).map((x) => walk(x, key)),
          ];
        }
        return v.map((x) => walk(x, key));
      }
      if (v instanceof Map) return walk(Object.fromEntries(v), key);
      if (v instanceof Set) return walk([...v], key);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (isForbiddenKey(k)) {
          report.dropped[k] = (report.dropped[k] ?? 0) + 1;
          continue;
        }
        out[k] = walk(val, k);
      }
      return out;
    } finally {
      stack.delete(v as object);
    }
  };

  const data = walk(input, null);
  report.distinctPrescriptions = seenRx.size;
  return { data, report };
}

export type Bundle = {
  /** What this file is, in the first thing anybody reads. */
  readme: string[];
  page: string;
  pageTitle: string;
  takenAt: string;
  /** What the page was showing: the dates, filters and settings it ran on. */
  shownWith: Record<string, unknown>;
  environment: Record<string, unknown>;
  privacy: RedactionReport;
  /** What the page itself said it could not do. Copied up so it is not buried. */
  notes: string[];
  data: unknown;
};

/** The header every export carries, so the file explains itself without anybody's help. */
export function readmeFor(a: { pageTitle: string; identifiersIncluded: boolean }): string[] {
  return [
    `This is the data behind the “${a.pageTitle}” page of the Pharmacy Admin Desk, exported so it can be sent for diagnosis.`,
    "It is what the page computed, not a fresh calculation — so a figure that is wrong on the screen is wrong here too, which is the point.",
    a.identifiersIncluded
      ? "REAL PRESCRIPTION NUMBERS ARE INCLUDED. This was asked for deliberately. Treat the file accordingly and delete it when the question is settled."
      : "Prescription numbers have been replaced with stand-ins. Rows that belong to one prescription still share a value inside this file, and that value means nothing outside it — a second export of the same day will use different ones.",
    "Patient names, dates of birth, addresses, phone numbers and member IDs are never stored by this site, so they cannot appear here.",
  ];
}
