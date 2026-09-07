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
  /** The supplier's own item number, what an order line is placed by. Null where the file carried none. */
  itemNumber?: string | null;
  description: string | null;
  productKey: string | null;
  packSize: string | null;
  unitCostMicros: number | null;
  packCostCents: number | null;
  awpCents: number | null;
  contractFlag: string | null;
  availability: string | null;
  pricedOn: string | null;
  /** True where the pharmacy has corrected this supplier's row by hand. */
  corrected?: boolean;
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

/**
 * Puts every supplier's row on the same footing: one package, its total, and the cost of a unit of it.
 *
 * Wholesalers write the same package at different heights. McKesson lists albuterol 1.25mg/3ML as
 * "(25) 3 ML" at $6.2500 a unit; API lists the same NDC as "75 ML" at $0.2532. Compared on the
 * printed unit cost, API looks twenty-five times cheaper and the buy list would always send the
 * order there — on a comparison of a millilitre against a vial.
 *
 * The two agree on what the box costs: $18.75 and $18.99, a 1.3% difference between two independent
 * wholesalers. That is not a coincidence, and it holds across the file — where two suppliers use
 * different notation for one NDC, the pack totals agree 183 times against the printed unit costs' 22.
 *
 * So the pack total is the figure a comparison can trust, and the unit cost is derived from it over
 * the whole package rather than taken from the column. A row without a bracket is already whole and
 * is left exactly as it is.
 */
export function wholePackage(r: CatalogueRow): CatalogueRow {
  if (!r.packSize) return r;
  const m = /\((\d+)\)\s*([\d.]+)\s*(EA|ML|GM)\b/i.exec(r.packSize);
  if (!m) return r;
  const cartons = Number(m[1]);
  const inner = Number(m[2]);
  const whole = cartons * inner;
  if (!Number.isFinite(whole) || whole <= 0 || cartons <= 1) return r;
  // Without a pack total there is nothing to divide, and guessing which column is right would be
  // the very mistake this exists to avoid.
  if (r.packCostCents === null) return r;
  return {
    ...r,
    packSize: `${whole} ${m[3].toUpperCase()}`,
    unitCostMicros: Math.round((r.packCostCents * 10_000) / whole),
    asImported: r.asImported ?? { packSize: r.packSize, unitCostMicros: r.unitCostMicros, packCostCents: r.packCostCents },
  };
}

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
  const [latest, newestFix, fixCount, packFixes, directoryLoad] = await Promise.all([
    db.query.supplierImports.findFirst({
      orderBy: (i, { desc }) => [desc(i.createdAt)],
      columns: { id: true, itemsAdded: true, itemsUpdated: true },
    }),
    // A correction changes what every screen should see, so it moves the key exactly as an import does.
    db.query.supplierItemFixes.findFirst({ orderBy: (f, { desc }) => [desc(f.correctedAt)], columns: { correctedAt: true } }),
    db.query.supplierItemFixes.findMany({ columns: { id: true } }),
    // A settled package changes what every supplier's row says, so it moves the key too.
    db.query.ndcPackFixes.findMany({ columns: { id: true, correctedAt: true } }),
    // The FDA now settles most packages, so a fresh directory changes what every row reads.
    db.query.drugDirectoryLoads.findFirst({ orderBy: (l, { desc }) => [desc(l.loadedAt)], columns: { id: true } }),
  ]);
  const imported = latest ? `${latest.id}:${latest.itemsAdded}:${latest.itemsUpdated}` : "empty";
  const newestPack = packFixes.map((f) => f.correctedAt).sort().pop() ?? "none";
  return `${imported}|${newestFix?.correctedAt ?? "none"}:${fixCount.length}|${newestPack}:${packFixes.length}|${directoryLoad?.id ?? "-"}`;
}

export async function catalogueRows(): Promise<CatalogueRow[]> {
  const key = await currentKey();
  if (held && held.key === key && Date.now() - held.at < MAX_AGE_MS) return held.rows;

  const { db } = await import("@/db");
  const { packageSizes } = await import("./drug-directory-store");
  const { packReadings } = await import("./drug-file");
  const [raw, fixes, packFixes, fdaPacks] = await Promise.all([
    db.query.supplierItems.findMany({
      columns: {
        ndc11: true,
        supplier: true,
        itemNumber: true,
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
    packageSizes(),
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

  /*
   * The FDA settles an argument; it does not overrule everybody.
   *
   * Its package field is stated for a regulator, not for a buyer, and the two do not always mean
   * the same thing by a unit. It describes a box of four buprenorphine patches as four pouches of
   * 168 hours, which multiplies out to 672; it counts a Breyna inhaler in 120 actuations where
   * every wholesaler prices it by the 10.3 grams in the canister. Applied blind, both turn a
   * $124.99 patch into a $0.74 one — and the site did exactly that to 69 rows.
   *
   * So the FDA's figure is used only where some supplier already reads the package that way: same
   * unit of measure, and its own inner or whole figure equal to the FDA's. That is precisely the
   * case the 998 disputes were — two wholesalers describing one box, one of them agreeing with the
   * FDA — and it is never the case above, where no wholesaler recognises the number at all. When
   * twenty-four files say four and the directory says six hundred and seventy-two, the directory
   * is being read wrong, not the trade.
   */
  const fdaAgreed = new Map<string, string>();
  {
    const readings = new Map<string, Set<string>>();
    for (const r of raw) {
      const p = packReadings(r.packSize);
      if (p.uom === null) continue;
      const set = readings.get(r.ndc11) ?? new Set<string>();
      if (p.inner !== null) set.add(`${p.inner} ${p.uom}`);
      if (p.whole !== null) set.add(`${p.whole} ${p.uom}`);
      readings.set(r.ndc11, set);
    }
    for (const [ndc11, size] of fdaPacks) if (readings.get(ndc11)?.has(size)) fdaAgreed.set(ndc11, size);
  }

  const rows: CatalogueRow[] = raw.map((r) => {
    const fix = by.get(`${r.supplier.trim().toLowerCase()}|${r.ndc11}`);
    /*
     * The pharmacy's own answer first, then the FDA's, then the wholesaler's.
     *
     * An NDC names one package, and until now the only party who could say what was in it was the
     * pharmacist with the bottle in his hand — 998 NDCs were waiting on that. The FDA's package
     * file states it outright, per package NDC, and it is not selling anything: where it speaks,
     * every wholesaler's row is put on the FDA's package and the arguing stops. It never overrides
     * a pharmacist who has settled a package himself; he has the bottle and the file does not.
     */
    const settledPack = packBy.get(r.ndc11) ?? fdaAgreed.get(r.ndc11) ?? null;
    if (!fix && !settledPack) return r;
    /*
     * A blank in a correction means "leave the supplier's", never "set it to nothing" — so fixing
     * a pack size does not silently wipe a price that was right.
     */
    const packSize = fix?.packSize ?? settledPack ?? r.packSize;
    const units = packSize ? unitsIn(packSize) : null;

    /*
     * Settling a package must not throw away what the box costs.
     *
     * The pack total is the figure a comparison can trust — the whole reason `wholePackage` exists
     * — and the printed unit cost is the untrustworthy half, because wholesalers quote it against
     * different levels of the same box. So when the pharmacy says how many units a package holds,
     * the box price is kept and the unit price is derived from it.
     *
     * It used to run the other way: keep the supplier's unit cost and multiply it by the new unit
     * count. On a row McKesson writes as "(4) 0.5 ML" that unit cost is the price of one vial, so
     * settling the package at "2 ML" multiplied a vial by four. Trulicity went from a correct
     * $976.72 to $3,906.88, while a supplier who wrote the same box as "2 ML" was left alone — so
     * the act of correcting a package invented a fourfold difference between two suppliers who
     * had agreed to within three per cent. The levelling had already got it right; the correction
     * was what broke it.
     *
     * A supplier-specific correction that names a unit price is the exception: there the pharmacy
     * is stating the price itself, and it is the pack total that follows.
     */
    const unitGiven = fix?.unitCostMicros ?? null;
    const unitCostMicros =
      unitGiven ??
      (r.packCostCents !== null && units !== null && units > 0
        ? Math.round((r.packCostCents * 10_000) / units)
        : r.unitCostMicros);
    const packCostCents =
      unitGiven !== null && units !== null
        ? Math.round((unitGiven * units) / 10_000)
        : r.packCostCents;
    return {
      ...r,
      packSize,
      unitCostMicros,
      packCostCents,
      asImported: { packSize: r.packSize, unitCostMicros: r.unitCostMicros, packCostCents: r.packCostCents },
    };
  });

  // Every row on the same footing before anything compares two of them; see wholePackage.
  const levelled = rows.map(wholePackage).map((r) => ({ ...r, corrected: by.has(`${r.supplier.trim().toLowerCase()}|${r.ndc11}`) }));

  /*
   * And a row whose package and price are both out by the same factor is withheld from all of them.
   *
   * Levelling puts two notations for one box on the same footing. It cannot do anything about a
   * row that is simply wrong — ABC listing a six-card box of Apri as "1 EA" at $15.39 where four
   * wholesalers list 168 EA at $0.1302. That row does not need levelling, it needs leaving out,
   * and it has to be left out here rather than on each screen: this is the one place every
   * comparison in the site draws its prices from, and a screen that filtered it would leave the
   * next screen buying on it. See quarantineWrongPrices for the four tests it has to fail.
   */
  const { quarantineWrongPrices } = await import("./catalogue-check");
  const { rows: sound, taken } = quarantineWrongPrices(levelled);
  quarantined = taken;
  held = { key, at: Date.now(), rows: sound };
  return sound;
}

/**
 * The rows left out of comparisons by the last read, keyed "ndc11|supplier".
 *
 * Kept so the drug file screen can say what was withheld and why, rather than a price silently
 * going missing — which is the failure this exists to prevent, one level up.
 */
let quarantined = new Map<string, import("./catalogue-check").Quarantine>();
export function withheldPrices(): Map<string, import("./catalogue-check").Quarantine> {
  return quarantined;
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
  quarantined = new Map();
}
