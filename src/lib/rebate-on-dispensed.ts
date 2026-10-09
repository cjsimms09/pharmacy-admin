import { isGlp1 } from "./scrubbed-products";
import { formatCents } from "./money";

/**
 * The wholesaler rebate that belongs to the goods dispensed in a month.
 *
 * The owner, 9 October 2026: "shouldn't accrual only take into account COGS, not what was bought? that would be for cash."
 * The cost of goods on the accrual account is the acquisition cost of what was dispensed, so a rebate that reduces that
 * cost has to follow the same fills. A rebate earned on purchases belongs to the stock bought; it reaches cost of goods as
 * that stock is sold. Taken on purchases it put $7,395 against nine days of October when the generics dispensed in those
 * days carried $3,485 of it, because October's buying ran ahead of its dispensing.
 *
 * Each dispensed fill is sorted by what the wholesaler's invoices say about its product:
 *   - a product the invoices flag as earning the contract rebate earns the contract rate on its cost;
 *   - a GLP-1 earns nothing, as McKesson leaves them out of the purchases both factors are paid on;
 *   - any other product bought from the wholesaler earns the brand factor on its cost;
 *   - a product never bought from this wholesaler earns nothing from it.
 * The rates are the month's own, from the wholesaler's scrubbed compliance ratio for that month.
 */
export type DispensedFill = { ndc11: string | null; itemName: string | null; acquisitionCents: number | null };

export type RebateOnDispensed = {
  cents: number;
  contractCostCents: number;
  brandCostCents: number;
  glp1CostCents: number;
  otherCostCents: number;
  note: string;
};

export function rebateOnDispensed(
  fills: DispensedFill[],
  /** Each product the wholesaler's invoices show, by NDC: true where its latest invoice line is flagged as earning the contract rebate. */
  flagged: Map<string, boolean>,
  rates: { contractPercent: number | null; brandPercent: number | null },
): RebateOnDispensed {
  let contract = 0;
  let brand = 0;
  let glp1 = 0;
  let other = 0;
  for (const f of fills) {
    const cost = f.acquisitionCents ?? 0;
    if (cost <= 0) continue;
    if (isGlp1(f.itemName)) glp1 += cost;
    else if (f.ndc11 && flagged.get(f.ndc11) === true) contract += cost;
    else if (f.ndc11 && flagged.get(f.ndc11) === false) brand += cost;
    else other += cost;
  }
  const cents = Math.round((contract * (rates.contractPercent ?? 0)) / 100) + Math.round((brand * (rates.brandPercent ?? 0)) / 100);
  return {
    cents,
    contractCostCents: contract,
    brandCostCents: brand,
    glp1CostCents: glp1,
    otherCostCents: other,
    note:
      `Worked out on what was dispensed, so it follows the cost of goods: ${formatCents(contract)} of contract generics at ${rates.contractPercent ?? 0}% ` +
      `and ${formatCents(brand)} of other McKesson products at ${rates.brandPercent ?? 0}%, at the wholesaler's own ratio for the month. ` +
      `GLP-1s (${formatCents(glp1)}) and products not bought from the wholesaler earn nothing here. ` +
      "It is replaced by the statement for this month once that is entered on Spending under Wholesaler rebates. A discount, so it reduces cost rather than adding to revenue.",
  };
}
