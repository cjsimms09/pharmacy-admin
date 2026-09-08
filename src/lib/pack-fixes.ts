import { comparePack, cataloguePackUnits, fdaPackageUnits, fdaContainerContents, type PackVerdict } from "./data-health-packages";

/**
 * Settling how many dispensing units are in a package, and keeping the answer.
 *
 * The owner: "We need to fix correctly all the package sizes that we can. For those we can't, I
 * need a way to lookup and correct. These corrections need to stick."
 *
 * A pack size is a divisor. Every per-unit cost on this site is the pack cost over the units in the
 * pack, so a pack size wrong by six makes a drug look six times cheaper than it is and the buy list
 * recommends it. On the real catalogue 48,852 of 51,502 comparable rows agree with the FDA and
 * about 2,650 do not, and the ones that are out by a whole factor are the expensive kind.
 *
 * This module decides which of those the FDA can settle on its own. It is pure; `pack-fixes-store.ts`
 * reads the catalogue and writes the corrections.
 *
 * ── Why auto-correction is restricted to a clean whole multiple ──
 *
 * Applying the FDA's figure blind has already broken this site. The directory describes a box of
 * four buprenorphine patches as four pouches of 168 hours, which multiplies out to 672; it counts a
 * Breyna inhaler in 120 actuations where every wholesaler prices the 10.3 grams in the canister.
 * Applied without judgement both turn a $124.99 package into a $0.74 one, and 69 rows were changed
 * that way.
 *
 * Two guards stop that here, and both were tested against those exact two packages before this was
 * written:
 *
 *   - `fdaPackageUnits` refuses a description that never reaches a dispensing unit. The patch is
 *     refused outright, because hours are not things.
 *   - Only the `multiple` verdict is acted on. The inhaler comes back `unit-differs` — actuations
 *     against grams — which is a disagreement about what is being counted, not about how many, and
 *     no arithmetic reconciles it. It goes to a person.
 *
 * So what is corrected automatically is the narrow case where both sides count the same kind of
 * thing and one is a whole number of the other: "30 EA" against the FDA's 180, which is thirty
 * blister packs of six. There the FDA is not disagreeing with the trade, it is stating the level
 * the trade left implicit.
 *
 * ── Why a person always outranks the file ──
 *
 * `ndc_pack_fixes` is the pharmacy's own answer and is keyed on the NDC alone, because an NDC names
 * one package and the pharmacist is the only party holding the bottle. A correction written from
 * the FDA is recorded with `FDA_SOURCE` as its author, so it is visibly not somebody's judgement,
 * and a later run never touches a row a person has signed. Nothing here can overwrite a pharmacist.
 */

/** The author recorded on a correction that came from the FDA's file rather than from a person. */
export const FDA_SOURCE = "FDA package file";

/** The author recorded on a contents correction, distinct so the two rules stay tellable apart. */
export const FDA_CONTENTS_SOURCE = "FDA package file (contents of containers)";

/**
 * True where this correction was written by an automatic pass rather than decided by somebody.
 *
 * Both authors count, and getting that wrong would be a quiet miscount rather than a crash: a row
 * settled by the contents rule would be reported as one a pharmacist had signed, which overstates
 * the work done by hand and understates what the file is doing.
 */
export function isFromFda(correctedBy: string | null | undefined): boolean {
  const by = (correctedBy ?? "").trim();
  return by === FDA_SOURCE || by === FDA_CONTENTS_SOURCE;
}

/** True where a person signed it, which is the thing no automatic pass may touch. */
export function isFromPerson(correctedBy: string | null | undefined): boolean {
  return (correctedBy ?? "").trim() !== "" && !isFromFda(correctedBy);
}

export type ExistingFix = { packSize: string; correctedBy: string } | null;

export type Proposal =
  | {
      apply: true;
      /** The pack size to store, in the form the catalogue uses: "180 EA". */
      packSize: string;
      /** The arithmetic that justified it, kept because it is the only record of why. */
      note: string;
      factor: number;
    }
  | { apply: false; why: string; verdict: PackVerdict["verdict"] | "already-settled" };

/**
 * Whether the FDA settles this row on its own, and the correction if it does.
 *
 * `catalogue` is one wholesaler's pack size as printed; `packageDescription` is the FDA's text for
 * the same NDC; `existing` is the correction already on file for that NDC, if any.
 */
export function proposeFdaCorrection(a: {
  catalogue: string | null | undefined;
  packageDescription: string | null | undefined;
  existing?: ExistingFix;
}): Proposal {
  /*
   * A person's answer is final and is not revisited.
   *
   * Checked before anything is read, so that a pharmacist who has settled a package never has the
   * arithmetic run against him — not even to agree with him, because agreeing would rewrite his
   * note and his name with the file's.
   */
  if (a.existing && (isFromPerson(a.existing.correctedBy) || a.existing.correctedBy.trim() === FDA_CONTENTS_SOURCE)) {
    return {
      apply: false,
      verdict: "already-settled",
      why: `${a.existing.correctedBy} has already settled this package at ${a.existing.packSize}.`,
    };
  }

  const verdict = comparePack(a.catalogue, a.packageDescription);
  if (verdict.verdict === "agree") {
    return { apply: false, verdict: "agree", why: "The catalogue and the FDA already agree; there is nothing to correct." };
  }
  if (verdict.verdict === "cannot-compare") {
    return { apply: false, verdict: "cannot-compare", why: verdict.why };
  }
  if (verdict.verdict === "unit-differs") {
    /*
     * Counted in different things. The inhaler: 120 actuations against 10.3 grams, both true, and
     * no factor turns one into the other. Applying the FDA here is how a $124.99 package became
     * $0.74 on 69 rows.
     */
    return {
      apply: false,
      verdict: "unit-differs",
      why: `The catalogue counts ${verdict.catalogue} and the FDA counts ${verdict.fda}. They are not the same kind of thing, so no arithmetic reconciles them — somebody has to say which describes the package.`,
    };
  }
  if (verdict.verdict === "differs") {
    return {
      apply: false,
      verdict: "differs",
      why: `The catalogue says ${verdict.catalogue} ${verdict.uom} and the FDA says ${verdict.fda} ${verdict.uom}, which is not a whole multiple either way. One of them is describing a different package.`,
    };
  }

  // A clean whole multiple: the FDA is stating the level the wholesaler left implicit.
  const fda = fdaPackageUnits(a.packageDescription);
  const cat = cataloguePackUnits(a.catalogue);
  if (!fda.ok || !cat.ok) {
    // Unreachable given comparePack returned "multiple", but a wrong pack size is expensive enough
    // that this refuses rather than trusts an invariant it cannot see.
    return { apply: false, verdict: "cannot-compare", why: "The reading changed between the comparison and the correction." };
  }

  const packSize = `${fda.units} ${fda.uom}`;
  const note =
    `The FDA's package file states ${fda.units} ${fda.uom}; the catalogue read ${cat.units} ${cat.uom}, ` +
    `a factor of ${verdict.factor}. Both count ${fda.uom === "EA" ? "the same kind of unit" : fda.uom.toLowerCase()}, and ` +
    `${verdict.factor} of the catalogue's is exactly the FDA's, so the catalogue was quoting an inner pack. Corrected to the FDA's figure.`;

  return { apply: true, packSize, note, factor: verdict.factor };
}

/**
 * A wholesaler counting containers where the FDA states what is in them.
 *
 * "McKesson counts 1 EA where the FDA counts 20 ML" is not a disagreement about the package. It is
 * two conventions: McKesson counts the vial you can hold, the FDA states the twenty millilitres in
 * it, and both are describing the same box truthfully. It is also not a handful of rows — it is
 * every single-dose vial in the catalogue, Alimta and Orencia and the rest, which is one convention
 * to settle rather than thousands of judgements to make.
 *
 * The FDA's reading is the one to keep, because NADAC prices injectables per millilitre and every
 * over- or under-payment figure is measured against NADAC. A per-EA cost held against a per-ML
 * benchmark is the fault that once read as 100 times NADAC.
 *
 * ── What makes this safe, and it is the container count ──
 *
 * The rule fires only where the wholesaler's own number equals the number of containers the FDA
 * describes. One vial against one container; twenty-five syringes against twenty-five. That
 * equality is the evidence that the two are describing the same package by different conventions
 * rather than disagreeing about its size — and where it fails, nothing is written.
 *
 * The outer levels must also be things a pharmacy dispenses one at a time — vial, syringe, ampule,
 * pen, cartridge — never a carton or a case, so "1 EA" against a carton of unknown contents is
 * still refused rather than settled at the carton's volume.
 */
export function proposeContainerContents(a: {
  catalogue: string | null | undefined;
  packageDescription: string | null | undefined;
  existing?: ExistingFix;
}): Proposal {
  if (a.existing && isFromPerson(a.existing.correctedBy)) {
    return {
      apply: false,
      verdict: "already-settled",
      why: `${a.existing.correctedBy} has already settled this package at ${a.existing.packSize}.`,
    };
  }

  const cat = cataloguePackUnits(a.catalogue);
  if (!cat.ok) return { apply: false, verdict: "cannot-compare", why: cat.why };
  // Only a wholesaler counting things, against a file measuring them. Anything else is not this.
  if (cat.uom !== "EA") {
    return { apply: false, verdict: "unit-differs", why: `The catalogue already counts ${cat.uom}, so it is not counting containers.` };
  }

  const contents = fdaContainerContents(a.packageDescription);
  if (contents === null) {
    return { apply: false, verdict: "cannot-compare", why: "The FDA does not describe this as containers with a volume or a mass in each." };
  }
  if (contents.containers !== cat.units) {
    /*
     * The guard. Without it this would settle "4 EA" at the contents of one vial, or at the
     * contents of ten, and a per-unit cost would be wrong by whatever the mismatch was.
     */
    return {
      apply: false,
      verdict: "differs",
      why: `The catalogue counts ${cat.units} where the FDA describes ${contents.containers} ${contents.containerNoun}. Those are not the same package by two conventions, they are two different numbers.`,
    };
  }

  const packSize = `${contents.units} ${contents.uom}`;
  const note =
    `The catalogue counts ${cat.units} ${contents.containerNoun}${cat.units === 1 ? "" : "s"} and the FDA states what is in ` +
    `${cat.units === 1 ? "it" : "them"}: ${contents.units} ${contents.uom} in total. Both describe the same package. ` +
    `Recorded in ${contents.uom} because NADAC prices this per ${contents.uom === "ML" ? "millilitre" : "gram"}, and a per-unit ` +
    `cost has to be in the same unit as the benchmark it is compared against.`;

  return { apply: true, packSize, note, factor: contents.units / cat.units };
}

/** What a row needs a person for, grouped so the page can lead with the biggest kind. */
export type NeedsPersonReason = "unit-differs" | "differs" | "cannot-compare";

/**
 * Everything a person has to look at, as a reason with words on it.
 *
 * The three are genuinely different jobs: a unit disagreement needs somebody to say what the
 * package is counted in, an unreadable FDA description needs the bottle, and a plain disagreement
 * needs somebody to decide which file is describing this package.
 */
export function reasonWords(reason: NeedsPersonReason): string {
  if (reason === "unit-differs") return "Counted in different units — somebody has to say which describes the package";
  if (reason === "differs") return "Both readable and neither a multiple of the other — one file is describing a different package";
  return "The FDA's description does not reach a dispensing unit, so only the bottle settles it";
}

/**
 * The cost of one dispensing unit under a given pack size, in millionths of a dollar.
 *
 * This is what makes a correction page decidable rather than abstract: the pharmacist is not being
 * asked which number is prettier, he is being shown that the drug costs $2.41 a tablet under one
 * reading and $0.40 under the other, and he knows which one he pays.
 *
 * Null where the pack cost is unknown or the size is unreadable — a per-unit cost invented from a
 * missing pack cost is exactly the kind of confident wrong number this page exists to remove.
 */
export function unitCostMicros(packCostCents: number | null | undefined, packSize: string | null | undefined): number | null {
  if (packCostCents === null || packCostCents === undefined || packCostCents <= 0) return null;
  const size = cataloguePackUnits(packSize);
  if (!size.ok || size.units <= 0) return null;
  return Math.round((packCostCents * 10_000) / size.units);
}
