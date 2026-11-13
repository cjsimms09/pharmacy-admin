/**
 * Grouping NDCs that are the same product.
 *
 * Purchasing decisions and reimbursement comparisons both need this: a MAC is set per molecule,
 * so the question is always "of the NDCs that are this same product, which should I buy". NDC
 * alone cannot answer it — every manufacturer has its own.
 *
 * The proper answer is a licensed classification (GPI, GCN) or RxNorm. Neither is available
 * offline without a licence or a download, so this derives a key from the product description,
 * which every claims export and every supplier catalogue carries.
 *
 * The whole design is shaped by one asymmetry. Failing to group two NDCs that match costs a
 * missed saving, which is visible and recoverable. Grouping two that do not match produces a
 * purchasing recommendation to substitute one drug for another, which is a dispensing error
 * waiting to happen. So everything that could distinguish two products is preserved, and
 * anything ambiguous stays apart.
 *
 * Specifically never collapsed:
 *   - salt forms      metoprolol succinate is not metoprolol tartrate
 *   - release profile ER, XR, SR, DR, CR, IR are separate products
 *   - strength        including the units it is expressed in
 *   - dosage form     a tablet is not a capsule is not a suspension
 */

/** Words that carry no distinguishing information and only get in the way of matching. */
const FILLER = /\b(oral|by mouth|usp|nf|generic|brand|the|a|an)\b/g;

/**
 * Release modifiers, kept as written rather than folded together.
 *
 * XL and SR are not the same product — bupropion XL and bupropion SR are dosed differently — so
 * collapsing every modifier to "extended release" would produce exactly the substitution this
 * must never suggest. A spelled-out "extended-release" with no letter code becomes "er", which
 * means it will not match a description that says "XL". That is a missed saving, and a missed
 * saving is the failure we accept.
 */
const RELEASE = /\b(xl|xr|sr|cr|dr|er|cd|ir)\b|\b(extended[- ]?release|delayed[- ]?release|controlled[- ]?release|sustained[- ]?release|immediate[- ]?release)\b/;

const RELEASE_SPELLED: Record<string, string> = {
  "extended release": "er",
  "extendedrelease": "er",
  "extended-release": "er",
  "delayed release": "dr",
  "delayedrelease": "dr",
  "delayed-release": "dr",
  "controlled release": "cr",
  "controlled-release": "cr",
  "sustained release": "sr",
  "sustained-release": "sr",
  "immediate release": "ir",
  "immediate-release": "ir",
};

/** Dosage forms, normalised to one spelling each. Longest match first. */
const FORMS: [RegExp, string][] = [
  [/\bchew(able)?\s+(tab|tablet)s?\b/, "chewable tablet"],
  [/\b(orally\s+disintegrating|odt)\s*(tab|tablet)s?\b/, "odt"],
  [/\b(tab|tablet)s?\b/, "tablet"],
  [/\b(cap|capsule)s?\b/, "capsule"],
  [/\b(susp|suspension)\b/, "suspension"],
  [/\b(soln|solution)\b/, "solution"],
  [/\b(inj|injection|injectable)\b/, "injection"],
  [/\b(oint|ointment)\b/, "ointment"],
  [/\bcream\b/, "cream"],
  [/\b(supp|suppository|suppositories)\b/, "suppository"],
  [/\b(patch|transdermal)\b/, "patch"],
  [/\b(inhaler|hfa|mdi)\b/, "inhaler"],
  [/\b(neb|nebulizer|nebuliser)\b/, "nebulizer solution"],
  [/\bgel\b/, "gel"],
  [/\b(syrup|elixir)\b/, "syrup"],
  [/\b(drops?|gtt)\b/, "drops"],
  [/\b(pack|kit)\b/, "kit"],
];

export type ProductParts = {
  /** Ingredient and salt, lowercase. */
  base: string;
  /** Strength as written, normalised: "20mg", "400mg/5ml". Null when none was stated. */
  strength: string | null;
  /** Dosage form, normalised. Null when none was recognised. */
  form: string | null;
  /** The key itself. Null when the description was too thin to key safely. */
  key: string | null;
};

/** Normalises the number in a strength so "0.5" and ".50" and "0.50" agree. */
function num(n: string): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return n;
  return String(v);
}

/**
 * Pulls every strength expression out of a description.
 *
 * Handles the ratio forms that suspensions and solutions use — "400 mg/5 ml" — as well as plain
 * strengths, percentages and microgram spellings.
 */
function extractStrength(s: string): { strength: string | null; rest: string } {
  const units = "mcg|ug|mg|g|gm|ml|l|unit|units|iu|meq|mmol|%";
  // \d*\.?\d+ so ".05" reads the same as "0.05"; the trailing boundary is (?![a-z]) rather
  // than \b because % is not a word character and \b would never fire after it.
  const n = "\\d*\\.?\\d+";
  // Combination products state every component: "10-325 mg", "1.5-30". Kept whole, because
  // 10-325 and 5-325 are different products and splitting them loses the distinction.
  const combo = new RegExp(`(${n}(?:\\s*-\\s*${n})+)\\s*(${units})(?![a-z])`, "i");
  const c = combo.exec(s);
  if (c) {
    const parts = c[1].split("-").map((x) => num(x.trim())).join("-");
    return { strength: `${parts}${c[2].toLowerCase()}`, rest: s.replace(combo, " ") };
  }

  const ratio = new RegExp(`(${n})\\s*(${units})\\s*/\\s*(${n})?\\s*(${units})(?![a-z])`, "i");
  const plain = new RegExp(`(${n})\\s*(${units})(?![a-z])`, "i");

  const r = ratio.exec(s);
  if (r) {
    const [, n1, u1, n2, u2] = r;
    const denom = n2 ? `${num(n2)}${u2.toLowerCase()}` : u2.toLowerCase();
    return { strength: `${num(n1)}${u1.toLowerCase()}/${denom}`, rest: s.replace(ratio, " ") };
  }
  const p = plain.exec(s);
  if (p) return { strength: `${num(p[1])}${p[2].toLowerCase()}`, rest: s.replace(plain, " ") };
  return { strength: null, rest: s };
}

/**
 * Turns a product description into a comparable key.
 *
 * Returns a null key rather than a weak one when the description lacks a strength or a
 * recognisable form. A key built on a bare drug name would match a 10mg tablet to a 40mg
 * capsule, which is exactly the substitution this must never suggest.
 */
export function productKey(description: string | null | undefined): ProductParts {
  const raw = (description ?? "").trim();
  if (!raw) return { base: "", strength: null, form: null, key: null };

  let s = raw
    .toLowerCase()
    .replace(/[®™]/g, " ")
    .replace(/[,()]/g, " ")
    .replace(/\s+/g, " ");

  // Release modifier first, so "ER Tablet" does not lose its ER when the form is consumed.
  let release: string | null = null;
  const rel = RELEASE.exec(s);
  if (rel) {
    const code = rel[1];
    const spelled = rel[2];
    release = code ?? RELEASE_SPELLED[(spelled ?? "").replace(/\s+/g, " ")] ?? null;
    s = s.replace(RELEASE, " ");
  }

  let form: string | null = null;
  for (const [re, name] of FORMS) {
    if (re.test(s)) {
      form = name;
      s = s.replace(re, " ");
      break;
    }
  }

  const { strength, rest } = extractStrength(s);
  s = rest;

  if (release) form = form ? `${release} ${form}` : release;

  const base = s
    .replace(FILLER, " ")
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Too thin to be safe. Two products sharing only a name are not the same product.
  if (!base || !strength) return { base, strength, form, key: null };

  return { base, strength, form, key: [base, strength, form ?? "unspecified-form"].join("|") };
}

/** True when two descriptions denote the same product and can be compared on price. */
export function sameProduct(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = productKey(a).key;
  const kb = productKey(b).key;
  return ka !== null && ka === kb;
}
