import { normalizeNdc } from "./ndc";
import { parseCents, parseUnitMicros, parseQuantityThousandths, extendedCents } from "./money";
import { splitRow } from "./pioneer-catalog";

/**
 * Reading a daily inventory on-hand export.
 *
 * On hand is the one figure the site could not derive. The claims say what left the shelf and the
 * invoices say what arrived on it, and the difference between those two is not what is there —
 * short fills, partial bottles, returns, breakage and every count ever done all sit in the gap. So
 * the shelf has to be read, not computed, and it has to be read often, because a snapshot a
 * fortnight old will confidently recommend returning stock that has already gone.
 *
 * With it, three questions become arithmetic instead of memory: how many days of stock is this,
 * what is sitting here that nothing is going to dispense, and what can still go back inside the
 * supplier's window.
 *
 * ── Why this reader is deliberately loose ──
 *
 * Every other reader in this site is written against a file whose exact shape has been seen. This
 * one is not: PioneerRx will export on hand under any of several report names with columns the
 * pharmacy chooses when it builds the export, and the column set is not going to be the same twice.
 * So it matches column *headers* by meaning rather than reading fixed positions, accepts tab,
 * semicolon, comma or pipe, and — this is the part that matters — says plainly which columns it
 * could not place instead of filling them with zero.
 *
 * A missing quantity is refused, never defaulted. A zero on hand and an unreadable on hand are
 * opposite instructions: the first says order it, the second says the file is wrong.
 *
 * ── One snapshot per day, replacing, never accumulating ──
 *
 * The same day uploaded twice is the same shelf, not twice the shelf. The caller stores these
 * against a count date and replaces that date wholesale, which is why the date is read here and a
 * file that carries no date at all is a file the caller has to date itself.
 */

export type OnHandRow = {
  /**
   * The item's code exactly as the pharmacy's system carries it: an eleven-digit NDC for anything
   * dispensed, a twelve-digit UPC for a front-shop item that was never assigned one.
   */
  code: string;
  codeKind: "ndc11" | "upc";
  /**
   * The eleven-digit NDC where the code is one, and null where it is a barcode. Kept separate from
   * `code` so nothing joins a shampoo's UPC to a drug that happens to share its digits.
   */
  ndc11: string | null;
  description: string | null;
  itemNumber: string | null;
  /** Which shelf the item sits on — "Rx" or "Retail" — where the report says. */
  inventoryGroup?: string | null;
  /** Ordered and not yet on the shelf, where the report carries it. Dispensing units. */
  onOrderThousandths?: number | null;
  /** Units in the package the item is bought in — "180 EA". */
  packQty?: number | null;
  /** True where the report counted whole packages and this reader multiplied them out. */
  countedInPackages?: boolean;
  /** Units on the shelf, in thousandths, so a part bottle is exact. Always dispensing units. */
  quantityThousandths: number;
  unit: string | null;
  /** What the pharmacy's own system values a unit at, in micros. Null where the file omits it. */
  unitCostMicros: number | null;
  /** The line's value in cents, read where printed and computed where it is not. */
  valueCents: number | null;
};

export type OnHandParse = {
  rows: OnHandRow[];
  /** The date the count represents, ISO, from the file. Null where it prints none. */
  countedOn: string | null;
  /** Headers in the file that meant nothing here. Reported, so a useful column is not lost silently. */
  unmappedColumns: string[];
  /** Rows read and rows kept; the difference is accounted for in `skipped`. */
  rowsRead: number;
  skipped: Record<string, number>;
  problems: string[];
};

/** Column meanings, matched against a header cell folded to lower case with punctuation dropped. */
const ALIASES: Record<keyof Pick<OnHandRow, "ndc11" | "description" | "itemNumber" | "quantityThousandths" | "unit" | "unitCostMicros" | "valueCents">, RegExp> = {
  ndc11: /^(ndc|ndc ?11|ndc ?number|ndc ?code|item ?ndc|dispensed ?ndc)$/,
  description: /^(description|item ?description|item ?name|drug ?name|product|product ?name|item)$/,
  itemNumber: /^(item ?number|item ?no|item ?#|supplier ?item ?number|sku)$/,
  quantityThousandths: /^(quantity ?on ?hand|qty ?on ?hand|on ?hand ?quantity|on ?hand ?qty|on ?hand|qoh|quantity|qty|current ?quantity|current ?qty|inventory ?quantity|stock ?on ?hand)$/,
  unit: /^(unit|uom|unit ?of ?measure|dispensing ?unit|pricing ?unit)$/,
  unitCostMicros: /^(unit ?cost|cost ?per ?unit|acquisition ?cost|acq ?cost|average ?cost|avg ?cost|cost ?each|last ?cost)$/,
  valueCents: /^(extended ?cost|extended ?value|total ?cost|inventory ?value|on ?hand ?value|value|extended|ext ?cost)$/,
};

const fold = (s: string) => s.replace(/^﻿/, "").trim().toLowerCase().replace(/[._\-/]+/g, " ").replace(/\s+/g, " ").replace(/[:*]+$/, "");

/** Which of the four separators splits the header into the most fields. Ties go to the earlier one. */
function separatorFor(line: string): string | null {
  let best: string | null = null;
  let width = 1;
  for (const sep of ["\t", ";", "|", ","]) {
    const n = splitRow(line, sep).length;
    if (n > width) {
      width = n;
      best = sep;
    }
  }
  return best;
}

const DATE = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/;
const ISO = /(\d{4})-(\d{2})-(\d{2})/;

/**
 * The date the count represents.
 *
 * A line naming it wins over a bare date anywhere in the page furniture, because a report printed
 * on the seventh may well be the sixth's count and dating it wrong by a day misplaces a day of
 * dispensing.
 */
export function countDate(text: string): string | null {
  const head = text.slice(0, 4000);
  const labelled = head.split(/\r?\n/).find((l) => /(as of|count(ed)? (on|date)|inventory date|report run date|printed on|run date)/i.test(l));
  for (const line of [labelled, head].filter((x): x is string => Boolean(x))) {
    const iso = ISO.exec(line);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const m = DATE.exec(line);
    if (m) {
      const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${yyyy}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
  }
  return null;
}

type Mapping = Partial<Record<keyof typeof ALIASES, number>>;

/** Places each header cell against a meaning. First match wins; a repeated meaning keeps the first. */
export function mapHeader(cells: string[]): { mapping: Mapping; unmapped: string[] } {
  const mapping: Mapping = {};
  const unmapped: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const name = fold(cells[i]);
    if (!name) continue;
    let placed = false;
    for (const [key, re] of Object.entries(ALIASES) as [keyof typeof ALIASES, RegExp][]) {
      if (mapping[key] === undefined && re.test(name)) {
        mapping[key] = i;
        placed = true;
        break;
      }
    }
    if (!placed) unmapped.push(cells[i].trim());
  }
  return { mapping, unmapped };
}

/** A header row is one that places both an NDC column and a quantity column. */
function findHeader(lines: string[]): { index: number; sep: string; mapping: Mapping; unmapped: string[] } | null {
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const sep = separatorFor(lines[i]);
    if (!sep) continue;
    const { mapping, unmapped } = mapHeader(splitRow(lines[i], sep));
    if (mapping.ndc11 !== undefined && mapping.quantityThousandths !== undefined) {
      return { index: i, sep, mapping, unmapped };
    }
  }
  return null;
}

/** True for either shape of count: the four-line PioneerRx report, or a column export. */
export function looksLikeOnHand(text: string): boolean {
  const head = text.slice(0, 20_000);
  if (looksLikePioneerOnHand(head)) return true;
  if (!/on ?hand|qoh|inventory/i.test(head)) return false;
  return findHeader(head.split(/\r?\n/)) !== null;
}

export function parseOnHand(text: string): OnHandParse {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/);
  const skipped: Record<string, number> = {};
  const problems: string[] = [];
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };

  const header = findHeader(lines);
  if (!header) {
    return {
      rows: [], countedOn: countDate(clean), unmappedColumns: [], rowsRead: 0, skipped: {},
      problems: ["No header row carrying both an NDC column and a quantity-on-hand column."],
    };
  }
  const { sep, mapping } = header;
  const at = (cells: string[], key: keyof typeof ALIASES): string | null => {
    const i = mapping[key];
    if (i === undefined) return null;
    const v = cells[i];
    return v === undefined ? null : v.trim();
  };

  const rows: OnHandRow[] = [];
  const seen = new Map<string, number>();
  let rowsRead = 0;

  for (let i = header.index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = splitRow(line, sep);
    // Page furniture: a footer or a repeated header carries no separator count worth reading.
    if (cells.length < 2) continue;
    if (/^(page \d|printed on|total|grand total)/i.test(line.trim())) continue;
    // A repeat of the header, printed at the top of each page.
    if (fold(cells[mapping.ndc11 as number] ?? "") && ALIASES.ndc11.test(fold(cells[mapping.ndc11 as number]))) continue;
    rowsRead++;

    const rawNdc = at(cells, "ndc11");
    if (!rawNdc) {
      skip("no NDC");
      continue;
    }
    const ndc = normalizeNdc(rawNdc);
    if (!ndc.ok) {
      skip("NDC unreadable");
      continue;
    }

    const rawQty = at(cells, "quantityThousandths");
    const qty = parseQuantityThousandths(rawQty);
    if (qty === null) {
      // Refused rather than defaulted: an unreadable quantity is not an empty shelf.
      skip("quantity unreadable");
      continue;
    }

    const unitCostMicros = parseUnitMicros(at(cells, "unitCostMicros"));
    const printedValue = parseCents(at(cells, "valueCents"));
    const valueCents =
      printedValue !== null
        ? printedValue
        : unitCostMicros !== null
          ? extendedCents(unitCostMicros, qty)
          : null;

    const row: OnHandRow = {
      code: ndc.ndc11,
      codeKind: "ndc11",
      ndc11: ndc.ndc11,
      description: at(cells, "description") || null,
      itemNumber: at(cells, "itemNumber") || null,
      quantityThousandths: qty,
      unit: at(cells, "unit") || null,
      unitCostMicros,
      valueCents,
    };

    /*
     * One NDC can appear on several lines — separate lots, or a bottle counted per shelf. They add
     * up; the shelf holds the total. Overwriting would report the last lot as the whole stock.
     */
    const already = seen.get(row.code);
    if (already !== undefined) {
      const prev = rows[already];
      prev.quantityThousandths += row.quantityThousandths;
      if (prev.valueCents !== null && row.valueCents !== null) prev.valueCents += row.valueCents;
      else if (row.valueCents !== null) prev.valueCents = row.valueCents;
      if (!prev.description && row.description) prev.description = row.description;
      continue;
    }
    seen.set(row.code, rows.length);
    rows.push(row);
  }

  if (rows.length === 0 && rowsRead > 0) problems.push("The header was read but no row held a usable NDC and quantity.");

  return { rows, countedOn: countDate(clean), unmappedColumns: header.unmapped, rowsRead, skipped, problems };
}

/** Total units and total value, for the import summary. */
export function onHandTotals(rows: OnHandRow[]): { items: number; unitsThousandths: number; valueCents: number | null } {
  let unitsThousandths = 0;
  let valueCents = 0;
  let anyValue = false;
  for (const r of rows) {
    unitsThousandths += r.quantityThousandths;
    if (r.valueCents !== null) {
      valueCents += r.valueCents;
      anyValue = true;
    }
  }
  return { items: rows.length, unitsThousandths, valueCents: anyValue ? valueCents : null };
}



/**
 * PioneerRx's "Inventory Search Results with Lot Information", which is the file this pharmacy
 * actually sends — and is not a table at all.
 *
 * Each item is four lines: its name, then three lines of "label:,value" pairs, with the report's
 * masthead and a "Printed On" footer every forty-odd lines. The reader above expects a header row
 * and columns and would make nothing of this, so this is a second reader rather than a looser
 * version of the first.
 *
 *     Acamprosate Calc Dr 333 Mg Tab
 *     NDC/UPC:,68462-0435-18,On Hand:,180.00,Inventory Group Status:,Active
 *     Package Info:,180 EA,On Order:,0.00
 *     Item Status:,Active,Cost:,$0.62
 *
 * It carries three things worth more than the count itself. **On Order** is what the order planner
 * needed and had no source for — without it the site cannot tell a shelf that is genuinely short
 * from one whose stock is already on a truck, and would order it twice. **Cost** is per dispensing
 * unit, so a value can be put on the shelf without a catalogue. And **Package Info** gives the pack
 * size, which is what turns "order 140 units" into "order two bottles".
 *
 * ── Two shelves in one file, counted in two different units ──
 *
 * The report is sectioned by inventory group — "Rx" then "Retail" — and the two count differently.
 * The same test strip appears in both:
 *
 *     Rx      65702-0712-10   On Hand 100.00   Package Info: 100 EA            Cost $0.41
 *     Retail  365702712102    On Hand   2.00   Package Info: Package (100 EA)  Cost $0.41
 *
 * The Rx line is a hundred strips. The Retail line is two boxes of a hundred, not two strips: the
 * parenthesised "Package (...)" form is PioneerRx saying the count is in packages. Cost stays per
 * dispensing unit in both, so a retail line is worth quantity × pack × cost — reading it as
 * quantity × cost values two boxes of Abreva at seventeen dollars a tube as thirty-five cents.
 *
 * So a package-counted line is multiplied out to dispensing units here, and everything downstream
 * gets one unit of measure. A package-counted line whose pack size cannot be read is refused
 * rather than guessed: there is no safe reading of "2" without knowing 2 of what.
 *
 * ── Why the front shop is kept ──
 *
 * Retail items are barcodes, not NDCs, and nothing in the claims will ever match them. They are
 * still money on a shelf and belong in the stock figure the accounts close on, so they are stored
 * with their group and their UPC kept out of the NDC field — the shelf tools filter to Rx, and the
 * balance takes the lot.
 */
const FURNITURE =
  /^(inventory search results|west wichita family|printed on:|inventory group:,|"?\d[\w ]* (?:w|e|n|s) [a-z]|"?wichita,)/i;

/** A label:,value pair reader for one of the three keyed lines. */
function pairs(cells: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const k = cells[i].trim().replace(/:$/, "").toLowerCase();
    if (k) out.set(k, cells[i + 1].trim());
  }
  return out;
}

export type PackageInfo = {
  /** Units in one package — 180 of "180 EA" and of "Package (180 EA)". Null where unreadable. */
  packQty: number | null;
  /** The dispensing unit: EA, ML, GM. */
  unit: string | null;
  /** True for the "Package (...)" form, which means the On Hand figure counts packages. */
  countsPackages: boolean;
};

/** Reads "180 EA" and "Package (100 EA)", and says which of the two it was. */
export function packFrom(text: string): PackageInfo {
  const t = text.trim();
  const paren = /^Package\s*\((.*)\)\s*$/i.exec(t);
  const inner = paren ? paren[1] : t;
  const m = /^\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]+)?/.exec(inner);
  const n = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return {
    packQty: Number.isFinite(n) && n > 0 ? n : null,
    unit: m && m[2] ? m[2].toUpperCase() : null,
    countsPackages: Boolean(paren),
  };
}

export function looksLikePioneerOnHand(text: string): boolean {
  const head = text.replace(/^﻿/, "").slice(0, 4000);
  return /Inventory Search Results/i.test(head) && /NDC\/UPC:/.test(head) && /On Hand:/.test(head);
}

/**
 * Eleven digits is an NDC; twelve to fourteen is a retail barcode — UPC-A, EAN-13 or a GTIN-14 —
 * and the front shop carries all three. Anything else this reader will not name.
 */
function codeOf(raw: string): { code: string; codeKind: "ndc11" | "upc"; ndc11: string | null } | null {
  const digits = raw.replace(/[^\d]/g, "");
  const ndc = normalizeNdc(raw);
  if (ndc.ok) return { code: ndc.ndc11, codeKind: "ndc11", ndc11: ndc.ndc11 };
  if (digits.length >= 12 && digits.length <= 14) return { code: digits, codeKind: "upc", ndc11: null };
  return null;
}

export function parsePioneerOnHand(text: string): OnHandParse {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const rows: OnHandRow[] = [];
  const seen = new Map<string, number>();
  const skipped: Record<string, number> = {};
  const problems: string[] = [];
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };

  let rowsRead = 0;
  let name: string | null = null;
  let group: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    const groupLine = /^Inventory Group:,(.*)$/i.exec(raw);
    if (groupLine) {
      group = groupLine[1].trim() || null;
      continue;
    }
    if (FURNITURE.test(raw)) continue;

    if (!/^NDC\/UPC:/i.test(raw)) {
      // Anything that is not one of the three keyed lines is the item's name.
      if (!/^(Package Info:|Item Status:)/i.test(raw)) name = splitRow(raw, ",")[0].trim() || raw;
      continue;
    }

    rowsRead++;
    const cells = splitRow(raw, ",");
    const a = pairs(cells);
    const b = i + 1 < lines.length ? pairs(splitRow(lines[i + 1].trim(), ",")) : new Map<string, string>();
    const c = i + 2 < lines.length ? pairs(splitRow(lines[i + 2].trim(), ",")) : new Map<string, string>();

    const rawCode = (a.get("ndc/upc") ?? "").trim();
    const id = codeOf(rawCode);
    if (!id) {
      // Split, because the two are different jobs: a blank field is an item to fix in PioneerRx,
      // an unrecognised one is a code shape this reader has not been taught.
      skip(rawCode ? "code was neither an NDC nor a barcode" : "no NDC or barcode on the item");
      continue;
    }
    const counted = parseQuantityThousandths(a.get("on hand"));
    if (counted === null) {
      // Refused rather than defaulted: an unreadable quantity is not an empty shelf.
      skip("quantity unreadable");
      continue;
    }

    const pack = packFrom(b.get("package info") ?? "");
    if (pack.countsPackages && pack.packQty === null) {
      // "2" of an unknown package is not a number of anything.
      skip("counted in packages with no readable pack size");
      continue;
    }
    // Package counts become dispensing units, so one unit of measure leaves this reader.
    const factor = pack.countsPackages ? (pack.packQty as number) : 1;
    const qty = counted * factor;
    const onOrder = parseQuantityThousandths(b.get("on order"));

    const unitCostMicros = parseUnitMicros((c.get("cost") ?? "").replace(/\$/g, ""));

    const row: OnHandRow = {
      code: id.code,
      codeKind: id.codeKind,
      ndc11: id.ndc11,
      description: name,
      itemNumber: null,
      inventoryGroup: group,
      quantityThousandths: qty,
      unit: pack.unit,
      unitCostMicros,
      valueCents: unitCostMicros === null ? null : extendedCents(unitCostMicros, qty),
      onOrderThousandths: onOrder === null ? null : onOrder * factor,
      packQty: pack.packQty,
      countedInPackages: pack.countsPackages,
    };

    /*
     * One code listed twice is one shelf. The report groups by item, and the same code can appear
     * under two item names where the pharmacy has renamed something; overwriting would report the
     * second listing as the whole stock.
     */
    const already = seen.get(row.code);
    if (already !== undefined) {
      const prev = rows[already];
      prev.quantityThousandths += row.quantityThousandths;
      if (prev.valueCents !== null && row.valueCents !== null) prev.valueCents += row.valueCents;
      if (prev.onOrderThousandths != null && row.onOrderThousandths != null) {
        prev.onOrderThousandths += row.onOrderThousandths;
      }
      continue;
    }
    seen.set(row.code, rows.length);
    rows.push(row);
  }

  if (rows.length === 0 && rowsRead > 0) problems.push("Items were found but none carried a usable code and quantity.");
  return { rows, countedOn: countDate(text), unmappedColumns: [], rowsRead, skipped, problems };
}

/** Reads whichever shape the file is. */
export function readOnHand(text: string): OnHandParse {
  return looksLikePioneerOnHand(text) ? parsePioneerOnHand(text) : parseOnHand(text);
}
