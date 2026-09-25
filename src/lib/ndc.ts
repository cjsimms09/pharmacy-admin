/**
 * National Drug Codes, in one place.
 *
 * Every feed carries an NDC and every feed writes it differently: NADAC and the claims report use
 * eleven digits, the catalogue export uses the FDA's hyphenated form, a spreadsheet drops the
 * leading zero, and an invoice prints whatever the wholesaler's system prints. Three readers grew
 * three converters, and two of them shared a mistake worth fixing once.
 *
 * ── The one canonical form ──
 *
 * Eleven digits, no hyphens, in the 5-4-2 layout (labeler, product, package). It is what a claim
 * is billed with, what NADAC is keyed on, and what every table here stores.
 *
 * ── Why a ten-digit code without hyphens is refused ──
 *
 * The FDA assigns ten digits in one of three layouts, and the hyphens are what say which:
 *
 *     4-4-2   0002-1433-80   →  0 0002 1433 80   (a zero goes on the labeler)
 *     5-3-2   50242-040-62   →  50242 0 040 62   (a zero goes on the product)
 *     5-4-1   60505-2503-4   →  60505 2503 0 4   (a zero goes on the package)
 *
 * With the hyphens present the conversion is exact. Without them, "5024204062" could be any of
 * the three, and they are three different products. The old readers put the zero at the front
 * every time, which is right for the 4-4-2 layout and wrong for the other two — a claim or a
 * catalogue price silently filed under a different drug, with nothing anywhere to say so.
 *
 * So a bare ten-digit code is not converted. It is returned as ambiguous with its three possible
 * readings, and the caller may resolve it against the NDCs the site already holds — a code that
 * matches exactly one product we know is that product; one that matches none or several stays
 * unresolved and is counted, so the gap is visible instead of guessed over.
 */

export type NdcResult =
  | { ok: true; ndc11: string; form: NdcForm }
  | { ok: false; reason: NdcReason; candidates?: string[] };

export type NdcForm = "11-digit" | "11-digit-hyphenated" | "10-digit-4-4-2" | "10-digit-5-3-2" | "10-digit-5-4-1" | "10-digit-resolved";

export type NdcReason = "empty" | "not a number" | "wrong length" | "hyphens in no known layout" | "ten digits with no hyphens: ambiguous";

const DIGITS = /^\d+$/;

/**
 * Reads any NDC the feeds send and returns the eleven-digit form, or says why it cannot.
 *
 * Accepts surrounding whitespace, an Excel-style leading apostrophe, and a numeric cell. A numeric
 * cell that has lost its leading zero comes back as the wrong length rather than being padded —
 * padding is exactly the guess this module exists to stop.
 */
export function normalizeNdc(raw: string | number | null | undefined): NdcResult {
  if (raw === null || raw === undefined) return { ok: false, reason: "empty" };
  let s = String(raw).trim();
  if (s.startsWith("'")) s = s.slice(1).trim();
  if (!s) return { ok: false, reason: "empty" };

  if (s.includes("-")) {
    const parts = s.split("-");
    if (parts.length !== 3 || !parts.every((p) => DIGITS.test(p))) return { ok: false, reason: "hyphens in no known layout" };
    const [a, b, c] = parts;
    const layout = `${a.length}-${b.length}-${c.length}`;
    if (layout === "5-4-2") return { ok: true, ndc11: a + b + c, form: "11-digit-hyphenated" };
    if (layout === "4-4-2") return { ok: true, ndc11: `0${a}${b}${c}`, form: "10-digit-4-4-2" };
    if (layout === "5-3-2") return { ok: true, ndc11: `${a}0${b}${c}`, form: "10-digit-5-3-2" };
    if (layout === "5-4-1") return { ok: true, ndc11: `${a}${b}0${c}`, form: "10-digit-5-4-1" };
    return { ok: false, reason: "hyphens in no known layout" };
  }

  if (!DIGITS.test(s)) return { ok: false, reason: "not a number" };
  if (s.length === 11) return { ok: true, ndc11: s, form: "11-digit" };
  if (s.length === 10) return { ok: false, reason: "ten digits with no hyphens: ambiguous", candidates: candidatesFor10(s) };
  return { ok: false, reason: "wrong length" };
}

/** The three eleven-digit codes a bare ten-digit NDC could be: 4-4-2, 5-3-2, 5-4-1, in that order. */
export function candidatesFor10(digits10: string): string[] {
  if (!DIGITS.test(digits10) || digits10.length !== 10) throw new Error(`candidatesFor10 wants exactly ten digits, got "${digits10}"`);
  return [`0${digits10}`, `${digits10.slice(0, 5)}0${digits10.slice(5)}`, `${digits10.slice(0, 9)}0${digits10.slice(9)}`];
}

/**
 * Settles a bare ten-digit code against the NDCs the site already knows.
 *
 * Exactly one known candidate is an answer. None is not — the product may simply be new to us —
 * and two or more is the ambiguity made concrete. Both of those stay unresolved.
 */
export function resolveNdc10(digits10: string, isKnown: (ndc11: string) => boolean): NdcResult {
  const candidates = candidatesFor10(digits10);
  const known = candidates.filter(isKnown);
  if (known.length === 1) return { ok: true, ndc11: known[0], form: "10-digit-resolved" };
  return { ok: false, reason: "ten digits with no hyphens: ambiguous", candidates };
}

/**
 * The whole rule in one call: normalise, and if that leaves a bare ten-digit code, resolve it
 * against what is held. Returns the eleven-digit code or null, and the reason when null — worded
 * for a skip-reason count, so every reader reports the same thing the same way.
 */
export function readNdc(raw: string | number | null | undefined, isKnown?: (ndc11: string) => boolean): { ndc11: string | null; reason: string | null; form: NdcForm | null } {
  const r = normalizeNdc(raw);
  if (r.ok) return { ndc11: r.ndc11, reason: null, form: r.form };
  if (r.reason === "ten digits with no hyphens: ambiguous" && isKnown) {
    const digits = String(raw).trim().replace(/^'/, "");
    const resolved = resolveNdc10(digits, isKnown);
    if (resolved.ok) return { ndc11: resolved.ndc11, reason: null, form: resolved.form };
  }
  return { ndc11: null, reason: describeNdcReason(r.reason), form: null };
}

/** The reason in the words the inbox and import summaries use. */
export function describeNdcReason(reason: NdcReason): string {
  switch (reason) {
    case "empty":
      return "no NDC";
    case "not a number":
      return "NDC is not a number";
    case "wrong length":
      return "NDC is not 10 or 11 digits";
    case "hyphens in no known layout":
      return "NDC hyphenated in a layout that is not 4-4-2, 5-3-2, 5-4-1 or 5-4-2";
    case "ten digits with no hyphens: ambiguous":
      return "10-digit NDC with no hyphens (could be any of three products, so not guessed)";
  }
}

/** True for a string already in the canonical form. */
export function isNdc11(s: string): boolean {
  return s.length === 11 && DIGITS.test(s);
}

/** 5-4-2 with hyphens, for display. */
export function formatNdc11(ndc11: string): string {
  return isNdc11(ndc11) ? `${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}-${ndc11.slice(9)}` : ndc11;
}
