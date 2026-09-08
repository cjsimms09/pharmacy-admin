/**
 * Which NDCs are the same product, for buying.
 *
 * "Which NDC should I buy" is a question about a product, and a product is several NDCs: the same
 * drug, strength and form from different manufacturers, each with its own price at each supplier
 * and its own NADAC. The site keys products off their description in `product-key.ts`, which is
 * careful about exactly the things a price comparison must never blur — salt forms, release
 * profiles, strength and its units, dosage form — and returns no key at all for a description too
 * thin to be safe. This module adds what a *buying* group needs on top of that key, using NADAC's
 * row for the NDC as the source, because NADAC prints one description per NDC in one house style:
 *
 *   - **classification** — NADAC's brand/generic flag. A brand and its generic are the same drug
 *     and are not the same buying decision; substituting one for the other is a DAW question that
 *     belongs to the pharmacist and the plan, not to a price comparison.
 *   - **pricing unit** — EA, ML or GM. Two rows priced in different units cannot share a per-unit
 *     margin, whatever their descriptions say.
 *   - **OTC** — an OTC row is reimbursed differently or not at all.
 *
 * It errs towards too many groups rather than too few: a product split in two loses a comparison,
 * a product wrongly merged recommends a switch that cannot be dispensed.
 *
 * ── Why the description is now the fallback and not the source ──
 *
 * Reading the product out of a description was always the weak link, and on the real database it
 * fails in the direction this file says it must never fail in. Measured against the FDA's own
 * directory across the 23,494 catalogue NDCs where both have an answer, keying on NADAC's
 * description merged 1,092 keys covering **10,427 NDCs** that the FDA says are different products,
 * and split 19.6% of the products that are the same one. The cause is that NADAC's house style
 * often states no dosage form, so the key falls back to "unspecified-form" and everything under
 * that name collapses together: lithium carbonate 300mg arrives as one product covering the
 * capsule, the tablet and the gelatin-coated capsule. "Which NDC pays best in this product" then
 * answers across dosage forms, which is exactly the substitution that cannot be dispensed.
 *
 * So identity comes from the NDC where it can. `drug_directory` is the FDA's NDC directory joined
 * to the Orange Book, and its `equivalence_key` is built from substances, strength, form and route
 * — none of it prose, none of it a wholesaler's typing. It covers 96.9% of the NDCs this pharmacy
 * dispenses and 77.5% of the catalogue. The description key stays for the rest, because a worse
 * answer on a tenth of the catalogue beats no answer, and because splitting a product across the
 * two schemes only ever costs a comparison — the safe direction.
 *
 * Pure. Everything comes in as arguments, the FDA key included.
 */

import { productKey } from "./product-key";

export type GroupSource = {
  ndc11: string;
  /**
   * The FDA directory's equivalence key for this NDC — substances, strength, form and route.
   *
   * The identity, where the directory has the NDC. Null where it does not, and then the
   * description is read instead. Callers fill this from `drug_directory.equivalence_key`.
   */
  equivalenceKey?: string | null;
  /** NADAC's description for the NDC. Null where the NDC has no NADAC row, which is its own answer. */
  description: string | null;
  /** NADAC's classification for rate setting: "G" or "B". */
  classification: string | null;
  pricingUnit: string | null;
  otc?: boolean | null;
};

/** The key two NDCs must share to be one product here, or null where the NDC cannot be placed safely. */
export function groupKey(src: GroupSource): string | null {
  /*
   * The FDA's answer first, the description only where there is none.
   *
   * The two are deliberately never mixed into one key and never compared against each other. A
   * product whose NDCs are split between the schemes simply forms two groups, which costs a
   * comparison and cannot recommend a switch that should not happen. The prefix keeps them apart
   * even in the unlikely event that a description key and an FDA key spell the same string.
   */
  const fda = (src.equivalenceKey ?? "").trim();
  const k = fda ? `fda:${fda}` : productKey(src.description).key;
  if (!k) return null;
  const cls = (src.classification ?? "").trim().toUpperCase() || "?";
  const unit = (src.pricingUnit ?? "").trim().toUpperCase() || "?";
  return `${k}|${cls}|${unit}|${src.otc ? "OTC" : "RX"}`;
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
