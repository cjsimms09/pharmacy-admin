/**
 * What is wrong with a catalogue row, decided by arithmetic rather than by eye.
 *
 * Forty-five thousand items arrive every week and nobody reads them. The ones that matter are the
 * ones that will quietly produce a wrong answer somewhere else: a pack size that cannot be read
 * turns "order 140 units" into nothing at all, a pack cost that does not match its own unit cost
 * means one of the two is a misread column, and a price that is a hundred times NADAC is almost
 * always a pack price filed as a unit price.
 *
 * Every check here is a statement about the row's own numbers, or about the row against a
 * benchmark. None of them is a matter of taste, and each one names what to do about it — because a
 * list of complaints nobody can act on is a list nobody opens twice.
 *
 * ── What is deliberately not flagged ──
 *
 * A dear drug is not a problem. Bortezomib at $1,058.85 a vial is what bortezomib costs, and a
 * check that flagged expensive things would bury the twelve rows that are actually broken under a
 * thousand that are not. The only price checks here are ones with a second opinion behind them:
 * the row disagreeing with itself, or the row disagreeing with NADAC by a factor rather than a
 * margin.
 */

export type CatalogueItem = {
  ndc11: string;
  supplier: string;
  description: string | null;
  packSize: string | null;
  unitCostMicros: number | null;
  packCostCents: number | null;
  awpCents: number | null;
  contractFlag: string | null;
};

export type ProblemKind =
  | "pack_size_unreadable"
  | "pack_cost_disagrees"
  | "price_far_from_nadac"
  | "nadac_unit_differs"
  | "awp_below_cost"
  | "no_price";

export type Problem = {
  kind: ProblemKind;
  /** What is wrong, with the figures in it. */
  says: string;
  /** What to do about it. */
  todo: string;
  /** How sure this is: "wrong" is arithmetic, "check" wants a person's eye. */
  level: "wrong" | "check";
  /**
   * What being wrong about this row is worth, in cents, for ordering a list by what to open first.
   *
   * A pack that costs three thousand dollars and is a penny out is not the row to spend a morning
   * on; a pack that costs eighty and is out by forty is. Sorting by the size of the pack put the
   * dear ones on top whatever was wrong with them, which is how a list of a thousand rows gets
   * opened once and never again.
   */
  costCents: number;
};

/** Units in a stored pack size: "30 EA" is thirty, "(10) 100 EA" is a hundred. */
export function packUnits(packSize: string | null): number | null {
  if (!packSize) return null;
  const m = /(?:\(\d+\)\s*)?([\d.]+)\s*(EA|ML|GM)\b/i.exec(packSize);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What the pack is measured in — each, millilitres or grams.
 *
 * Needed because a price per millilitre and a price per each are not comparable numbers, and the
 * benchmark below is published per one of them. Null where the pack size names no unit, which is
 * the only honest answer and is treated as "do not compare".
 */
export function packUom(packSize: string | null): "EA" | "ML" | "GM" | null {
  if (!packSize) return null;
  const m = /(?:\(\d+\)\s*)?[\d.]+\s*(EA|ML|GM)\b/i.exec(packSize);
  return m ? (m[1].toUpperCase() as "EA" | "ML" | "GM") : null;
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const perUnit = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

/**
 * A tenth of a cent, which is what two figures may differ by and still be the same figure.
 *
 * Pack cost is stored in cents and unit cost in millionths, so multiplying one out never lands
 * exactly on the other. The tolerance is the rounding, not a judgement about how close is close
 * enough: anything wider is a genuine disagreement between two columns of the same file.
 */
const ROUNDING_CENTS = 2;

/**
 * How far from NADAC is far enough to be a mistake rather than a bad deal.
 *
 * Three times, or a third. A wholesaler being half as dear as the federal average is a good week;
 * being thirty times dearer is a pack price in a unit column, which is the actual failure this
 * catches. The band is wide on purpose — it is looking for a misplaced decimal or a misread
 * column, not for a negotiating position.
 */
const NADAC_HIGH = 3;
const NADAC_LOW = 1 / 3;

/**
 * How far below cost a list price has to sit before it is worth saying so.
 *
 * On the real McKesson file 1,575 items carry an AWP under what the pack costs, and 176 of them are
 * under one per cent — a stale penny, not a fault, and putting them at the top of the list buried
 * the ones that matter. Both floors have to be cleared: a fifth of a per cent on a three-thousand
 * dollar vial is six dollars and still only rounding, and forty per cent of an eighty cent pack is
 * not worth a morning either.
 */
const AWP_GAP_FRACTION = 0.02;
const AWP_GAP_CENTS = 100;

export function problemsWith(item: CatalogueItem, nadacUnitMicros?: number | null, nadacPricingUnit?: string | null): Problem[] {
  const out: Problem[] = [];
  const units = packUnits(item.packSize);

  if (item.unitCostMicros === null && item.packCostCents === null) {
    out.push({
      kind: "no_price",
      says: "The catalogue lists this item with no price at all.",
      todo: "Nothing can be compared or ordered on it. If the supplier does sell it, the price has to come from somewhere else.",
      level: "check",
      costCents: 0,
    });
    return out; // Everything below is about a price this row does not have.
  }

  if (units === null) {
    out.push({
      kind: "pack_size_unreadable",
      says: `The pack size reads “${item.packSize ?? "(blank)"}”, which gives no number of units.`,
      todo: "Without it a package price cannot be put per unit, so this item is left out of every comparison and every order. Correct the pack size below.",
      level: "wrong",
      costCents: item.packCostCents ?? 0,
    });
  }

  if (units !== null && item.unitCostMicros !== null && item.packCostCents !== null) {
    const implied = Math.round((item.unitCostMicros * units) / 10_000);
    if (Math.abs(implied - item.packCostCents) > ROUNDING_CENTS) {
      out.push({
        kind: "pack_cost_disagrees",
        says: `${perUnit(item.unitCostMicros)} a unit across ${units} units is ${money(implied)}, and the pack cost on the row is ${money(item.packCostCents)}.`,
        todo: "One of the three — unit cost, pack cost, pack size — was read from the wrong column. The pack size is the one to check first, because it is the one a person can verify from the bottle.",
        level: "wrong",
        costCents: Math.abs(implied - item.packCostCents),
      });
    }
  }

  /*
   * The benchmark, and only where the two are counting the same thing.
   *
   * NADAC publishes a price per each, per millilitre or per gram, and says which. A supplier
   * prices whatever its pack size names. Put a per-each cost beside a per-millilitre benchmark and
   * the ratio is out by however many millilitres are in the bottle — hundreds, on a liquid — so the
   * row is reported as a hundred times the national average and the remedy offered ("a pack price
   * sitting in a unit column") sends somebody to check a pack size that was right all along.
   *
   * The site already refuses this comparison when pricing a claim, in as many words:
   * "Pricing across units would be wrong by orders of magnitude" (reimbursement-rules.ts). The
   * same refusal belongs here, where it decides what the purchasing screen calls a fault.
   */
  const mine = packUom(item.packSize);
  const theirs = (nadacPricingUnit ?? "").trim().toUpperCase() || null;
  // Compared unless the two are known to be counting different things. An unknown unit on either
  // side is not evidence of a mismatch, so the benchmark keeps working exactly as it always did.
  const unitsDiffer = mine !== null && theirs !== null && mine !== theirs;
  if (unitsDiffer) {
    // Said out loud rather than passed over: a benchmark that cannot be used is worth knowing about.
    out.push({
      kind: "nadac_unit_differs",
      says: `This is priced per ${mine} and NADAC prices it per ${theirs}, so the two are not comparable.`,
      todo: "No benchmark is applied to this row. If the pack size is wrong, correcting it below brings the benchmark back.",
      level: "check",
      costCents: 0,
    });
  }
  if (!unitsDiffer && item.unitCostMicros !== null && nadacUnitMicros !== null && nadacUnitMicros !== undefined && nadacUnitMicros > 0) {
    const ratio = item.unitCostMicros / nadacUnitMicros;
    if (ratio > NADAC_HIGH || ratio < NADAC_LOW) {
      const times = ratio >= 1 ? `${ratio.toFixed(1)} times` : `${(1 / ratio).toFixed(1)} times under`;
      out.push({
        kind: "price_far_from_nadac",
        says: `${perUnit(item.unitCostMicros)} a unit against NADAC's ${perUnit(nadacUnitMicros)} — ${times} the national average.`,
        todo:
          ratio > NADAC_HIGH
            ? "A price this far above the benchmark is usually a pack price sitting in a unit column, which makes the pack size wrong too. Check both against the bottle."
            : "A price this far below the benchmark is usually a unit price sitting in a pack column. Check the pack size against the bottle.",
        level: "check",
        costCents: Math.round((Math.abs(item.unitCostMicros - nadacUnitMicros) * (units ?? 1)) / 10_000),
      });
    }
  }

  if (item.awpCents !== null && item.packCostCents !== null && item.awpCents > 0 && item.awpCents < item.packCostCents) {
    const gap = item.packCostCents - item.awpCents;
    if (gap >= AWP_GAP_CENTS && gap / item.packCostCents >= AWP_GAP_FRACTION) {
      out.push({
        kind: "awp_below_cost",
        says: `AWP is ${money(item.awpCents)} and the pack costs ${money(item.packCostCents)} — the list price is ${money(gap)} below what it is being bought at.`,
        todo: "Either the cost is wrong or the AWP is stale. It matters because a plan paying a discount off AWP pays less than the drug cost, so every claim on it loses money.",
        level: "check",
        costCents: gap,
      });
    }
  }

  return out;
}

/** The worst thing wrong with a row, for sorting a list by what needs attention first. */
export function worstLevel(problems: Problem[]): "wrong" | "check" | null {
  if (problems.some((p) => p.level === "wrong")) return "wrong";
  return problems.length > 0 ? "check" : null;
}

/* ── A price the arithmetic says is wrong must not win a comparison ── */

/** The shape the quarantine needs: one supplier's row for one NDC. */
export type ComparableRow = {
  ndc11: string;
  supplier: string;
  packSize: string | null;
  unitCostMicros: number | null;
  packCostCents: number | null;
  /** True where the pharmacy has corrected this row by hand; a correction is never second-guessed. */
  corrected?: boolean;
};

/** Why a row was taken out of the comparison, in the words the screen shows. */
export type Quarantine = { supplier: string; says: string; majorityUnits: number; majorityUnitMicros: number };

/**
 * Takes out of every comparison the supplier rows whose pack size *and* price are both wrong.
 *
 * A comparison is only as good as its worst row, and the catalogue has rows that are not wrong by
 * a little. ABC lists Apri — a six-card box of 28 — as "1 EA" at $15.39 a unit where four other
 * wholesalers list 168 EA at $0.1302: the same box, priced a hundred and eighteen times too dear.
 * The other direction is the expensive one. ABC lists fondaparinux as "4 ML" at $12.50 where the
 * rest say 1.2 ML at $57.12, so it looks five times cheaper than anyone and wins the order — and
 * the invoice arrives at five times the price the site promised.
 *
 * These are not judgements about who is right. They are arithmetic: a row is taken out only when
 * all four of these hold, which on the pharmacy's 147,730 catalogue rows is 245 of them.
 *
 *   1. Three or more suppliers price this NDC, so there is something to be a majority of.
 *   2. Two or more of them read the package the same way.
 *   3. This row reads it differently.
 *   4. And its unit price is off that majority's by threefold or more — so the disagreement has
 *      reached the money, rather than being the two-notations-for-one-box case that is not a fault.
 *
 * A row the pharmacy has corrected by hand is never quarantined: the pharmacy has the bottle and
 * the site does not. The row keeps its pack size, its item number and its place on the drug file
 * screen — only its prices are withheld, which is exactly what every comparison already handles,
 * because a supplier who does not carry an item has no price either.
 */
export function quarantineWrongPrices<T extends ComparableRow>(rows: T[]): { rows: T[]; taken: Map<string, Quarantine> } {
  const byNdc = new Map<string, T[]>();
  for (const r of rows) byNdc.set(r.ndc11, [...(byNdc.get(r.ndc11) ?? []), r]);

  const taken = new Map<string, Quarantine>();
  for (const [ndc11, group] of byNdc) {
    const priced = group
      .map((r) => ({ r, units: packUnits(r.packSize), unit: r.unitCostMicros }))
      .filter((x) => x.units !== null && x.units > 0 && x.unit !== null && x.unit > 0) as {
      r: T; units: number; unit: number;
    }[];
    if (priced.length < 3) continue;

    const counts = new Map<number, number>();
    for (const x of priced) counts.set(x.units, (counts.get(x.units) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const [majorityUnits, agreeing] = ranked[0];
    // No majority, or everybody agrees: nothing to be an outlier against.
    if (agreeing < 2 || agreeing === priced.length) continue;
    // A tie for the majority is not a majority.
    if (ranked.length > 1 && ranked[1][1] === agreeing) continue;

    const peers = priced.filter((x) => x.units === majorityUnits).map((x) => x.unit).sort((a, b) => a - b);
    const median = peers[Math.floor(peers.length / 2)];

    for (const x of priced) {
      if (x.units === majorityUnits || x.r.corrected) continue;
      const ratio = x.unit / median;
      if (ratio < 3 && ratio > 1 / 3) continue;
      const times = ratio > 1 ? ratio : 1 / ratio;
      taken.set(`${ndc11}|${x.r.supplier}`, {
        supplier: x.r.supplier,
        majorityUnits,
        majorityUnitMicros: median,
        says:
          `${x.r.supplier} lists this as ${x.r.packSize ?? "no package"} at $${(x.unit / 1_000_000).toFixed(4)} a unit, ` +
          `where ${agreeing} other${agreeing === 1 ? "" : "s"} list ${majorityUnits} at $${(median / 1_000_000).toFixed(4)} — ` +
          `${Math.round(times)} times ${ratio > 1 ? "dearer" : "cheaper"}. The package and the price are both out by the ` +
          `same factor, so it is one error rather than a bargain, and this row is left out of every comparison until it is settled.`,
      });
    }
  }

  if (taken.size === 0) return { rows, taken };
  return {
    rows: rows.map((r) => (taken.has(`${r.ndc11}|${r.supplier}`) ? { ...r, unitCostMicros: null, packCostCents: null } : r)),
    taken,
  };
}
