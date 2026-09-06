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


export type PLLine = { label: string; amountCents: number; note?: string };

export type MonthlyPL = {
  month: string;
  basis: "accrual" | "cash";

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

export function monthlyPL(i: PLInputs): MonthlyPL {
  const missing: string[] = [];

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
      if (i.sales.retailCents) revenue.push({ label: "Retail and over the counter", amountCents: i.sales.retailCents });
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
      note: "Invoices marked paid in this month. On a cash account the goods are a cost when the money leaves, not when the bottle does.",
    });
    if (i.purchasesUnpaidCount) {
      missing.push(
        `${i.purchasesUnpaidCount} wholesaler ${i.purchasesUnpaidCount === 1 ? "invoice has" : "invoices have"} no payment date, so ${i.purchasesUnpaidCount === 1 ? "it is" : "they are"} not in the cash cost of goods. Enter the date each was paid and this becomes exact.`,
      );
    }
  } else {
    missing.push(
      "What was paid to the wholesalers this month. No invoice carries a payment date yet, so a cash account has no cost of goods — " +
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
  const rebateCents =
    i.basis === "cash"
      ? i.receipts.filter((r) => r.kind === "rebate").reduce((n, r) => n + r.amountCents, 0)
      : (i.rebatesCents ?? 0);
  if (rebateCents) {
    costOfGoods.push({
      label: i.basis === "cash" ? "Wholesaler rebates received" : "Wholesaler rebates earned",
      amountCents: -Math.abs(rebateCents),
      note:
        i.basis === "cash"
          ? "Settled this month, on buying done a month or two ago. A discount arriving late, so it reduces cost rather than adding to revenue."
          : "Earned by this month's buying, whenever the wholesaler settles it. A discount, so it reduces cost rather than adding to revenue.",
    });
  }
  for (const l of byCategory(i.expenses, "cost_of_goods")) costOfGoods.push(l);
  const costOfGoodsCents = sum(costOfGoods);

  const grossProfitCents = netRevenueCents - costOfGoodsCents;
  const grossMarginPercent = netRevenueCents > 0 ? Math.round((grossProfitCents / netRevenueCents) * 1000) / 10 : null;

  const operating = byCategory(i.expenses, "operating");
  const operatingCents = sum(operating);
  const netProfitCents = grossProfitCents - operatingCents;

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
      openingStock: { cents: i.openingStockCents ?? null, from: "the dispensing shelf at the first inventory count of the month" },
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
  const { latestSalesMonth, salesMonths } = await import("./sales-store");
  const { expensesIn, cashReceiptsIn, categories } = await import("./expenses");
  const { allFills } = await import("./claims");
  const { earningSoFar } = await import("./rebate-rates");
  const { allSuppliers } = await import("./suppliers-registry");
  const { db, schema } = await import("@/db");
  const { and, gte, lte } = await import("drizzle-orm");

  const [months, bills, receipts, cats, fills, suppliers, driverCents] = await Promise.all([
    salesMonths(),
    expensesIn(month, basis),
    cashReceiptsIn(month),
    categories(true),
    allFills(),
    allSuppliers(true),
    driverCostFor(month),
  ]);
  void latestSalesMonth;

  const sales = months.find((m) => m.month === month) ?? null;

  /*
   * The cost of what was actually dispensed in the month, per bottle, from the claims themselves.
   *
   * This is the figure that makes a stocktake unnecessary — see the note at the top of this file.
   * A fill with no acquisition cost on it is left out of both sides rather than counted as free.
   */
  const mine = fills.filter((f) => f.dateFilled.startsWith(month) && f.acquisitionCents !== null);
  /*
   * What the month sold on account. Reported beside the profit, never added to it: the sale is
   * already in the revenue above, and the only thing still open is whether the money has arrived.
   */
  const monthFills = fills.filter((f) => f.dateFilled.startsWith(month));
  /*
   * What the month's dispensing actually brought in, per fill rather than per transmission, so a
   * coordinated claim is one bottle's revenue and not two.
   */
  const claimsRevenueCents = monthFills.length
    ? monthFills.reduce((n, f) => n + f.remitCents + f.patientPaidCents, 0)
    : null;
  const onAccount = {
    receivableCents: monthFills.reduce((n, f) => n + f.receivableCents, 0),
    unbilledCostCents: monthFills.reduce((n, f) => n + (f.unbilledCostCents ?? 0), 0),
  };
  const dispensedCostCents = mine.length ? mine.reduce((n, f) => n + (f.acquisitionCents ?? 0), 0) : null;
  const laterMoneyCents = fills
    .filter((f) => f.dateFilled.startsWith(month))
    .reduce((n, f) => n + f.laterPaymentsCents, 0);

  /* What the wholesalers billed in the month, for the stock comparison only — never as accrual cost of goods. */
  const lines = await db.query.invoiceLines.findMany({
    where: and(gte(schema.invoiceLines.invoiceDate, `${month}-01`), lte(schema.invoiceLines.invoiceDate, `${month}-31`)),
    columns: { extendedCents: true },
  });
  const purchasesCents = lines.length ? lines.reduce((n, l) => n + l.extendedCents, 0) : null;

  /*
   * What actually left the bank for goods this month: the invoices marked paid in it.
   *
   * The cash account's cost of goods. Counted on the invoice's own total where it has one, because
   * that is what was paid; where a total was never read the invoice cannot contribute and is
   * counted as unpaid-unknown instead of as zero.
   */
  const allInvoices = await db.query.supplierInvoices.findMany({
    columns: { totalCents: true, paidOn: true, invoiceDate: true },
  });
  const paidThisMonth = allInvoices.filter((v) => v.paidOn?.startsWith(month) && v.totalCents !== null);
  const paidPurchasesCents = paidThisMonth.length ? paidThisMonth.reduce((n, v) => n + (v.totalCents ?? 0), 0) : null;
  const purchasesUnpaidCount = allInvoices.filter((v) => !v.paidOn && v.invoiceDate?.startsWith(month)).length;

  /*
   * The shelf at each end of the month, which is what makes the cost of goods checkable at all.
   *
   * The first count of the month stands for the opening position and the last for the closing one.
   * They are the counts that exist, not the first and last day — a count taken on the 3rd is the
   * best opening figure available and saying so is better than refusing to check anything until
   * somebody counts on the 1st.
   */
  const counts = await db.query.onHandImports.findMany({
    where: and(gte(schema.onHandImports.countedOn, `${month}-01`), lte(schema.onHandImports.countedOn, `${month}-31`)),
    columns: { countedOn: true, valueCents: true, rxValueCents: true },
  });
  /*
   * The dispensing shelf, not the whole building.
   *
   * This figure exists to check cost of goods: opening + purchases − closing should come out at
   * what the claims say was dispensed. Both sides of that have to count the same shelf. Front-shop
   * stock moves on retail sales that leave no claim behind them, so a month where the shop sold
   * well would show as unexplained drug cost. Counts filed before the reader could tell the two
   * apart carry no Rx figure and fall back to the whole value, which is what they meant then.
   */
  const valued = counts
    .map((c) => ({ countedOn: c.countedOn, valueCents: c.rxValueCents ?? c.valueCents }))
    .filter((c) => c.valueCents !== null)
    .sort((a, b) => a.countedOn.localeCompare(b.countedOn));
  const openingStockCents = valued.length > 1 ? valued[0].valueCents : null;
  const closingStockCents = valued.length > 1 ? valued[valued.length - 1].valueCents : null;

  const earned = await Promise.all(suppliers.map((s) => earningSoFar(s.id, month)));
  const rebatesCents = earned.reduce((n, e) => n + (e?.estimatedRebateCents ?? 0), 0) || null;

  const byId = new Map(cats.map((c) => [c.id, c]));
  return monthlyPL({
    month,
    basis,
    sales: sales ? { retailCents: sales.retailCents, rxPatientCents: sales.rxPatientCents, rxRemitCents: sales.rxRemitCents, totalCents: sales.totalCents } : null,
    receipts: receipts.map((r) => ({ kind: r.kind, amountCents: r.amountCents })),
    laterMoneyCents,
    claimsRevenueCents,
    claimsCount: monthFills.length,
    dispensedCostCents,
    purchasesCents,
    paidPurchasesCents,
    purchasesUnpaidCount,
    openingStockCents,
    closingStockCents,
    rebatesCents,
    onAccount,
    expenses: [
      ...bills.map((b) => {
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
      ...(driverCents > 0
        ? [{ categoryId: null, categoryName: "Delivery round", kind: "operating", amountCents: driverCents }]
        : []),
    ],
  });
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
   * The site raises the driver's invoice, and raising an invoice says nothing about whose money it
   * is: it is raised on his behalf and billed to the clinic, so it is neither revenue nor cost
   * here. Where the pharmacy pays its own driver, the setting says so and the month's invoices go
   * in as an operating cost instead — see `driverCostFor` below, which the account uses.
   */
  try {
    const invoices = await db.query.driverInvoices.findMany({ where: eq(schema.driverInvoices.month, month) });
    const total = invoices.reduce((n, i) => n + i.totalCents, 0);
    if (invoices.length > 0 && (s.driver_paid_by ?? "clinic") !== "pharmacy") {
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
 * The delivery round as a cost, where the pharmacy is the one paying for it.
 *
 * Nought in the ordinary arrangement here, where the clinic pays the driver directly. Kept apart
 * from `excludedFromAccount` so the account can add it without deciding anything: one setting
 * governs both, and they cannot disagree about which way it went.
 */
export async function driverCostFor(month: string): Promise<number> {
  const { db, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { getSettings } = await import("./settings");
  const s = await getSettings();
  if ((s.driver_paid_by ?? "clinic") !== "pharmacy") return 0;
  const invoices = await db.query.driverInvoices.findMany({ where: eq(schema.driverInvoices.month, month) });
  // Drafts are not yet a bill: the month is unfinished and the figure would change under the account.
  return invoices.filter((i) => i.status !== "draft").reduce((n, i) => n + i.totalCents, 0);
}
