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
};

export type PLInputs = {
  month: string;
  basis: "accrual" | "cash";
  /** From the System Sales Summary: the whole till, retail included. Accrual. */
  sales: { retailCents: number | null; rxPatientCents: number | null; rxRemitCents: number | null; totalCents: number | null } | null;
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
  claimsCount?: number;
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
   * The cash account's cost of goods. Null where no invoice in the month carries a payment date,
   * which is not the same as zero and must never be shown as it.
   */
  paidPurchasesCents: number | null;
  /** How many invoices in the month have no payment date, so the gap can be named rather than hidden. */
  purchasesUnpaidCount?: number;
  /**
   * How many of the cash cost-of-goods invoices are counted on an assumed date — the invoice date
   * plus the supplier's payment terms, or the invoice date alone — rather than a recorded payment.
   */
  purchasesAssumedCount?: number;
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
    if (i.sales) {
      if (i.sales.rxRemitCents) revenue.push({ label: "Third-party remittance", amountCents: i.sales.rxRemitCents });
      if (i.sales.rxPatientCents) revenue.push({ label: "Patient payments", amountCents: i.sales.rxPatientCents });
      if (i.sales.retailCents) revenue.push({ label: "Retail and over the counter", amountCents: i.sales.retailCents, note: "Before sales tax. The tax collected is the state's money and is not in this account." });
    } else if (i.claimsRevenueCents) {
      /*
       * The claims, when the till report has not arrived. Never as well as it — that would count
       * every prescription twice, since the summary already contains them.
       *
       * Retail is genuinely unknown here rather than zero, so it is named as missing. An account
       * short of the front of shop understates revenue and profit, which is the safe direction to
       * be wrong in and still needs saying out loud.
       */
      revenue.push({
        label: "Prescriptions, from the claims",
        amountCents: i.claimsRevenueCents,
        note: `Every plan's remittance plus what the patient paid, across ${(i.claimsCount ?? 0).toLocaleString()} dispensings. The System Sales Summary has not been loaded for this month, so this stands in for the prescription side of it.`,
      });
      missing.push(
        "The System Sales Summary for this month. Prescriptions are taken from the claims instead, but retail and over-the-counter sales are missing entirely — so revenue, gross profit and net profit are all understated by whatever the front of shop took.",
      );
    } else {
      missing.push("The System Sales Summary for this month, which is the only report carrying retail sales as well as prescriptions.");
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
  } else if (i.paidPurchasesCents !== null) {
    costOfGoods.push({
      label: "Paid to the wholesalers",
      amountCents: i.paidPurchasesCents,
      note: i.purchasesAssumedCount
        ? `Wholesaler invoices paid in this month. ${i.purchasesAssumedCount} of them ${i.purchasesAssumedCount === 1 ? "is" : "are"} counted on the invoice date plus the supplier's payment terms, because no payment date was recorded; enter the date paid on the invoices page and this becomes exact.`
        : "Invoices marked paid in this month. On a cash account the goods are a cost when the money leaves, not when the bottle does.",
    });
  } else {
    missing.push(
      "What was paid to the wholesalers this month. No wholesaler invoice falls in this month by its recorded payment date or by its date plus the supplier's terms, so a cash account has no cost of goods — " +
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
  const spent = new Set(operating.filter((l) => l.amountCents !== 0).map((l) => l.label));
  if (!spent.has("Wages and salaries")) {
    missing.push("Wages and salaries. Usually the largest cost a pharmacy has — without it this account is not conservative, it is wrong.");
  }
  if (!spent.has("Rent and occupancy")) missing.push("Rent and occupancy.");
  if (!spent.has("Card processing and bank fees")) {
    missing.push("Card processing and bank fees — two to three per cent of everything taken on a card, and nobody sends an invoice for it.");
  }
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
    netProfitCents,
    otherCashOut,
    otherCashOutCents,
    cashChangeCents,
    stockMovementCents,
    reconciliation,
    missing,
    /* A bottom line is only worth printing when the biggest costs are actually in it. */
    usable: missing.length === 0,
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
  const { held } = await import("./held");
  return held(`month-account:${month}:${basis}`, async () => {
    const shared = await loadShared([month], basis);
    return monthlyPL(monthInputs(month, basis, shared));
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
  invoices: { totalCents: number | null; paidOn: string | null; invoiceDate: string | null; supplierId: string | null; supplier: string | null }[];
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
  const [sales, cats, fills, suppliers, invoices, lines, counts, payments, standing] = await Promise.all([
    salesMonths(),
    categories(true),
    allFills({ from, to }),
    allSuppliers(true),
    db.query.supplierInvoices.findMany({ columns: { totalCents: true, paidOn: true, invoiceDate: true, supplierId: true, supplier: true } }),
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
  return { basis, sales, cats, fills, suppliers, invoices, lines, counts, payments, byMonth, standing, today: todayIso() };
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
  const monthFills = fills.filter((f) => f.dateFilled.startsWith(month));
  const mine = monthFills.filter((f) => f.acquisitionCents !== null);
  /*
   * What the month's dispensing actually brought in, per fill rather than per transmission, so a
   * coordinated claim is one bottle's revenue and not two.
   */
  const claimsRevenueCents = monthFills.length ? monthFills.reduce((n, f) => n + f.remitCents + f.patientPaidCents, 0) : null;
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
   * The day an invoice's money left, in order of how well it is known: the payment date somebody
   * recorded; else the invoice date plus the supplier's payment terms from its agreement; else the
   * invoice date itself. The first is a fact, the second is the document's own rule, the third is
   * the nearest thing to either — and every invoice on the second or third is counted and said to
   * be, so the figure is never mistaken for a bank statement. What it is never allowed to be is
   * nought for want of a date, which is what a cash account with no cost of goods was saying.
   */
  const termsFor = (v: (typeof invoices)[number]): number => {
    const sup = shared.suppliers.find((s) => s.id === v.supplierId) ?? shared.suppliers.find((s) => v.supplier && s.name.toLowerCase() === v.supplier.toLowerCase());
    return sup?.paymentTermsDays ?? 0;
  };
  const cashDateOf = (v: (typeof invoices)[number]): string | null => {
    if (v.paidOn) return v.paidOn;
    if (!v.invoiceDate) return null;
    const d = new Date(`${v.invoiceDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + termsFor(v));
    return d.toISOString().slice(0, 10);
  };
  const paidThisMonth = invoices.filter((v) => v.totalCents !== null && cashDateOf(v)?.startsWith(month));
  const paidPurchasesCents = paidThisMonth.length ? paidThisMonth.reduce((n, v) => n + (v.totalCents ?? 0), 0) : null;
  const purchasesAssumedCount = paidThisMonth.filter((v) => !v.paidOn).length;
  const purchasesUnpaidCount = invoices.filter((v) => !v.paidOn && v.invoiceDate?.startsWith(month)).length;


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
    sales: sales ? { retailCents: sales.retailCents, rxPatientCents: sales.rxPatientCents, rxRemitCents: sales.rxRemitCents, totalCents: sales.totalCents } : null,
    receipts,
    laterMoneyCents,
    claimsRevenueCents,
    claimsCount: monthFills.length,
    dispensedCostCents,
    purchasesCents,
    paidPurchasesCents,
    purchasesUnpaidCount,
    purchasesAssumedCount,
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

/** Which months there is anything to report on, most recent first. */
export async function accountMonths(): Promise<string[]> {
  const { salesMonths } = await import("./sales-store");
  const { db, schema } = await import("@/db");
  const [sales, bills, claims] = await Promise.all([
    salesMonths(),
    db.query.expenses.findMany({ columns: { invoiceDate: true } }),
    db.query.claims.findMany({ columns: { dateFilled: true } }),
  ]);
  void schema;
  const set = new Set<string>();
  for (const m of sales) set.add(m.month);
  for (const b of bills) set.add(b.invoiceDate.slice(0, 7));
  for (const c of claims) set.add(c.dateFilled.slice(0, 7));
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
  const months = await Promise.all(wanted.map((m) => monthlyAccount(m, basis)));
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
  const months = await Promise.all(wanted.map((m) => monthlyAccount(m, basis)));
  return trend(months);
}
