import "server-only";
import { db } from "@/db";
import { drugProfit, type DrugProfit, type ClaimLeg, type Price, type Bench } from "./drug-profit";
import { groupKey } from "./product-groups";
import { packQtyOf, productLedger } from "./product-ledger";
import { catalogueRows } from "./catalogue-cache";
import { nadacNow } from "./nadac-latest";
import { daysBetween } from "./dates";

/**
 * The profit-by-model engine, assembled from what the site holds.
 *
 * Claims give the legs (with the basis code and the split where the export carries them); NADAC
 * gives each NDC's benchmark and the product it belongs to; the AWP the PBM priced against comes
 * off the claims themselves where it is printed, and off the catalogue where it is not; prices
 * come from the product ledger, which already holds every invoice and catalogue price per NDC
 * after the rebate it earns. Nothing is estimated here that a table could say.
 */
export type DrugProfitView = {
  rows: DrugProfit[];
  months: number;
  /** Fills read, and how many carried a basis code — the share the model is read off the PBM's word rather than arithmetic. */
  fills: number;
  withBasis: number;
  ready: boolean;
  reason: string | null;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export async function drugProfitNow(): Promise<DrugProfitView> {
  const [claims, nadac, catalogue, ledger] = await Promise.all([
    db.query.claims.findMany({
      columns: {
        rxNumber: true, fillNumber: true, dateFilled: true, ndc11: true, pbmName: true, payerLabel: true, basisOfReimbursement: true,
        quantityThousandths: true, remitCents: true, ingredientPaidCents: true, dispensingFeePaidCents: true, awpCents: true, cashPlan: true, status: true,
      },
    }),
    nadacNow(),
    catalogueRows(),
    productLedger(),
  ]);

  const legs: ClaimLeg[] = [];
  const awpSeen = new Map<string, number[]>();
  let withBasis = 0;
  for (const c of claims) {
    if (c.status !== "paid" || !c.ndc11) continue;
    if (c.basisOfReimbursement) withBasis++;
    legs.push({
      fillKey: `${c.rxNumber}|${c.fillNumber ?? ""}|${c.dateFilled}`,
      ndc11: c.ndc11,
      dateFilled: c.dateFilled,
      payer: c.pbmName ?? c.payerLabel ?? null,
      basisCode: c.basisOfReimbursement ?? null,
      quantityThousandths: c.quantityThousandths,
      remitCents: c.remitCents ?? 0,
      ingredientPaidCents: c.ingredientPaidCents ?? null,
      feePaidCents: c.dispensingFeePaidCents ?? null,
      awpCents: c.awpCents ?? null,
      cashPlan: c.cashPlan,
    });
    if ((c.awpCents ?? 0) > 0 && (c.quantityThousandths ?? 0) > 0) {
      awpSeen.set(c.ndc11, [...(awpSeen.get(c.ndc11) ?? []), Math.round(((c.awpCents as number) * 10_000 * 1000) / (c.quantityThousandths as number))]);
    }
  }
  if (legs.length === 0) return { rows: [], months: 0, fills: 0, withBasis: 0, ready: false, reason: "No claims are held, so there is nothing to read a payer's model from." };

  // Each NDC's product, off NADAC's own description; and its AWP per unit, off the claims first.
  const groupByNdc = new Map<string, string | null>();
  const nadacByNdc = new Map<string, { micros: number; description: string | null }>();
  for (const r of nadac) {
    if (!groupByNdc.has(r.ndc11)) groupByNdc.set(r.ndc11, groupKey({ ndc11: r.ndc11, description: r.description, classification: r.classification, pricingUnit: r.pricingUnit }));
    if (!nadacByNdc.has(r.ndc11)) nadacByNdc.set(r.ndc11, { micros: r.unitMicros, description: r.description });
  }
  const catalogueAwp = new Map<string, number>();
  const itemNumbers = new Map<string, string>();
  const catalogueName = new Map<string, string>();
  for (const c of catalogue) {
    if (c.itemNumber) itemNumbers.set(`${c.supplier.trim().toLowerCase()}|${c.ndc11}`, c.itemNumber);
    if (c.description && !catalogueName.has(c.ndc11)) catalogueName.set(c.ndc11, c.description);
    const q = packQtyOf(c.packSize);
    if (c.awpCents && q && q > 0 && !catalogueAwp.has(c.ndc11)) catalogueAwp.set(c.ndc11, Math.round((c.awpCents * 10_000) / q));
  }

  const ndcs = new Set<string>([...legs.map((l) => l.ndc11), ...ledger.rows.map((r) => r.ndc11)]);
  const bench: Bench[] = [...ndcs].map((ndc) => {
    const seen = awpSeen.get(ndc);
    return {
      ndc11: ndc,
      description: nadacByNdc.get(ndc)?.description ?? catalogueName.get(ndc) ?? null,
      nadacMicros: nadacByNdc.get(ndc)?.micros ?? null,
      awpMicros: seen && seen.length ? median(seen) : catalogueAwp.get(ndc) ?? null,
    };
  });

  const prices: Price[] = ledger.rows.flatMap((r) =>
    r.buys.map((b) => ({
      ndc11: r.ndc11,
      supplier: b.supplier,
      effectiveUnitMicros: b.effectiveUnitMicros,
      source: b.source,
      itemNumber: itemNumbers.get(`${b.supplier.trim().toLowerCase()}|${r.ndc11}`) ?? null,
    })),
  );

  const days = legs.map((l) => l.dateFilled).sort();
  const months = Math.max(0.25, (daysBetween(days[0], days[days.length - 1]) + 1) / 30.4);
  const rows = drugProfit({ legs, prices, bench, groupOf: (ndc) => groupByNdc.get(ndc) ?? null, months });
  return { rows, months, fills: legs.length, withBasis, ready: true, reason: null };
}
