import "server-only";
import { todayIso } from "./dates";
import { allSuppliers } from "./suppliers-registry";
import { latestRatio } from "./purchase-ratio";
import { ratesFor, earningSoFar, type EarningSoFar } from "./rebate-rates";
import { facilitatorMoney } from "./claim-payments";
import { allFills } from "./claims";

/**
 * The three figures that decide what this pharmacy makes, as they stand this morning.
 *
 * Everything else on the desk is a list of things to do. This is the money, and it is three
 * numbers because there are exactly three levers:
 *
 *   the ratio    — where the generic compliance ratio has got to this month, because it alone
 *                  selects the band, and the band is the discount on every generic bought today
 *   the rebate   — what the buying already done this month is earning at that band
 *   the money in — what the facilitator has actually paid, and what it still owes
 *
 * All three are month-to-date and all three are estimates drawn from what the site holds rather
 * than from anything typed in. Where a link in the chain is missing the answer is null and the
 * screen says which link — a made-up figure here would be worse than no figure, because it is the
 * figure somebody prices an order against.
 */

export type MoneyPosition = {
  /**
   * What the pharmacy dispensed this month and what it made on it.
   *
   * Prescriptions only — this is the transaction report, and it does not carry front-of-shop
   * merchandise. Cash fills are counted here with the rest, because a bottle the pharmacy priced
   * itself is revenue like any other, and it is the business it has the most control over.
   */
  dispensing: {
    month: string;
    fills: number;
    revenueCents: number;
    marginCents: number;
    /** The pharmacy's own cash programme, shown apart because it is priced rather than negotiated. */
    cashFills: number;
    cashRevenueCents: number;
    cashMarginCents: number;
    /** Promised at adjudication by a plan and not yet paid. Real, sourced, and chaseable. */
    promisedCents: number;
    promisedFills: number;
    /**
     * The report's own bottom line for the last file loaded, which nothing here computed.
     *
     * PioneerRx prints a grand total — what the pharmacy took, what the drugs cost, what it made —
     * and it is the only authoritative total sales figure in the building. Shown beside our own so
     * a disagreement is visible rather than discovered later; the period it covers is the file's,
     * which is the whole month once the monthly report is the one being sent.
     */
    reported: { salesCents: number; grossProfitCents: number; from: string | null; to: string | null; fileName: string } | null;
  };
  /** Where the compliance ratio stands, and what it is buying. */
  ratio: {
    supplierId: string;
    supplierName: string;
    percent: number | null;
    /** The daily drill down beats the monthly statement: one is a position, the other a settlement. */
    source: "daily report" | "monthly statement" | null;
    asOf: string | null;
    /** What a contract generic is discounted by at this ratio, adding every ladder that pays on one. */
    contractGenericPercent: number | null;
    brandPercent: number | null;
    /** The next band up, how far off it is, and what it was worth last month. */
    next: { fromPercent: number; rebatePercent: number; shortByPercent: number; worthCents: number | null } | null;
  } | null;
  /** What this month's buying is earning, before the statement arrives to settle it. */
  rebates: {
    month: string;
    estimatedCents: number;
    purchasedCents: number;
    /** Buying whose contract marking the invoice did not print, so nothing is claimed for it. */
    unmarkedCents: number;
    unmarkedLines: number;
    bySupplier: { supplierId: string; supplierName: string; estimatedCents: number | null; purchasedCents: number }[];
    /** True where a supplier was bought from this month and no ladder could price it. */
    incomplete: boolean;
  };
  /** Facilitator money actually banked this month. */
  facilitator: {
    month: string;
    receivedCents: number;
    payments: number;
    lastMonthCents: number;
    /** Payments that name a prescription this site has not loaded — they attach when it arrives. */
    unmatched: number;
  };
  /**
   * Revenue the daily report booked that this site has not found in the claim rows.
   *
   * Deliberately not called money owed. PioneerRx computes its gross profit from the same rows we
   * read, so a gap means it counted something we did not — but the fill cannot say what. One real
   * gap was $146.18 of facilitator money promised at adjudication; another was $5.56 on a generic
   * Losartan, which no facilitator was ever going to pay and is far likelier to be a patient total
   * in a column this reader is missing. Shown as a reconciliation to work through, never added to
   * a forecast.
   */
  unreconciled: { cents: number; fills: number };
};

/**
 * The nearest band worth chasing, across every ladder a supplier runs.
 *
 * A supplier can run several — McKesson pays a compliance rate and a purchase-ratio rate on the
 * same items — and each has its own next rung. The one to say out loud is the closest, because
 * that is the one this month's buying can still reach. Pure, so it can be checked.
 */
export function nearestBand(
  nexts: ({ fromPercent: number; rebatePercent: number; shortByPercent: number; worthCents: number | null } | null)[],
): { fromPercent: number; rebatePercent: number; shortByPercent: number; worthCents: number | null } | null {
  return (
    nexts
      .filter((n): n is NonNullable<typeof n> => n !== null)
      .sort((a, b) => a.shortByPercent - b.shortByPercent)[0] ?? null
  );
}

/**
 * This month's rebate position, added up from what each supplier is earning.
 *
 * Only suppliers actually bought from count: a list of every supplier at $0.00 buries the two that
 * matter. A supplier bought from whose ladder cannot price the buying is not silently dropped — it
 * is what makes the total incomplete, and the screen has to be able to say so, because a rebate
 * total quietly missing a supplier is worse than one that admits it.
 *
 * Pure, so the arithmetic can be checked against a month's invoices by hand.
 */
export function summariseEarnings(
  earnings: (Pick<
    EarningSoFar,
    "supplierId" | "supplierName" | "estimatedRebateCents" | "totalPurchasedCents" | "unmarkedPurchasedCents" | "unmarkedLines"
  > | null)[],
  month: string,
): MoneyPosition["rebates"] {
  const bought = earnings.filter((e): e is NonNullable<typeof e> => e !== null && e.totalPurchasedCents > 0);
  return {
    month,
    estimatedCents: bought.reduce((n, e) => n + (e.estimatedRebateCents ?? 0), 0),
    purchasedCents: bought.reduce((n, e) => n + e.totalPurchasedCents, 0),
    unmarkedCents: bought.reduce((n, e) => n + e.unmarkedPurchasedCents, 0),
    unmarkedLines: bought.reduce((n, e) => n + e.unmarkedLines, 0),
    bySupplier: bought
      .map((e) => ({
        supplierId: e.supplierId,
        supplierName: e.supplierName,
        estimatedCents: e.estimatedRebateCents,
        purchasedCents: e.totalPurchasedCents,
      }))
      .sort((a, b) => (b.estimatedCents ?? 0) - (a.estimatedCents ?? 0)),
    incomplete: bought.some((e) => e.estimatedRebateCents === null),
  };
}

export async function moneyPosition(today = new Date()): Promise<MoneyPosition> {
  const month = todayIso().slice(0, 7);
  const suppliers = await allSuppliers(true);

  /*
   * The ratio belongs to the supplier whose report carried it, which is McKesson in this pharmacy
   * and must not be assumed to be. Where nothing has been filed at all there is no ratio to show,
   * and the screen says so rather than printing a zero that reads like a catastrophe.
   */
  const daily = await latestRatio();
  const ratioSupplier =
    suppliers.find((s) => s.id === daily?.supplierId) ??
    suppliers.find((s) => /mckesson/i.test(s.name)) ??
    suppliers[0] ??
    null;

  const rates = ratioSupplier ? await ratesFor(ratioSupplier.id) : null;
  const ratio: MoneyPosition["ratio"] = ratioSupplier
    ? {
        supplierId: ratioSupplier.id,
        supplierName: ratioSupplier.name,
        percent: daily?.supplierId === ratioSupplier.id || (!daily?.supplierId && /mckesson/i.test(ratioSupplier.name)) ? (daily?.gcrPercent ?? null) : null,
        source: rates?.ratioSource ?? null,
        asOf: rates?.ratioAsOf ?? daily?.generatedOn ?? null,
        contractGenericPercent: rates?.view.contractGenericPercent ?? null,
        brandPercent: rates?.view.brandPercent ?? null,
        /*
         * The nearest band worth chasing, across every ladder — the one that says "buy this much
         * more on contract and the rate goes up", which is the only actionable thing a ratio says.
         */
        next: nearestBand((rates?.view.programmes ?? []).map((p) => p.next)),
      }
    : null;

  /*
   * The rebate estimate, supplier by supplier, on the invoices already loaded for this month.
   *
   * Only suppliers actually bought from appear: a list of every supplier at $0.00 buries the two
   * that matter. A supplier bought from whose ladder cannot price the buying is not silently
   * dropped — it is what makes the total incomplete, and the screen says so.
   */
  const earnings = await Promise.all(suppliers.map((s) => earningSoFar(s.id, month)));
  const rebates = summariseEarnings(earnings, month);

  const [mtf, fills] = await Promise.all([facilitatorMoney("mtf", today), allFills()]);
  const gaps = fills.filter((f) => f.unreconciledCents !== null);

  /*
   * This month's dispensing, by the date the drug was actually handed over.
   *
   * Not by the date a payment settled — that is a different question with a different answer, and
   * mixing them gives a figure that agrees with neither the bank nor the shop floor.
   */
  const mine = fills.filter((f) => f.dateFilled.startsWith(month));
  const cash = mine.filter((f) => f.cashPlan);
  const promised = mine.filter((f) => (f.facilitatorOutstandingCents ?? 0) > 0);
  /*
   * The most recent file's own grand total. Reported as the report's figure for the report's
   * period, never silently reinterpreted as the month's — they are the same thing only when the
   * file sent is the monthly one.
   */
  const { db, schema } = await import("@/db");
  void schema;
  const lastImport = await db.query.claimImports.findFirst({ orderBy: (i, { desc }) => [desc(i.createdAt)] });
  const reported =
    lastImport?.reportSalesCents !== null && lastImport?.reportSalesCents !== undefined
      ? {
          salesCents: lastImport.reportSalesCents,
          grossProfitCents: lastImport.reportGrossProfitCents ?? 0,
          from: lastImport.periodFrom,
          to: lastImport.periodTo,
          fileName: lastImport.fileName,
        }
      : null;

  const dispensing: MoneyPosition["dispensing"] = {
    month,
    fills: mine.length,
    revenueCents: mine.reduce((n, f) => n + f.revenueCents, 0),
    marginCents: mine.reduce((n, f) => n + (f.marginCents ?? 0), 0),
    cashFills: cash.length,
    cashRevenueCents: cash.reduce((n, f) => n + f.revenueCents, 0),
    cashMarginCents: cash.reduce((n, f) => n + (f.marginCents ?? 0), 0),
    promisedCents: promised.reduce((n, f) => n + (f.facilitatorOutstandingCents ?? 0), 0),
    promisedFills: promised.length,
    reported,
  };

  return {
    dispensing,
    ratio,
    rebates,
    facilitator: {
      month,
      receivedCents: mtf.monthToDateCents,
      payments: mtf.monthToDatePayments,
      lastMonthCents: mtf.lastMonthCents,
      unmatched: mtf.unmatched,
    },
    unreconciled: { cents: gaps.reduce((n, f) => n + (f.unreconciledCents ?? 0), 0), fills: gaps.length },
  };
}
