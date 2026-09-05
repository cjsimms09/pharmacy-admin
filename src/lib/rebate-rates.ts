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
   * Today's ratio beats last month's, and only for the supplier it belongs to.
   *
   * The daily report carries the compliance ratio and the OneStop share as the month stands. The
   * statement carries what closed. Pricing an order placed this morning off a closed month is the
   * error this ordering exists to prevent — and a ratio filed against McKesson must not select a
   * band on somebody else's ladder.
   */
  const dailyIsOurs = daily !== null && (daily.supplierId === supplierId || (!daily.supplierId && /mckesson/i.test(supplier.name)));
  const ratioSource = dailyIsOurs && daily.gcrPercent !== null ? "daily report" : statement ? "monthly statement" : null;

  const view = rebateView(
    programmes.map((p) => ({ id: p.row.id, name: p.row.name, effectiveFrom: p.row.effectiveFrom, terms: p.terms })),
    statement || dailyIsOurs
      ? {
          scrubbedGcrPercent: (dailyIsOurs ? daily.gcrPercent : null) ?? statement?.scrubbedGcrPercent ?? null,
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
    ratioAsOf: (dailyIsOurs ? (daily.generatedOn ?? daily.month) : null) ?? statement?.periodFrom ?? null,
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
