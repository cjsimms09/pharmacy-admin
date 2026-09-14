/**
 * A claim that lost money, and the one thing to do about it.
 *
 * The owner set the tree out himself, and it is the whole design:
 *
 * > "for claims where we are buying cheapest drug and still losing money then we need to find best
 * > actionable thing we can do. Are we buying too expensive and should request a price reduction to
 * > buying group (you should find these drugs and alert me once a month)... If we are buying fine and
 * > still losing money, then we need to do mac appeals (if Mac based reimbursement only), if NADAC
 * > based we need to submit NADAC underpayment to Kansas insurance. I'm really needing you to figure
 * > out which claims fall into which, keep them organized, make sure it gets done."
 *
 * So: buying first, then how the plan priced it. Four remedies, one per claim, and a named reason
 * for every claim that gets none. Pure, so every rule here is a test rather than a belief.
 *
 * ── What "losing money" means, and the bug that made this file necessary ──
 *
 * `mac-appeal-candidates.ts` compared the acquisition cost against `remit_cents`, which is what the
 * *plan* sent. It is not what the pharmacy was paid for the drug. Measured on this pharmacy's own
 * claims, `remit = ingredient + fee − copay` holds on 1,523 of 1,594 September fills: the copay is
 * the patient's slice **of** the ingredient cost, not money on top of it. Comparing cost against the
 * plan's share alone therefore counts every copay dollar as a loss.
 *
 * On September's book that was 342 claims and **$25,810.59** of "below cost" that was nothing of the
 * kind — a Wegovy fill costing $1,308.55 against a $1,535.01 patient copay read as $1,136.45 in the
 * red. Those are the claims a buying decision or a don't-dispense decision would have been made on.
 *
 * The figure to compare is the **ingredient reimbursement**, patient share included. See
 * `ingredientReceivedCents`.
 *
 * ── Why the dispensing fee is not in it ──
 *
 * The fee pays for dispensing, not for the drug. Every PBM appeal form and the Kansas floor both ask
 * the same question — what did the drug cost, and what did you get for the drug — so the fee sits
 * outside the comparison. It is carried on the row so a screen can show the whole fill.
 */

/** What a fill has to carry to be routed. */
export type Fill = {
  claimId: string;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  ndc11: string;
  drugName: string | null;
  pbmName: string;
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  quantityThousandths: number | null;
  /** What the drug cost, from the invoice where there is one. */
  acquisitionCents: number | null;
  /** The adjudicated ingredient cost, patient share included. The figure that matters. */
  ingredientPaidCents: number | null;
  dispensingFeePaidCents: number | null;
  /** What the plan sent: ingredient + fee − copay. Only a fallback, never the comparison. */
  remitCents: number | null;
  copayCents: number | null;
  /** NCPDP 522-FM, as the plan returned it. */
  basisOfReimbursement: string | null;
  /** NADAC per dispensing unit in force on the fill date, in cents. Null where NADAC has none. */
  nadacPerUnitCents: number | null;
  nadacOn: string | null;
  /**
   * Whether the Kansas floor reaches this plan.
   *
   * `true` proved in scope, `false` proved out, **`null` nobody has classified it** — and null is
   * the common case: 481 of 491 plans on the register. A null here is not a "no"; it is the reason
   * the claim cannot be filed yet, and it is said in those words.
   */
  inKansasScope: boolean | null;
};

export type Remedy =
  /** Nothing is wrong with it. */
  | "not_below_cost"
  /** Bought above the national average. The buying group can take the price up with the wholesaler. */
  | "buy_better"
  /** Bought well, and a MAC list set the price. */
  | "mac_appeal"
  /** Bought well, paid under NADAC, and the floor reaches the plan. */
  | "kansas_underpayment"
  /** Would be a Kansas filing, but nobody has classified the plan, so it cannot be filed. */
  | "kansas_plan_unclassified"
  /** Bought well, priced off something with no appeal behind it. A contract question. */
  | "contract_problem"
  /** The plan named a basis nobody has identified. Nothing can be routed on a code with no meaning. */
  | "basis_unknown"
  /** No invoice covers the NDC, so neither the loss nor the buying can be judged. */
  | "no_cost"
  /** NADAC does not price this NDC, so there is no way to tell a buying gap from an underpayment. */
  | "no_nadac";

export type Routed = {
  fill: Fill;
  remedy: Remedy;
  /** Acquisition less the ingredient reimbursement. Zero where not below cost. */
  shortfallCents: number;
  /** Acquisition less NADAC for the same units. Positive means bought above the national average. */
  overNadacCents: number | null;
  /** The ingredient reimbursement used in the comparison, and where it came from. */
  ingredientCents: number | null;
  ingredientFrom: "adjudicated" | "derived" | null;
  /** True where a second remedy also applies and is being left on the table. Said in `says`. */
  alsoUnderNadac: boolean;
  says: string;
};

/**
 * The two basis codes that mean a MAC list set the price.
 *
 * Kept in step with `mac-appeal-candidates.ts` deliberately rather than imported: that file is about
 * whether an appeal may be *filed*, this one about which remedy a claim *belongs to*, and a future
 * change to one is not automatically right for the other. The tests assert they agree today.
 */
const MAC_BASES = new Set(["06", "07"]);

/**
 * Codes that mean the plan priced off the national average, or off a benchmark that tracks it.
 *
 * 09 is acquisition-cost pricing, which is NADAC-based in every state programme that uses it.
 */
const NADAC_BASES = new Set(["09"]);

/**
 * What each code means, for the sentence on the row.
 *
 * **Only codes whose meaning is known are here.** A claim carrying anything else routes to
 * `basis_unknown` rather than being guessed at, and on September's book that is real money: basis
 * **20** ($1,733.97 short over 7 fills) and basis **46** ($3,650.83 over 14) are the two largest
 * unidentified codes and together carry more below-cost money than every MAC appeal combined.
 * Guessing at them is how a pharmacy files the wrong form; naming them as unknown is how they get
 * looked up.
 */
const BASIS_MEANS: Record<string, string> = {
  "00": "no basis specified",
  "01": "the ingredient cost as submitted",
  "02": "AWP",
  "03": "AWP less a percentage",
  "04": "usual and customary, as submitted",
  "05": "the lower of cost plus fees and usual and customary",
  "06": "a MAC list",
  "07": "the ingredient cost reduced to a MAC",
  "08": "contract pricing",
  "09": "acquisition cost",
  "13": "wholesale acquisition cost",
  "14": "another payer's patient-responsibility amount",
  "15": "the patient pay amount",
  "16": "a coupon",
};

/** Two digits, so "6" and "06" are one basis. */
export function basisCode(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  return /^\d$/.test(t) ? `0${t}` : t;
}

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What the pharmacy was paid for the drug itself.
 *
 * The adjudicated ingredient cost where the feed carried it. Where it did not — 71 of 1,594
 * September fills, mostly Mounjaro and Eliquis lines whose report omitted the split — it is put back
 * together from the identity the rest of the book obeys:
 *
 *     remit = ingredient + fee − copay      →      ingredient = remit + copay − fee
 *
 * The row says which of the two it used, because a derived figure is one the plan never stated and a
 * screen that does not distinguish them invites an appeal filed on arithmetic the PBM never sent.
 *
 * Null where neither is available: not zero. A fill with no reimbursement figure at all has never
 * been measured, and rendering that as nought is the fault this project keeps finding in itself.
 */
export function ingredientReceivedCents(f: {
  ingredientPaidCents: number | null;
  dispensingFeePaidCents: number | null;
  remitCents: number | null;
  copayCents: number | null;
}): { cents: number | null; from: "adjudicated" | "derived" | null } {
  if (f.ingredientPaidCents !== null && f.ingredientPaidCents > 0) return { cents: f.ingredientPaidCents, from: "adjudicated" };
  if (f.remitCents === null) return { cents: null, from: null };
  return { cents: f.remitCents + (f.copayCents ?? 0) - (f.dispensingFeePaidCents ?? 0), from: "derived" };
}

/** NADAC for the units actually dispensed, in cents. Null where either half is missing. */
export function nadacForFillCents(f: Fill): number | null {
  const units = (f.quantityThousandths ?? 0) / 1000;
  if (units <= 0 || f.nadacPerUnitCents === null || f.nadacPerUnitCents <= 0) return null;
  return f.nadacPerUnitCents * units;
}

/**
 * Route one fill.
 *
 * The order is the owner's: buying first, then how the plan priced it. A fill can be both bought
 * dear *and* underpaid, and where it is, the buying is the remedy and the underpayment is recorded
 * on `alsoUnderNadac` rather than dropped — a price request and an appeal are different letters to
 * different people and doing the first does not settle the second.
 */
export function route(f: Fill): Routed {
  const base = { fill: f, shortfallCents: 0, overNadacCents: null as number | null, alsoUnderNadac: false };
  const { cents: ingredient, from } = ingredientReceivedCents(f);
  const carry = { ...base, ingredientCents: ingredient, ingredientFrom: from };
  const name = f.drugName ?? f.ndc11;

  if (f.acquisitionCents === null || f.acquisitionCents <= 0) {
    return {
      ...carry,
      remedy: "no_cost",
      says: `No invoice on file covers ${name}, so there is no telling whether this fill made money — and every remedy, from a price request to an appeal, is evidenced with the invoice.`,
    };
  }
  if (ingredient === null) {
    return {
      ...carry,
      remedy: "no_cost",
      says: `${name} carries no reimbursement figure at all, so nothing can be compared against the ${money(f.acquisitionCents)} it cost.`,
    };
  }

  const shortfallCents = f.acquisitionCents - ingredient;
  if (shortfallCents <= 0) {
    return {
      ...carry,
      remedy: "not_below_cost",
      says: `Paid ${money(ingredient)} for a drug that cost ${money(f.acquisitionCents)}. Nothing to chase.`,
    };
  }

  const nadacFill = nadacForFillCents(f);
  if (nadacFill === null) {
    return {
      ...carry,
      shortfallCents,
      remedy: "no_nadac",
      says:
        `${money(shortfallCents)} below cost on ${name}, but NADAC does not price this NDC on ${f.dateFilled}. ` +
        `Without the national average there is no way to tell a drug bought badly from a plan paying badly, and those take opposite letters.`,
    };
  }

  const overNadacCents = f.acquisitionCents - nadacFill;
  const under = ingredient < nadacFill;

  /*
   * Bought above the national average.
   *
   * NADAC is a survey of what pharmacies actually paid, so paying over it is this pharmacy's price
   * being worse than the country's — which the buying group can take up with the wholesaler and no
   * PBM will ever fix. His words: "Are we buying too expensive and should request a price reduction
   * to buying group".
   */
  if (overNadacCents > 0) {
    return {
      ...carry,
      shortfallCents,
      overNadacCents,
      alsoUnderNadac: under,
      remedy: "buy_better",
      says:
        `${money(shortfallCents)} below cost on ${name}. It cost ${money(f.acquisitionCents)} against a national average of ` +
        `${money(nadacFill)} — ${money(overNadacCents)} more than pharmacies pay on average, so the price is the problem before the plan is.` +
        (under
          ? ` The plan also paid under NADAC, which is a separate letter and is not settled by a better price.`
          : ""),
    };
  }

  const basis = basisCode(f.basisOfReimbursement);

  /*
   * A code with no known meaning routes nowhere.
   *
   * Bases 20 and 46 carry more below-cost money on this pharmacy's book than every MAC appeal put
   * together, and neither is in any list read so far. A guess here picks a form to file, and the
   * cost of filing the wrong one is a refusal on the record with a PBM this pharmacy has to keep
   * filing with.
   */
  if (basis !== null && !(basis in BASIS_MEANS)) {
    return {
      ...carry,
      shortfallCents,
      overNadacCents,
      alsoUnderNadac: under,
      remedy: "basis_unknown",
      says:
        `${money(shortfallCents)} below cost on ${name}, bought at or under the national average — so this is the plan, not the price. ` +
        `But ${f.pbmName} returned basis of reimbursement ${basis}, which nothing on file identifies, and the remedy depends entirely on what it means. Not routed until it is looked up.`,
    };
  }

  if (basis !== null && MAC_BASES.has(basis)) {
    return {
      ...carry,
      shortfallCents,
      overNadacCents,
      alsoUnderNadac: under,
      remedy: "mac_appeal",
      says:
        `${money(shortfallCents)} below cost on ${name}, bought at or under the national average. ` +
        `${f.pbmName} priced it off a MAC list (basis ${basis}), so the MAC is what to appeal.`,
    };
  }

  /*
   * Paid under the national average, on a basis that is not a MAC — the Kansas route.
   *
   * `under` is necessarily true by the time execution reaches here, and it is worth saying why
   * rather than testing it: the fill is below cost, so ingredient < acquisition; and it was not
   * bought dear, so acquisition ≤ NADAC. Therefore ingredient < NADAC. There is no fourth case.
   *
   * The first draft of this file had one — "bought well, paid at or above NADAC, a contract
   * problem" — and it could never be reached. The test that caught it is the one that asserts the
   * invariant, because an unreachable branch in a router is a remedy that silently never fires.
   *
   * The route is gated on the plan being one the floor reaches. A filing against a self-funded
   * ERISA plan is a filing the department cannot act on, and 481 of 491 plans on this register have
   * never been classified — so `null` is said as "not yet classified", never quietly read as "no".
   */
  if (f.inKansasScope === true) {
    return {
      ...carry,
      shortfallCents,
      overNadacCents,
      alsoUnderNadac: true,
      remedy: "kansas_underpayment",
      says:
        `${money(shortfallCents)} below cost on ${name}. Bought at or under the national average and ${f.pbmName} still paid ` +
        `${money(ingredient)} against a NADAC of ${money(nadacFill)}${basis ? ` on ${BASIS_MEANS[basis]}` : ""} — under the floor, on a plan the floor reaches.`,
    };
  }
  return {
    ...carry,
    shortfallCents,
    overNadacCents,
    alsoUnderNadac: true,
    remedy: f.inKansasScope === false ? "contract_problem" : "kansas_plan_unclassified",
    says:
      f.inKansasScope === false
        ? `${money(shortfallCents)} below cost on ${name}, paid ${money(ingredient)} against a NADAC of ${money(nadacFill)} — but this plan is out of the Kansas floor's reach, so there is nothing to file and it is a contract question with ${f.pbmName}.`
        : `${money(shortfallCents)} below cost on ${name}, paid ${money(ingredient)} against a NADAC of ${money(nadacFill)}. That is a Kansas underpayment ` +
          `if the floor reaches this plan — and nobody has classified ${f.pbmName}'s plan, so it cannot be filed yet.`,
  };
}

/**
 * One line per NDC for the monthly price request to the buying group.
 *
 * Batched by NDC and not by claim, because that is what the form asks and what the wholesaler can
 * act on: a cent over on a drug dispensed forty times is a better ask than a dollar over on one
 * dispensed once. The floor is therefore applied to the **month's total for the NDC**, never to a
 * single fill — a per-claim threshold would throw away exactly the high-volume, low-margin lines
 * that a price request is best at fixing.
 */
export type PriceRequest = {
  ndc11: string;
  drugName: string | null;
  fills: number;
  /** Units dispensed over the period. */
  units: number;
  /** What the pharmacy paid over the period. */
  paidCents: number;
  /** What the national average would have come to for the same units. */
  nadacCents: number;
  /** The gap: what a price at the national average would have saved. */
  overCents: number;
  /** Of that, how much actually fell below the reimbursement. */
  belowCostCents: number;
  says: string;
};

/**
 * Build the month's price-request list.
 *
 * `minOverCents` is the least a drug has to be over, across the whole month, before it is worth
 * putting on a form. Unlike the MAC appeal floor this is not about the owner's time — the form is
 * one submission for the batch — it is about not sending a buying group a list of ninety lines worth
 * four cents each and training them to ignore it.
 */
export function priceRequests(routed: Routed[], minOverCents = 500): PriceRequest[] {
  const by = new Map<string, PriceRequest>();
  for (const r of routed) {
    if (r.remedy !== "buy_better" || r.overNadacCents === null) continue;
    const f = r.fill;
    const e =
      by.get(f.ndc11) ??
      { ndc11: f.ndc11, drugName: f.drugName, fills: 0, units: 0, paidCents: 0, nadacCents: 0, overCents: 0, belowCostCents: 0, says: "" };
    e.fills++;
    e.units += (f.quantityThousandths ?? 0) / 1000;
    e.paidCents += f.acquisitionCents ?? 0;
    e.nadacCents += nadacForFillCents(f) ?? 0;
    e.overCents += r.overNadacCents;
    e.belowCostCents += r.shortfallCents;
    e.drugName ??= f.drugName;
    by.set(f.ndc11, e);
  }
  return [...by.values()]
    .filter((e) => e.overCents >= minOverCents)
    .map((e) => ({
      ...e,
      says:
        `${e.drugName ?? e.ndc11}: ${e.fills} fill${e.fills === 1 ? "" : "s"}, ${e.units.toLocaleString("en-US")} units at ` +
        `${money(Math.round(e.paidCents))} against a national average of ${money(Math.round(e.nadacCents))} — ` +
        `${money(Math.round(e.overCents))} over.`,
    }))
    .sort((a, b) => b.overCents - a.overCents);
}

export type RemedyBook = {
  routed: Routed[];
  /** Every remedy, with what it is worth and how many claims. Ordered by money. */
  buckets: { remedy: Remedy; claims: number; shortfallCents: number; says: string }[];
  priceRequests: PriceRequest[];
  says: string;
};

const BUCKET_SAYS: Record<Remedy, string> = {
  not_below_cost: "made money, or broke even",
  buy_better: "bought above the national average — a price request to the buying group",
  mac_appeal: "bought well and MAC-priced — a MAC appeal",
  kansas_underpayment: "bought well and paid under NADAC on a plan the floor reaches — a Kansas filing",
  kansas_plan_unclassified: "would be a Kansas filing, but the plan has never been classified",
  contract_problem: "neither the price nor a MAC list — the contract, or do not dispense",
  basis_unknown: "the plan named a basis of reimbursement nothing on file identifies",
  no_cost: "no invoice covers the NDC, so nothing can be judged",
  no_nadac: "NADAC does not price this NDC, so the price cannot be told from the payment",
};

/** The whole book for a period, ready for a screen. */
export function remedyBook(fills: Fill[], minOverCents = 500): RemedyBook {
  const routed = fills.map(route);
  const by = new Map<Remedy, { claims: number; shortfallCents: number }>();
  for (const r of routed) {
    const e = by.get(r.remedy) ?? { claims: 0, shortfallCents: 0 };
    e.claims++;
    e.shortfallCents += r.shortfallCents;
    by.set(r.remedy, e);
  }
  const buckets = [...by.entries()]
    .map(([remedy, e]) => ({ remedy, ...e, says: BUCKET_SAYS[remedy] }))
    .sort((a, b) => b.shortfallCents - a.shortfallCents);

  const actionable = routed.filter((r) => r.remedy === "buy_better" || r.remedy === "mac_appeal" || r.remedy === "kansas_underpayment");
  const total = actionable.reduce((n, r) => n + r.shortfallCents, 0);
  const blocked = routed.filter((r) => r.remedy === "kansas_plan_unclassified" || r.remedy === "basis_unknown" || r.remedy === "no_cost");
  const blockedCents = blocked.reduce((n, r) => n + r.shortfallCents, 0);

  return {
    routed,
    buckets,
    priceRequests: priceRequests(routed, minOverCents),
    says:
      actionable.length === 0
        ? "Nothing below cost has a remedy behind it."
        : `${actionable.length} fill${actionable.length === 1 ? "" : "s"} worth ${money(total)} have something that can be done about them` +
          (blocked.length > 0
            ? `, and ${money(blockedCents)} more is waiting on a plan classification, a basis code nobody has looked up, or an invoice.`
            : "."),
  };
}
