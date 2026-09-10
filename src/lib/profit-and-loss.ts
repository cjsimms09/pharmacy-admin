/**
 * ── A month, honestly ───────────────────────────────────────────────────────────
 *
 * The arithmetic is easy. Deciding what belongs on each line is the whole job, and getting it wrong
 * produces an account that balances and misleads. Four decisions are worth stating outright.
 *
 * 1. COST OF GOODS COMES FROM WHAT WAS DISPENSED, NOT FROM WHAT WAS BOUGHT.
 *
 *    Purchases are not cost of goods. A month with a big buy-in looks catastrophic and the month
 *    that sells the stock looks wonderful, and neither figure means anything. The textbook fix is
 *    opening stock plus purchases less closing stock, which needs the shelves counted every month —
 *    which nobody does.
 *
 *    This pharmacy does not need to. PioneerRx prints the acquisition cost of every fill, so the
 *    cost of what was actually sold is already known, exactly, per bottle. That is the true cost of
 *    goods and it needs no stocktake at all. Purchases are still worth watching — the difference
 *    between them is stock building up or running down, which is cash, and it is reported as that
 *    rather than smuggled into profit.
 *
 * 2. REBATES REDUCE COST, THEY ARE NOT REVENUE.
 *
 *    A generic rebate is a discount arriving late. Booking it as income overstates both sales and
 *    cost of goods by the same amount, leaves profit right, and makes every margin percentage wrong.
 *
 * 3. DIR FEES COME OUT OF REVENUE, NOT OUT OF OVERHEADS.
 *
 *    They are money a plan said the pharmacy had earned and later took back. Filed as an operating
 *    cost they flatter the dispensing margin, which is the number used to decide what to stock and
 *    who to contract with.
 *
 * 4. CASH AND ACCRUAL ARE BOTH TRUE AND NEITHER IS OPTIONAL.
 *
 *    Accrual says what the month earned: a prescription dispensed on the 30th is September's, even
 *    though the plan pays in October. Cash says what reached the bank. A pharmacy is paid two to
 *    four weeks in arrears, so the two differ every month, and the gap between them is the
 *    receivable — real money, owed, and worth watching in its own right.
 *
 * What this cannot do is invent the lines nobody has entered. A month with no payroll in it will
 * report a profit the pharmacy did not make, so the account says what is missing rather than
 * printing a confident total over a hole.
 */
import { reconcileCogs, reconcileRevenue, type Check as ReconCheck } from "./reconcile";
import { standingLines } from "./standing-math";
import { todayIso } from "./dates";
import { formatCents } from "./money";


export type PLLine = { label: string; amountCents: number; note?: string };

export type MonthlyPL = {
  month: string;
  basis: "accrual" | "cash";
  /**
   * Dispensings in the month, one per bottle rather than one per transmission.
   *
   * On the result as well as the inputs because every per-script figure divides by it, and a
   * period report that had to reach back into the loader for it would end up with a second
   * definition of "a script".
   */
  claimsCount: number;

  /** What the month took, before anything is taken back out of it. */
  revenue: PLLine[];
  revenueCents: number;
  /** DIR fees, chargebacks: money already counted as revenue and since removed. */
  offsets: PLLine[];
  netRevenueCents: number;

  /** What the goods sold actually cost, less what the rebates took off them. */
  costOfGoods: PLLine[];
  costOfGoodsCents: number;
  grossProfitCents: number;
  /** Gross profit as a share of net revenue. The number that says whether dispensing works at all. */
  grossMarginPercent: number | null;

  operating: PLLine[];
  operatingCents: number;
  /**
   * What the standing costs come to for the WHOLE month, not the part accrued so far.
   *
   * `operatingCents` is the month to date — payroll accrued by the day, rent likewise — which is
   * the right figure for an account of what has happened. It is the wrong one to subtract from a
   * revenue figure that has been scaled to the whole month, and `pace` was doing exactly that.
   */
  standingWholeMonthCents: number;
  netProfitCents: number;

  /**
   * Money that left the bank and is not a cost: loan principal, owner draws, equipment bought
   * outright, income tax. Cash basis only — on the accrual account these lines are empty and the
   * cash change is null, because profit is before them and the account says so.
   */
  otherCashOut: PLLine[];
  otherCashOutCents: number;
  /** Net cash from operations less the other cash out: what the bank balance actually did. */
  cashChangeCents: number | null;

  /**
   * Bought less dispensed: stock going onto the shelf or coming off it.
   *
   * Not profit and never counted as it. It is where the cash went, which is a different question and
   * one a pharmacy with a good month and an empty bank account needs answered.
   */
  stockMovementCents: number | null;
  /** What each figure's independent source says, and where they disagree. */
  reconciliation: {
    cogs: { checks: ReconCheck[]; impliedCogsCents: number | null; stockMovementCents: number | null };
    revenue: ReconCheck[];
  };

  /**
   * What the account cannot see, named rather than left to be discovered.
   *
   * A silently missing line does not read as missing; it reads as a better month.
   */
  missing: string[];
  /** Whether enough is present for the bottom line to mean anything. */
  usable: boolean;
  /**
   * Figures the account computed and knows are wrong in a stated direction.
   *
   * Distinct from `missing`, which means a line could not be worked out at all and the bottom line
   * is meaningless without it — a month with no payroll is not a slightly optimistic month, it is
   * a fiction. A caveat is different: the number is readable and useful and leans, and saying which
   * way it leans is what lets it be trusted. Lumping the two would make `usable` trip on everything
   * and stop meaning anything at all.
   */
  caveats: string[];
};

export type PLInputs = {
  month: string;
  basis: "accrual" | "cash";
  /** From the System Sales Summary: the whole till, retail included. Accrual. */
  sales: { retailCents: number | null; retailCostCents?: number | null; rxPatientCents: number | null; rxRemitCents: number | null; totalCents: number | null } | null;
  /** From the remittances actually banked, where the basis is cash. */
  receipts: { kind: string; amountCents: number }[];
  /** Facilitator and top-off money that reached fills in the month. */
  laterMoneyCents: number;
  /**
   * Prescription revenue from the claims themselves: every plan's remittance plus what the patient
   * paid, per dispensing, for fills dated in the month.
   *
   * A fallback for the accrual account, never an addition. The System Sales Summary is the
   * authority because it is the only report carrying the front of shop as well — but when it has
   * not been loaded, the claims know the prescription side exactly, and showing nothing while a
   * month of claims sits in the database is the answer that makes the page look broken.
   */
  claimsRevenueCents?: number | null;
  /** The same figure split, so the summary and the claims can each supply the half they know. */
  claimsRemitCents?: number | null;
  claimsPatientCents?: number | null;
  claimsCount?: number;
  /**
   * Filled this month and still in the will-call bin: not revenue, and not a shortfall either.
   *
   * Named on the account so a full bin is never read as a bad month. The cost is stated with it
   * because that stock is still on the shelf — it is inventory, not cost of goods, and the two
   * figures move together.
   */
  /**
   * Fills sold this month whose acquisition cost the report never printed.
   *
   * Held out of revenue and cost together. Named because the fix is somebody chasing a cost, not
   * the account guessing one.
   */
  costUnknownFills?: number;
  costUnknownRevenueCents?: number | null;
  waitingFills?: number;
  waitingRevenueCents?: number | null;
  waitingCostCents?: number | null;
  /** The value on the shelf at the first and last count of the month, for the independent check. */
  openingStockCents?: number | null;
  closingStockCents?: number | null;
  /** The acquisition cost of everything dispensed in the month, from the claims themselves. */
  dispensedCostCents: number | null;
  /** What the wholesalers were invoiced for in the month, for the stock comparison only. */
  purchasesCents: number | null;
  /**
   * What was actually paid to the wholesalers in the month, from the invoices marked paid.
   *
   * The cash account's cost of goods: the wholesaler invoices dated in the month. Null where the
   * month has none, which is not the same as zero and must never be shown as it.
   */
  billedPurchasesCents: number | null;
  /** The month's invoices as filed, so the register can see a bill that is on file twice. */
  invoicesInMonth?: { invoiceNumber: string | null; totalCents: number | null; invoiceDate: string | null; fingerprint?: string | null }[];
  /**
   * The part of that which is PioneerRx's receiving record standing in for an invoice that never came.
   *
   * Named on the account because it is weaker evidence than a document the wholesaler sent, and
   * because the fix is chasing an invoice rather than accepting the figure.
   */
  uninvoicedPurchasesCents?: number | null;
  uninvoicedPurchases?: number;
  /**
   * The standing costs the month carries so far: payroll and rent by the day, each already reduced
   * to the month's share. Dropped where a real bill from the same vendor is entered for the month.
   */
  standing?: { name: string; categoryId: string | null; categoryName: string; kind: string; accruedCents: number; amountCents: number; days: number; of: number; noPaidDay?: boolean }[];
  /**
   * Rebates the month's buying earned. Used on an accrual basis, where the discount belongs to the
   * month that earned it rather than the month the cheque cleared.
   */
  rebatesCents: number | null;
  /** Every confirmed bill in the month, already placed on the right side of the account. */
  expenses: { categoryId: string | null; categoryName: string; kind: string; amountCents: number }[];
  /**
   * Revenue the month earned on account and has not collected, and cost that went out unbilled.
   *
   * Neither changes the profit — an accrual account counts a sale when it is made, and the cash
   * account below draws only from what was actually banked, so neither figure can leak into the
   * wrong basis. They are here because "the month made this, and this much of it is not money yet"
   * is the sentence that stops a good month being spent before it arrives.
   */
  onAccount?: { receivableCents: number; unbilledCostCents: number } | null;
};

const sum = (xs: { amountCents: number }[]) => xs.reduce((n, x) => n + x.amountCents, 0);

/** Adds bills up by category, dropping the categories nothing was spent on. */
function byCategory(rows: PLInputs["expenses"], kind: string): PLLine[] {
  const by = new Map<string, number>();
  for (const e of rows) {
    if (e.kind !== kind) continue;
    by.set(e.categoryName, (by.get(e.categoryName) ?? 0) + e.amountCents);
  }
  return [...by.entries()]
    .filter(([, cents]) => cents !== 0)
    .map(([label, amountCents]) => ({ label, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

export function monthlyPL(given: PLInputs): MonthlyPL {
  /*
   * Standing costs are expenses the month is owed so far. They join the bills by category before
   * anything is added up, so payroll accrued to the 15th sits on the same line as a payroll bill
   * would, and the account reads the same whether the bill has come or not.
   */
  const missing: string[] = [];
  const caveats: string[] = [];
  /*
   * On the cash basis a standing cost counts on the day it is paid, and one with no paid day is
   * not guessed at: it is left out and named, so the cash account never carries an accrual by
   * mistake and never silently omits payroll either.
   */
  const placed = (given.standing ?? []).filter((st) => !(given.basis === "cash" && st.noPaidDay));
  for (const st of (given.standing ?? []).filter((st) => given.basis === "cash" && st.noPaidDay)) {
    missing.push(`${st.name}, a standing cost with no day of the month it is paid. The cash account cannot place it; say on Spending which day the money leaves.`);
  }
  /*
   * A wholesaler bill filed on Spending is not counted on either basis. The wholesalers' money is
   * counted from the supplier invoices — as dispensed cost on the accrual account, by payment
   * date on the cash one — and a bill here as well is the same money twice. It is named rather
   * than dropped in silence, because the person who filed it meant it to count somewhere.
   */
  const wholesalerBills = given.expenses.filter((e) => e.kind === "cost_of_goods" && e.categoryName === "Drug purchases");
  if (wholesalerBills.length > 0) {
    const cents = wholesalerBills.reduce((n, e) => n + e.amountCents, 0);
    missing.push(
      `${wholesalerBills.length} bill${wholesalerBills.length === 1 ? "" : "s"} worth $${(cents / 100).toFixed(2)} filed under Drug purchases on Spending, and left out: wholesaler invoices are counted from the invoices page, so this is the same money twice if it is one of those, and belongs in another category if it is not.`,
    );
  }
  const i: PLInputs = {
    ...given,
    expenses: [
      ...given.expenses.filter((e) => !wholesalerBills.includes(e)),
      ...placed.map((st) => ({ categoryId: st.categoryId, categoryName: st.categoryName, kind: st.kind, amountCents: st.accruedCents })),
    ],
  };

  /*
   * Revenue, from whichever source actually answers the question being asked.
   *
   * On an accrual basis the System Sales Summary is the authority: it is drawn by the calendar month
   * and it is the only report carrying the front of shop. On a cash basis it says nothing at all,
   * because a September sale is October's money — so cash revenue comes from what was banked.
   */
  const revenue: PLLine[] = [];
  if (i.basis === "accrual") {
    /*
     * Each side of the revenue from the best source that has it, rather than all three or none.
     *
     * This used to be a single choice: a System Sales Summary, or the claims. That was fine while
     * the only source was the summary, and wrong the moment a partial one existed — a summary
     * carrying retail and no prescription figures would have taken the whole prescription side of
     * the account with it, silently, because the claims branch was an `else`.
     *
     * So the three components are chosen one at a time. The summary wins where it has a figure,
     * because it is the till and the till is what the bank will agree with. The claims stand in for
     * the prescription halves where it does not. And retail has no fallback at all: there is no
     * other source for what the front of shop took, so its absence is reported rather than papered
     * over with a nought.
     */
    /*
     * The split is preferred and the combined figure still works.
     *
     * `claimsRevenueCents` is what every existing caller passes, and a reader that only understood
     * the two halves would have shown a month of noughts to any of them. So the halves are used
     * where they are given and the whole is used where they are not.
     */
    const splitKnown = i.claimsRemitCents !== null && i.claimsRemitCents !== undefined;
    const remitCents = i.sales?.rxRemitCents ?? (splitKnown ? i.claimsRemitCents : null) ?? null;
    const patientCents = i.sales?.rxPatientCents ?? (splitKnown ? i.claimsPatientCents : null) ?? null;
    const fromClaims = !i.sales?.rxRemitCents && !i.sales?.rxPatientCents;
    if (remitCents) {
      revenue.push({
        label: "Third-party remittance",
        amountCents: remitCents,
        note: fromClaims ? `From the claims, across ${(i.claimsCount ?? 0).toLocaleString()} dispensings.` : undefined,
      });
    }
    if (patientCents) {
      revenue.push({
        label: "Patient payments",
        amountCents: patientCents,
        note: fromClaims ? "What patients paid at the counter, as the claims recorded it." : undefined,
      });
    }
    if (i.sales?.retailCents) {
      revenue.push({ label: "Retail and over the counter", amountCents: i.sales.retailCents, note: "Before sales tax. The tax collected is the state's money and is not in this account." });
    }
    // Neither half known, but a combined claims figure was given: show it as one line, as before.
    if (!remitCents && !patientCents && i.claimsRevenueCents) {
      revenue.push({
        label: "Prescriptions, from the claims",
        amountCents: i.claimsRevenueCents,
        note: `Every plan’s remittance plus what the patient paid, across ${(i.claimsCount ?? 0).toLocaleString()} dispensings.`,
      });
    }
    if (!remitCents && !patientCents && !i.claimsRevenueCents) {
      missing.push("The System Sales Summary for this month, which is the only report carrying retail sales as well as prescriptions.");
    } else if (!i.sales?.retailCents) {
      missing.push(
        "What the front of shop took this month. Prescriptions are complete, but retail and over-the-counter sales are missing entirely — so revenue, gross profit and net profit are all understated by whatever it was.",
      );
    }
    if (i.laterMoneyCents) {
      revenue.push({
        label: "Facilitator and top-off payments",
        amountCents: i.laterMoneyCents,
        note: "Earned on claims already dispensed and paid weeks later. Counted here because the month earned it.",
      });
    }
    /*
     * Not a line, a note against the revenue above.
     *
     * On an accrual basis an account sale is revenue the moment it is made, which is right and is
     * also how a profitable month runs out of money. Adding it again as a line would double the
     * sale; leaving it unsaid lets the profit be read as cash.
     */
    if (i.onAccount && i.onAccount.receivableCents > 0) {
      revenue.push({
        label: "— of which on account, not yet collected",
        amountCents: 0,
        note: `$${(i.onAccount.receivableCents / 100).toFixed(2)} of the revenue above was billed to an account rather than taken at the counter. It is earned and it is not money yet.`,
      });
    }
  } else {
    const banked = i.receipts.filter((r) => r.kind !== "rebate");
    const label: Record<string, string> = {
      third_party: "Third-party remittances banked",
      patient: "Patient payments banked",
      retail: "Retail takings banked",
      facilitator: "Facilitator payments banked",
      other: "Other receipts",
    };
    const by = new Map<string, number>();
    for (const r of banked) by.set(label[r.kind] ?? r.kind, (by.get(label[r.kind] ?? r.kind) ?? 0) + r.amountCents);
    for (const [l, c] of by) revenue.push({ label: l, amountCents: c });
    if (banked.length === 0) missing.push("What actually reached the bank this month. Without it a cash account has no revenue at all.");
  }
  const revenueCents = sum(revenue);

  const offsets = byCategory(i.expenses, "revenue_offset");
  const netRevenueCents = revenueCents - sum(offsets);

  /*
   * Cost of goods: what the bottles that left the shelf cost, plus anything filed against them.
   *
   * Drug purchases are deliberately not read from the expenses list. They arrive as supplier
   * invoices and are counted from those, and a wholesaler bill entered here as well would count the
   * same money twice — which is why the seeded category says so.
   */
  /*
   * The two accounts answer different questions here, and answering both with the same figure is
   * wrong on at least one of them every month.
   *
   * Accrual matches cost to the revenue it produced: what the bottles that left the shelf cost,
   * whenever they were bought or paid for. Cash records money as it leaves: what the wholesalers
   * were actually paid this month, whenever those bottles are dispensed. In a month of building
   * stock the cash account is the worse of the two and should be; in a month of running it down it
   * is the better. Showing dispensed cost on both made the cash account quietly track the accrual
   * one and say nothing about the bank.
   */
  const costOfGoods: PLLine[] = [];
  if (i.basis === "accrual") {
    if (i.dispensedCostCents !== null) {
      costOfGoods.push({
        label: "Acquisition cost of what was dispensed",
        amountCents: i.dispensedCostCents,
        note: "Taken per bottle from the claims themselves, so it needs no stocktake and does not move with when the stock was bought or paid for.",
      });
    } else {
      missing.push("The acquisition cost of what was dispensed — no claims are loaded for this month, so there is no cost of goods.");
    }
    /*
     * And what the front-of-shop goods cost.
     *
     * Retail revenue used to arrive with nothing against it, because cost of goods here is the
     * acquisition cost on each claim and a bottle of shampoo has no claim. Booked that way it is
     * pure profit, which flatters the margin by the whole cost of the front shop. PioneerRx's till
     * carries the cost on every line, so where the source supplies one it is booked beside the
     * dispensed cost and the caveat further down no longer applies.
     */
    if (i.sales?.retailCostCents) {
      costOfGoods.push({ label: "What the retail goods cost", amountCents: i.sales.retailCostCents });
    }

    /*
     * The front of shop, counted on one side only.
     *
     * Retail and over-the-counter revenue comes off the till summary and goes into this account in
     * full. The cost of goods on the accrual basis comes from one place — the acquisition cost
     * printed on each dispensing — and a dispensing is a prescription. An OTC sale never becomes a
     * claim, so nothing on the cost side of this account has ever known what the front of shop cost
     * to buy.
     *
     * That is not a rounding difference. On this pharmacy's August the retail line was $5,078 and
     * every cent of it fell to profit. At any ordinary front-of-shop margin the month reads two and
     * a half to three thousand dollars better than it was, and it errs in the direction that
     * flatters — which is the direction an account must never quietly err in.
     *
     * The site has nowhere yet to get the figure: the Purchase Drill Down knows what OTC was bought
     * for, but that is purchases rather than cost of sales and it is not stored. Until it is, the
     * honest thing is to refuse to let the number pass unremarked.
     */
    /*
     * Only where the cost really is missing. The till supplies it now, so a month that has it must
     * not still be warned that it has not — a caveat that fires when it is untrue teaches the
     * reader to skip the ones that are.
     */
    if (i.sales?.retailCents && !i.sales.retailCostCents) {
      caveats.push(
        `What the retail and over-the-counter goods cost to buy. $${(i.sales.retailCents / 100).toFixed(2)} of front-of-shop sales is ` +
          "counted as revenue and nothing is counted against it, because cost of goods here is the acquisition cost on each " +
          "dispensing and an OTC sale is not a dispensing. Profit below is overstated by whatever that stock cost.",
      );
    }
  } else if (i.billedPurchasesCents !== null) {
    costOfGoods.push({
      label: "Billed by the wholesalers",
      amountCents: i.billedPurchasesCents,
      note:
        "Every wholesaler invoice dated in this month, at its own total." +
        (i.uninvoicedPurchases
          ? ` ${i.uninvoicedPurchases} of these have no invoice on file — ${formatCents(i.uninvoicedPurchasesCents ?? 0)} taken from PioneerRx's own record of receiving them, which is what the pharmacy has until the wholesaler's document turns up.`
          : "") +
        " The accrual account counts something different on purpose — what the month's dispensings cost to buy — so a month with a big buy-in reads worse here and better there, which is the gap between the two bases doing its job.",
    });
  } else {
    missing.push(
      "What the wholesalers billed this month. No wholesaler invoice is dated in this month, so a cash account has no cost of goods — " +
        "the dispensed cost is deliberately not substituted, because that is the accrual answer and would make the two accounts agree when they should not.",
    );
  }
  /*
   * Rebates follow the basis, like everything else.
   *
   * A wholesaler settles a month's rebate a month or two after it closes, so "earned" and "received"
   * are different months and both are true. An accrual account wants the discount against the buying
   * that earned it; a cash account wants the month the money actually arrived. Using one figure for
   * both would put the same rebate in the wrong month on one of the two accounts, every month.
   */
  /*
   * The wholesaler's own statement beats the estimate. A rebate entered on Spending under
   * "Wholesaler rebates" is the figure the wholesaler settled, and the estimate from the ladder
   * was only ever standing in for it; both on the account would take the discount twice. On the
   * cash basis the same statement entered as a receipt of kind "rebate" is the fact, and a bill
   * with a paid date says the same thing, so the receipts win and the bill is dropped.
   */
  const statedRebate = i.expenses.filter((e) => e.kind === "cost_of_goods" && e.categoryName === "Wholesaler rebates");
  const rebateReceipts = i.receipts.filter((r) => r.kind === "rebate").reduce((n, r) => n + r.amountCents, 0);
  const rebateCents = i.basis === "cash" ? rebateReceipts : statedRebate.length > 0 ? 0 : (i.rebatesCents ?? 0);
  if (rebateCents) {
    costOfGoods.push({
      label: i.basis === "cash" ? "Wholesaler rebates received" : "Wholesaler rebates earned",
      amountCents: -Math.abs(rebateCents),
      note:
        i.basis === "cash"
          ? "Settled this month, on buying done a month or two ago. A discount arriving late, so it reduces cost rather than adding to revenue."
          : "Estimated from this month's invoice lines at the ladder in force, until the wholesaler's statement is entered on Spending under Wholesaler rebates, which then takes its place. A discount, so it reduces cost rather than adding to revenue.",
    });
  }
  const dropStatedRebate = i.basis === "cash" && rebateReceipts !== 0;
  for (const l of byCategory(i.expenses.filter((e) => !(dropStatedRebate && statedRebate.includes(e))), "cost_of_goods")) {
    costOfGoods.push(l.label === "Wholesaler rebates" ? { ...l, note: "The wholesaler's statement, entered on Spending. It replaces the estimate from the ladder." } : l);
  }
  const costOfGoodsCents = sum(costOfGoods);

  const grossProfitCents = netRevenueCents - costOfGoodsCents;
  const grossMarginPercent = netRevenueCents > 0 ? Math.round((grossProfitCents / netRevenueCents) * 1000) / 10 : null;

  const operating = byCategory(i.expenses, "operating");
  const operatingCents = sum(operating);
  const netProfitCents = grossProfitCents - operatingCents;

  /*
   * Below the line, on the cash account only: money that left and is not a cost.
   *
   * The loan's principal, the owner's draws, a fridge bought outright, the tax bill. On the accrual
   * account none of it is an expense and profit is stated before it; on the cash account it is
   * exactly what makes "the month made money and the balance went down" true, so it is shown and
   * the cash change is the figure after it.
   */
  const otherCashOut = i.basis === "cash" ? byCategory(i.expenses, "balance_sheet") : [];
  const otherCashOutCents = sum(otherCashOut);
  const cashChangeCents = i.basis === "cash" ? netProfitCents - otherCashOutCents : null;

  /*
   * The lines whose absence would otherwise read as a better month.
   *
   * Wages are the test. In an independent pharmacy they are commonly more than half of gross profit,
   * so a month without them does not look slightly optimistic — it looks profitable when it was not.
   */
  /*
   * A full bin is not a bad month, and the account has to say so.
   *
   * Revenue is counted when the script is collected, so a month that dispensed heavily on its last
   * few days reads low until those scripts are picked up. Without this line the reader has no way
   * to tell that from trade actually falling away.
   */
  if (i.waitingFills && (i.waitingRevenueCents ?? 0) > 0) {
    caveats.push(
      `${i.waitingFills.toLocaleString("en-US")} prescriptions filled this month are still in the bin, ` +
        `${formatCents(i.waitingRevenueCents ?? 0)} of them. None of it is revenue until somebody collects them, and the ` +
        `${formatCents(i.waitingCostCents ?? 0)} of stock behind them is on the shelf rather than in cost of goods. ` +
        "A script unclaimed for a fortnight is reversed, so some of this will never be revenue at all.",
    );
  }

  if (i.costUnknownFills && (i.costUnknownRevenueCents ?? 0) > 0) {
    caveats.push(
      `${i.costUnknownFills.toLocaleString("en-US")} prescriptions sold this month carry no acquisition cost, so ${formatCents(i.costUnknownRevenueCents ?? 0)} of revenue is held out of this account along with the cost that would have gone against it. ` +
        "Counting the revenue with nothing behind it would put the whole of it into gross profit. The figure is missing from the report, not from the pharmacy — the fills are real and so is the money.",
    );
  }

  const spent = new Set(operating.filter((l) => l.amountCents !== 0).map((l) => l.label));
  /*
   * A cost the pharmacy has told the site about is not a cost the site has forgotten.
   *
   * On the cash basis a standing cost is nought until the day it is paid, so payroll on the 30th
   * shows nothing on the 9th — correctly, no money has left the bank. But the line below reads a
   * nought as an omission, and told the owner wages were missing on the very month he had just
   * entered them, in the words "without it this account is not conservative, it is wrong". It is
   * not wrong; it is early. Where the figure is on file and merely not due, that is a caveat about
   * a month in progress, not a hole in the account.
   */
  const onFile = new Map((given.standing ?? []).filter((st) => !st.noPaidDay).map((st) => [st.categoryName, st] as const));
  const absent = (label: string, why: string) => {
    if (spent.has(label)) return;
    const st = onFile.get(label);
    if (st && i.basis === "cash") {
      caveats.push(`${label} is on file at ${formatCents(st.amountCents)} a month and is not paid until later in the month, so the cash account does not carry it yet. The accrual account does.`);
      return;
    }
    missing.push(why);
  };
  absent("Wages and salaries", "Wages and salaries. Usually the largest cost a pharmacy has — without it this account is not conservative, it is wrong.");
  absent("Rent and occupancy", "Rent and occupancy.");
  absent(
    "Card processing and bank fees",
    "Card processing and bank fees — two to three per cent of everything taken on a card, and nobody sends an invoice for it.",
  );
  /*
   * DIR fees are entered by hand, so their absence means "nobody has entered them yet" far more
   * often than it means "there were none". Silence on a line that only ever reduces profit reads as
   * good news, which is exactly the wrong way for a missing figure to read.
   */
  if (offsets.length === 0) {
    missing.push("DIR fees and price concessions for the month. These are entered by hand, so an empty line means nobody has entered them rather than that there were none.");
  }

  const stockMovementCents = i.purchasesCents !== null && i.dispensedCostCents !== null ? i.purchasesCents - i.dispensedCostCents : null;

  /*
   * Where each figure came from, and what an independent record of the same month says.
   *
   * The account is only worth reading if a number that ought to be corroborated has been. Cost of
   * goods has a genuinely independent second source — opening stock plus purchases less closing
   * stock uses nothing from the claims — and revenue has one too, in the till report. Both are
   * computed here so the page can show its working rather than only its verdict.
   */
  const reconciliation = {
    cogs: reconcileCogs({
      dispensed: { cents: i.dispensedCostCents, from: "the acquisition cost on each dispensing" },
      purchases: { cents: i.purchasesCents, from: "the wholesaler invoices dated in the month" },
      openingStock: { cents: i.openingStockCents ?? null, from: "the dispensing shelf at the last inventory count before the month began" },
      closingStock: { cents: i.closingStockCents ?? null, from: "the dispensing shelf at the last inventory count of the month" },
    }),
    revenue: reconcileRevenue({
      claims: { cents: i.claimsRevenueCents ?? null, from: "every plan's remittance plus what the patient paid" },
      tillRx: {
        cents: i.sales ? (i.sales.rxRemitCents ?? 0) + (i.sales.rxPatientCents ?? 0) || null : null,
        from: "the System Sales Summary's prescription lines",
      },
      banked: {
        cents: i.receipts.filter((r) => r.kind !== "rebate").reduce((n, r) => n + r.amountCents, 0) || null,
        from: "receipts recorded against the month",
      },
    }),
  };

  return {
    month: i.month,
    basis: i.basis,
    claimsCount: i.claimsCount ?? 0,
    revenue,
    revenueCents,
    offsets,
    netRevenueCents,
    costOfGoods,
    costOfGoodsCents,
    grossProfitCents,
    grossMarginPercent,
    operating,
    operatingCents,
    standingWholeMonthCents: (i.standing ?? []).filter((st) => !(i.basis === "cash" && st.noPaidDay)).reduce((n, st) => n + st.amountCents, 0),
    netProfitCents,
    otherCashOut,
    otherCashOutCents,
    cashChangeCents,
    stockMovementCents,
    reconciliation,
    missing,
    /* A bottom line is only worth printing when the biggest costs are actually in it. */
    usable: missing.length === 0,
    caveats,
  };
}

/**
 * Assembles a month from everything the site already holds.
 *
 * Nothing here computes; it gathers. The arithmetic and every decision about where a figure belongs
 * is in `monthlyPL` above, kept pure so a month can be checked against the page it came from by
 * hand — which is the only way anybody will ever trust a profit figure they did not add up
 * themselves.
 */
export async function monthlyAccount(month: string, basis: "accrual" | "cash" = "accrual"): Promise<MonthlyPL> {
  // One month in, one account out: `accountsFor` computes every month it is given.
  return (await accountsFor([month], basis)).months[0];
}

/**
 * A run of months, computed from one read of everything under them.
 *
 * The one place a month's account is produced from the database, and the reason it exists is a
 * fault rather than a tidiness: the books at `/money` and the reports at `/money/report` grew two
 * separate routes to the same figures, and the reporting one read every claim the site holds once
 * *per month* — three passes for a quarter, twelve for a year, and on the report page eighteen in
 * a single load, since the period, the period before it and the twelve-month chart each did their
 * own. Nothing underneath changes between one month's account and the next, so it is read once and
 * sliced.
 *
 * The other half of the fault mattered more than the speed. Two routes to a number are two numbers
 * eventually, and this is the owner's books: *"needs to not double count things."* Both surfaces
 * now come through here, so a quarter on one page and a quarter on the other are the same
 * arithmetic over the same read, and cannot drift apart.
 *
 * The inputs each account was built from come back too, in the same order: the double-count
 * register reads them to say which of two routes to a figure the account took, and slicing them a
 * second time would be the extra pass this exists to remove.
 *
 * What does **not** come back is the shared read itself, and that is a correction rather than a
 * choice. This result is held between requests, so everything in it is pinned for as long as the
 * key lives — and `SharedInputs` carries every fill, every supplier invoice, every invoice line,
 * every stock count and every payment across the whole span. Handing it back put a year of claims
 * into the cache under three separate keys at once (the month's books, the six-month strip, the
 * twelve-month trend), on a machine that shares 7.3 GB with the dispensing system and where the
 * counter has already lost its page for ninety seconds.
 *
 * What the books actually want from that read is three fields per fill. So three fields per fill is
 * what they get, projected inside the held computation so the rows behind it can be collected the
 * moment this returns rather than living as long as the cache entry.
 */
export type FillForScripts = { dateFilled: string; cashPlan: boolean; revenueCents: number };

export async function accountsFor(
  months: string[],
  basis: "accrual" | "cash",
): Promise<{ months: MonthlyPL[]; inputs: PLInputs[]; fills: FillForScripts[] }> {
  const wanted = [...new Set(months)].sort();
  if (wanted.length === 0) throw new Error("accountsFor needs at least one month; an empty period is answered without a read.");
  const { held } = await import("./held");
  return held(`accounts:${basis}:${wanted.join(",")}`, async () => {
    const shared = await loadShared(wanted, basis);
    const inputs = wanted.map((m) => monthInputs(m, basis, shared));
    return {
      months: inputs.map(monthlyPL),
      inputs,
      fills: shared.fills.map((f) => ({ dateFilled: f.dateFilled, cashPlan: f.cashPlan, revenueCents: f.revenueCents })),
    };
  });
}

/**
 * Everything a run of months needs, read once.
 *
 * A quarter is three months and a year twelve, and each month used to re-read every claim the site
 * holds. The claims, the invoices and the suppliers do not change between one month's account and
 * the next, so they are loaded once and sliced per month.
 */
export type SharedInputs = {
  basis: "accrual" | "cash";
  sales: Awaited<ReturnType<typeof import("./sales-store").salesMonths>>;
  cats: Awaited<ReturnType<typeof import("./expenses").categories>>;
  fills: Awaited<ReturnType<typeof import("./claims").allFills>>;
  suppliers: Awaited<ReturnType<typeof import("./suppliers-registry").allSuppliers>>;
  invoices: { totalCents: number | null; paidOn: string | null; invoiceDate: string | null; supplierId: string | null; supplier: string | null; invoiceNumber: string | null; fingerprint: string | null }[];
  /**
   * What PioneerRx recorded receiving. Not invoices — see the table comment — but the only evidence
   * of a purchase whose invoice never reached the pharmacy.
   */
  pioneerPurchases: { invoiceNumber: string | null; invoiceDate: string | null; totalCents: number | null; supplier: string | null }[];
  /** Every standing cost on file; which apply to a month is decided per month. */
  standing: { id: string; name: string; categoryId: string | null; vendorId: string | null; amountCents: number; fromMonth: string; toMonth: string | null; paidDay: number | null }[];
  /** The day the account is drawn, which decides how much of a standing cost a month in progress carries. */
  today: string;
  lines: { invoiceDate: string | null; extendedCents: number }[];
  counts: { countedOn: string; valueCents: number | null; rxValueCents: number | null }[];
  /** Money received against fills, by the day it arrived, for the cash account. */
  payments: { source: string; receivedOn: string | null; amountCents: number; revenueCents: number | null }[];
  /** Per month: the bills on the basis asked for, the receipts entered, the rebate earned, and the driver's invoices where the pharmacy pays them. */
  byMonth: Map<string, { bills: Awaited<ReturnType<typeof import("./expenses").expensesIn>>; receipts: { kind: string; amountCents: number }[]; rebatesCents: number | null; driverCents: number }>;
};

export async function loadShared(months: string[], basis: "accrual" | "cash"): Promise<SharedInputs> {
  /*
   * The window is taken from the first and last month asked for, so an empty list would read the
   * claims between "undefined-01" and "undefined-31" — no rows, no error, and an account of
   * nothing that looks exactly like an account of a quiet month. Refused by name instead: a caller
   * with no months to report on has an empty period, which it can say without reading anything.
   */
  if (months.length === 0) throw new Error("loadShared needs at least one month; an empty period is answered without a read.");
  const { salesMonths } = await import("./sales-store");
  const { expensesIn, cashReceiptsIn, categories } = await import("./expenses");
  const { allFills } = await import("./claims");
  const { earningSoFar } = await import("./rebate-rates");
  const { allSuppliers } = await import("./suppliers-registry");
  const { db, schema } = await import("@/db");
  const { and, gte, lte } = await import("drizzle-orm");

  const sorted = [...months].sort();
  const from = `${sorted[0]}-01`;
  const to = `${sorted[sorted.length - 1]}-31`;

  const { allStandingCosts } = await import("./standing-costs");
  const pioneerPurchases = await db.select().from(schema.pioneerPurchases);
  const [sales, cats, fills, suppliers, invoices, lines, counts, payments, standing] = await Promise.all([
    salesMonths(),
    categories(true),
    allFills({ from, to }),
    allSuppliers(true),
    db.query.supplierInvoices.findMany({ columns: { totalCents: true, paidOn: true, invoiceDate: true, supplierId: true, supplier: true, invoiceNumber: true, documentId: true } }),
    db.query.invoiceLines.findMany({ where: and(gte(schema.invoiceLines.invoiceDate, from), lte(schema.invoiceLines.invoiceDate, to)), columns: { invoiceDate: true, extendedCents: true } }),
    /*
     * Every count, not just the ones inside the months asked for: a month opens on the last count
     * taken before it began, which lives in the month before. It is one small row per count — a
     * week of daily ones and a closing one per month after retention — so the whole list is cheaper
     * than working out which single earlier row is wanted.
     */
    db.query.onHandImports.findMany({ columns: { countedOn: true, valueCents: true, rxValueCents: true } }),
    db.query.claimPayments.findMany({ columns: { source: true, receivedOn: true, amountCents: true, revenueCents: true } }),
    allStandingCosts(),
  ]);

  const byMonth: SharedInputs["byMonth"] = new Map();
  for (const month of sorted) {
    const [bills, receipts, earned, driverCents] = await Promise.all([
      expensesIn(month, basis),
      cashReceiptsIn(month),
      Promise.all(suppliers.map((s) => earningSoFar(s.id, month))),
      driverCostFor(month, basis),
    ]);
    byMonth.set(month, {
      bills,
      receipts: receipts.map((r) => ({ kind: r.kind, amountCents: r.amountCents })),
      rebatesCents: earned.reduce((n, e) => n + (e?.estimatedRebateCents ?? 0), 0) || null,
      driverCents,
    });
  }
  /*
   * What each invoice's document actually is, so a bill filed twice can be seen when neither copy
   * carries a number. IPD's two rows are the same PDF byte for byte and the duplicate check was
   * blind to them, which put $3,255.70 into the cash account twice.
   */
  const shas = new Map(
    (await db.query.documents.findMany({ columns: { id: true, sha256: true } })).map((d) => [d.id, d.sha256]),
  );
  return {
    basis,
    sales,
    cats,
    fills,
    suppliers,
    invoices: invoices.map((v) => ({ ...v, fingerprint: shas.get(v.documentId) ?? null })),
    lines,
    counts,
    payments,
    byMonth,
    standing,
    pioneerPurchases,
    today: todayIso(),
  };
}

/** One month's inputs, sliced from what was loaded. Nothing here computes; `monthlyPL` does. */
export function monthInputs(month: string, basis: "accrual" | "cash", shared: SharedInputs): PLInputs {
  const { sales: months, cats, fills, invoices, lines, counts } = shared;
  const per = shared.byMonth.get(month) ?? { bills: [], receipts: [], rebatesCents: null, driverCents: 0 };
  const sales = months.find((m) => m.month === month) ?? null;

  /*
   * The cost of what was actually dispensed in the month, per bottle, from the claims themselves.
   *
   * This is the figure that makes a stocktake unnecessary — see the note at the top of this file.
   * A fill with no acquisition cost on it is left out of both sides rather than counted as free.
   */
  /*
   * A prescription is revenue when the patient takes it away, not when it is filled.
   *
   * The owner: "I still don't think those scripts were picked up or paid at all.. no one paid those
   * prices." He was right, and it was not three scripts. 386 of September's fills were billed to a
   * plan and never collected — $55,713.96 of payer money and $16,990.53 of patient money, 43% of
   * the month, booked as revenue while the drugs sat in the will-call bin and their cost was
   * charged against them as though they had been sold.
   *
   * A fill in the bin has earned nothing. The plan will pay when it pays, the patient has handed
   * over nothing, and an unclaimed script is reversed after a fortnight — so booking it is not
   * early, it is wrong in the direction that flatters. Its stock is inventory, not cost of goods.
   *
   * So a fill belongs to the month it was *sold* in. PioneerRx's completed date says when that was
   * and the daily transaction report already prints it, so this needs nothing new to arrive: a paid
   * row with no completed date is transmitted and not yet picked up.
   *
   * Two consequences worth stating plainly. A fill dispensed in one month and collected in the next
   * is revenue in the second, which is correct and will make a month's figure move after it looked
   * finished. And a month in progress always understates, because today's fills have not been
   * collected yet — that is not a fault to be corrected but the point of the basis.
   */
  const monthFills = fills.filter((f) => (f.soldOn ?? "").startsWith(month));
  /*
   * Filled this month and still in the bin: named, never counted.
   *
   * Reported rather than dropped in silence, because the difference between "we sold less" and "we
   * have not been paid for it yet" is the difference between a bad month and a full bin.
   */
  const waiting = fills.filter((f) => !f.soldOn && f.dateFilled.startsWith(month));
  const waitingRevenueCents = waiting.reduce((n, f) => n + f.remitCents + f.patientPaidCents, 0);
  const waitingCostCents = waiting.reduce((n, f) => n + (f.acquisitionCents ?? 0), 0);
  /*
   * A fill whose cost nobody knows is left out of both sides, which is what this file has always
   * said it does and did not do.
   *
   * The rule is stated a few lines above — "A fill with no acquisition cost on it is left out of
   * both sides rather than counted as free" — and only the cost side honoured it. Revenue came from
   * every fill, so a bottle of unknown cost contributed its whole price to gross profit and nothing
   * against it. Thirty-nine September fills were in that state: an Adzenys, a Zepbound pen, an
   * Auvelity, $5,071.34 of revenue and $5,071.34 of profit, a third of the month's gross and
   * twenty-six times its bottom line.
   *
   * Both directions are wrong by the same amount, so the choice is which way to be wrong. Dropping
   * the revenue understates the month; keeping it flatters the month. This account has said in half
   * a dozen places that it must never quietly err in the flattering direction, so the revenue goes
   * out with the cost and the pair is named below with the figure, which is the only version
   * somebody can act on.
   */
  const costUnknown = monthFills.filter((f) => f.acquisitionCents === null);
  const costUnknownRevenueCents = costUnknown.reduce((n, f) => n + f.remitCents + f.patientPaidCents, 0);
  const mine = monthFills.filter((f) => f.acquisitionCents !== null);
  /*
   * What the month's dispensing actually brought in, per fill rather than per transmission, so a
   * coordinated claim is one bottle's revenue and not two.
   */
  const claimsRevenueCents = mine.length ? mine.reduce((n, f) => n + f.remitCents + f.patientPaidCents, 0) : null;
  // Kept apart as well as together: the summary can supply one side of the prescription revenue
  // and not the other, and an account that could only take all three figures or none of them was
  // one retail-only summary away from dropping every prescription. See the revenue block above.
  const claimsRemitCents = mine.length ? mine.reduce((n, f) => n + f.remitCents, 0) : null;
  const claimsPatientCents = mine.length ? mine.reduce((n, f) => n + f.patientPaidCents, 0) : null;
  const onAccount = {
    receivableCents: monthFills.reduce((n, f) => n + f.receivableCents, 0),
    unbilledCostCents: monthFills.reduce((n, f) => n + (f.unbilledCostCents ?? 0), 0),
  };
  const dispensedCostCents = mine.length ? mine.reduce((n, f) => n + (f.acquisitionCents ?? 0), 0) : null;
  const laterMoneyCents = monthFills.reduce((n, f) => n + f.laterPaymentsCents, 0);

  /* What the wholesalers billed in the month, for the stock comparison only — never as accrual cost of goods. */
  const monthLines = lines.filter((l) => l.invoiceDate?.startsWith(month));
  const purchasesCents = monthLines.length ? monthLines.reduce((n, l) => n + l.extendedCents, 0) : null;

  /*
   * What actually left the bank for goods this month: the invoices marked paid in it.
   *
   * The cash account's cost of goods. Counted on the invoice's own total where it has one, because
   * that is what was paid; where a total was never read the invoice cannot contribute and is
   * counted as unpaid-unknown instead of as zero.
   */
  /*
   * The owner: "Let's simplify it.. let's just use invoices in September."
   *
   * This used to be the day the money left, in order of how well it was known — a recorded payment
   * date, else the invoice date plus the supplier's payment terms, else the invoice date. That is
   * the cash basis in principle. In practice not one of September's 71 invoices carries a payment
   * date and not one of the 22 suppliers has terms on file, so every invoice fell through to its
   * own date and the cascade was three ways of arriving at the same $200,225.87 — while leaving a
   * standing instruction to key in 71 payment dates to make the account "exact". Nobody was ever
   * going to do that for a number the account already had.
   *
   * So the invoice date, plainly, which is the date the pharmacy itself means by a September bill.
   * The cost is the whole invoice where it has a total; an invoice whose total was never read
   * cannot contribute and is left out rather than counted as nought.
   */
  const billedThisMonth = invoices.filter((v) => v.totalCents !== null && v.invoiceDate?.startsWith(month));
  /*
   * The purchases PioneerRx recorded and no invoice ever arrived for.
   *
   * The owner: "I more just wanted to use it to catch the money from invoices we didn't get before
   * this was setup in September... it was for the money section." Invoices began arriving by email
   * partway through September, so the month's earlier purchases have no document at all — and the
   * pharmacy system's own receiving record is the only evidence they happened.
   *
   * Matched on the wholesaler's own invoice number, which both sides carry, so a purchase with a
   * real invoice is counted once from the invoice and never again from here. Where PioneerRx and the
   * invoice disagree on the figure the invoice wins: it is the document the pharmacy was billed on
   * and the one it has to pay.
   */
  const invoiceNumbers = new Set(invoices.map((v) => (v.invoiceNumber ?? "").trim().toUpperCase()).filter(Boolean));
  const uninvoiced = shared.pioneerPurchases.filter(
    (p) => p.totalCents !== null && p.invoiceDate?.startsWith(month) && !invoiceNumbers.has((p.invoiceNumber ?? "").trim().toUpperCase()),
  );
  const uninvoicedPurchasesCents = uninvoiced.length ? uninvoiced.reduce((n, p) => n + (p.totalCents ?? 0), 0) : null;
  const billedPurchasesCents =
    billedThisMonth.length || uninvoiced.length
      ? billedThisMonth.reduce((n, v) => n + (v.totalCents ?? 0), 0) + (uninvoicedPurchasesCents ?? 0)
      : null;


  /*
   * The shelf at each end of the month, which is what makes the cost of goods checkable at all.
   *
   * The closing position is the last count taken in the month. The opening position is the last
   * count taken *before* it — which is normally the previous month's closing count, and is the same
   * shelf seen from the other side.
   *
   * It used to take the first and last count within the month, which needed two counts in the same
   * month to report anything and was wrong even then: if the first count of September fell on the
   * third, two days of buying and dispensing sat outside the month's own arithmetic. The month
   * opens where the last one closed.
   *
   * The dispensing shelf, not the whole building: front-shop stock moves on retail sales that leave
   * no claim behind them.
   */
  const valued = counts
    .map((c) => ({ countedOn: c.countedOn, valueCents: c.rxValueCents ?? c.valueCents }))
    .filter((c) => c.valueCents !== null)
    .sort((a, b) => a.countedOn.localeCompare(b.countedOn));
  const inMonth = valued.filter((c) => c.countedOn.startsWith(month));
  const before = valued.filter((c) => c.countedOn < `${month}-01`);
  const closingStockCents = inMonth.length > 0 ? inMonth[inMonth.length - 1].valueCents : null;
  const openingStockCents = before.length > 0 ? before[before.length - 1].valueCents : null;

  /*
   * Facilitator money for the cash account, from the remittances themselves.
   *
   * The receipts list is typed in from the bank statement, and the one payer whose remittances the
   * site reads directly is the facilitator. Where nobody has typed a facilitator receipt for the
   * month, the payments the site holds with a received date in it stand in, and say so.
   */
  const receipts = [...per.receipts];
  if (basis === "cash" && !receipts.some((r) => r.kind === "facilitator")) {
    const banked = shared.payments.filter((p) => p.source === "mtf" && p.receivedOn?.startsWith(month)).reduce((n, p) => n + (p.revenueCents ?? p.amountCents), 0);
    if (banked > 0) receipts.push({ kind: "facilitator", amountCents: banked });
  }

  const byId = new Map(cats.map((c) => [c.id, c]));

  /* Payroll and rent by the day, dropped where the real bill for the month is already in. */
  const standing = standingLines(shared.standing, month, shared.today, per.bills, basis)
    .filter((l) => !l.replacedByBill)
    .map((l) => {
      const c = l.categoryId ? byId.get(l.categoryId) : undefined;
      return { name: l.name, categoryId: l.categoryId, categoryName: c?.name ?? "Uncategorised", kind: c?.kind ?? "operating", accruedCents: l.accruedCents, amountCents: l.amountCents, days: l.days, of: l.of, noPaidDay: l.noPaidDay };
    });
  return {
    month,
    basis,
    sales: sales ? { retailCents: sales.retailCents, retailCostCents: sales.retailCostCents ?? null, rxPatientCents: sales.rxPatientCents, rxRemitCents: sales.rxRemitCents, totalCents: sales.totalCents } : null,
    receipts,
    laterMoneyCents,
    claimsRevenueCents,
    claimsRemitCents,
    claimsPatientCents,
    costUnknownFills: costUnknown.length,
    costUnknownRevenueCents,
    waitingFills: waiting.length,
    waitingRevenueCents,
    waitingCostCents,
    claimsCount: monthFills.length,
    dispensedCostCents,
    purchasesCents,
    billedPurchasesCents,
    invoicesInMonth: billedThisMonth.map((v) => ({ invoiceNumber: v.invoiceNumber, totalCents: v.totalCents, invoiceDate: v.invoiceDate, fingerprint: v.fingerprint })),
    uninvoicedPurchasesCents,
    uninvoicedPurchases: uninvoiced.length,

    standing,
    openingStockCents,
    closingStockCents,
    rebatesCents: per.rebatesCents,
    onAccount,
    expenses: [
      ...per.bills.map((b) => {
        const c = b.categoryId ? byId.get(b.categoryId) : undefined;
        return {
          categoryId: b.categoryId,
          categoryName: c?.name ?? "Uncategorised",
          // A bill nobody has filed is an overhead until somebody says otherwise: it is the reading
          // that keeps it out of gross profit, where a wrong guess would move the margin.
          kind: c?.kind ?? "operating",
          amountCents: b.amountCents,
        };
      }),
      /*
       * The delivery round, where the pharmacy is the one paying for it.
       *
       * Nought in this pharmacy's arrangement, where the invoice is raised on the driver's behalf
       * and billed to the clinic — and `excludedFromAccount` says so on the page rather than
       * leaving the omission to be noticed. One setting governs both, so the account and the note
       * about it can never disagree.
       */
      ...(per.driverCents > 0
        ? [{ categoryId: null, categoryName: "Delivery round", kind: "operating", amountCents: per.driverCents }]
        : []),
    ],
  };
}

/**
 * Which months there is anything to report on, most recent first.
 *
 * The gate on both the books and the reports: a month not in this list is named as empty rather
 * than run through the account, because a month nobody has loaded anything for is not a month the
 * pharmacy took nothing in, and a column of noughts says the second thing.
 *
 * Money banked counts, and used not to. The list was drawn from sales, bills and claims — all
 * three accrual feeds — so a month whose only record was a deposit had nothing to report on and
 * disappeared from both surfaces, taking the cash account's only revenue with it. That is the one
 * feed the cash basis has, so leaving it out of the gate meant the gate could hide it.
 */
export async function accountMonths(): Promise<string[]> {
  const { salesMonths } = await import("./sales-store");
  const { db, schema } = await import("@/db");
  const [sales, bills, claims, receipts] = await Promise.all([
    salesMonths(),
    db.query.expenses.findMany({ columns: { invoiceDate: true } }),
    db.query.claims.findMany({ columns: { dateFilled: true } }),
    db.query.cashReceipts.findMany({ columns: { month: true } }),
  ]);
  void schema;
  const set = new Set<string>();
  for (const m of sales) set.add(m.month);
  for (const b of bills) set.add(b.invoiceDate.slice(0, 7));
  for (const c of claims) set.add(c.dateFilled.slice(0, 7));
  for (const r of receipts) set.add(r.month.slice(0, 7));
  return [...set].filter((m) => /^\d{4}-\d{2}$/.test(m)).sort().reverse();
}

/**
 * What the site knows about, in money, and deliberately keeps out of the month's account.
 *
 * The owner asked whether the money section takes the delivery charges into account. It does not,
 * and it should not — but an account that silently omits something the site plainly holds is
 * indistinguishable from one that forgot, and the only way to tell them apart was to read the
 * code. So the omissions are named, with this month's actual figures against them and the reason
 * in a sentence.
 *
 * The rule each of these follows is the same one: an account records the pharmacy's own money.
 * Raising somebody else's invoice is administration, not trade, and an order is not a cost until
 * somebody has priced it.
 */
export type AccountExclusion = {
  label: string;
  /** The money involved, where there is a figure. Null where the site holds no price. */
  amountCents: number | null;
  /** A count instead, where the figure is a number of things rather than an amount. */
  count: number | null;
  why: string;
  href: string;
};

export async function excludedFromAccount(month: string): Promise<AccountExclusion[]> {
  const out: AccountExclusion[] = [];
  const { db, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { getSettings } = await import("./settings");
  const s = await getSettings();

  /*
   * The delivery round.
   *
   * The pharmacy pays its own driver, so the round is an operating cost of the month (`driverCostFor`,
   * which the account uses). Only where the setting says the clinic pays him directly is the
   * invoice raised on his behalf and the money between the two of them, and then it is named
   * here so the omission is never mistaken for an oversight.
   */
  try {
    const invoices = await db.query.driverInvoices.findMany({ where: eq(schema.driverInvoices.month, month) });
    const total = invoices.reduce((n, i) => n + i.totalCents, 0);
    const { driverPaidBy } = await import("./driver-cost");
    if (invoices.length > 0 && driverPaidBy(s.driver_paid_by) !== "pharmacy") {
      out.push({
        label: `The delivery round — ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`,
        amountCents: total,
        count: null,
        why:
          `Raised here on the driver's behalf and billed to ${(s.driver_bill_to ?? "").trim() || "the clinic"}, so the money is ` +
          "between the two of them. If the pharmacy is the one paying him, say so in Settings and it becomes an operating cost of the month.",
        href: "/deliveries",
      });
    }
  } catch {
    /* No delivery records. */
  }

  /*
   * Supply orders.
   *
   * The site records what was asked for, never what it cost — the order is an email, and the price
   * arrives later on the vendor's own invoice. Booking the order would be inventing a figure; the
   * invoice, when it comes, is an ordinary bill and goes in as one.
   */
  try {
    const orders = await db.query.supplyOrders.findMany();
    const mine = orders.filter((o) => o.placedOn.startsWith(month) && o.status !== "cancelled" && o.status !== "draft");
    if (mine.length > 0) {
      const vendors = [...new Set(mine.map((o) => o.vendorName))];
      out.push({
        label: `Supply orders sent — ${mine.length} to ${vendors.join(", ")}`,
        amountCents: null,
        count: mine.length,
        why:
          "The order is an email; the price arrives on the vendor's invoice afterwards. Booking the order would be " +
          "inventing a figure. Record the invoice under Spending when it comes and it lands in this month's account.",
        href: "/purchasing/supplies",
      });
    }
  } catch {
    /* No supply orders. */
  }

  return out;
}

/**
 * The delivery round as a cost of the month. The rule is `driver-cost.ts`: the pharmacy pays its
 * driver unless the setting says the clinic does; a month in progress carries the draft's running
 * total on the accrual account; the cash account counts an invoice on the day it was sent.
 */
export async function driverCostFor(month: string, basis: "accrual" | "cash" = "accrual"): Promise<number> {
  const { db } = await import("@/db");
  const { getSettings } = await import("./settings");
  const { driverCostOf, driverPaidBy } = await import("./driver-cost");
  const s = await getSettings();
  const paidBy = driverPaidBy(s.driver_paid_by);
  if (paidBy !== "pharmacy") return 0;
  const invoices = await db.query.driverInvoices.findMany({ columns: { month: true, status: true, totalCents: true, sentAt: true } });
  return driverCostOf(invoices, month, basis, paidBy);
}

/**
 * A quarter or a year, and the months behind it.
 *
 * Each month is computed by `monthlyAccount` exactly as the monthly screen computes it, and then
 * added up by `period-account.ts`. Nothing is recomputed a second way, so a quarter can never
 * disagree with the three months printed inside it — which is the failure mode of every
 * spreadsheet this replaces.
 *
 * Only months with something recorded are loaded. A year of empty months would be twelve full
 * passes over the claims to produce twelve zeroes, and the period names its empty months anyway.
 */
export async function periodAccount(
  periodKey: string,
  basis: "accrual" | "cash" = "accrual",
): Promise<import("./period-account").PeriodTotals | null> {
  const { parsePeriod, periodTotals } = await import("./period-account");
  const period = parsePeriod(periodKey);
  if (!period) return null;
  const have = new Set(await accountMonths());
  const wanted = period.months.filter((m) => have.has(m));
  if (wanted.length === 0) return periodTotals(period, basis, []);
  const { months } = await accountsFor(wanted, basis);
  return periodTotals(period, basis, months);
}

/**
 * The last `count` months as a series, for the charts.
 *
 * Ends at `through` (or the most recent month with anything in it) and reaches back from there, so
 * a chart drawn in the first week of a month does not open with an empty column that reads as a
 * collapse.
 */
export async function monthlyTrend(
  count = 12,
  basis: "accrual" | "cash" = "accrual",
  through?: string,
): Promise<import("./period-account").TrendPoint[]> {
  const { trend } = await import("./period-account");
  const all = await accountMonths();
  if (all.length === 0) return [];
  const end = through && all.includes(through) ? through : all[0];
  const wanted = all.filter((m) => m <= end).slice(0, Math.max(1, count));
  if (wanted.length === 0) return [];
  const { months } = await accountsFor(wanted, basis);
  return trend(months);
}
