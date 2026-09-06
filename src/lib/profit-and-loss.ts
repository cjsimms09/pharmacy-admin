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
  /** The acquisition cost of everything dispensed in the month, from the claims themselves. */
  dispensedCostCents: number | null;
  /** What the wholesalers were invoiced for in the month, for the stock comparison only. */
  purchasesCents: number | null;
  /**
   * Rebates the month's buying earned. Used on an accrual basis, where the discount belongs to the
   * month that earned it rather than the month the cheque cleared.
   */
  rebatesCents: number | null;
  /** Every confirmed bill in the month, already placed on the right side of the account. */
  expenses: { categoryId: string | null; categoryName: string; kind: string; amountCents: number }[];
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
  const costOfGoods: PLLine[] = [];
  if (i.dispensedCostCents !== null) {
    costOfGoods.push({
      label: "Acquisition cost of what was dispensed",
      amountCents: i.dispensedCostCents,
      note: "Taken per bottle from the claims themselves, so it needs no stocktake and does not move with when the stock was bought.",
    });
  } else {
    missing.push("The acquisition cost of what was dispensed — no claims are loaded for this month, so there is no cost of goods.");
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

  const [months, bills, receipts, cats, fills, suppliers] = await Promise.all([
    salesMonths(),
    expensesIn(month, basis),
    cashReceiptsIn(month),
    categories(true),
    allFills(),
    allSuppliers(true),
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
  const dispensedCostCents = mine.length ? mine.reduce((n, f) => n + (f.acquisitionCents ?? 0), 0) : null;
  const laterMoneyCents = fills
    .filter((f) => f.dateFilled.startsWith(month))
    .reduce((n, f) => n + f.laterPaymentsCents, 0);

  /* What the wholesalers billed in the month, for the stock comparison only — never as cost of goods. */
  const lines = await db.query.invoiceLines.findMany({
    where: and(gte(schema.invoiceLines.invoiceDate, `${month}-01`), lte(schema.invoiceLines.invoiceDate, `${month}-31`)),
    columns: { extendedCents: true },
  });
  const purchasesCents = lines.length ? lines.reduce((n, l) => n + l.extendedCents, 0) : null;

  const earned = await Promise.all(suppliers.map((s) => earningSoFar(s.id, month)));
  const rebatesCents = earned.reduce((n, e) => n + (e?.estimatedRebateCents ?? 0), 0) || null;

  const byId = new Map(cats.map((c) => [c.id, c]));
  return monthlyPL({
    month,
    basis,
    sales: sales ? { retailCents: sales.retailCents, rxPatientCents: sales.rxPatientCents, rxRemitCents: sales.rxRemitCents, totalCents: sales.totalCents } : null,
    receipts: receipts.map((r) => ({ kind: r.kind, amountCents: r.amountCents })),
    laterMoneyCents,
    dispensedCostCents,
    purchasesCents,
    rebatesCents,
    expenses: bills.map((b) => {
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
