import "server-only";

/**
 * The supplier catalogue, read once and kept until it changes.
 *
 * McKesson's weekly export is forty-five thousand items. Three screens read the whole of it on
 * every request — the purchasing ledger, the money list and the buy list — and pulling those rows
 * out of SQLite and into JavaScript takes about one and a quarter seconds each time. Today, the
 * money page and Purchasing were therefore paying that toll on every page load, twice over on the
 * pages that use two of the three, and the pharmacy computer is slower than the machine those
 * figures were measured on.
 *
 * It is the same forty-five thousand rows every time. The catalogue changes when a file is
 * imported, which is once a week, so it is read once and held.
 *
 * ── Knowing when it has changed ──
 *
 * The cache is keyed on the newest supplier import — its id and the number of items filed with it —
 * which is one indexed row rather than a scan. An import writes a new row, the key moves, and the
 * next read reloads. A ten-minute ceiling stands behind that so nothing can be stale for long even
 * if a future path writes items without an import row.
 *
 * Only the columns the three callers use are read. The rest of the row — the AWP, the item number,
 * the timestamps — is real and wanted elsewhere, and reading it here would be a third of a second
 * spent on fields nobody in this path looks at.
 */

export type CatalogueRow = {
  ndc11: string;
  supplier: string;
  description: string | null;
  productKey: string | null;
  packSize: string | null;
  unitCostMicros: number | null;
  packCostCents: number | null;
  contractFlag: string | null;
  availability: string | null;
  pricedOn: string | null;
};

let held: { key: string; at: number; rows: CatalogueRow[] } | null = null;

const MAX_AGE_MS = 10 * 60_000;

/** What the catalogue looks like from outside: the newest import, and how many items it filed. */
async function currentKey(): Promise<string> {
  const { db } = await import("@/db");
  const latest = await db.query.supplierImports.findFirst({
    orderBy: (i, { desc }) => [desc(i.createdAt)],
    columns: { id: true, itemsAdded: true, itemsUpdated: true },
  });
  return latest ? `${latest.id}:${latest.itemsAdded}:${latest.itemsUpdated}` : "empty";
}

export async function catalogueRows(): Promise<CatalogueRow[]> {
  const key = await currentKey();
  if (held && held.key === key && Date.now() - held.at < MAX_AGE_MS) return held.rows;

  const { db } = await import("@/db");
  const rows = await db.query.supplierItems.findMany({
    columns: {
      ndc11: true,
      supplier: true,
      description: true,
      productKey: true,
      packSize: true,
      unitCostMicros: true,
      packCostCents: true,
      contractFlag: true,
      availability: true,
      pricedOn: true,
    },
  });
  held = { key, at: Date.now(), rows };
  return rows;
}

/**
 * Forget it, for a path that has just changed the catalogue and wants the change seen at once.
 *
 * The key would catch it on the next read anyway; this is so the screen the import redirects to
 * shows the new prices rather than the ones from a moment ago, which reads as an import that did
 * nothing.
 */
export function forgetCatalogue(): void {
  held = null;
}
