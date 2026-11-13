/**
 * How many dispensing units are in one package of an NDC, and what unit those are.
 *
 * The owner: "i dont like that we seem to be having lots of issues matching ndcs. whats the fix
 * here, everything needs to run as smoothly and be as accurate as possible."
 *
 * Reading the NDC off a wholesaler's paper is settled — `ndcFromRun`, `ndcFromUpc`, `sameDrugCode`
 * in `invoice-lines.ts`. This is the other half, and it is the more expensive one, because a pack
 * size is not a fact that is either present or absent: it is a number that is always available and
 * is sometimes the wrong number. Every margin, every loss figure, every MAC appeal shortfall and
 * every evidence PDF divides a package price by it. Get it wrong and nothing looks wrong.
 *
 * ── What was actually happening ──
 *
 * The question was being re-derived in four places, each with its own regex over
 * `drug_directory.package_description`, and three of them were the same regex: `/^\s*([\d.]+)\s+[A-Z]/`.
 * That takes the **outer** count — the first number in the text — which is a count of cartons,
 * blisters or syringes about as often as it is a count of anything dispensed. Measured on this
 * pharmacy's own September claims:
 *
 *   **Wegovy.** `4 SYRINGE, PLASTIC in 1 CARTON (0169-4505-14) / .5 mL in 1 SYRINGE, PLASTIC`.
 *   The claim quantity is 2 — two millilitres, four pens of half a millilitre. The outer count is
 *   4. Dividing a package price by 4 instead of 2 halves the cost per unit, and comparing that
 *   against the claim's own per-unit cost produced a phantom "$34,363 of overstated cost" finding
 *   twice in one session.
 *
 *   **Estradiol vaginal cream.** `1 TUBE in 1 CARTON (45802-097-35) / 42.5 g in 1 TUBE`. The claim
 *   quantity is 42.5 — grams. The outer count is 1. Claim-per-unit $0.28 against invoice-per-unit
 *   $7.86 is a 28× artefact, and it silently disqualified a real appealable claim: the appeal plan
 *   throws away any claim where the two sources disagree by more than 2%, so the drug with the
 *   worst reading is the drug that never gets appealed.
 *
 *   **Methylphenidate** once produced "$245.98 per tablet" from a per-package price, and that one
 *   was one edit away from going to a PBM under the pharmacy's NPI.
 *
 * ── Why this is a separate question from what is physically in the box ──
 *
 * `data-health-packages.ts` already reads the FDA's nest properly and answers "what does this
 * package physically contain": 144 pouches of 0.9 g of gel is 129.6 g of gel, and that is the right
 * answer to the question it is asked, which is whether a wholesaler's catalogue pack size is
 * correct. It is the wrong answer to *this* question. A claim for a lidocaine patch counts patches:
 * `30 POUCH in 1 CARTON / .7 g in 1 POUCH` is 30 dispensing units, not 21 grams. The FDA states the
 * drug's mass per patch because that is what the product is; the pharmacy bills per patch.
 *
 * So there are two honest questions and this file answers the billing one. It shares the level
 * parser with the other so there is still only one reader of the FDA's text.
 *
 * ── The form decides the unit, not the innermost level ──
 *
 * This is the whole rule, and it is the part every previous copy was missing. The FDA's innermost
 * level is whatever the product physically is; what the claim counts is decided by the **dosage
 * form**:
 *
 *   A discrete form — TABLET, CAPSULE, PATCH, FILM, LOZENGE — is billed each. Any mass or volume
 *   the description states below it is the drug content of one unit and must be skipped, not
 *   multiplied. `8 POUCH in 1 CARTON / 1 PATCH in 1 POUCH / 3.5 d in 1 PATCH` is 8 patches: the
 *   3.5 days is how long one is worn. The pharmacy's own claim for that NDC says 8.
 *
 *   A bulk form — SOLUTION, CREAM, INJECTION — is billed by the measure, and the measure is the
 *   innermost level. `1 TUBE in 1 CARTON / 42.5 g in 1 TUBE` is 42.5 grams.
 *
 * Both readings exist in the same shapes of text, which is why no regex over the description alone
 * can be right. `30 POUCH / .7 g in 1 POUCH` and `1 TUBE / 42.5 g in 1 TUBE` are the same shape and
 * the answers are 30 EA and 42.5 GM.
 *
 * ── Refusing is the point ──
 *
 * The standing brief's "derived unit" fault shape says a silent factor of 25 lives here, and it does
 * — twice, in this pharmacy's live data, and both are refused rather than answered:
 *
 *   **A metered inhaler.** `1 CANISTER in 1 CARTON / 200 AEROSOL, METERED in 1 CANISTER` for
 *   albuterol HFA. The claim quantity is **8.5** — the canister's net weight in grams, which the FDA
 *   description does not state anywhere. Reading the actuation count gives 200: a factor of 23.5.
 *
 *   **An oral contraceptive kit.** `3 BLISTER PACK in 1 CARTON / 1 KIT in 1 BLISTER PACK`. The claim
 *   quantity is **84**. Nothing in the description says 28; the only number available is 3. A factor
 *   of 28.
 *
 * A null that says why is correct. A plausible number is the bug. So every refusal carries its
 * reason in words, because the reason is what lets somebody either fix the data or accept that the
 * figure cannot be had — and a caller putting a cost in front of a PBM must have neither a guess nor
 * a silence, but a refusal it can print.
 *
 * ── The claim's own unit is not on the claim ──
 *
 * `claims.quantity_unit` exists as a column and is **null on all 3,370 rows**. PioneerRx's export
 * has never carried it. So the unit can only be inferred from the drug, which is what this does, and
 * `claimQuantityAgrees` is the check that the inference and the claim's number are consistent —
 * because an inference nothing tests is just a better-documented guess.
 *
 * Pure and DB-free: the caller supplies the directory row, exactly as `invoice-lines.ts` takes a
 * `KnownNdc`.
 */

import { fdaPackageLevels, type PackLevel } from "./data-health-packages";

/** NADAC's and NCPDP's pricing units, and the only three a claim quantity is ever in. */
export type DispensingUnit = "EA" | "ML" | "GM";

export type PackSize = {
  /** Dispensing units in one package. */
  units: number;
  unit: DispensingUnit;
  /**
   * How the number was reached, in words, for the audit trail.
   *
   * Every figure on this site is supposed to say where it came from. A cost per unit is two numbers
   * and a division, and this is the half that is not on the invoice.
   */
  source: string;
  /**
   * For a package built as N containers with a measure in each: how many containers.
   *
   * Kept because it is the only thing that can catch the unit-dose trap. A tray of 60 single-use
   * vials of 0.4 mL is 24 mL and is also 60 things, and a claim quantity of 60 means the second.
   * See `claimQuantityAgrees`.
   */
  containers: number | null;
};

export type PackSizeRead = { ok: true; pack: PackSize } | { ok: false; why: string };

/** What this file needs off a `drug_directory` row, and nothing else. */
export type DirectoryPack = {
  packageDescription: string | null | undefined;
  /** The FDA's dosage form. The column that decides whether a measure is the unit or the content. */
  form: string | null | undefined;
};

/** The noun with the FDA's qualifier after the comma taken off: "TABLET, DELAYED RELEASE" is a tablet. */
function headNoun(noun: string): string {
  return (noun.split(",")[0] ?? "").trim();
}

/**
 * A volume or a mass, to millilitres or grams.
 *
 * Micrograms are deliberately absent. A package stated in micrograms converted to grams gives a
 * number like 0.0002, and every per-unit cost divided by it is astronomical; nothing in this
 * pharmacy's data is packaged that way, and the one place it could arrive is better refused.
 */
function measureOf(noun: string): { unit: DispensingUnit; factor: number } | null {
  const n = headNoun(noun).toLowerCase();
  if (!n) return null;
  if (/^(ml|milliliters?|millilitres?)$/.test(n)) return { unit: "ML", factor: 1 };
  if (/^(l|liters?|litres?)$/.test(n)) return { unit: "ML", factor: 1000 };
  if (/^(g|gm|grams?)$/.test(n)) return { unit: "GM", factor: 1 };
  if (/^(kg|kilograms?)$/.test(n)) return { unit: "GM", factor: 1000 };
  if (/^(mg|milligrams?)$/.test(n)) return { unit: "GM", factor: 0.001 };
  return null;
}

/**
 * A length of time, which is not a thing that can be counted.
 *
 * The FDA states how long a patch is worn as though it were package contents: "3.5 d in 1 PATCH".
 * Reading that as a count once turned four patches into six hundred and seventy-two.
 */
const DURATION = /^(h|hr|hour|d|day|wk|week|min|sec)s?$/i;

/**
 * Nouns that are an actuation rather than a thing, and the reason a metered product is refused.
 *
 * An inhaler's description counts the doses the device can deliver — "200 AEROSOL, METERED in 1
 * CANISTER". A claim for it is in grams: 8.5 for albuterol HFA, 10.2 for Symbicort, 10.7 for
 * Breztri. That weight is the canister's net fill, and the FDA package description does not state
 * it at any level. There is no arithmetic from one to the other, so there is no answer here — only
 * a number that would look like one.
 */
const ACTUATION = /^(aerosol|spray|powder|inhalant|actuation|puff|metered)$/i;

/**
 * Outer packaging a pharmacy opens and throws away.
 *
 * Where one of these is the innermost level the FDA has stopped short of saying what is inside, and
 * the count is a count of boxes. Kept in step with the same list in `data-health-packages.ts`,
 * which refuses for the same reason.
 */
const CONTAINERS =
  /^(carton|box|case|blister\s*(pack|card)?|package|packet|tray|container|shipper|drum|dispenser\s*pack|bottle|jar|can|pail|bucket|bag|pouch|kit|cup|vial|syringe|ampule|ampoule|pen|cartridge|tube|inhaler|applicator|dropper|dewar|cylinder|jug)s?$/i;

/**
 * How a dosage form is billed: per unit, or per volume or mass.
 *
 * Read off the FDA's `form` column rather than guessed from the description, because the description
 * cannot say. This is the disambiguator the standing brief pointed at, and it is the difference
 * between 30 lidocaine patches and 21 grams of lidocaine.
 */
function formBilling(form: string | null | undefined): "each" | "measure" | "refuse" | null {
  const f = String(form ?? "").trim().toUpperCase();
  if (!f) return null;

  /*
   * A kit is refused on the form as well as on the "*" in its description, because the commonest
   * kit in this pharmacy's data carries neither: an oral contraceptive is "3 BLISTER PACK in 1
   * CARTON / 1 KIT in 1 BLISTER PACK", which parses perfectly and means nothing. The claim says 84.
   */
  if (f === "KIT" || f.startsWith("KIT")) return "refuse";
  /* Medical gas is sold by the cylinder and billed by nothing this site handles. */
  if (f === "GAS" || f.startsWith("GAS")) return "refuse";
  /* A lyophilised powder for injection is billed per vial by some payers and per mL by others. */
  if (/^INJECTION,\s*POWDER/.test(f)) return "refuse";

  /*
   * Discrete forms: the claim counts them. Matched on the head word, so every "TABLET, FILM COATED,
   * EXTENDED RELEASE" variant is a tablet without the list having to name all forty of them.
   */
  const head = headNoun(f);
  if (
    /^(TABLET|CAPSULE|PATCH|FILM|LOZENGE|TROCHE|SUPPOSITORY|INSERT|IMPLANT|RING|WAFER|GUM|PELLET|GRANULE|STICK|SPONGE|CLOTH|SWAB|TAMPON|TAPE|BAR|PLASTER|SYSTEM|DISC|PASTILLE)$/.test(
      head,
    )
  ) {
    return "each";
  }

  /*
   * Bulk forms: the claim counts millilitres or grams. POWDER is here rather than refused because
   * the form covers two quite different products — nystatin powder in a 60 g bottle, which is
   * grams, and Trelegy's dry-powder inhaler, which is actuations. The description tells them apart:
   * the inhaler's innermost noun is an actuation and is refused below on the noun, not the form.
   */
  if (
    /^(SOLUTION|SUSPENSION|LIQUID|SYRUP|ELIXIR|TINCTURE|CREAM|OINTMENT|GEL|JELLY|LOTION|EMULSION|SHAMPOO|SOAP|PASTE|OIL|RINSE|ENEMA|DOUCHE|IRRIGANT|FOAM|INJECTION|CONCENTRATE|POWDER|COLLODION|SALVE|SPIRIT|SUSPENSION\/ DROPS|SOLUTION\/ DROPS)$/.test(
      head,
    )
  ) {
    return "measure";
  }

  /*
   * An aerosol or a spray, where the description did not already settle it. Refused rather than
   * treated as a measure: these are the products whose billing quantity is a net fill weight that
   * appears nowhere in the FDA's text.
   */
  if (/^(AEROSOL|SPRAY|INHALANT|POWDER, METERED)$/.test(head) || f.includes("METERED")) {
    /*
     * Except where the description states a real mass or volume in a real container, which is the
     * testosterone gel pump: "1 BOTTLE, PUMP in 1 CARTON / 88 g in 1 BOTTLE, PUMP", form
     * "GEL, METERED", billed in grams. The measure is there to be read, so the "METERED" qualifier
     * is not on its own a reason to refuse. Decided by the caller below, which has the levels.
     */
    return head === "GEL" || head === "CREAM" || head === "OINTMENT" ? "measure" : "refuse";
  }

  return null;
}

/**
 * How many dispensing units are in one package of this NDC, and what unit they are.
 *
 * Refuses, with the reason in words, wherever the answer cannot be had. See the file header for the
 * two live cases where a plausible number would have been wrong by 23.5× and 28×.
 */
export function dispensingPack(row: DirectoryPack): PackSizeRead {
  const text = String(row.packageDescription ?? "").trim();
  if (!text) return { ok: false, why: "The FDA gives no package description for this NDC." };

  /*
   * "*" separates a kit's components rather than nesting them — a glucagon emergency kit is a vial
   * and a syringe, and neither is "the" dispensing unit.
   */
  if (text.includes("*")) {
    return { ok: false, why: "A kit: several different components in one package, with no single dispensing unit." };
  }

  const levels = fdaPackageLevels(text);
  if (levels === null || levels.length === 0) {
    return { ok: false, why: `The FDA package description does not read as package levels: "${text.slice(0, 70)}".` };
  }

  const billing = formBilling(row.form);
  if (billing === null) {
    return {
      ok: false,
      why: `The FDA dosage form "${String(row.form ?? "").trim() || "(blank)"}" is not one this can say a billing unit for, so how many units are in the pack cannot be settled.`,
    };
  }
  if (billing === "refuse") {
    return {
      ok: false,
      why: `A "${String(row.form).trim()}" is not billed in a unit the FDA package description states. ${whyRefused(String(row.form).trim())}`,
    };
  }

  /* Any level naming an actuation makes the whole reading an actuation count. See ACTUATION. */
  const metered = levels.find((l) => ACTUATION.test(headNoun(l.noun)));
  if (metered) {
    return {
      ok: false,
      why:
        `The description counts ${metered.count} ${metered.noun} — doses the device delivers, not a quantity anybody bills. ` +
        `A claim for a metered product is in grams or millilitres of net fill, which the FDA does not state at any level.`,
    };
  }

  /* A level naming a kit, inside a description that otherwise parses. The contraceptive case. */
  const kit = levels.find((l) => /^kit$/i.test(headNoun(l.noun)));
  if (kit) {
    return {
      ok: false,
      why: `The description stops at "${kit.noun}" and never says what is in it, so the only number available is a count of kits.`,
    };
  }

  return billing === "each" ? asEach(levels) : asMeasure(levels);
}

/** Why a form was refused, said plainly, because the caller has to print something. */
function whyRefused(form: string): string {
  const f = form.toUpperCase();
  if (f.startsWith("KIT")) return "Its components are different products and the claim counts something the description never names.";
  if (f.startsWith("GAS")) return "Medical gas is not dispensed in units this site prices.";
  if (/^INJECTION,\s*POWDER/.test(f)) return "A powder for reconstitution is billed per vial by some payers and per millilitre by others.";
  return "Its billing quantity is a net fill weight or volume that appears nowhere in the FDA's text.";
}

/**
 * A discrete dosage form: the product of every level's count, skipping any measure or duration.
 *
 * Skipping rather than multiplying is the correction. A patch's description states the drug's mass
 * and its wear time as though they were package contents, and both are properties of one patch:
 * "30 POUCH in 1 CARTON / .7 g in 1 POUCH" is thirty patches, and the pharmacy's claim for that NDC
 * says 30. Multiplying gave 21.
 */
function asEach(levels: PackLevel[]): PackSizeRead {
  let units = 1;
  const counted: string[] = [];
  let skipped: string | null = null;
  for (const l of levels) {
    const noun = headNoun(l.noun);
    if (measureOf(l.noun) !== null || DURATION.test(noun)) {
      /* The bottom of the nest: what one unit contains, or how long it lasts. Not a count. */
      skipped = `${l.count} ${l.noun}`;
      continue;
    }
    units *= l.count;
    counted.push(`${l.count} ${l.noun}`);
  }

  /*
   * Where the innermost level is outer packaging and nothing states what is inside it, the product
   * is a count of boxes. Three blister packs is not three tablets — against a catalogue saying 84
   * it is a 28-fold error, and it is the shape the oral contraceptives take.
   *
   * A description that reached a measure or a duration did reach the bottom, so the level above it
   * is the per-dose container and its count is the dose count. That is the patch case, and it is
   * the difference between refusing correctly and refusing everything.
   */
  const innermost = levels[levels.length - 1];
  if (skipped === null && CONTAINERS.test(headNoun(innermost.noun))) {
    return {
      ok: false,
      why: `The description stops at "${innermost.noun}" and never says what is inside, so ${units} is a count of containers rather than of dispensing units.`,
    };
  }

  /*
   * Where every level was skipped there is nothing left to be a count, and the 1 this would
   * otherwise return is not a pack size — it is an empty product.
   *
   * A real case, and a silent one: NDC 72603021301 dexamethasone 0.75 mg is described as
   * "100 mg in 1 BOTTLE" and its form is TABLET. That is the FDA stating the bottle's total drug
   * mass where every other row of the file states a tablet count. Skipping the milligrams is right
   * — a solid dose is not billed by mass — but it leaves no counted level at all, and answering
   * "1 EA" made a bottle of tablets look like one tablet. The claim for it is 10, which divides by
   * 1 perfectly and confirmed a hundred-fold error.
   */
  if (counted.length === 0) {
    return {
      ok: false,
      why:
        `The description states only "${skipped}", which is what the package holds rather than how many units are in it. ` +
        `A ${innermost.noun} count is never stated, so the number of dispensing units cannot be had.`,
    };
  }

  if (!Number.isFinite(units) || units <= 0 || units > 1_000_000) {
    return { ok: false, why: `${units} units is not a package any pharmacy receives.` };
  }
  return {
    ok: true,
    pack: {
      units: Math.round(units * 1000) / 1000,
      unit: "EA",
      source:
        `FDA package: ${counted.join(" x ")}` +
        (skipped ? ` (the "${skipped}" is what one holds, not a count)` : "") +
        `, billed each`,
      containers: null,
    },
  };
}

/**
 * A bulk form: every level's count multiplied, in the unit of the innermost measure.
 *
 * Wegovy is the case worth naming. "4 SYRINGE, PLASTIC in 1 CARTON / .5 mL in 1 SYRINGE, PLASTIC"
 * is 4 x 0.5 = 2 millilitres, and the claim quantity is 2. Every previous copy read the 4.
 */
function asMeasure(levels: PackLevel[]): PackSizeRead {
  const innermost = levels[levels.length - 1];
  const measure = measureOf(innermost.noun);
  if (measure === null) {
    return {
      ok: false,
      why:
        `This is a bulk form billed by volume or mass, and the description's innermost level is "${innermost.noun}" — ` +
        `it never states a volume or a mass, so there is nothing to bill against.`,
    };
  }

  const outer = levels.slice(0, -1);
  const containers = outer.reduce((n, l) => n * l.count, 1);
  const units = containers * innermost.count * measure.factor;
  if (!Number.isFinite(units) || units <= 0 || units > 1_000_000) {
    return { ok: false, why: `${units} ${measure.unit} is not a package any pharmacy receives.` };
  }

  const chain = [...outer.map((l) => `${l.count} ${l.noun}`), `${innermost.count} ${innermost.noun}`].join(" x ");
  return {
    ok: true,
    pack: {
      units: Math.round(units * 1000) / 1000,
      unit: measure.unit,
      source: `FDA package: ${chain} = ${Math.round(units * 1000) / 1000} ${measure.unit}`,
      containers: outer.length > 0 ? containers : null,
    },
  };
}

/**
 * Whether a claim's quantity is expressed in the same unit as the pack, and how many packages it is.
 *
 * This is the check the four old copies did not have, and the reason they could not have had it:
 * `claims.quantity_unit` is null on every row this pharmacy has ever imported, so there is nothing
 * to compare a unit against. What there is instead is arithmetic. A quantity in the pack's own unit
 * is either a whole number of packages or less than one package; a quantity in some *other* unit is
 * neither, and says so by not dividing.
 *
 *   "confirmed"     — whole packages, or a partial of a single package. A 30-count off a bottle of
 *                     100 is the commonest line in the pharmacy and is not a problem.
 *   "container"     — the unit-dose trap, and the one case where a number divides and is still
 *                     wrong. A tray of 60 single-use vials of 0.4 mL is 24 mL and is also 60
 *                     things; a claim quantity of 60 means the second, so the volume reading is
 *                     refused for that claim rather than quietly dividing 2.5 packages.
 *   "unconfirmed"   — more than one package and not a whole number of them. Usually legitimate — 56
 *                     buprenorphine films come out of 30-film cartons — but it cannot be *proved*
 *                     to be in the pack's unit, so anything going to a PBM must not rest on it.
 *
 * The distinction matters because a caller putting a figure in front of a payer needs "confirmed",
 * and a caller totalling the month's margin can live with "unconfirmed" as long as it says so.
 */
export type QuantityAgreement =
  | { agrees: true; packages: number; exact: boolean }
  | { agrees: false; why: string; kind: "container" | "unconfirmed" };

/** How close to a whole number of packages counts as a whole number. */
const WHOLE = 0.001;

export function claimQuantityAgrees(pack: PackSize, quantityThousandths: number | null | undefined): QuantityAgreement {
  const quantity = Number(quantityThousandths ?? 0) / 1000;
  if (!Number.isFinite(quantity) || quantity === 0) {
    return { agrees: false, why: "The claim carries no quantity.", kind: "unconfirmed" };
  }
  /*
   * A reversal is the same fill with the sign turned round, and the unit question is identical.
   * Judging it on the magnitude keeps a credited claim from reading as an unreadable one.
   */
  const q = Math.abs(quantity);
  const packages = q / pack.units;

  if (Math.abs(packages - Math.round(packages)) < WHOLE) return { agrees: true, packages: Math.round(packages), exact: true };
  if (packages < 1) return { agrees: true, packages, exact: false };

  /*
   * The unit-dose trap. Where the package is N containers holding a measure each and the claim's
   * quantity is the container count rather than the measure, the claim is counting vials.
   */
  if (pack.containers !== null && pack.containers > 1) {
    const asContainers = q / pack.containers;
    if (Math.abs(asContainers - Math.round(asContainers)) < WHOLE) {
      return {
        agrees: false,
        kind: "container",
        why:
          `The claim's quantity of ${q} matches the ${pack.containers} containers in the package rather than the ` +
          `${pack.units} ${pack.unit} in them, so the claim is counting containers and a cost per ${pack.unit} would be ` +
          `${Math.round((q / pack.units) * 100) / 100} times wrong.`,
      };
    }
  }

  return {
    agrees: false,
    kind: "unconfirmed",
    why:
      `The claim's quantity of ${q} is ${Math.round(packages * 100) / 100} packages of ${pack.units} ${pack.unit}, ` +
      `which is neither a whole number of packages nor part of one — so it cannot be shown to be in ${pack.unit} at all.`,
  };
}

/**
 * The cost of one dispensing unit, in micros, from the price of one package.
 *
 * The division itself lives here so that it is done one way. This is the arithmetic that printed
 * "$245.98 per tablet" for a methylphenidate, and the fault was never the division — it was the
 * number underneath it.
 */
export function costPerUnitMicros(packPriceCents: number, pack: PackSize): number {
  return Math.round((packPriceCents * 10_000) / pack.units);
}

/**
 * The whole question in one call: the pack, and whether this claim's quantity is in its unit.
 *
 * What nearly every caller actually wants, because a pack size with no check on the claim is how
 * all four of the old copies were wrong. Refuses as one thing, with one reason, so a caller cannot
 * accidentally use a good pack size against a quantity measured in something else.
 */
export function packForClaim(
  row: DirectoryPack,
  quantityThousandths: number | null | undefined,
  /** Where an unproven partial across several packages is good enough. Never for a payer. */
  allowUnconfirmed = false,
): { ok: true; pack: PackSize; packages: number; exact: boolean } | { ok: false; why: string } {
  const read = dispensingPack(row);
  if (!read.ok) return read;
  const agreement = claimQuantityAgrees(read.pack, quantityThousandths);
  if (!agreement.agrees) {
    if (agreement.kind === "unconfirmed" && allowUnconfirmed) {
      return { ok: true, pack: read.pack, packages: Math.abs(Number(quantityThousandths ?? 0) / 1000) / read.pack.units, exact: false };
    }
    return { ok: false, why: agreement.why };
  }
  return { ok: true, pack: read.pack, packages: agreement.packages, exact: agreement.exact };
}
