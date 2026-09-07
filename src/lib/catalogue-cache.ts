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
  awpCents: number | null;
  contractFlag: string | null;
  availability: string | null;
  pricedOn: string | null;
  /**
   * What the supplier's own file said, where the pharmacy has corrected the row.
   *
   * The correction is applied here rather than on the screen that made it, so that the buy list,
   * the ledger and the money list all work from the corrected figures — a pack size fixed on one
   * page and ignored by the page that spends money would be worse than not fixing it. The
   * supplier's own figures are carried alongside, because the first question about a corrected row
   * is always what the file actually said.
   */
  asImported?: { packSize: string | null; unitCostMicros: number | null; packCostCents: number | null };
};

let held: { key: string; at: number; rows: CatalogueRow[] } | null = null;

/** Units in a pack size — "180 EA" is 180. The bracket is the order multiple, not the pack. */
function unitsIn(packSize: string): number | null {
  const m = /(?:\(\d+\)\s*)?([\d.]+)\s*(EA|ML|GM)\b/i.exec(packSize);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const MAX_AGE_MS = 10 * 60_000;

/** What the catalogue looks like from outside: the newest import, and how many items it filed. */
async function currentKey(): Promise<string> {
  const { db } = await import("@/db");
  const [latest, newestFix, fixCount, packFixes] = await Promise.all([
    db.query.supplierImports.findFirst({
      orderBy: (i, { desc }) => [desc(i.createdAt)],
      columns: { id: true, itemsAdded: true, itemsUpdated: true },
    }),
    // A correction changes what every screen should see, so it moves the key exactly as an import does.
    db.query.supplierItemFixes.findFirst({ orderBy: (f, { desc }) => [desc(f.correctedAt)], columns: { correctedAt: true } }),
    db.query.supplierItemFixes.findMany({ columns: { id: true } }),
    // A settled package changes what every supplier's row says, so it moves the key too.
    db.query.ndcPackFixes.findMany({ columns: { id: true, correctedAt: true } }),
  ]);
  const imported = latest ? `${latest.id}:${latest.itemsAdded}:${latest.itemsUpdated}` : "empty";
  const newestPack = packFixes.map((f) => f.correctedAt).sort().pop() ?? "none";
  return `${imported}|${newestFix?.correctedAt ?? "none"}:${fixCount.length}|${newestPack}:${packFixes.length}`;
}

export async function catalogueRows(): Promise<CatalogueRow[]> {
  const key = await currentKey();
  if (held && held.key === key && Date.now() - held.at < MAX_AGE_MS) return held.rows;

  const { db } = await import("@/db");
  const [raw, fixes, packFixes] = await Promise.all([
    db.query.supplierItems.findMany({
      columns: {
        ndc11: true,
        supplier: true,
        description: true,
        productKey: true,
        packSize: true,
        unitCostMicros: true,
        packCostCents: true,
        awpCents: true,
        contractFlag: true,
        availability: true,
        pricedOn: true,
      },
    }),
    db.query.supplierItemFixes.findMany(),
    db.query.ndcPackFixes.findMany(),
  ]);

  const by = new Map(fixes.map((f) => [`${f.supplier.trim().toLowerCase()}|${f.ndc11}`, f]));
  /*
   * What a package of an NDC holds, settled by the pharmacy for every supplier at once.
   *
   * An NDC names one package, so when two wholesalers describe it differently only one of them can
   * be right — and the pharmacy is the only party that can say which, because the pharmacy has the
   * bottle. Applied here rather than on the screen that recorded it, so the buy list orders against
   * the settled figure and not the one the file happened to carry.
   *
   * A supplier-specific correction still wins: it is the more specific statement, and it is how a
   * pharmacy records that one wholesaler genuinely ships a different configuration.
   */
  const packBy = new Map(packFixes.map((f) => [f.ndc11, f.packSize]));
  const rows: CatalogueRow[] = raw.map((r) => {
    const fix = by.get(`${r.supplier.trim().toLowerCase()}|${r.ndc11}`);
    const settledPack = packBy.get(r.ndc11) ?? null;
    if (!fix && !settledPack) return r;
    /*
     * A blank in a correction means "leave the supplier's", never "set it to nothing" — so fixing
     * a pack size does not silently wipe a price that was right.
     */
    const packSize = fix?.packSize ?? settledPack ?? r.packSize;
    const unitCostMicros = fix?.unitCostMicros ?? r.unitCostMicros;
    // The pack cost follows from the two figures above; keeping the file's would leave the row
    // disagreeing with itself, which is one of the faults the correction exists to remove.
    const units = packSize ? unitsIn(packSize) : null;
    const packCostCents = unitCostMicros !== null && units !== null ? Math.round((unitCostMicros * units) / 10_000) : r.packCostCents;
    return {
      ...r,
      packSize,
      unitCostMicros,
      packCostCents,
      asImported: { packSize: r.packSize, unitCostMicros: r.unitCostMicros, packCostCents: r.packCostCents },
    };
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
