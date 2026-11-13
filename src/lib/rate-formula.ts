/**
 * A contract's reimbursement formula, read from its own words into arithmetic.
 *
 * Contracts state the price of a claim as a sentence: "AWP-15% + $1.00", "Lesser of (MAC or
 * AWP-25%) + $1.00", "NADAC + $10.50", "WAC+2% + $0.75". The extractor copies the sentence exactly
 * (`contract-terms.ts`, rule 2) and this turns it into a formula the site can price a claim with,
 * so that "what should this have paid" is computed from the contract and compared to what arrived.
 *
 * ── What it will not do ──
 *
 * It never guesses a benchmark. A formula on AWP needs the AWP of the NDC on the day; without it
 * the expected amount is null with the reason, never an estimate. A MAC formula needs the PBM's
 * MAC, which the pharmacy does not hold, so a lesser-of with MAC prices at the other leg and says
 * "at most". A sentence it cannot read is returned as `unknown` with the text kept, so a page can
 * show it to a person rather than pricing on a misreading.
 *
 * Pure.
 */

export type Benchmark = "AWP" | "WAC" | "NADAC" | "MAC" | "UC" | "FUL" | "GEAP";

export type Leg = {
  benchmark: Benchmark;
  /** Percent off the benchmark: 15 for "AWP-15%". Negative for a markup: -2 for "WAC+2%". */
  discountPercent: number;
};

export type Formula = {
  /** Every leg; the claim pays the lowest of them where there is more than one. */
  legs: Leg[];
  lesserOf: boolean;
  /** Per-claim dispensing fee, in cents. Null where the sentence carries none. */
  feeCents: number | null;
  /** The sentence as the contract wrote it. */
  text: string;
  kind: "priced" | "unknown";
};

const BENCH: { re: RegExp; b: Benchmark }[] = [
  { re: /\bAWP\b/i, b: "AWP" },
  { re: /\bWAC\b/i, b: "WAC" },
  { re: /\bNADAC\b/i, b: "NADAC" },
  { re: /\bMAC\b|\bMAXIMUM ALLOWABLE COST\b/i, b: "MAC" },
  { re: /\bU\s*&\s*C\b|\bUSUAL AND CUSTOMARY\b|\bU\/C\b/i, b: "UC" },
  { re: /\bFUL\b/i, b: "FUL" },
  { re: /\bGEAP\b/i, b: "GEAP" },
];

/** "AWP-15%" → { AWP, 15 }; "WAC+2%" → { WAC, -2 }; "NADAC" → { NADAC, 0 }; "MAC" → { MAC, 0 }. */
function parseLeg(s: string): Leg | null {
  const t = s.trim();
  const bench = BENCH.find((x) => x.re.test(t));
  if (!bench) return null;
  const m = t.match(/([+\-−–])\s*(\d+(?:\.\d+)?)\s*%/);
  const discount = m ? (m[1] === "+" ? -1 : 1) * Number(m[2]) : 0;
  return { benchmark: bench.b, discountPercent: discount };
}

/** "$1.00" or "$0.75 dispensing fee" → cents. The last dollar figure after the pricing part. */
function parseFee(s: string): number | null {
  const fees = [...s.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)].map((m) => Math.round(Number(m[1]) * 100));
  if (fees.length === 0) return null;
  return fees[fees.length - 1];
}

/**
 * Reads the sentence. Handles "A + $fee", "Lesser of (A or B) + $fee", "lower of A, B, and C",
 * "A minus X% plus $fee", and a fee written first ("$1.00 + AWP-15%").
 */
export function parseFormula(text: string | null | undefined): Formula {
  const raw = (text ?? "").trim();
  const unknown: Formula = { legs: [], lesserOf: false, feeCents: null, text: raw, kind: "unknown" };
  if (!raw) return unknown;

  // Normalise the words people write for arithmetic.
  let s = raw
    .replace(/\bminus\b/gi, "-")
    .replace(/\bless\b(?!er)/gi, "-")
    .replace(/\bplus\b/gi, "+")
    .replace(/\bpercent\b/gi, "%")
    .replace(/[−–]/g, "-");

  const fee = parseFee(s);
  // Take the fee out so it is not read as a leg.
  s = s.replace(/\+?\s*\$\s*\d+(?:\.\d+)?(\s*(dispensing|disp\.?|professional)?\s*fee)?/gi, " ");

  const lesser = /\b(lesser|lower|least|lowest)\s+of\b/i.test(s);
  // Split the pricing part into candidate legs on "or", commas, slashes and "and" inside a lesser-of.
  const body = s.replace(/\b(lesser|lower|least|lowest)\s+of\b/i, " ").replace(/[()]/g, " ");
  const parts = lesser ? body.split(/\bor\b|,|\/|\band\b/i) : [body];
  const legs = parts.map(parseLeg).filter((l): l is Leg => l !== null);
  // Deduplicate a benchmark named twice ("MAC or MAC list").
  const seen = new Set<string>();
  const unique = legs.filter((l) => { const k = `${l.benchmark}|${l.discountPercent}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (unique.length === 0) return unknown;
  return { legs: unique, lesserOf: lesser || unique.length > 1, feeCents: fee, text: raw, kind: "priced" };
}

export type Benchmarks = {
  /** Per unit, micros. Absent where the pharmacy does not hold the figure. */
  awpMicros?: number | null;
  wacMicros?: number | null;
  nadacMicros?: number | null;
  macMicros?: number | null;
  fulMicros?: number | null;
  /** The pharmacy's own usual and customary price for this fill, in cents (a total, not per unit). */
  usualAndCustomaryCents?: number | null;
};

export type Expected = {
  /** What the contract says the claim should have paid, ingredient plus fee. Null where it cannot be priced. */
  totalCents: number | null;
  ingredientCents: number | null;
  feeCents: number | null;
  /** The leg that priced it. */
  leg: Leg | null;
  /** True where a leg the pharmacy cannot value (MAC, usually) might have been lower: the figure is a ceiling. */
  atMost: boolean;
  why: string;
};

/**
 * Prices a claim on the formula, with the benchmarks the pharmacy holds.
 *
 * A leg whose benchmark is missing is skipped; if it was the only leg, nothing is priced. If it was
 * one leg of a lesser-of, the claim is priced on the others and marked "at most", because the
 * missing leg could only have lowered it. That is the honest reading of "lesser of MAC or AWP-25%"
 * for a pharmacy that does not hold the MAC: the AWP leg is the most the contract owes.
 */
export function expectedCents(f: Formula, quantityThousandths: number | null, b: Benchmarks): Expected {
  const none = (why: string): Expected => ({ totalCents: null, ingredientCents: null, feeCents: f.feeCents, leg: null, atMost: false, why });
  if (f.kind !== "priced") return none(`The formula could not be read: "${f.text}".`);
  if (!quantityThousandths || quantityThousandths <= 0) return none("No quantity on the claim.");
  const units = quantityThousandths / 1000;
  const perUnit = (leg: Leg): number | null => {
    const micros =
      leg.benchmark === "AWP" ? b.awpMicros : leg.benchmark === "WAC" ? b.wacMicros : leg.benchmark === "NADAC" ? b.nadacMicros
      : leg.benchmark === "MAC" ? b.macMicros : leg.benchmark === "FUL" ? b.fulMicros : null;
    if (micros === null || micros === undefined) return null;
    return micros * (1 - leg.discountPercent / 100);
  };
  let best: { leg: Leg; cents: number } | null = null;
  let skipped: Benchmark[] = [];
  for (const leg of f.legs) {
    let cents: number | null;
    if (leg.benchmark === "UC") cents = b.usualAndCustomaryCents ?? null;
    else {
      const pu = perUnit(leg);
      cents = pu === null ? null : Math.round((pu * units) / 10_000);
    }
    if (cents === null) { skipped.push(leg.benchmark); continue; }
    if (!best || cents < best.cents) best = { leg, cents };
  }
  if (!best) return none(`No ${f.legs.map((l) => l.benchmark).join(" or ")} held for this NDC, so the formula cannot be priced.`);
  const fee = f.feeCents ?? 0;
  const atMost = f.lesserOf && skipped.length > 0;
  return {
    totalCents: best.cents + fee,
    ingredientCents: best.cents,
    feeCents: f.feeCents,
    leg: best.leg,
    atMost,
    why: atMost
      ? `Priced on ${best.leg.benchmark}${best.leg.discountPercent ? `-${best.leg.discountPercent}%` : ""}; the ${skipped.join("/")} leg is not held, and could only be lower, so this is the most the contract owes.`
      : `Priced on ${best.leg.benchmark}${best.leg.discountPercent ? `-${best.leg.discountPercent}%` : ""}${f.feeCents !== null ? ` plus a $${(f.feeCents / 100).toFixed(2)} fee` : ""}.`,
  };
}
