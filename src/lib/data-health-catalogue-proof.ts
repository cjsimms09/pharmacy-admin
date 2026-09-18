/**
 * Each wholesaler's catalogue, proved against the file it was imported from.
 *
 * Written by `scripts/prove-catalogue.ts` into the `catalogue_proof` setting each night. The
 * catalogue is what every buying decision on this site is made from — which supplier is cheapest,
 * what an add-on costs, what the shelf is worth — so a price the table holds that the wholesaler's
 * file does not say is a purchase made on a number nobody sent.
 *
 * ── What the fraction is, and what it deliberately leaves out ──
 *
 * NDCs the newest file carries that the table agrees with, out of every NDC the newest file
 * carries. Per NDC and never per row: a wholesaler lists the same NDC several times in one file —
 * McKesson 539 of them — and the table holds one, so a fraction on rows would count the same
 * product many times and answer a question nobody asked.
 *
 * Carried-over items are outside the fraction on purpose. A catalogue import replaces only the
 * NDCs the arriving file carries, so a product the wholesaler stopped listing keeps the price it
 * last had. That is not a disagreement with the newest file — it is a price the newest file has
 * nothing to say about — and counting it against the score would make a wholesaler who trimmed
 * their catalogue look like one whose prices are wrong. It is reported in the gaps instead, with
 * the date those prices were last confirmed, because being old is the risk and nothing else on the
 * site says how old.
 *
 * A wholesaler with no catalogue at all contributes nothing to either half, which would let four
 * silent wholesalers hide behind one good one. So the gaps name them, and the row points at
 * "Catalogue files arriving", which is the row that measures that and has a denominator that can
 * see it.
 *
 * Pure.
 */

export type CatalogueProofSupplier = {
  supplier: string;
  supplierId: string | null;
  fileName: string | null;
  importedAt: string | null;
  printedOn: string | null;
  documentFound: boolean;
  rowsInFile: number;
  ndcsInFile: number;
  listedTwice: number;
  itemsInTable: number;
  proved: number;
  matchedOtherListing: number;
  priceDiffers: number;
  missing: number;
  carriedOver: number;
  carriedOverOldestPricedOn: string | null;
  fileUnitMicros: number;
  tableUnitMicros: number;
  problems: string[];
};

export type CatalogueProof = {
  provedOn: string | null;
  suppliers: CatalogueProofSupplier[];
  rowsInFiles: number;
  ndcsInFiles: number;
  listedTwice: number;
  proved: number;
  matchedOtherListing: number;
  priceDiffers: number;
  missing: number;
  carriedOver: number;
  suppliersWithNoFile: string[];
  lines: string[];
};

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseCatalogueProof(raw: string | undefined | null): CatalogueProof | null {
  if (!raw) return null;
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    j = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const suppliers = Array.isArray(j.suppliers)
    ? (j.suppliers as Record<string, unknown>[]).filter((s) => s && typeof s === "object").map(
        (s): CatalogueProofSupplier => ({
          supplier: str(s.supplier) ?? "an unnamed wholesaler",
          supplierId: str(s.supplierId),
          fileName: str(s.fileName),
          importedAt: str(s.importedAt),
          printedOn: str(s.printedOn),
          documentFound: s.documentFound === true,
          rowsInFile: num(s.rowsInFile),
          ndcsInFile: num(s.ndcsInFile),
          listedTwice: num(s.listedTwice),
          itemsInTable: num(s.itemsInTable),
          proved: num(s.proved),
          matchedOtherListing: num(s.matchedOtherListing),
          priceDiffers: num(s.priceDiffers),
          missing: num(s.missing),
          carriedOver: num(s.carriedOver),
          carriedOverOldestPricedOn: str(s.carriedOverOldestPricedOn),
          fileUnitMicros: num(s.fileUnitMicros),
          tableUnitMicros: num(s.tableUnitMicros),
          problems: strs(s.problems),
        }),
      )
    : [];
  return {
    provedOn: str(j.provedOn),
    suppliers,
    rowsInFiles: num(j.rowsInFiles),
    ndcsInFiles: num(j.ndcsInFiles),
    listedTwice: num(j.listedTwice),
    proved: num(j.proved),
    matchedOtherListing: num(j.matchedOtherListing),
    priceDiffers: num(j.priceDiffers),
    missing: num(j.missing),
    carriedOver: num(j.carriedOver),
    suppliersWithNoFile: strs(j.suppliersWithNoFile),
    lines: strs(j.lines),
  };
}

/**
 * NDCs the table agrees with the newest file about, out of every NDC that file carries.
 *
 * `matchedOtherListing` counts as agreement, because it is: the table holds a price the file
 * actually states, just not the listing the import rule would choose today. That is a fact about
 * the rule or about the file having changed, and it is reported in the gaps — it is not a price
 * the wholesaler never sent, which is the only thing this fraction is for.
 */
export function catalogueProofFraction(p: CatalogueProof): { numerator: number; denominator: number } {
  const denominator = p.suppliers.reduce((n, s) => n + s.ndcsInFile, 0);
  const numerator = p.suppliers.reduce((n, s) => n + s.proved + s.matchedOtherListing, 0);
  return { numerator: Math.min(numerator, denominator), denominator };
}

export function catalogueProofGaps(p: CatalogueProof): string[] {
  const n = (x: number) => x.toLocaleString("en-US");
  const gaps: string[] = [];

  // The fault, first and by supplier: a price no listing in the file states.
  for (const s of p.suppliers.filter((x) => x.priceDiffers > 0)) {
    gaps.push(
      `${s.supplier}: ${n(s.priceDiffers)} price${s.priceDiffers === 1 ? "" : "s"} in the table that no listing in ${s.fileName ?? "the newest file"} states. Every buying decision on those NDCs is made on the table's figure.`,
    );
  }
  for (const s of p.suppliers.filter((x) => x.missing > 0)) {
    gaps.push(`${s.supplier}: ${n(s.missing)} NDC${s.missing === 1 ? "" : "s"} in ${s.fileName ?? "the newest file"} reached no row in the catalogue table.`);
  }
  for (const s of p.suppliers) {
    for (const w of s.problems) gaps.push(`${s.supplier}: ${w}.`);
  }

  /*
   * Prices still quoted that the newest file does not carry. Not a fault and never counted as one —
   * see the header — but the one place anybody would learn how old a quoted price is.
   */
  for (const s of p.suppliers.filter((x) => x.carriedOver > 0)) {
    gaps.push(
      `${s.supplier}: ${n(s.carriedOver)} price${s.carriedOver === 1 ? "" : "s"} are held that ${s.fileName ?? "the newest file"} does not carry${s.carriedOverOldestPricedOn ? `, the oldest priced ${s.carriedOverOldestPricedOn}` : ""}. They came from an earlier file and are still quoted.`,
    );
  }

  if (p.matchedOtherListing > 0) {
    gaps.push(
      `${n(p.matchedOtherListing)} NDC${p.matchedOtherListing === 1 ? "" : "s"} are held at a price the file states on a different listing from the one the import rule would pick today. Not a wrong price; the file or the rule has changed since the import.`,
    );
  }

  if (p.suppliersWithNoFile.length > 0) {
    gaps.push(
      `No catalogue has ever been imported for ${p.suppliersWithNoFile.join(", ")}, so nothing of theirs is proved against anything and they are outside the figure above. Which wholesalers' files are still arriving is the "Catalogue files arriving" row.`,
    );
  }
  return gaps;
}

export function catalogueProofNote(p: CatalogueProof): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const withFile = p.suppliers.filter((s) => s.ndcsInFile > 0);
  if (withFile.length === 0) return "The proof ran and found no wholesaler with a catalogue file to be proved against.";
  const oldest = withFile.reduce<string | null>((a, s) => (s.printedOn && (!a || s.printedOn < a) ? s.printedOn : a), null);
  return (
    `${n(withFile.length)} wholesaler${withFile.length === 1 ? "" : "s"}' newest files re-read: ${n(p.ndcsInFiles)} NDCs across ${n(p.rowsInFiles)} listings` +
    (p.listedTwice > 0 ? `, ${n(p.listedTwice)} of them listed more than once in their own file` : "") +
    `.${oldest ? ` The oldest of those files was priced ${oldest}.` : ""}` +
    (p.carriedOver > 0
      ? ` A further ${n(p.carriedOver)} prices are held from earlier files and are outside this figure: the newest file says nothing about them, so there is nothing to agree or disagree with.`
      : "")
  );
}
