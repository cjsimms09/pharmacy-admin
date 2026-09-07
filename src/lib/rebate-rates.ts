import "server-only";
import { allSuppliers } from "./suppliers-registry";
import { rebateProgramsInForce } from "./supplier-terms-store";
import { rebateStatementFor } from "./rebate-report-store";
import { latestRatio } from "./purchase-ratio";
import { rebateView, type RebateView } from "./rebate-view";
import { todayIso } from "./dates";

/**
 * What each supplier is actually taking off a price today.
 *
 * One number, worked out rather than typed, and it is the number every purchasing comparison on
 * this site depends on. It used to be a setting — a percentage copied off last month's rebate
 * statement into a text box — which was wrong in three ways at once: it belonged to no supplier in
 * particular, it held only one of the three ladders McKesson runs, and it was as old as the last
 * statement rather than as new as this morning's report.
 *
 * The chain is: the ladders in force say what each band pays; the ratio says which band the
 * pharmacy is in; and the ratio comes from the daily drill down where there is one and from the
 * last monthly statement otherwise. Every ladder paying on the same kind of item is added, because
 * that is what the supplier does — McKesson pays the compliance rate and the purchase-ratio rate
 * on the same OneStop items.
 *
 * Where any link is missing the answer is null, and a comparison that gets null uses gross prices
 * and says so. That is the right failure: understating the pharmacy's position costs an
 * opportunity, and inventing a discount costs money.
 */

export type SupplierRates = {
  supplierId: string;
  supplierName: string;
  view: RebateView;
  /** Where the ratio that picked the bands came from, for a page that has to explain itself. */
  ratioSource: "daily report" | "monthly statement" | null;
  ratioAsOf: string | null;
  /**
   * The daily drill-down's compliance ratio, which is a position rather than a settlement.
   *
   * Shown, never used to pick a band: it carries only the exclusions the scheduled report was set up
   * with, not McKesson's own, and on one real month the two read 10.13% and 20.64%.
   */
  dailyGcrPercent?: number | null;
  /** The settled figure less the daily one. Closes to nothing if the report is ever fixed. */
  driftPercent?: number | null;
};

export async function ratesFor(supplierId: string, on = todayIso()): Promise<SupplierRates | null> {
  const rows = await allSuppliers(true);
  const supplier = rows.find((s) => s.id === supplierId);
  if (!supplier) return null;
  const [programmes, statement, daily] = await Promise.all([
    rebateProgramsInForce(supplierId, on),
    rebateStatementFor(supplierId),
    latestRatio(),
  ]);

  /*
   * ── The daily ratio does not select the band, and that is deliberate ──────────
   *
   * It used to. The reasoning was sound and the arithmetic was not: the daily drill-down carries a
   * compliance ratio for the month so far, and pricing this morning's order off a month that closed
   * three weeks ago is exactly the error to avoid.
   *
   * But the two figures are not the same measure. The drill-down's ratio carries only the exclusions
   * the scheduled report was set up with — "Flu or Dropship" — while McKesson settles on its own
   * scrubbed figure with its own exclusions. On one real month those are 10.13% and 20.64%. Letting
   * the daily figure choose meant picking the bottom band on a pharmacy sitting near the top of the
   * ladder: every discount understated, every purchasing comparison wrong, and the rebate on the
   * scoreboard wrong with them. Being a few weeks stale is a much smaller error than being a
   * different measurement.
   *
   * So the statement selects the band, and the daily figure is shown for what it is — a position,
   * not a settlement. The day the scheduled report carries McKesson's own exclusions this can be
   * revisited, and `driftPercent` below is what will say when it does.
   */
  const dailyIsOurs = daily !== null && (daily.supplierId === supplierId || (!daily.supplierId && /mckesson/i.test(supplier.name)));
  const scrubbed = statement?.scrubbedGcrPercent ?? null;

  /*
   * The day the note above anticipated has arrived, and the report itself says so.
   *
   * The drill down prints the exclusions it was run with. It used to carry "Flu or Dropship" — a
   * wider denominator than McKesson settles on — which is the whole reason its ratio was shown and
   * never used. The pharmacy's scheduled report now carries "Flu or Dropship or Specialty or
   * GLP1", which is McKesson's own scrub, and a ratio measured on that basis is the settled figure
   * rather than an approximation of it.
   *
   * So it selects the band, and it should: it is the same basis as the statement and it is this
   * month rather than last. What decides is the line the document prints about itself, so a report
   * re-scheduled with narrower exclusions goes back to being a position the next morning, with
   * nobody editing anything.
   */
  const dailyScrubbed = dailyIsOurs && daily.scrubbed === true && daily.gcrPercent !== null;
  const selectsBand = dailyScrubbed ? daily.gcrPercent : scrubbed;
  const ratioSource =
    dailyScrubbed ? "daily report" : scrubbed !== null ? "monthly statement" : dailyIsOurs && daily.gcrPercent !== null ? "daily report" : null;
  /*
   * How far the daily figure sits from the settled one, when both are known.
   *
   * The evidence for the paragraph above, kept live rather than written down once: if the scheduled
   * report is ever fixed to carry McKesson's exclusions this closes to nothing, and the daily figure
   * can be trusted to select the band again.
   */
  const driftPercent =
    scrubbed !== null && dailyIsOurs && daily.gcrPercent !== null ? Math.round((scrubbed - daily.gcrPercent) * 100) / 100 : null;

  const view = rebateView(
    programmes.map((p) => ({ id: p.row.id, name: p.row.name, effectiveFrom: p.row.effectiveFrom, terms: p.terms })),
    statement || dailyIsOurs
      ? {
          // Whichever figure is on McKesson's own basis, preferring the current month. See above.
          scrubbedGcrPercent: selectsBand ?? (dailyIsOurs ? daily.gcrPercent : null),
          gprPercent: statement?.gprPercent ?? null,
          periodFrom: (dailyIsOurs ? daily.month : null) ?? statement?.periodFrom ?? null,
          oneStopPurchasedCents: statement?.oneStopPurchasedCents ?? null,
          brandPurchasedCents: statement?.brandPurchasedCents ?? null,
          gcrRebateCents: statement?.gcrRebateCents ?? null,
          gprRebateCents: statement?.gprRebateCents ?? null,
          brandRebateCents: statement?.brandRebateCents ?? null,
        }
      : null,
  );

  return {
    supplierId,
    supplierName: supplier.name,
    view,
    ratioSource,
    /** The daily drill-down's ratio. Selects the band where the report says it is scrubbed. */
    dailyGcrPercent: dailyIsOurs ? daily.gcrPercent : null,
    driftPercent,
    // The date belongs to whichever figure actually selected the band.
    ratioAsOf: dailyScrubbed
      ? (daily.generatedOn ?? daily.month)
      : scrubbed !== null
        ? (statement?.periodFrom ?? null)
        : dailyIsOurs
          ? (daily.generatedOn ?? daily.month)
          : null,
  };
}

/**
 * The contract discount every supplier gives today, keyed by name for the ledger.
 *
 * Only the rate that applies to a line an invoice or catalogue marks rebated — which is the
 * contract-item rate, plus the every-generic rate where a supplier pays one, because a line marked
 * rebated earns both where both exist.
 */
export async function contractRatesBySupplier(on = todayIso()): Promise<Record<string, number>> {
  const rows = await allSuppliers(true);
  const out: Record<string, number> = {};
  for (const s of rows) {
    const r = await ratesFor(s.id, on);
    if (!r) continue;
    const pct = (r.view.contractGenericPercent ?? 0) + (r.view.allGenericsPercent ?? 0);
    if (pct <= 0 || pct >= 100) continue;
    out[s.name.trim().toLowerCase()] = pct / 100;
    if (s.catalogName) out[s.catalogName.trim().toLowerCase()] = pct / 100;
  }
  return out;
}

/**
 * What this month's buying is earning, worked from the invoices themselves.
 *
 * The rebate statement is a month behind and the ladder alone says nothing about volume. What a
 * pharmacist wants at a glance is the arithmetic on the buying already done: this much went on
 * contract items and earns that rate, this much went on brand and earns the brand factor, and here
 * is what that comes to.
 *
 * It is an estimate and is called one. The invoice marks which lines are on contract, and that
 * marking is what the rebate is paid on — but McKesson settles against its own scrubbed figures,
 * and a line the invoice did not mark either way contributes nothing here rather than being
 * guessed into one side or the other.
 */
export type EarningSoFar = {
  supplierId: string;
  supplierName: string;
  /** The month this covers, as YYYY-MM. */
  month: string;
  contractPurchasedCents: number;
  brandPurchasedCents: number;
  unmarkedPurchasedCents: number;
  totalPurchasedCents: number;
  /**
   * The prescription lines only — the supplier's class letter is printed (legend or scheduled) —
   * which is the denominator the compliance ratio is measured on. Over-the-counter lines carry no
   * class and are not in the ratio; put in the denominator they overstate the spend a band needs.
   * Equal to the total where the invoice prints no class letters at all.
   */
  rxPurchasedCents: number;
  contractRatePercent: number | null;
  brandRatePercent: number | null;
  contractRebateCents: number | null;
  brandRebateCents: number | null;
  estimatedRebateCents: number | null;
  /** Lines whose contract marking the invoice did not print, so nothing is claimed for them. */
  unmarkedLines: number;
};

export async function earningSoFar(supplierId: string, month?: string): Promise<EarningSoFar | null> {
  const { db, schema } = await import("@/db");
  const { and, eq, gte, lte } = await import("drizzle-orm");
  const rows = await allSuppliers(true);
  const supplier = rows.find((s) => s.id === supplierId);
  if (!supplier) return null;

  const m = month ?? todayIso().slice(0, 7);
  const names = [supplier.name, supplier.catalogName].filter(Boolean).map((x) => x!.trim().toLowerCase());

  const lines = await db.query.invoiceLines.findMany({
    where: and(gte(schema.invoiceLines.invoiceDate, `${m}-01`), lte(schema.invoiceLines.invoiceDate, `${m}-31`)),
  });
  void eq;
  const mine = lines.filter((l) => {
    const n = (l.supplier ?? "").trim().toLowerCase();
    return n !== "" && names.some((x) => n === x || n.includes(x) || x.includes(n));
  });

  let contract = 0;
  let brand = 0;
  let unmarked = 0;
  let unmarkedLines = 0;
  let rx = 0;
  const classed = mine.some((l) => /^[RXBDE]$/i.test((l.itemClass ?? "").trim()));
  const isRx = (l: (typeof mine)[number]) => !classed || /^[RXBDE]$/i.test((l.itemClass ?? "").trim());
  for (const l of mine) {
    if (isRx(l)) rx += l.extendedCents;
    /*
     * Brand or generic, decided by the invoice's own marking rather than by the drug name.
     *
     * A line marked as earning the contract rebate is a contract generic. A line the supplier
     * marks and does not flag is a brand line or an off-contract one; McKesson's brand factor is
     * paid on brand purchases, and the invoice does not separate those from off-contract generics,
     * so both sit in the same bucket and the figure is called an estimate.
     */
    if (l.rebated === true) contract += l.extendedCents;
    // The brand factor is paid on brand prescription purchases; an over-the-counter line marked
    // "not rebated" is neither, and earned the factor here until the class letter was read.
    else if (l.rebated === false && isRx(l)) brand += l.extendedCents;
    else if (l.rebated === false) unmarked += l.extendedCents;
    else {
      unmarked += l.extendedCents;
      unmarkedLines++;
    }
  }

  /*
   * The ladders in force at the end of the month asked for, not today's: an August account drawn
   * in September must use August's programme. The ratio that picks the band is still the latest
   * known (the statement on file, or the current drill-down), because statements are held one per
   * supplier rather than one per period — see money-ledger.md §7.1.
   */
  const rates = await ratesFor(supplierId, `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`);
  const contractRate = rates?.view.contractGenericPercent ?? null;
  const brandRate = rates?.view.brandPercent ?? null;
  const contractRebate = contractRate === null ? null : Math.round((contract * contractRate) / 100);
  const brandRebate = brandRate === null ? null : Math.round((brand * brandRate) / 100);

  return {
    supplierId,
    supplierName: supplier.name,
    month: m,
    contractPurchasedCents: contract,
    brandPurchasedCents: brand,
    unmarkedPurchasedCents: unmarked,
    totalPurchasedCents: contract + brand + unmarked,
    rxPurchasedCents: rx,
    contractRatePercent: contractRate,
    brandRatePercent: brandRate,
    contractRebateCents: contractRebate,
    brandRebateCents: brandRebate,
    estimatedRebateCents: contractRebate === null && brandRebate === null ? null : (contractRebate ?? 0) + (brandRebate ?? 0),
    unmarkedLines,
  };
}
