/**
 * Which NDCs are the same product.
 *
 * "Which NDC should I buy" is a question about a product, and a product is several NDCs: the same
 * drug, strength and form from different manufacturers, each with its own price at each supplier
 * and its own NADAC. Nothing the site holds groups them. The catalogues describe a product in each
 * supplier's own words, the invoices in another, and the claims not at all. NADAC does: CMS prints
 * one description per NDC, and it is the same words for every manufacturer's version of the same
 * thing ("ATORVASTATIN CALCIUM 40 MG TABLET"), because the file is built from the drug, not from
 * the label.
 *
 * So the grouping key is NADAC's description, with three more things that must match before two
 * NDCs are treated as interchangeable here:
 *
 *   - **classification** — NADAC's brand/generic flag. A brand and its generic are the same drug
 *     and are not the same buying decision; substituting one for the other is a DAW question that
 *     belongs to the pharmacist and the plan, not to a price comparison.
 *   - **pricing unit** — EA, ML or GM. Two rows priced in different units cannot share a per-unit
 *     margin, whatever their descriptions say.
 *   - **OTC** — an OTC row is reimbursed differently or not at all.
 *
 * This is deliberately not therapeutic equivalence. It does not know AB ratings, it does not know
 * that a capsule and a tablet are interchangeable for some drugs and not others, and it never puts
 * two different descriptions together. It errs towards too many groups rather than too few: a
 * product split in two loses a comparison, a product wrongly merged recommends a switch that
 * cannot be dispensed. When an Orange Book or RxNorm reference is added it replaces this key; the
 * callers only ask for the key.
 *
 * Pure. Everything comes in as arguments.
 */

export type GroupSource = {
  ndc11: string;
  /** NADAC's description for the NDC. Null where the NDC has no NADAC row, which is its own answer. */
  description: string | null;
  /** NADAC's classification for rate setting: "G" or "B". */
  classification: string | null;
  pricingUnit: string | null;
  otc?: boolean | null;
};

/**
 * NADAC descriptions are consistent but not identical in spacing across years of files:
 * "5 MG" and "5MG" both occur. The key folds case, collapses whitespace, and closes the gap
 * between a number and its unit so that those read as one product.
 */
export function normalizeDescription(s: string): string {
  return s
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/(\d)\s+(MG|MCG|ML|GM|G|IU|UNIT|UNITS|%|MEQ|MMOL)\b/g, "$1$2")
    .replace(/\s*\/\s*/g, "/")
    .trim();
}

/** The key two NDCs must share to be one product here, or null where the NDC cannot be placed. */
export function groupKey(src: GroupSource): string | null {
  if (!src.description || !src.description.trim()) return null;
  const cls = (src.classification ?? "").trim().toUpperCase() || "?";
  const unit = (src.pricingUnit ?? "").trim().toUpperCase() || "?";
  return `${normalizeDescription(src.description)}|${cls}|${unit}|${src.otc ? "OTC" : "RX"}`;
}

/**
 * Every product with more than one NDC, keyed so that a caller can ask "what else is this".
 *
 * An NDC with several NADAC rows (one per effective date) is one NDC; the first row with a
 * description places it, and a later row that disagrees does not move it, because the file does
 * not rename products between weeks and a disagreement is a data problem to be looked at, not
 * settled by ordering.
 */
export function groupProducts(rows: GroupSource[]): Map<string, string[]> {
  const keyOf = new Map<string, string>();
  for (const r of rows) {
    if (keyOf.has(r.ndc11)) continue;
    const k = groupKey(r);
    if (k) keyOf.set(r.ndc11, k);
  }
  const groups = new Map<string, string[]>();
  for (const [ndc, k] of keyOf) {
    const list = groups.get(k);
    if (list) list.push(ndc);
    else groups.set(k, [ndc]);
  }
  return groups;
}

/** The NDCs that are the same product as this one, itself included. Just itself where nothing places it. */
export function equivalentsOf(rows: GroupSource[], ndc11: string): string[] {
  const groups = groupProducts(rows);
  for (const list of groups.values()) if (list.includes(ndc11)) return [...list];
  return [ndc11];
}
