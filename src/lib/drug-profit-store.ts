import "server-only";
import { db } from "@/db";
import { drugProfitReport, type DrugProfit, type ProfitSummary, type ClaimLeg, type Price, type Bench } from "./drug-profit";
import { groupKey } from "./product-groups";
import { directoryKeys } from "./drug-directory-store";
import { planLookup, planScopeOf } from "./plans";
import type { PlanClass } from "@/db/schema";
import { SB20_EFFECTIVE_FROM, SB20_MIN_DISPENSING_FEE_CENTS } from "./reimbursement-rules";
import { getSettings } from "./settings";
import { packQtyOf, productLedger } from "./product-ledger";
import { catalogueRows } from "./catalogue-cache";
import { nadacNow } from "./nadac-latest";
import { daysBetween } from "./dates";

/**
 * The profit-by-model engine, assembled from what the site holds.
 *
 * Claims give the legs (with the basis code and the split where the export carries them); the
 * plan register says which fills the law settles (Medicaid, and from 1 July 2026 every plan the
 * Kansas floor reaches); NADAC gives each NDC's benchmark; the FDA directory says which NDCs are
 * one product, with NADAC's description standing in for NDCs the directory does not carry; the
 * AWP the PBM priced against comes off the claims themselves where it is printed, and off the
 * catalogue where it is not; prices come from the product ledger, which already holds every
 * invoice and catalogue price per NDC after the rebate it earns. Nothing is estimated here that a
 * table could say.
 */
export type DrugProfitView = {
  rows: DrugProfit[];
  summary: ProfitSummary;
  months: number;
  /** How many of the NDCs dispensed the FDA directory places, and how many fall back to the description. */
  grouping: { directory: number; description: number };
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
  const { held } = await import("./held");
  return held("drug-profit", loadDrugProfit);
}

async function loadDrugProfit(): Promise<DrugProfitView> {
  const [claims, nadac, catalogue, ledger, plans, s, directory] = await Promise.all([
    db.query.claims.findMany({
      columns: {
        rxNumber: true, fillNumber: true, dateFilled: true, ndc11: true, pbmName: true, payerLabel: true, basisOfReimbursement: true,
        quantityThousandths: true, remitCents: true, ingredientPaidCents: true, dispensingFeePaidCents: true, awpCents: true, cashPlan: true, status: true,
        bin: true, pcn: true, groupNumber: true,
      },
    }),
    nadacNow(),
    catalogueRows(),
    productLedger(),
    db.query.planGroups.findMany({ columns: { bin: true, pcn: true, groupNumber: true, classification: true } }),
    getSettings(),
    directoryKeys(),
  ]);
  const lookup = planLookup(plans);
  const floorFeeCents = Math.max(SB20_MIN_DISPENSING_FEE_CENTS, Number(s.ks_medicaid_dispensing_fee_cents ?? "") || 0);
  /** What the law settles for a fill, from the register: nothing until the plan has been classified. */
  const settledOf = (c: { bin: string | null; pcn: string | null; groupNumber: string | null; dateFilled: string }): ClaimLeg["settled"] => {
    const cls = lookup(c)?.classification as PlanClass | undefined;
    if (!cls) return null;
    if (cls === "medicaid") return "medicaid";
    if (planScopeOf(cls) === "commercial_non_erisa" && c.dateFilled >= SB20_EFFECTIVE_FROM) return "floor";
    return null;
  };

  const legs: ClaimLeg[] = [];
  const awpSeen = new Map<string, number[]>();
  let withBasis = 0;
  for (const c of claims) {
    if (c.status !== "paid" || !c.ndc11) continue;
    if (c.basisOfReimbursement) withBasis++;
    legs.push({
      settled: settledOf(c),
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
  const emptySummary: ProfitSummary = { fills: 0, byLaw: { fills: 0, remitCents: 0 }, floor: { fills: 0, bound: 0, above: 0, unpriced: 0 }, byCode: 0, inferred: 0, remitCents: 0 };
  if (legs.length === 0) return { rows: [], summary: emptySummary, months: 0, grouping: { directory: 0, description: 0 }, fills: 0, withBasis: 0, ready: false, reason: "No claims are held, so there is nothing to read a payer's model from." };

  // Each NDC's product, off NADAC's own description; and its AWP per unit, off the claims first.
  const groupByNdc = new Map<string, string | null>();
  const nadacByNdc = new Map<string, { micros: number; description: string | null }>();
  for (const r of nadac) {
    if (!groupByNdc.has(r.ndc11))
      groupByNdc.set(
        r.ndc11,
        groupKey({
          ndc11: r.ndc11,
          equivalenceKey: directory.get(r.ndc11)?.key ?? null,
          description: r.description,
          classification: r.classification,
          pricingUnit: r.pricingUnit,
        }),
      );
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
  // The FDA directory's product first; NADAC's description where the directory does not carry the NDC.
  /*
   * One grouping rule, not two.
   *
   * This used to read the directory through `groupResolver`, which returned a bare "fda:<key>" for
   * every NDC the directory carried and the full `groupKey` string for the rest. The bare key drops
   * the three things `groupKey` deliberately appends — NADAC's brand/generic classification, the
   * pricing unit, and OTC — so a brand and its generic, which share an FDA equivalence key by
   * definition, were one product here and two products everywhere else. On this database that was
   * the rule in force for 96.9% of the NDCs dispensed. The key now comes from `groupKey` alone,
   * with the directory's answer passed into it, so every screen groups the same way.
   */
  const groupOf = (ndc: string): string | null => {
    const held = groupByNdc.get(ndc);
    if (held !== undefined) return held;
    // The loop above only visits NDCs NADAC prices. The directory carries 77.5% of the catalogue
    // against NADAC's 57.3%, so an NDC can be perfectly well placed by the FDA and never appear
    // there; without this it would fall out of every product group for want of a benchmark it does
    // not need to be grouped. Classification and pricing unit are NADAC's to give and stay unknown.
    const k = groupKey({ ndc11: ndc, equivalenceKey: directory.get(ndc)?.key ?? null, description: null, classification: null, pricingUnit: null });
    groupByNdc.set(ndc, k);
    return k;
  };
  const grouping = { directory: 0, description: 0 };
  for (const ndc of new Set(legs.map((l) => l.ndc11))) {
    if (directory.has(ndc)) grouping.directory++;
    else grouping.description++;
  }
  const { rows, summary } = drugProfitReport({ legs, prices, bench, groupOf, months, floorFeeCents });
  return { rows, summary, months, grouping, fills: legs.length, withBasis, ready: true, reason: null };
}
