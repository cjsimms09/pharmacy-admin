/**
 * How many dispensing units are in a pack, read from the FDA and from a wholesaler, and compared.
 *
 * This is the arithmetic behind one row of the data health page — "catalogue row → FDA package
 * size" — and the reason that row is worth having is a money error rather than a tidiness one. A
 * per-unit cost is the pack cost over the units in the pack, so a pack size wrong by a factor of
 * six makes the drug look six times cheaper than it is, and the buy list recommends it. Measured
 * against the levelled catalogue, about 95% agree, 0.5–1% differ by a whole multiple, and 2.5%
 * differ in the unit itself.
 *
 * ── Why this does not use packageUnits() from drug-directory.ts ──
 *
 * That function ends by treating any alphabetic noun as a countable unit: "Everything the FDA
 * counts rather than measures: TABLET, CAPSULE, PATCH, SYRINGE, VIAL…". Containers are alphabetic
 * nouns too. So "3 BLISTER PACK in 1 CARTON", where the FDA never states what is in the blister
 * pack, reads as three dispensing units — and against a catalogue that says 84 tablets it looks
 * like a disagreement of 28×. It is not a disagreement; it is a description that does not reach a
 * dispensing unit, and the honest answer is that the two cannot be compared.
 *
 * The distinction matters because this row is the one that finds cross-unit errors. A reader that
 * turns "cannot tell" into a number would manufacture exactly the false alarms the row exists to
 * catch, and bury the real ones among them. So a description whose innermost noun is a container
 * is refused with the reason, and refusals are counted and shown rather than scored.
 *
 * Pure. `data-health-store.ts` feeds it rows.
 */

/** A pack size that could be read, or the reason it could not. */
export type PackRead =
  | { ok: true; units: number; uom: "EA" | "ML" | "GM" }
  | { ok: false; why: string };

/**
 * Nouns that hold a dispensing unit rather than being one.
 *
 * A carton of blister packs is not three of anything a pharmacist hands over. Where one of these
 * is the innermost noun the FDA has not said what is inside, and no unit count exists to compare.
 *
 * Deliberately conservative: VIAL, SYRINGE, TUBE, AMPULE and the like are left off, because those
 * genuinely are dispensed one at a time and every file in this site counts them that way. The list
 * holds only the outer packaging a pharmacy opens and throws away.
 */
const CONTAINERS =
  /^(carton|box|case|blister\s*(pack|card)?|package|packet|tray|container|shipper|drum|dispenser\s*pack|bottle|jar|can|pail|bucket|bag|pouch|kit|cup)s?$/i;

/**
 * The noun itself, with the FDA's qualifier after the comma taken off.
 *
 * The directory writes "BOTTLE, PLASTIC", "VIAL, SINGLE-USE", "SYRINGE, PLASTIC", "TABLET, DELAYED
 * RELEASE". Every list in this file names the thing, not the thing plus an adjective, so a
 * qualifier used to defeat the match: "3 BOTTLE, PLASTIC in 1 CARTON" read as three dispensing
 * units and returned a per-unit cost three times too cheap — the exact container fault this module
 * was written to stop, walking back in behind a comma.
 *
 * The qualifier is never the unit. "TABLET, DELAYED RELEASE" is a tablet and "VIAL, MULTI-DOSE" is
 * a vial, so taking the head noun is right for the measures as well as for the containers.
 */
function headNoun(noun: string): string {
  return (noun.split(",")[0] ?? "").trim();
}

/** A duration is not a thing. Reading one as a count turned four patches into six hundred and seventy-two. */
const DURATION = /^(h|hr|hour|d|day|wk|week|min|sec)s?\b/i;

/**
 * The measure a noun denotes, where it denotes one.
 *
 * Volumes and masses keep their own unit and are converted to millilitres and grams; anything the
 * FDA counts is EA. A noun this does not recognise at all is refused rather than assumed to be
 * countable, which is the difference between this and `packageUnits`.
 */
function measureOf(noun: string): { uom: "EA" | "ML" | "GM"; factor: number } | null {
  const n = headNoun(noun).toLowerCase();
  if (!n) return null;
  if (DURATION.test(n)) return null;
  if (/^ml$|^milliliter|^millilitre/.test(n)) return { uom: "ML", factor: 1 };
  if (/^l$|^liter|^litre/.test(n)) return { uom: "ML", factor: 1000 };
  if (/^g$|^gm$|^gram/.test(n)) return { uom: "GM", factor: 1 };
  if (/^kg$|^kilogram/.test(n)) return { uom: "GM", factor: 1000 };
  if (/^mg$|^milligram/.test(n)) return { uom: "GM", factor: 0.001 };
  if (/^mcg$|^ug$|^microgram/.test(n)) return { uom: "GM", factor: 0.000001 };
  if (CONTAINERS.test(n)) return null;
  // A dosage form: TABLET, CAPSULE, PATCH, SYRINGE, VIAL, SUPPOSITORY, LOZENGE…
  if (/^[a-z][a-z ,()\-.]*$/i.test(n)) return { uom: "EA", factor: 1 };
  return null;
}

/**
 * The units in an FDA package description, read down to the innermost dispensing unit.
 *
 * The FDA nests its packaging with slashes, outermost first:
 *
 *   3 BLISTER PACK in 1 CARTON (0555-9043-58) / 28 TABLET in 1 BLISTER PACK   → 84 EA
 *   1 BOTTLE in 1 CARTON (0069-0069-01) / 30 mL in 1 BOTTLE                   → 30 ML
 *   100 CAPSULE in 1 BOTTLE (0093-0073-01)                                    → 100 EA
 *
 * Every level's count multiplies and the innermost noun gives the unit. Where the innermost noun is
 * a container the description stops short of a dispensing unit and this refuses, because the count
 * it would otherwise return is a count of boxes.
 */
export function fdaPackageUnits(packageDescription: string | null | undefined): PackRead {
  const text = (packageDescription ?? "").trim();
  if (!text) return { ok: false, why: "The FDA gives no package description." };

  /*
   * A kit is not one package of one thing. "*" separates a kit's components — a starter pack of
   * two strengths, fifty different remedies in a box — and there is no single dispensing unit to
   * state. Inventing one would put a wrong number exactly where the FDA is meant to be the party
   * nobody argues with.
   */
  if (text.includes("*")) return { ok: false, why: "A kit: several different components in one package, with no single dispensing unit." };

  const levels = text.split("/").map((s) => s.trim()).filter(Boolean);
  if (levels.length === 0) return { ok: false, why: "The FDA package description is empty." };

  let product = 1;
  let innermost = "";
  for (const level of levels) {
    const m = /^(\d*\.?\d+)\s+(.+?)\s+in\s+1\s+/i.exec(level);
    if (!m) return { ok: false, why: `Could not read the level "${level.slice(0, 60)}".` };
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, why: `"${m[1]}" is not a package count.` };
    product *= n;
    innermost = m[2].trim();
  }

  if (CONTAINERS.test(headNoun(innermost))) {
    return {
      ok: false,
      why: `The description stops at "${innermost}" and never says what is inside it, so ${product} is a count of containers rather than of dispensing units.`,
    };
  }
  const measure = measureOf(innermost);
  if (measure === null) return { ok: false, why: `"${innermost}" is not a dispensing unit.` };

  const units = product * measure.factor;
  if (!Number.isFinite(units) || units <= 0 || units > 1_000_000) {
    return { ok: false, why: `${units} units is not a package any pharmacy receives.` };
  }
  return { ok: true, units: Math.round(units * 1000) / 1000, uom: measure.uom };
}

/** One "N NOUN in 1 CONTAINER" level of an FDA description, outermost first. */
export type PackLevel = { count: number; noun: string };

/**
 * The FDA's description broken into its levels, without judging them.
 *
 * `fdaPackageUnits` multiplies the levels out and throws the structure away, which is right for a
 * total and useless for the question "how many containers, holding how much each". A single-dose
 * vial is exactly that question: McKesson counts one vial, the FDA states twenty millilitres, and
 * both are describing the same box truthfully.
 */
export function fdaPackageLevels(packageDescription: string | null | undefined): PackLevel[] | null {
  const text = (packageDescription ?? "").trim();
  if (!text || text.includes("*")) return null;
  const levels: PackLevel[] = [];
  for (const level of text.split("/").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d*\.?\d+)\s+(.+?)\s+in\s+1\s+/i.exec(level);
    if (!m) return null;
    const count = Number(m[1]);
    if (!Number.isFinite(count) || count <= 0) return null;
    levels.push({ count, noun: m[2].trim() });
  }
  return levels.length > 0 ? levels : null;
}

/**
 * Containers a pharmacy dispenses one at a time, as opposed to outer packaging it throws away.
 *
 * Deliberately separate from `CONTAINERS`, which is the list that stops a reading. A vial is a real
 * thing a wholesaler can count; a carton is not something anybody dispenses. The two lists answer
 * different questions and must not be merged.
 */
const DISPENSED_CONTAINERS = /^(vial|syringe|ampule|ampoule|pen|cartridge|tube|bottle|inhaler|applicator|dropper)s?$/i;

/**
 * A package stated as N containers with a volume or a mass in each.
 *
 * Null where the description is not that shape. The count of containers is what a wholesaler
 * counting "1 EA" is counting, and the total is what the FDA and every per-millilitre benchmark
 * mean by the same package.
 */
export function fdaContainerContents(
  packageDescription: string | null | undefined,
): { containers: number; containerNoun: string; units: number; uom: "ML" | "GM" } | null {
  const levels = fdaPackageLevels(packageDescription);
  if (!levels || levels.length < 2) return null;

  const inner = levels[levels.length - 1];
  const measure = measureOf(inner.noun);
  // The innermost has to be a volume or a mass. A count of tablets is not this shape.
  if (measure === null || measure.uom === "EA") return null;

  const outer = levels.slice(0, -1);
  // Every outer level must be a container somebody dispenses, not a carton or a case.
  if (!outer.every((l) => DISPENSED_CONTAINERS.test(headNoun(l.noun)))) return null;

  const containers = outer.reduce((n, l) => n * l.count, 1);
  const units = containers * inner.count * measure.factor;
  if (!Number.isFinite(units) || units <= 0 || units > 1_000_000) return null;
  return {
    containers,
    containerNoun: outer[outer.length - 1].noun,
    units: Math.round(units * 1000) / 1000,
    uom: measure.uom,
  };
}

/**
 * Why a description is not "N containers with a volume in each", in words.
 *
 * `fdaContainerContents` returns null for four quite different reasons and the difference matters:
 * two thousand NDCs that are "not this shape" is a number nobody can act on, where "1,400 of them
 * are a single level counting tablets" is a finding. Named rather than guessed at, because guessing
 * at the shape of the bulk is what produced a rule that only reached 309 of them.
 */
export function containerShape(packageDescription: string | null | undefined): string {
  const text = (packageDescription ?? "").trim();
  if (!text) return "no FDA package description";
  if (text.includes("*")) return "a kit: several components, no single dispensing unit";
  const levels = fdaPackageLevels(text);
  if (levels === null) return "the description does not parse as levels";
  if (levels.length < 2) {
    const m = measureOf(levels[0].noun);
    if (m === null) return `one level only, innermost "${levels[0].noun}" is not a unit this reads`;
    return m.uom === "EA"
      ? `one level only, counting ${levels[0].noun} — a count, not a measure`
      : `one level only, already measured in ${m.uom}`;
  }
  const inner = levels[levels.length - 1];
  const measure = measureOf(inner.noun);
  if (measure === null) return `innermost "${inner.noun}" is not a dispensing unit`;
  if (measure.uom === "EA") return `innermost "${inner.noun}" is counted, not measured`;
  const outer = levels.slice(0, -1);
  const notDispensed = outer.filter((l) => !DISPENSED_CONTAINERS.test(headNoun(l.noun)));
  if (notDispensed.length > 0) return `outer "${notDispensed[0].noun}" is packaging, not a container anybody dispenses`;
  return "containers with a volume or a mass in each — this rule's own shape";
}

/**
 * The units in a wholesaler's pack size, as the catalogues write it.
 *
 * The shapes that actually appear: "84 EA", "30 EA", "473 ML", and McKesson's "(3) 28 EA" — three
 * inner packs of twenty-eight, which is eighty-four and not three and not twenty-eight. That form
 * has already caused a real fault: McKesson's "(3) 28 EA" priced against IPD's "84 EA" made one of
 * them look like a third of the other.
 */
export function cataloguePackUnits(packSize: string | null | undefined): PackRead {
  const text = (packSize ?? "").trim();
  if (!text) return { ok: false, why: "The catalogue row carries no pack size." };

  // "(3) 28 EA" — an outer multiplier in brackets before the inner count.
  const outer = /^\(\s*(\d*\.?\d+)\s*\)\s*(.+)$/.exec(text);
  const multiplier = outer ? Number(outer[1]) : 1;
  const rest = outer ? outer[2].trim() : text;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return { ok: false, why: `"${text}" has an unreadable inner-pack count.` };

  const m = /^(\d*\.?\d+)\s*([A-Za-z]+)?/.exec(rest);
  if (!m) return { ok: false, why: `"${text}" is not a pack size.` };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, why: `"${text}" has no positive quantity.` };

  const uom = uomOf(m[2] ?? "EA");
  if (uom === null) return { ok: false, why: `"${m[2]}" is not a unit this can compare.` };

  const units = n * multiplier;
  if (units > 1_000_000) return { ok: false, why: `${units} units is not a package any pharmacy receives.` };
  return { ok: true, units: Math.round(units * 1000) / 1000, uom };
}

/** The wholesalers' unit codes. Anything else is refused rather than guessed at. */
function uomOf(raw: string): "EA" | "ML" | "GM" | null {
  const u = raw.trim().toUpperCase();
  if (u === "" || u === "EA" || u === "EACH" || u === "CT" || u === "TAB" || u === "CAP" || u === "UN") return "EA";
  if (u === "ML" || u === "MLS" || u === "CC") return "ML";
  if (u === "GM" || u === "G" || u === "GR" || u === "GRAM") return "GM";
  return null;
}

export type PackVerdict =
  /** The two agree, and a per-unit cost from either is the same figure. */
  | { verdict: "agree"; units: number; uom: string }
  /**
   * One is a whole multiple of the other: the blister case, and the expensive one.
   *
   * IPD says "30 EA" where the FDA says 180 — thirty blister packs of six — and a per-unit cost
   * taken from the catalogue is six times too high, or the buy is six times too cheap depending
   * which way round it is read.
   */
  | { verdict: "multiple"; factor: number; catalogue: number; fda: number; uom: string }
  /** Counted in different things entirely: grams against tablets. Never comparable per unit. */
  | { verdict: "unit-differs"; catalogue: string; fda: string }
  /** Both readable, neither agreeing nor a clean multiple. */
  | { verdict: "differs"; catalogue: number; fda: number; uom: string }
  /** One side could not be read. Not a disagreement, and must never be counted as one. */
  | { verdict: "cannot-compare"; why: string };

/**
 * Whether a catalogue row's pack size and the FDA's agree.
 *
 * "cannot-compare" is a first-class answer and the reason this returns a verdict rather than a
 * boolean. Roughly one row in sixty has an FDA description that never reaches a dispensing unit,
 * and scoring those as disagreements would put a false alarm beside every real one — which on a
 * page built to find cross-unit errors is the worst possible outcome.
 */
export function comparePack(packSize: string | null | undefined, packageDescription: string | null | undefined): PackVerdict {
  const cat = cataloguePackUnits(packSize);
  if (!cat.ok) return { verdict: "cannot-compare", why: cat.why };
  const fda = fdaPackageUnits(packageDescription);
  if (!fda.ok) return { verdict: "cannot-compare", why: fda.why };

  if (cat.uom !== fda.uom) return { verdict: "unit-differs", catalogue: `${cat.units} ${cat.uom}`, fda: `${fda.units} ${fda.uom}` };
  if (cat.units === fda.units) return { verdict: "agree", units: cat.units, uom: cat.uom };

  const big = Math.max(cat.units, fda.units);
  const small = Math.min(cat.units, fda.units);
  const factor = big / small;
  // A whole multiple within a hair's breadth, and more than one: the nested-pack case.
  if (factor > 1 && Math.abs(factor - Math.round(factor)) < 0.001) {
    return { verdict: "multiple", factor: Math.round(factor), catalogue: cat.units, fda: fda.units, uom: cat.uom };
  }
  return { verdict: "differs", catalogue: cat.units, fda: fda.units, uom: cat.uom };
}
