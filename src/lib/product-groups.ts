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
import { isARated, teGroup } from "./drug-directory";

export type GroupSource = {
  ndc11: string;
  /**
   * The FDA directory's equivalence key for this NDC — substances, strength, form and route.
   *
   * The identity, where the directory has the NDC. Null where it does not, and then the
   * description is read instead. Callers fill this from `drug_directory.equivalence_key`.
   */
  equivalenceKey?: string | null;
  /**
   * The Orange Book's therapeutic equivalence rating — "AB", "AB1", "AP" — or null where the
   * product carries none. Callers fill this from `drug_directory.te_code`.
   *
   * Without it the equivalence key decides alone, and the equivalence key is a statement about
   * chemistry, not about substitution. See `groupKey`.
   */
  teCode?: string | null;
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
  /*
   * ── A key is not a rating, and the difference cost a recommendation ──
   *
   * On 9 September the site told the owner to buy NDC 00169-1704-30 rather than 00169-4404-31 and
   * keep $193.31 a fill. Those are Ozempic and Wegovy. Same molecule, same strength, same form,
   * same route, same manufacturer — so the same equivalence key, "semaglutide|4 mg/1|tablet|oral"
   * — and two different FDA applications, NDA213051 and NDA218316, approved for different things.
   * Neither may be dispensed for the other by anybody. 1,295 equivalence keys in this directory
   * span more than one application that way.
   *
   * `drug-directory.ts` already held the correct rule and stated it plainly: "Two unrated products
   * with the same key are the same drug on paper and still not called substitutable here, because
   * nothing has said they are." `substitutable()` enforces it for dispensing. This module, which
   * decides what to *buy*, did not use it, so the weaker rule sat in the more expensive place.
   *
   * A group now needs a rating as well as a key, in three cases.
   *
   * Products sharing an Orange Book A-rating are one group, suffix and all, because AB1 is not AB2
   * and a bare AB is neither.
   *
   * A generic with no rating extracted is still a generic: an approved ANDA is therapeutically
   * equivalent to its reference product by law, and that is what the approval means. 14,773 of this
   * directory's generic NDCs carry no code — the Orange Book row did not match on strength, or the
   * listing was not found — and splitting each into a group of one would have cost real comparisons
   * on 4,317 NDCs that share a key with a rated product. They group on the key, as before.
   *
   * An unrated brand is substitutable for nothing. It groups only with other packages of its own
   * product, which is a real buying choice and a safe one. That is the case Ozempic and Wegovy fall
   * into, and Mounjaro and Zepbound, and Cymbalta and Drizalma Sprinkle.
   */
  const fda = (src.equivalenceKey ?? "").trim();
  const rating = isARated(src.teCode ?? null) ? `te:${teGroup(src.teCode ?? null)}` : (src.classification ?? "").trim().toUpperCase() === "B" ? `product:${src.ndc11.slice(0, 9)}` : "generic";
  const k = fda ? `fda:${fda}|${rating}` : productKey(src.description).key;
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
