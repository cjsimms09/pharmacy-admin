import "server-only";
import { productLedger, opportunities, margins, losers } from "./product-ledger";
import { underNadac, switchNdc, notYetBought } from "./under-nadac";
import { groupKey } from "./product-groups";
import { directoryKeys } from "./drug-directory-store";
import { nadacNow } from "./nadac-latest";

/**
 * The comparisons the Which-NDC-pays page draws under its lead table, computed once and held.
 *
 * They are arithmetic over the whole ledger — fifty thousand rows on the catalogues held — and
 * were done again on every open of the page, half a second each time, for figures that change
 * only when a file loads.
 */
export async function productsExtrasNow() {
  const { held } = await import("./held");
  return held("products-extras", loadProductsExtras);
}

async function loadProductsExtras() {
  const [ledger, nadac, directory] = await Promise.all([productLedger(), nadacNow(), directoryKeys()]);
  const groupByNdc = new Map<string, string | null>();
  for (const r of nadac) {
    if (groupByNdc.has(r.ndc11)) continue;
    groupByNdc.set(
      r.ndc11,
      groupKey({ ndc11: r.ndc11, equivalenceKey: directory.get(r.ndc11)?.key ?? null, description: r.description, classification: r.classification ?? directory.get(r.ndc11)?.classification ?? null, pricingUnit: r.pricingUnit, otc: r.otc ?? directory.get(r.ndc11)?.otc ?? false }),
    );
  }
  const buys = underNadac(ledger.rows, (ndc) => groupByNdc.get(ndc) ?? null);
  const earned = margins(ledger.rows);
  return {
    ledgerRows: opportunities(ledger.rows),
    rate: ledger.rate,
    buys,
    switches: switchNdc(buys),
    unstocked: notYetBought(buys),
    earned,
    losing: losers(earned),
  };
}
