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
  const rows: MoneyRow[] = [];
  const blocked: MoneyFound["blocked"] = [];

  // ── What the pharmacy is overpaying for ──
  try {
    const { productLedger, opportunities, margins, losers } = await import("./product-ledger");
    const ledger = await productLedger();
    const cheaper = opportunities(ledger.rows).filter((r) => r.flags.includes("cheaper_elsewhere") && (r.switchSavingCents ?? 0) > 0);
    const switchTotal = cheaper.reduce((n, r) => n + (r.switchSavingCents ?? 0), 0);
    if (switchTotal > 0) {
      const top = cheaper[0];
      rows.push({
        key: "switch-supplier",
        says: `${money(switchTotal)} a month buying ${cheaper.length} drug${cheaper.length === 1 ? "" : "s"} from a cheaper supplier already on file.`,
        todo: `Start with ${top.name ?? top.ndc11}: ${money(top.switchSavingCents ?? 0)} on what you dispensed, buying from ${top.best?.supplier ?? "the cheaper source"} instead.`,
        amountCents: switchTotal,
        cadence: "recurring_monthly",
        confidence: "likely",
        basis:
          "Your invoice price against the cheapest price on any catalogue held, both per unit and both after the rebate that supplier actually pays. It assumes you go on dispensing the same quantities.",
        href: "/purchasing",
      });
    }

    const losing = losers(margins(ledger.rows));
    const lossTotal = losing.reduce((n, m) => n + Math.abs(m.marginCents), 0);
    if (lossTotal > 0) {
      rows.push({
        key: "dispensed-at-a-loss",
        says: `${money(lossTotal)} lost dispensing ${losing.length} product${losing.length === 1 ? "" : "s"} for less than they cost.`,
        todo: `Look at ${losing[0].name ?? losing[0].ndc11} first — ${money(Math.abs(losing[0].marginCents))} on ${losing[0].claims} claim${losing[0].claims === 1 ? "" : "s"} from ${losing[0].supplier ?? "your supplier"}. Either the price is wrong or the plan is.`,
        amountCents: lossTotal,
        cadence: "recurring_monthly",
        confidence: "certain",
        basis: "What the plans and patients paid against the effective cost of what you bought — the invoice price less the rebate that supplier really pays on the line.",
        href: "/purchasing",
        overlapsWith: ["switch-supplier"],
      });
    }
    if (ledger.rate === null) {
      blocked.push({
        says: "Every contract line is being compared at its gross invoice price, so savings here are understated.",
        todo: "Send the monthly rebate report, or enter the tier ladder, so a contract generic is priced at what it really costs.",
        href: "/suppliers",
      });
    }
  } catch {
    // Purchasing needs invoices, catalogues and claims. Missing any, it contributes nothing.
  }

  // ── What the rebate ladder is leaving behind ──
  try {
    const { allSuppliers } = await import("./suppliers-registry");
    const { ratesFor } = await import("./rebate-rates");
    for (const s of (await allSuppliers(true)).filter((x) => x.active)) {
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
  try {
    const { claimFlags } = await import("./claims");
    const f = await claimFlags();
    if (f.underFee.length > 0 && f.underFeeShortfallCents > 0) {
      rows.push({
        key: "kansas-floor",
        says: `${money(f.underFeeShortfallCents)} paid below the Kansas floor on ${f.underFee.length} claim${f.underFee.length === 1 ? "" : "s"}.`,
        todo: "These are on plans the floor applies to and were paid less in total than the dispensing fee alone. Appeal them.",
        amountCents: f.underFeeShortfallCents,
        cadence: "one_off",
        confidence: "certain",
        basis: "Kansas SB 20: the floor is NADAC plus the greater of $10.50 and the Medicaid dispensing fee. Only plans classified as in scope are counted.",
        href: "/claims/floor",
      });
    }
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
    if (worth > 0) {
      const top = spread.sort((a, b) => (b.spreadPerFillCents ?? 0) * (b.worstPayer?.fills ?? 0) - (a.spreadPerFillCents ?? 0) * (a.worstPayer?.fills ?? 0))[0];
      rows.push({
        key: "payer-spread",
        says: `${money(worth)} is the gap between what your best and worst plans pay for the same drugs.`,
        todo: `${top.name ?? top.ndc11}: ${top.bestPayer!.name} pays ${money(top.spreadPerFillCents!)} more per fill than ${top.worstPayer!.name}. That difference is what a MAC appeal points at.`,
        amountCents: worth,
        cadence: "recurring_monthly",
        confidence: "worth checking",
        basis:
          "The per-fill margin of the best-paying plan against the worst, on drugs dispensed under both. Plans legitimately buy different things, so this is where to look rather than money already owed.",
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

  const ranked = rank(rows);
  return { rows: ranked, ...totals(ranked), blocked };
}
