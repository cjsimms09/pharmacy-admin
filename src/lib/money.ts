/**
 * Money and quantity arithmetic, in integers.
 *
 * Every figure here can end up in a complaint to the Kansas Insurance Department, so none of it
 * goes anywhere near a floating-point dollar. Three scales are used, and they are not
 * interchangeable:
 *
 *   cents        — an amount of money. 1234 = $12.34.
 *   micros       — a unit price, dollars × 1,000,000. NADAC publishes five decimal places
 *                  (0.03428), and a per-unit price rounded to the cent is useless when it is
 *                  about to be multiplied by a quantity of 473.
 *   thousandths  — a dispensed quantity, × 1,000. NCPDP allows three decimals, so 473.176 mL
 *                  is 473176.
 *
 * The multiply that turns a unit price into an extended cost overflows a JavaScript number
 * (10^17 against a safe limit of 9×10^15), so it is done in BigInt and rounded once, at the end.
 *
 * No function here throws on bad input — parsing returns null, and the caller decides. A claim
 * that cannot be priced must be excluded with a reason, never priced approximately.
 */

const MICROS = 1_000_000n;
const THOUSANDTHS = 1_000n;

/** "12.34", "$1,234.56", "(4.10)" for negatives, "" → null. */
export function parseCents(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) s = `-${paren[1]}`;
  s = s.replace(/[$,\s]/g, "");
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === "" || s === "-" || s === ".") return null;
  return scaleToInt(s, 2);
}

/** NADAC per unit: "0.03428" → 34280 micros. */
export function parseUnitMicros(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/[$,\s]/g, "");
  if (!s || !/^-?\d*(\.\d*)?$/.test(s) || s === "-" || s === ".") return null;
  return scaleToInt(s, 6);
}

/** Dispensed quantity: "473.176" → 473176 thousandths. */
export function parseQuantityThousandths(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/[,\s]/g, "");
  if (!s || !/^-?\d*(\.\d*)?$/.test(s) || s === "-" || s === ".") return null;
  return scaleToInt(s, 3);
}

/**
 * Decimal string to a scaled integer, without going through a float.
 * More decimals than the scale allows are rounded half-away-from-zero rather than truncated.
 */
function scaleToInt(s: string, scale: number): number | null {
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const [whole = "0", frac = ""] = s.split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  let n = BigInt(whole || "0") * 10n ** BigInt(scale) + BigInt(kept || "0");
  // Round on the first dropped digit.
  const dropped = frac.slice(scale);
  if (dropped && Number(dropped[0]) >= 5) n += 1n;
  const out = Number(neg ? -n : n);
  return Number.isSafeInteger(out) ? out : null;
}

/**
 * Unit price × quantity, to the nearest cent. Half away from zero, which is what a person
 * checking the arithmetic by hand will do.
 */
export function extendedCents(unitMicros: number, quantityThousandths: number): number {
  const product = BigInt(unitMicros) * BigInt(quantityThousandths); // dollars × 10^9
  const scale = MICROS * THOUSANDTHS / 100n; // 10^9 / 100 → cents
  const half = scale / 2n;
  const rounded = product >= 0n ? (product + half) / scale : (product - half) / scale;
  return Number(rounded);
}

/** For display and for the complaint schedule. Always two decimals, never a bare float. */
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const a = Math.abs(cents);
  return `${neg ? "-" : ""}$${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
}

/** NADAC's pricing unit. A claim quantity in the wrong unit is the easiest way to be badly wrong. */
export const PRICING_UNITS = ["EA", "ML", "GM"] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

export function isPricingUnit(v: string): v is PricingUnit {
  return (PRICING_UNITS as readonly string[]).includes(v.trim().toUpperCase());
}
