import "server-only";
import { db } from "@/db";
import { overNadac, type OverNadac, type Offer } from "./over-nadac";
import { catalogueRows } from "./catalogue-cache";
import { packQtyOf, productLedger } from "./product-ledger";
import { nadacNow } from "./nadac-latest";
import { contractRatesBySupplier } from "./rebate-rates";
import { planLookup, planScopeOf } from "./plans";
import { SB20_EFFECTIVE_FROM } from "./reimbursement-rules";
import { addDays, todayIso } from "./dates";
import type { PlanClass } from "@/db/schema";

/**
 * The over-NADAC list, assembled from what the site holds.
 *
 * Invoice lines are the purchases; the catalogues say the pack each is priced by and what every
 * supplier lists now (through the product ledger, so the rebate is off both sides the same way);
 * NADAC is the benchmark in force; the plan register says which fills paid NADAC by law, so the
 * row can say how much of the gap was actually paid out. The window is the owner's: seven days for
 * the weekly file, longer to see a pattern.
 */
export async function overNadacNow(days = 7, to = todayIso()): Promise<OverNadac> {
  const { held } = await import("./held");
  return held(`over-nadac:${days}:${to}`, () => loadOverNadac(days, to));
}

async function loadOverNadac(days: number, to: string): Promise<OverNadac> {
  const from = addDays(to, -(days - 1));
  const [lines, catalogue, nadac, ledger, rates, claims, plans] = await Promise.all([
    db.query.invoiceLines.findMany({ columns: { ndc11: true, supplier: true, description: true, itemNumber: true, invoiceDate: true, quantity: true, unitCostCents: true, rebated: true } }),
    catalogueRows(),
    nadacNow(),
    productLedger(),
    contractRatesBySupplier(),
    db.query.claims.findMany({ columns: { ndc11: true, dateFilled: true, quantityThousandths: true, status: true, bin: true, pcn: true, groupNumber: true, cashPlan: true } }),
    db.query.planGroups.findMany({ columns: { bin: true, pcn: true, groupNumber: true, classification: true } }),
  ]);

  const packOf = new Map<string, number>();
  for (const c of catalogue) {
    const q = packQtyOf(c.packSize);
    if (q && q > 0 && !packOf.has(c.ndc11)) packOf.set(c.ndc11, q);
  }
  const nadacMap = new Map(nadac.map((n) => [n.ndc11, { unitMicros: n.unitMicros, effectiveOn: n.effectiveOn, description: n.description }]));
  const itemNumbers = new Map<string, string>();
  for (const c of catalogue) if (c.itemNumber) itemNumbers.set(`${c.ndc11}|${c.supplier.trim().toLowerCase()}`, c.itemNumber);
  const offers: Offer[] = ledger.rows.flatMap((r) =>
    r.buys.filter((b) => b.source === "catalogue").map((b) => ({ ndc11: r.ndc11, supplier: b.supplier, effectiveUnitMicros: b.effectiveUnitMicros, itemNumber: itemNumbers.get(`${r.ndc11}|${b.supplier.trim().toLowerCase()}`) ?? null, shortDated: b.shortDated !== null })),
  );

  // Units that went out in the window on plans paying NADAC by law: Medicaid, and the floor from 1 July 2026.
  const lookup = planLookup(plans);
  const lawUnits = new Map<string, number>();
  for (const c of claims) {
    if (c.status !== "paid" || c.cashPlan || !c.ndc11 || c.dateFilled < from || c.dateFilled > to) continue;
    const cls = lookup(c)?.classification as PlanClass | undefined;
    if (!cls) continue;
    const byLaw = cls === "medicaid" || (planScopeOf(cls) === "commercial_non_erisa" && c.dateFilled >= SB20_EFFECTIVE_FROM);
    if (!byLaw) continue;
    lawUnits.set(c.ndc11, (lawUnits.get(c.ndc11) ?? 0) + (c.quantityThousandths ?? 0) / 1000);
  }

  return overNadac({
    lines: lines.map((l) => ({ ndc11: l.ndc11, supplier: l.supplier, description: l.description, itemNumber: l.itemNumber, invoiceDate: l.invoiceDate, packs: l.quantity, packCostCents: l.unitCostCents, rebated: l.rebated })),
    packQtyOf: (ndc) => packOf.get(ndc) ?? null,
    nadac: nadacMap,
    rateOf: (s) => (s ? rates[s.trim().toLowerCase()] ?? null : null),
    offers,
    lawUnitsOf: (ndc) => lawUnits.get(ndc) ?? 0,
    from,
    to,
  });
}
