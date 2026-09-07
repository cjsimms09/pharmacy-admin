import "server-only";
import { db } from "@/db";
import { catalogueRows } from "./catalogue-cache";
import { allFills } from "./claims";
import { allSuppliers } from "./suppliers-registry";
import { rebateProgramsInForce } from "./supplier-terms-store";
import { groupKey } from "./product-groups";
import { replayContracts, type Replay, type ReplayContract, type ReplayOffer, type ReplayProduct } from "./contract-replay";
import { todayIso } from "./dates";

/**
 * The contract replay, assembled from what the site holds.
 *
 * Fills come from the claims as bottles, not transmissions, so a coordinated claim is one
 * dispensing. Products are keyed off NADAC's descriptions. Offers are every supplier's current
 * catalogue; contracts are each supplier's programmes in force today. Another wholesaler's offer
 * is tested by adding it as a supplier, loading its price file and typing its ladder on its terms
 * page — the same three steps the existing ones went through.
 */
export type ReplayView = { replay: Replay; months: number; missing: string[]; asOf: string };

export async function replayNow(monthsBack = 12): Promise<ReplayView> {
  const today = todayIso();
  const [fills, nadac, items, suppliers] = await Promise.all([
    allFills(),
    db.query.nadacPrices.findMany({ columns: { ndc11: true, description: true, classification: true, pricingUnit: true, otc: true, effectiveOn: true } }),
    // The levelled catalogue: every supplier's row on the same footing (one whole package, the unit
    // derived from its total) with the pharmacy's corrections applied. Read raw, McKesson's "(3) 28 EA"
    // priced per inner pack against IPD's "84 EA" per tablet showed a twenty-three-fold gap that was
    // notation, not price.
    catalogueRows(),
    allSuppliers(true),
  ]);
  const missing: string[] = [];

  const fromMonth = (() => {
    const [y, m] = today.slice(0, 7).split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 - monthsBack, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();
  const replayFills = fills
    .filter((f) => f.ndc11 && f.quantityThousandths && f.quantityThousandths > 0 && f.dateFilled >= `${fromMonth}-01`)
    .map((f) => ({ dateFilled: f.dateFilled, ndc11: f.ndc11!, quantityThousandths: f.quantityThousandths! }));
  if (replayFills.length === 0) missing.push("No dispensing with a quantity in the last twelve months, so there is nothing to replay.");

  /* One product key per NDC from its earliest NADAC row, as product-groups.ts does. */
  const seen = new Map<string, ReplayProduct>();
  for (const n of [...nadac].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))) {
    if (seen.has(n.ndc11)) continue;
    const cls = n.classification === "B" || n.classification === "G" ? n.classification : null;
    seen.set(n.ndc11, { ndc11: n.ndc11, groupKey: groupKey({ ndc11: n.ndc11, description: n.description, classification: n.classification, pricingUnit: n.pricingUnit, otc: n.otc }), classification: cls });
  }
  if (seen.size === 0) missing.push("No NADAC file is loaded, so no two NDCs can be told to be the same product.");

  // The flag is read the way the buy list reads it: "rebated" is rebated, "not rebated" is not, and anything else is unknown.
  const offers: ReplayOffer[] = items
    .filter((it) => it.unitCostMicros !== null)
    .map((it) => ({ supplier: it.supplier, ndc11: it.ndc11, unitCostMicros: it.unitCostMicros as number, rebated: it.contractFlag === "rebated" ? true : it.contractFlag === "not rebated" ? false : null, description: it.description }));
  if (offers.length === 0) missing.push("No supplier catalogue is loaded.");

  const contracts: ReplayContract[] = [];
  for (const s of suppliers) {
    const progs = await rebateProgramsInForce(s.id, today);
    // Offers name suppliers by the catalogue's word for them; the register by its own. Match on either.
    const names = new Set([s.name, s.catalogName ?? ""].map((x) => x.trim().toLowerCase()).filter(Boolean));
    const supplierInOffers = [...new Set(offers.map((o) => o.supplier))].find((o) => names.has(o.trim().toLowerCase())) ?? s.name;
    contracts.push({ supplier: supplierInOffers, supplierId: s.id, programmes: progs.map((p) => ({ name: p.row.name, terms: p.terms })) });
  }

  const replay = replayContracts({ fills: replayFills, products: [...seen.values()], offers, contracts, minCoverage: 0.9 });
  return { replay, months: monthsBack, missing, asOf: today };
}
