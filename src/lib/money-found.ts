import "server-only";

/**
 * Every pound of money this site can actually see, ranked, with what to do about each.
 *
 * The site had grown six answers to six questions — what a drug costs elsewhere, what a plan pays,
 * what a rebate band is worth, what a return is still worth, what a claim was paid against the
 * Kansas floor — and every one of them lived on its own page. A pharmacist who wanted to know what
 * to do this morning had to open six screens and add up in his head, which is the same as not
 * being told.
 *
 * So this is the one list. It is not a dashboard of metrics: every row is an amount of money and an
 * action, and a row that cannot say what to do about it does not belong here.
 *
 * ── Honesty is what makes it usable ──
 *
 * Three things would ruin it, and each is guarded against.
 *
 * **Inventing money.** Every figure is arithmetic on documents this pharmacy holds — an invoice, a
 * catalogue, a rebate statement, a return policy, a claim. Where a figure would need a number
 * nobody supplied, the row says so and is worth nothing rather than being estimated. A list that
 * over-promises is read once.
 *
 * **Counting it twice.** A drug bought dearly and dispensed at a loss is one problem with two
 * symptoms. Rows carry what they overlap with, and the total is stated as the sum of the *distinct*
 * actions rather than of the rows.
 *
 * **Confusing one-off with recurring.** Ten dollars saved every month is worth more than a hundred
 * recovered once, and a list that mixes them ranks the wrong thing first. Each row says which it is.
 */

export type Confidence = "certain" | "likely" | "worth checking";
export type Cadence = "one_off" | "recurring_monthly";

export type MoneyRow = {
  key: string;
  /** What it is, in one line, with the money in it. */
  says: string;
  /** What to do. Not a description — an instruction. */
  todo: string;
  amountCents: number;
  cadence: Cadence;
  confidence: Confidence;
  /** Why the figure is what it is, so it can be argued with. */
  basis: string;
  href: string;
  /** Other rows describing the same underlying problem, so nothing is added up twice. */
  overlapsWith?: string[];
};

export type MoneyFound = {
  rows: MoneyRow[];
  /** What acting on all of it is worth in the first year, one-offs plus twelve months of recurring. */
  firstYearCents: number;
  recurringMonthlyCents: number;
  oneOffCents: number;
  /** Things that would put money on this list if they were settled. */
  blocked: { says: string; todo: string; href: string }[];
  /** Worth a look and not yet worth a figure: measured on too few days, or on nothing dispensed. */
  watch: { says: string; todo: string; href: string }[];
  /** Days each row has been on the list, by key, from the recommendation log. Empty if the log could not be written. */
  ages: Record<string, number>;
  /** The log entry behind each row, by key: its id for the buttons, and the owner's word on it so far. */
  log: Record<string, { id: string; firstSeenOn: string; status: string; note: string | null }>;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Ranked by what it is worth over a year, so a recurring saving is not buried under a one-off.
 *
 * Confidence breaks a tie rather than scaling the money: a figure this site is unsure of is said to
 * be unsure, not quietly halved. Halving it would make every number here a number nobody can check
 * against the document it came from.
 */
export function rank(rows: MoneyRow[]): MoneyRow[] {
  const yearly = (r: MoneyRow) => (r.cadence === "recurring_monthly" ? r.amountCents * 12 : r.amountCents);
  const sure = { certain: 0, likely: 1, "worth checking": 2 } as const;
  return [...rows].sort((a, b) => yearly(b) - yearly(a) || sure[a.confidence] - sure[b.confidence]);
}

/** The sum, counting each underlying problem once. */
export function totals(rows: MoneyRow[]): { firstYearCents: number; recurringMonthlyCents: number; oneOffCents: number } {
  const counted = new Set<string>();
  let recurring = 0;
  let oneOff = 0;
  for (const r of rank(rows)) {
    if (counted.has(r.key)) continue;
    counted.add(r.key);
    // Anything this row already accounts for is not counted again on its own row.
    for (const o of r.overlapsWith ?? []) counted.add(o);
    if (r.cadence === "recurring_monthly") recurring += r.amountCents;
    else oneOff += r.amountCents;
  }
  return { firstYearCents: oneOff + recurring * 12, recurringMonthlyCents: recurring, oneOffCents: oneOff };
}

/**
 * Gathers every opportunity the site can currently see.
 *
 * Each source is asked for money and an action; anything that cannot supply both is left out of the
 * list and, where it is only waiting on a fact, named under `blocked` instead — because "we cannot
 * tell you yet, and here is why" is a useful sentence and a silently short list is not.
 */
export async function moneyFound(): Promise<MoneyFound> {
  const { held } = await import("./held");
  return held("money-found", loadMoneyFound);
}

async function loadMoneyFound(): Promise<MoneyFound> {
  const rows: MoneyRow[] = [];
  const blocked: MoneyFound["blocked"] = [];

  const watch: MoneyFound["watch"] = [];

  /*
   * The buying logic's inputs, gathered by three loaders that fail apart.
   *
   * The buy list needs invoices, catalogues and NADAC; the band position needs a primary supplier
   * with a ladder and this month's invoice lines; the plan bases need claims against NADAC. Any
   * one can be missing on a given morning, and the rows that the others support should still
   * appear, so each loader fills its own field and `recommendations()` is read once at the end.
   */
  const recInput: import("./recommendations").RecommendationInput = {};
  let materialityCents = 500;
  let groupOf: (ndc11: string) => string | null = () => null;
  try {
    const { db } = await import("@/db");
    const { groupKey } = await import("./product-groups");
    // One row per drug, newest first, rather than every price ever published to keep the first of
    // each. On a year of weekly files that was over a million rows read to build this map.
    const nadacRows = await (await import("./nadac-latest")).nadacNow();
    const groupByNdc = new Map<string, string | null>();
    for (const r of nadacRows) {
      if (groupByNdc.has(r.ndc11)) continue;
      groupByNdc.set(r.ndc11, groupKey({ ndc11: r.ndc11, description: r.description, classification: r.classification, pricingUnit: r.pricingUnit }));
    }
    groupOf = (ndc) => groupByNdc.get(ndc) ?? null;
  } catch {
    /* No NADAC held: products cannot be grouped, so no switch between NDCs can be named. */
  }

  // ── What the pharmacy is overpaying for ──
  try {
    const { productLedger, opportunities, margins, losers } = await import("./product-ledger");
    const { perMonthCents, spanDays } = await import("./recommendations");
    const { db, schema } = await import("@/db");
    const { min, max } = await import("drizzle-orm");
    const ledger = await productLedger();

    /*
     * The claims held are not a month.
     *
     * Every figure below is summed over every claim on file, and the file grows with the calendar:
     * after ninety days of feed the same sentence would say three times the truth. So each is
     * scaled to thirty days by the span of days the claims cover, and a span under a week is not
     * offered as a month at all — a week is a guess about a month, and the row waits.
     */
    const [span] = await db.select({ from: min(schema.claims.dateFilled), to: max(schema.claims.dateFilled) }).from(schema.claims);
    const periodDays = spanDays(span?.from ?? null, span?.to ?? null);
    recInput.periodDays = periodDays;
    materialityCents = ledger.materialityCents;
    const overDays = periodDays ? `on the units dispensed over ${periodDays} day${periodDays === 1 ? "" : "s"} of claims, scaled to thirty` : "on the claims held";

    const cheaper = opportunities(ledger.rows).filter((r) => r.flags.includes("cheaper_elsewhere") && (r.switchSavingCents ?? 0) > 0);
    const switchTotal = cheaper.reduce((n, r) => n + (r.switchSavingCents ?? 0), 0);
    const switchMonthly = perMonthCents(switchTotal, periodDays);
    if (switchTotal > 0 && switchMonthly !== null) {
      const top = cheaper[0];
      rows.push({
        key: "switch-supplier",
        says: `${money(switchMonthly)} a month buying ${cheaper.length} drug${cheaper.length === 1 ? "" : "s"} from a cheaper supplier already on file.`,
        todo: `Start with ${top.name ?? top.ndc11}: ${money(top.switchSavingCents ?? 0)} on what you dispensed, buying from ${top.best?.supplier ?? "the cheaper source"} instead.`,
        amountCents: switchMonthly,
        cadence: "recurring_monthly",
        confidence: "likely",
        basis:
          `Your invoice price against the cheapest price on any catalogue held, both per unit and both after the rebate that supplier actually pays, ${overDays}. It assumes you go on dispensing the same quantities.`,
        href: "/purchasing",
      });
    } else if (switchTotal > 0) {
      watch.push({
        says: `${money(switchTotal)} from buying ${cheaper.length} drug${cheaper.length === 1 ? "" : "s"} at a cheaper supplier, measured on ${periodDays ?? 0} day${periodDays === 1 ? "" : "s"} of claims — too few to call a month.`,
        todo: `Start with ${cheaper[0].name ?? cheaper[0].ndc11} from ${cheaper[0].best?.supplier ?? "the cheaper source"}; the monthly figure appears after a week of claims.`,
        href: "/purchasing",
      });
    }

    const losing = losers(margins(ledger.rows));
    const lossTotal = losing.reduce((n, m) => n + Math.abs(m.marginCents), 0);
    const lossMonthly = perMonthCents(lossTotal, periodDays);
    if (lossTotal > 0 && lossMonthly !== null) {
      rows.push({
        key: "dispensed-at-a-loss",
        says: `${money(lossMonthly)} a month lost dispensing ${losing.length} product${losing.length === 1 ? "" : "s"} for less than they cost.`,
        todo: `Look at ${losing[0].name ?? losing[0].ndc11} first — ${money(Math.abs(losing[0].marginCents))} on ${losing[0].claims} claim${losing[0].claims === 1 ? "" : "s"} from ${losing[0].supplier ?? "your supplier"}. Either the price is wrong or the plan is.`,
        amountCents: lossMonthly,
        cadence: "recurring_monthly",
        confidence: "certain",
        basis: `What the plans and patients paid against the effective cost of what you bought — the invoice price less the rebate that supplier really pays on the line — ${overDays}.`,
        href: "/purchasing",
        overlapsWith: ["switch-supplier"],
      });
    } else if (lossTotal > 0) {
      watch.push({
        says: `${money(lossTotal)} lost on ${losing.length} product${losing.length === 1 ? "" : "s"} dispensed for less than they cost, on ${periodDays ?? 0} day${periodDays === 1 ? "" : "s"} of claims.`,
        todo: `Look at ${losing[0].name ?? losing[0].ndc11}: ${money(Math.abs(losing[0].marginCents))} on ${losing[0].claims} claim${losing[0].claims === 1 ? "" : "s"}.`,
        href: "/purchasing",
      });
    }
    if (ledger.rate === null) {
      blocked.push({
        says: "Every contract line is being compared at its gross invoice price, so savings here are understated.",
        todo: "Send the monthly rebate report, or enter the tier ladder, so a contract generic is priced at what it really costs.",
        href: "/suppliers",
      });
    }

    /*
     * The buy list: every NDC ranked by its gap under NADAC after the rebate, grouped into
     * products on NADAC's own description so a switch is between genuine equivalents.
     */
    const { underNadac } = await import("./under-nadac");
    recInput.under = underNadac(ledger.rows, groupOf);
  } catch {
    // Purchasing needs invoices, catalogues and claims. Missing any, it contributes nothing.
  }

  // ── The month's position on the primary's ladder, for the band at risk ──
  try {
    const { allSuppliers } = await import("./suppliers-registry");
    const primary = (await allSuppliers(true)).find((x) => x.primarySupplier === true);
    if (primary) {
      const { ratesFor, earningSoFar } = await import("./rebate-rates");
      const [rates, earning] = await Promise.all([ratesFor(primary.id), earningSoFar(primary.id)]);
      /*
       * The ladder the compliance ratio measures, at the statement's scrub: the same construction
       * as the shelf's basket guard, so the two never disagree about where the month stands. A
       * programme measured by something else is not moved by where a generic is bought.
       */
      const ladder = rates?.view.programmes.find((p) => p.terms.kind === "tiered_ratio" && /compliance|gcr/i.test(p.measuredBy ?? p.name));
      if (rates && earning && ladder && ladder.achievedPercent !== null && ladder.terms.tiers.length > 0 && earning.rxPurchasedCents > 0) {
        const { tierEffect } = await import("./ratio-effect");
        const position = { ratioPercent: ladder.achievedPercent, denominatorCents: earning.rxPurchasedCents, definition: "generics_over_rx" as const, scrub: "statement" as const };
        const bands = ladder.terms.tiers.map((t) => ({ thresholdPercent: t.thresholdPercent, rebatePercent: t.rebatePercent }));
        recInput.tier = { supplierName: primary.name, effect: tierEffect(position, bands, [], earning.contractPurchasedCents), baseCents: earning.contractPurchasedCents, bands };
      }
    }
  } catch {
    /* No primary supplier, no ladder, or no invoice lines this month: nothing to say about the band. */
  }

  // ── How each plan pays, read off its own claims against NADAC ──
  try {
    const { db } = await import("@/db");
    const { payBasisByPlan } = await import("./pay-basis");
    const { planKey } = await import("./plans");
    const claims = await db.query.claims.findMany({
      columns: { bin: true, pcn: true, groupNumber: true, ndc11: true, dateFilled: true, quantityThousandths: true, ingredientPaidCents: true, status: true, cashPlan: true },
    });
    /*
     * The benchmark in force on each fill's own date, asked of the database (nadac-in-force.ts):
     * a plan's formula is read by pricing each fill against the NADAC of its day, and that is one
     * row per distinct (NDC, date) among the claims rather than every date ever held for every
     * NDC dispensed.
     */
    const { nadacRecordsForClaims } = await import("./nadac-in-force");
    const nadac = await nadacRecordsForClaims();
    // A cash fill is priced by the pharmacy, not by a plan, and says nothing about how a plan pays.
    const paid = claims.filter((c) => !c.cashPlan).map((c) => ({ planKey: planKey(c.bin, c.pcn, c.groupNumber), ndc11: c.ndc11, dateFilled: c.dateFilled, quantityThousandths: c.quantityThousandths, ingredientPaidCents: c.ingredientPaidCents, status: c.status }));
    if (paid.length > 0 && nadac.length > 0) {
      const bases = payBasisByPlan(paid, nadac.map((n) => ({ ...n, pricingUnit: n.pricingUnit as import("./reimbursement-rules").NadacRecord["pricingUnit"] })), groupOf);
      const units = new Map<string, number>();
      for (const c of paid) if (c.status !== "reversed") units.set(c.planKey, (units.get(c.planKey) ?? 0) + (c.quantityThousandths ?? 0) / 1000);
      recInput.plans = bases.map((b) => ({ basis: b, units: units.get(b.planKey) ?? 0 }));
    }
  } catch {
    /* No claims or no NADAC: no plan can be read. */
  }

  try {
    const { recommendations } = await import("./recommendations");
    const rec = recommendations(recInput, { materialityCents });
    rows.push(...rec.rows);
    blocked.push(...rec.blocked);
    watch.push(...rec.watch);
  } catch {
    /* A loader above produced something the logic could not read; the other rows stand. */
  }

  /*
   * ── What the rebate ladder is leaving behind ──
   *
   * For the primary, this month, with the spend it would take and the premium at which it stops
   * paying — because "one more band is worth $500" is not an instruction until it says what
   * reaching it costs and how long is left to do it. `nextTierNow` answers all three; the ladder
   * figure below is last period's buying and stands for the suppliers it has no position for.
   */
  let primaryBandKey: string | null = null;
  try {
    const { nextTierNow } = await import("./shelf");
    const { allSuppliers } = await import("./suppliers-registry");
    const tier = await nextTierNow();
    const primary = (await allSuppliers(true)).find((x) => x.primarySupplier === true);
    if (tier && primary && tier.worthCents > 0) {
      primaryBandKey = `rebate-band-${primary.id}`;
      rows.push({
        key: primaryBandKey,
        says:
          `${money(tier.worthCents)} from the ${tier.nextRatePercent}% band at ${tier.supplier}` +
          (tier.daysLeft > 0 ? `, with ${tier.daysLeft} day${tier.daysLeft === 1 ? "" : "s"} left this month.` : ", if the month were still open."),
        todo:
          tier.breakEvenPremiumPercent === null
            ? `Move ${money(tier.neededCents)} more of contract generics to ${tier.supplier} to pass ${tier.nextThresholdPercent}%.`
            : `Buy ${money(tier.neededCents)} more of contract generics at ${tier.supplier} — worth doing on anything they are less than ${tier.breakEvenPremiumPercent.toFixed(2)}% dearer on.`,
        amountCents: tier.worthCents,
        // The band is earned or missed once, in this month. It is not a rate that repeats.
        cadence: "one_off",
        confidence: tier.daysLeft > 0 ? "likely" : "worth checking",
        basis: tier.says,
        href: "/purchasing",
      });
    }
  } catch {
    /* No primary, no ladder, or no invoices this month. */
  }
  try {
    const { allSuppliers } = await import("./suppliers-registry");
    const { ratesFor } = await import("./rebate-rates");
    for (const s of (await allSuppliers(true)).filter((x) => x.active)) {
      // The primary already has the better row above; two would be the same band counted twice.
      if (primaryBandKey === `rebate-band-${s.id}`) continue;
      const r = await ratesFor(s.id);
      if (!r || r.view.nextBandWorthCents === null || r.view.nextBandWorthCents <= 0) continue;
      const ladder = r.view.programmes.find((p) => p.next && (p.next.worthCents ?? 0) > 0);
      rows.push({
        key: `rebate-band-${s.id}`,
        says: `${money(r.view.nextBandWorthCents)} a month from one more rebate band at ${s.name}.`,
        todo: ladder?.next
          ? `You are ${ladder.next.shortByPercent} points short of the ${ladder.next.fromPercent}% band, which pays ${ladder.next.rebatePercent}%. Moving generic buying to them closes it.`
          : `Move more of your buying to them to reach the next band.`,
        amountCents: r.view.nextBandWorthCents,
        cadence: "recurring_monthly",
        confidence: "likely",
        basis: `Their own ladder applied to last period's purchases, at the band above the ratio you are in now. It assumes you keep buying the same amount.`,
        href: `/suppliers/${s.id}/terms`,
      });
    }
  } catch {
    /* No supplier terms on file yet. */
  }

  // ── What is about to stop being returnable ──
  try {
    const { returnsDueNow, worthOf, actNow } = await import("./returns-due");
    const { rows: due, suppliersWithoutPolicy } = await returnsDueNow();
    const urgent = actNow(due);
    if (urgent.length > 0) {
      rows.push({
        key: "returns-closing",
        says: `${money(worthOf(urgent))} of stock loses credit within the week.`,
        todo: `${urgent.length} line${urgent.length === 1 ? "" : "s"} to raise now — none has been dispensed since it arrived. ${urgent[0].says}`,
        amountCents: worthOf(urgent),
        cadence: "one_off",
        confidence: "certain",
        basis: "Days since each invoice against the credit steps in that supplier's own returns policy. Nothing appears for a supplier whose policy is not on file.",
        href: "/inventory/returns",
      });
    }
    if (suppliersWithoutPolicy.length > 0) {
      blocked.push({
        says: `Nothing can be said about returns to ${suppliersWithoutPolicy.join(", ")} — no returns policy is on file for them.`,
        todo: "Email their returns policy to the mailbox, or enter the credit steps on their terms page.",
        href: "/suppliers",
      });
    }
  } catch {
    /* Needs invoice lines and a return policy. */
  }

  // ── What the plans have underpaid ──
  /*
   * The floor itself, not the screen for it. The claims page's "under $10.50" test is a quick
   * sieve — a fill that received less than the dispensing fee alone — and this list used to call
   * that sum "paid below the Kansas floor". The floor is NADAC plus the fee, priced per fill on
   * the NADAC in force that day, and only a claim that passes every check is filable money. That
   * is what the floor page computes, so that is the figure here.
   */
  try {
    const { floorReview } = await import("./floor-review");
    const r = await floorReview();
    if (r.filable.length > 0 && r.filableCents > 0) {
      rows.push({
        key: "kansas-floor",
        says: `${money(r.filableCents)} paid below the Kansas floor on ${r.filable.length} claim${r.filable.length === 1 ? "" : "s"} that pass every check.`,
        todo: "Each is priced on the NADAC in force on its fill date, on a plan the floor reaches, paid and not adjusted since. File them.",
        amountCents: r.filableCents,
        cadence: "one_off",
        confidence: "certain",
        basis: "Kansas SB 20: NADAC plus the greater of $10.50 and the Medicaid dispensing fee, per fill, less what was received. Only claims passing every check on the floor page are counted; the blocked ones are listed there with what would clear them.",
        href: "/claims/floor",
      });
    }
  } catch {
    /* No claims or no NADAC held. */
  }
  /*
   * Cash prices under cost or under what a plan would have to pay. A cash fill is a price the
   * pharmacy set, so this is not money owed — it is money given away on every bottle until the
   * price moves, which is why it is recurring and not one-off.
   */
  try {
    const { cashPricingNow } = await import("./cash-pricing-store");
    const cp = await cashPricingNow();
    if (cp.underPriced.length > 0 && cp.gainPerMonthCents > 0) {
      const top = cp.underPriced[0];
      const lossRows = cp.underPriced.filter((r) => r.reason === "under_cost");
      rows.push({
        key: "cash-pricing",
        says: `${money(cp.gainPerMonthCents)} a month is cash prices set under cost or under the Kansas floor on ${cp.underPriced.length} product${cp.underPriced.length === 1 ? "" : "s"}${lossRows.length ? `, ${lossRows.length} of them sold at a loss` : ""}.`,
        todo: `Raise each to the floor — NADAC plus the dispensing fee, what a plan would have to pay. ${top.name ?? top.ndc11}: ${money(top.chargedCents)} charged, ${money(top.targetCents ?? 0)} to move to, ${money(top.gainPerMonthCents)} a month.`,
        amountCents: cp.gainPerMonthCents,
        cadence: "recurring_monthly",
        confidence: "likely",
        basis: `Cash fills from the claims held over ${cp.months.toFixed(1)} months, each scaled to the product's typical quantity; the median price charged against the median invoice cost on the fill and against NADAC plus the greater of $10.50 and the Medicaid fee. ${cp.withCost} of ${cp.fills} cash fills carry a cost; ${cp.unjudged} product${cp.unjudged === 1 ? "" : "s"} had neither cost nor NADAC and are not counted.`,
        href: "/claims",
      });
    }
  } catch {
    /* No claims held. */
  }
  try {
    const { claimFlags } = await import("./claims");
    const f = await claimFlags({ all: true });
    if (f.undetermined > 0) {
      blocked.push({
        says: `${f.undetermined} claims are on plans nobody has classified, so nothing can say whether the Kansas floor applies to them.`,
        todo: "Classify each plan as commercial, ERISA, Medicare, Medicaid or a discount card. Only then can an underpayment be claimed.",
        href: "/plans",
      });
    }
  } catch {
    /* No claims held. */
  }

  // ── The same drug, paid better by another plan ──
  try {
    const { payerMap } = await import("./payer-map");
    const { ndcs, links, scores } = await payerMap();
    /*
     * Plans are compared with plans.
     *
     * A card is a payer, but it pays a patient's residual rather than pricing a drug, so the gap
     * between a card and a plan is not a rate anybody can appeal. Left in, the largest
     * "opportunity" on this list would be to move brand volume onto copay cards, which is not a
     * thing a pharmacy can do.
     */
    const subsidyNames = new Set(scores.filter((x) => x.isSubsidy).map((x) => x.pbmName));
    const spread = ndcs.filter(
      (n) =>
        (n.spreadPerFillCents ?? 0) > 0 &&
        n.worstPayer &&
        n.worstPayer.fills >= 2 &&
        !subsidyNames.has(n.bestPayer?.name ?? "") &&
        !subsidyNames.has(n.worstPayer.name),
    );
    const worth = spread.reduce((n, x) => n + (x.spreadPerFillCents ?? 0) * (x.worstPayer?.fills ?? 0), 0);
    // Summed over every fill held, so scaled to a month by the span of claims like the purchasing rows.
    const { perMonthCents } = await import("./recommendations");
    const worthMonthly = perMonthCents(worth, recInput.periodDays);
    const top = worth > 0 ? spread.sort((a, b) => (b.spreadPerFillCents ?? 0) * (b.worstPayer?.fills ?? 0) - (a.spreadPerFillCents ?? 0) * (a.worstPayer?.fills ?? 0))[0] : null;
    if (worth > 0 && worthMonthly !== null && top) {
      rows.push({
        key: "payer-spread",
        says: `${money(worthMonthly)} a month is the gap between what your best and worst plans pay for the same drugs.`,
        todo: `${top.name ?? top.ndc11}: ${top.bestPayer!.name} pays ${money(top.spreadPerFillCents!)} more per fill than ${top.worstPayer!.name}. That difference is what a MAC appeal points at.`,
        amountCents: worthMonthly,
        cadence: "recurring_monthly",
        confidence: "worth checking",
        basis:
          `The per-fill margin of the best-paying plan against the worst, on drugs dispensed under both, on the fills over ${recInput.periodDays} days of claims, scaled to thirty. Plans legitimately buy different things, so this is where to look rather than money already owed.`,
        href: "/payers/performance",
      });
    } else if (worth > 0 && top) {
      watch.push({
        says: `${money(worth)} between what your best and worst plans paid for the same drugs, on ${recInput.periodDays ?? 0} day${recInput.periodDays === 1 ? "" : "s"} of claims.`,
        todo: `${top.name ?? top.ndc11}: ${top.bestPayer!.name} pays ${money(top.spreadPerFillCents!)} more per fill than ${top.worstPayer!.name}.`,
        href: "/payers/performance",
      });
    }
    const unmapped = links.filter((l) => l.gaps.length > 0);
    if (unmapped.length > 0) {
      const hidden = unmapped.reduce((n, l) => n + l.revenueCents, 0);
      blocked.push({
        says: `${money(hidden)} of reimbursement comes through ${unmapped.length} plan${unmapped.length === 1 ? "" : "s"} the site cannot follow to a contract.`,
        todo: "Name each one — the contracts on file are searched for it — then link it once so nothing has to search again.",
        href: "/payers/performance",
      });
    }
  } catch {
    /* No claims or no payer reference loaded. */
  }

  /*
   * Money already in the bank, reported rather than ranked.
   *
   * This list is things to go and do, and a facilitator payment that has already arrived is not one
   * of them. But somebody looking at "where the money is" and seeing no mention of a channel that
   * paid four hundred dollars this month would reasonably conclude it was not being counted.
   */
  try {
    const { facilitatorMoney } = await import("./claim-payments");
    const m = await facilitatorMoney("mtf");
    if (m.monthToDateCents > 0 || m.allTimeCents > 0) {
      blocked.push({
        says:
          `${money(m.monthToDateCents)} has come in from the Medicare Transaction Facilitator this month` +
          (m.allTimeCents !== m.monthToDateCents ? `, ${money(m.allTimeCents)} since it started` : "") +
          ". It is already counted against the fills it paid.",
        todo:
          m.unmatched > 0
            ? `${m.unmatched} of those payments name a prescription this site has not loaded, so ${money(m.unmatchedCents)} is not yet against a claim. Load the days they belong to.`
            : "Nothing to do — it is collected and posted. Shown here so a channel that is working is not mistaken for one that is silent.",
        href: "/remits/mtf",
      });
    }
  } catch {
    /* Nothing configured. */
  }

  const ranked = rank(rows);

  /*
   * Remembered from the morning it first appears.
   *
   * A row that is shown and forgotten teaches nobody anything. The log starts an entry for each
   * new row, touches the ones still showing and closes the ones that went, so the page can say
   * "on the list since 3 September" and the scorecard can say what became of the advice. The
   * list itself does not depend on it: if the log cannot be written the rows still show, with no
   * ages beside them.
   */
  const ages: MoneyFound["ages"] = {};
  const log: MoneyFound["log"] = {};
  try {
    const { rememberRecommendations, openEntries } = await import("./recommendation-store");
    const r = await rememberRecommendations(ranked);
    for (const [k, v] of r.ages) ages[k] = v;
    for (const [k, e] of await openEntries()) log[k] = { id: e.id, firstSeenOn: e.firstSeenOn, status: e.status, note: e.note };
  } catch {
    /* The log is a convenience over the list, never a condition of it. */
  }

  return { rows: ranked, ...totals(ranked), blocked, watch, ages, log };
}
