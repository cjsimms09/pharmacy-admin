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
  /**
   * The level the pharmacy's own system would reorder at, in dispensing units.
   *
   * PioneerRx's answer, not this site's: it is what the pharmacist set, and the shelf screen shows
   * it beside what is actually on hand so the two can disagree in public. Null where none is set —
   * the file writes -1 for that, on 406 of 1,770 rows, and a sentinel is not a quantity.
   */
  orderPointUnits?: number | null;
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

/**
 * The reasons a row is dropped, as the exact strings that go into `skipped` and into the database.
 *
 * Named rather than typed inline because Data health reads them back out of stored JSON to say how
 * much real stock the shelf is missing. Two copies of a string in two files is a coupling nothing
 * enforces: change the wording here and the proof row silently stops recognising the reason, keeps
 * counting, and reports a shelf in better health than it is. Shared constants make that a compile
 * error instead.
 *
 * Changing a value here is a change to data already stored under the old wording. Add a new reason
 * rather than reword an old one, or the counts in every filing before today stop being readable.
 */
export const ON_HAND_SKIP = {
  noNdc: "no NDC",
  badCode: "code is neither an NDC nor a barcode",
  noQuantity: "quantity unreadable",
  noPackSize: "counted in packages with no readable pack size",
} as const;

/** The reasons that mean real stock was dropped: the row had a quantity and no usable code. */
export const ON_HAND_UNCODED_REASONS: readonly string[] = [ON_HAND_SKIP.noNdc, ON_HAND_SKIP.badCode];

export type OnHandParse = {
  rows: OnHandRow[];
  /** The date the count represents, ISO, from the file. Null where it prints none. */
  countedOn: string | null;
  /**
   * Where that date came from, so the import can record which kind of fact it is.
   *
   * A shelf the report dated itself and a shelf somebody typed a date onto are different claims,
   * and the second is only as good as the memory behind it.
   */
  countedOnSource: CountDateSource | null;
  /** Headers in the file that meant nothing here. Reported, so a useful column is not lost silently. */
  unmappedColumns: string[];
  /** Rows read and rows kept; the difference is accounted for in `skipped`. */
  rowsRead: number;
  skipped: Record<string, number>;
  /**
   * Lines that were the tail of the row above rather than a product of their own.
   *
   * Neither kept nor lost, so they belong in neither count — reported separately because a reader
   * that silently discards lines is one nobody can check.
   */
  continuations: number;
  /** The report's own record count, where it prints one. The only figure here we did not produce. */
  reportedCount: number | null;
  problems: string[];
};

/** Column meanings, matched against a header cell folded to lower case with punctuation dropped. */
const ALIASES: Record<
  keyof Pick<
    OnHandRow,
    "ndc11" | "description" | "itemNumber" | "quantityThousandths" | "unit" | "unitCostMicros" | "valueCents" | "inventoryGroup" | "packQty" | "orderPointUnits"
  >,
  RegExp
> = {
  ndc11: /^(ndc|ndc ?11|ndc ?number|ndc ?code|item ?ndc|dispensed ?ndc)$/,
  description: /^(description|item ?description|item ?name|drug|drug ?name|product|product ?name|item)$/,
  itemNumber: /^(item ?number|item ?no|item ?#|supplier ?item ?number|sku)$/,
  quantityThousandths: /^(quantity ?on ?hand|qty ?on ?hand|on ?hand ?quantity|on ?hand ?qty|on ?hand|qoh|quantity|qty|current ?quantity|current ?qty|inventory ?quantity|stock ?on ?hand)$/,
  unit: /^(unit|uom|unit ?of ?measure|dispensing ?unit|pricing ?unit)$/,
  /*
   * A bare "Cost" is a cost per unit here, and the drug file's is the reason.
   *
   * Every row of the owner's first count came back costless — the shelf page said "the file carried
   * no values" for 1,770 products — because PioneerRx heads the column "Cost" and this list wanted
   * "Unit Cost". The figure is per unit: $0.93 against a bottle of 180 acamprosate.
   *
   * The ambiguity is real and is settled by the neighbours rather than by hope: a file meaning the
   * whole line's cost calls it "Extended Cost", "Total Cost" or "Inventory Value", and every one of
   * those is claimed by `valueCents` below. What is left for a bare "Cost" is the per-unit reading.
   */
  unitCostMicros: /^(cost|unit ?cost|cost ?per ?unit|acquisition ?cost|acq ?cost|average ?cost|avg ?cost|cost ?each|last ?cost)$/,
  valueCents: /^(extended ?cost|extended ?value|total ?cost|inventory ?value|on ?hand ?value|value|extended|ext ?cost)$/,
  /*
   * Which shelf the item sits on, which the four-line report reads and the column export dropped.
   *
   * fileOnHand splits the dispensing shelf from the front shop with it, so the accounts can check
   * drug cost against a drug shelf. Without it that split falls back to guessing from the NDC alone
   * and a front-shop line with an eleven-digit code is counted as stock on the pharmacy shelf.
   */
  inventoryGroup: /^(inventory ?group|inv ?group|group|department|dept|category|shelf|location)$/,
  /**
   * How many units the package holds, which the drug file heads "Size".
   *
   * Read but never multiplied by: this path counts units already, and `countedInPackages` stays
   * false, so nothing here turns 180 tablets into 180 bottles. It is carried so the shelf can say
   * "two bottles of 90" instead of "180", which is how a pharmacist thinks about a shelf.
   */
  packQty: /^(size|pack ?size|package ?size|pack ?qty|package ?quantity|units ?per ?pack)$/,
  /**
   * The level PioneerRx would reorder at, which it heads "Order Point".
   *
   * Minus one is the file's own "none set" — on 406 of the 1,770 rows — and it is a sentinel, not a
   * shelf one unit overdrawn. Stored as null so nothing averages it or compares it to a quantity.
   */
  orderPointUnits: /^(order ?point|reorder ?point|min ?stock|minimum ?stock|par|par ?level)$/,
};

/**
 * A whole count of units, or null.
 *
 * `treatMinusOneAsNull` is for a sentinel rather than a quantity: PioneerRx writes -1 for "no order
 * point set". Averaged or compared as a number it would report a shelf one unit overdrawn.
 */
function wholeUnits(raw: string | null | undefined, treatMinusOneAsNull = false): number | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (treatMinusOneAsNull && n === -1) return null;
  return n;
}

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
 * A printed report's page footer, which is where PioneerRx puts the date it was run.
 *
 * The Drug File Print carries no "As of" line at all: it prints "09/08/2026,Page 1 of 34" under
 * every page, and the first of those sits past the first four thousand characters that `countDate`
 * reads. So the file did say when it was counted, and the reader refused it for carrying no date —
 * which is the site ignoring the document rather than reading it.
 *
 * Matched on the whole shape, the date and the page number together, so a date inside a drug name
 * can never be mistaken for the day the shelf was counted.
 */
const PAGE_FOOTER = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*,\s*Page\s+\d+\s+of\s+\d+/i;

/**
 * Where a count date came from, because the three are not the same quality of fact.
 *
 * "Counted on 8 September, dated by the report itself" and "dated by hand" are different claims,
 * and the second is only as good as the memory of whoever typed it. The caller records this against
 * the import so a shelf can say which it was rather than presenting both as equally settled.
 *
 * `typed` is not produced here — it is the caller's own answer overriding the file — but it is named
 * in the union so the caller has one vocabulary rather than two.
 */
export type CountDateSource = "typed" | "labelled" | "head" | "footer";

/**
 * The date the count represents, and where it was read from.
 *
 * A line naming it wins over a bare date anywhere in the page furniture, because a report printed
 * on the seventh may well be the sixth's count and dating it wrong by a day misplaces a day of
 * dispensing.
 */
export function readCountDate(text: string): { date: string | null; source: CountDateSource | null } {
  const head = text.slice(0, 4000);
  const labelled = head.split(/\r?\n/).find((l) => /(as of|count(ed)? (on|date)|inventory date|report run date|printed on|run date)/i.test(l));
  for (const [line, source] of [
    [labelled, "labelled"],
    [head, "head"],
  ] as [string | undefined, CountDateSource][]) {
    if (!line) continue;
    const iso = ISO.exec(line);
    if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, source };
    const m = DATE.exec(line);
    if (m) {
      const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
      return { date: `${yyyy}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`, source };
    }
  }

  /*
   * Last, and only last: the date the report was printed, off a page footer.
   *
   * Deliberately below everything above it, for the reason this function already gives — a report
   * printed on the seventh may well be the sixth's count, so a line that names the count date beats
   * the day the paper came out of the machine. But a print date is still the document speaking, and
   * refusing a file that carries one is the site ignoring what it was told.
   *
   * Searched over the whole text rather than the head, because a footer is the last thing on a page
   * and the first one sits past the four thousand characters read above.
   */
  const footer = PAGE_FOOTER.exec(text);
  if (footer) {
    return { date: `${footer[3]}-${footer[1].padStart(2, "0")}-${footer[2].padStart(2, "0")}`, source: "footer" };
  }

  return { date: null, source: null };
}

/**
 * The date alone, for the callers that only want the date.
 *
 * Kept so `readCountDate` could be added without changing every caller — the date is what most of
 * them need, and the source matters only where it is being recorded against an import.
 */
export function countDate(text: string): string | null {
  return readCountDate(text).date;
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

/**
 * The line that came closest to being a header, and what it was missing.
 *
 * Only used to explain a refusal, and the explanation is the point. "No header row carrying both an
 * NDC column and a quantity-on-hand column" is true and useless: it does not say whether the file
 * was unreadable or one heading away from working, and the pharmacist cannot tell which column to
 * rename. A PioneerRx export configured with "Qty On Hand (Units)" instead of "Qty On Hand" fails
 * exactly the same way as a photograph of a shelf.
 *
 * So this finds the row that mapped the most columns, names the one it could not find, and prints
 * the headings it actually read — which turns "it did not work" into a thing somebody can fix in
 * the report designer in a minute.
 */
function nearestHeader(lines: string[]): { headings: string[]; hasNdc: boolean; hasQuantity: boolean } | null {
  let best: { headings: string[]; hasNdc: boolean; hasQuantity: boolean; score: number } | null = null;
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const sep = separatorFor(lines[i]);
    if (!sep) continue;
    const cells = splitRow(lines[i], sep);
    const { mapping } = mapHeader(cells);
    const score = Object.keys(mapping).length;
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = {
        headings: cells.map((c) => c.trim()).filter(Boolean),
        hasNdc: mapping.ndc11 !== undefined,
        hasQuantity: mapping.quantityThousandths !== undefined,
        score,
      };
    }
  }
  return best ? { headings: best.headings, hasNdc: best.hasNdc, hasQuantity: best.hasQuantity } : null;
}

/** What the reader needs, in the words a PioneerRx report designer would show. */
const WANTED = {
  ndc11: 'a column named "NDC" (or NDC Number, NDC Code, Item NDC)',
  quantity: 'a column named "Quantity On Hand" (or Qty On Hand, On Hand, QOH, Quantity)',
};

/** Why this file could not be read as a count, in a sentence naming the column that is missing. */
export function whyNotAnOnHandFile(lines: string[]): string {
  const near = nearestHeader(lines);
  if (!near) {
    return (
      "Nothing in this file reads as a table of columns. An on-hand count has to be the report exported as " +
      "text or CSV rather than a PDF or a picture, with one row per item."
    );
  }
  const missing: string[] = [];
  if (!near.hasNdc) missing.push(WANTED.ndc11);
  if (!near.hasQuantity) missing.push(WANTED.quantity);
  const seen = near.headings.slice(0, 12).join(", ") + (near.headings.length > 12 ? ", …" : "");
  return `This file has columns but not the ones a count needs: it is missing ${missing.join(" and ")}. The headings it does carry are: ${seen}. Add the missing column to the report and export it again.`;
}

/** True for either shape of count: the four-line PioneerRx report, or a column export. */
export function looksLikeOnHand(text: string): boolean {
  const head = text.slice(0, 20_000);
  if (looksLikePioneerOnHand(head)) return true;
  if (!/on ?hand|qoh|inventory/i.test(head)) return false;
  return findHeader(head.split(/\r?\n/)) !== null;
}

/**
 * An inch mark inside a quoted field, written the way PioneerRx writes it rather than the way CSV
 * expects.
 *
 * Two rows of the pharmacy's own drug file carry a backslash-escaped quote — "ULTICARE TB SAFETY 1
 * ML 25GX1\"" and "Walker Adult Folding W/5\" Wheels". CSV escapes a quote by doubling it, so
 * `splitRow` reads the first as an escaped quote and never closes the field, and closes the second
 * early and reopens it. Either way the rest of the line is swallowed, the NDC column with it, and
 * the row is skipped for having no NDC — two products silently off the shelf, and nothing about the
 * result looking wrong.
 *
 * Repaired rather than refused, because the intent is unambiguous: a backslash before a quote here
 * is an inch mark, and doubling it is exactly what CSV wanted.
 */
function repairEscapedQuotes(text: string): string {
  return text.replace(/\\"/g, '""');
}

/**
 * The report's own record count, where it prints one.
 *
 * "Total Record Count:,1772" on the last line of the Drug File Print. It is the only figure in the
 * file that did not come from us, and it is the arithmetic check every reader here is meant to have:
 * rows kept plus rows skipped must equal it. It has already earned its place — it is what caught
 * the two backslash rows, which between them had swallowed sixty-eight records while the load
 * reported no errors at all.
 */
function reportedRecordCount(lines: string[]): number | null {
  for (const line of lines) {
    const m = /total\s+record\s+count\s*:?\s*,?\s*"?([\d,]+)"?/i.exec(line);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function parseOnHand(text: string): OnHandParse {
  const clean = repairEscapedQuotes(text.replace(/^﻿/, ""));
  const lines = clean.split(/\r?\n/);
  const skipped: Record<string, number> = {};
  const problems: string[] = [];
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };

  const dated = readCountDate(clean);
  const header = findHeader(lines);
  if (!header) {
    return {
      rows: [], countedOn: dated.date, countedOnSource: dated.source, unmappedColumns: [], rowsRead: 0, skipped: {},
      continuations: 0, reportedCount: reportedRecordCount(lines),
      problems: [whyNotAnOnHandFile(lines)],
    };
  }
  const { sep, mapping } = header;
  const at = (cells: string[], key: keyof typeof ALIASES): string | null => {
    const i = mapping[key];
    if (i === undefined) return null;
    const v = cells[i];
    return v === undefined ? null : v.trim();
  };

  /*
   * How wide a real row is here, so a wrapped tail is judged against this file rather than against
   * a number I picked.
   *
   * The first attempt called any line under four fields a tail, which is true of the drug file's
   * eleven columns and catastrophic for an export of two: "NDC, Quantity On Hand" is a perfectly
   * good count and every row of it was thrown away as a continuation. The tests caught it, which is
   * the entire reason they exist.
   */
  const headerWidth = splitRow(lines[header.index], sep).length;

  const rows: OnHandRow[] = [];
  const seen = new Map<string, number>();
  let rowsRead = 0;
  /** Lines that are the tail of the row above rather than a product of their own. */
  let continuations = 0;

  for (let i = header.index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = splitRow(line, sep);
    /*
     * A row that wrapped, recognised so it is neither counted as a product nor mourned as one.
     *
     * A long manufacturer spills onto a line of its own — "AMNEAL PHARMACEUTICALS, LLC", "INC/GNP",
     * "PHARMA, LTD U.S". Every real row carries the full set of columns, so a line carrying less
     * than half the header's width is the tail of the one above it — measured against this file,
     * because "NDC, Quantity On Hand" is a two-column count and every row of it is two fields wide.
     *
     * Not appended to the row above, deliberately. The tail is a manufacturer and this reader has
     * no manufacturer field, so the only place to put it would be the drug's name — which would
     * turn "Desvenlafaxine Succinate ER 100mg" into a name with a company stuck on the end, and a
     * wrong name is worse than an absent one. It is dropped as what it is.
     *
     * What matters is that it is not counted either way: counted as a record it makes the file
     * longer than the report says it is, and skipped as unreadable it reports products lost that
     * were never lost. On the pharmacy's own drug file that was seven rows of each.
     */
    /*
     * Page furniture first, so the count of wrapped tails means what it says.
     *
     * A printed report puts its title on every page and "09/08/2026,Page 1 of 34" under it, and
     * both are narrow enough to look like a tail. Judged the other way round the drug file reported
     * 73 continuations where five were real — sixty-eight of them page footers — and a number that
     * overstates itself by fourteen times is not worth printing.
     */
    if (/^(page \d|printed on|total|grand total|drug file print|\d{1,2}\/\d{1,2}\/\d{4}\s*,\s*page )/i.test(line.trim())) continue;
    if (cells.length * 2 < headerWidth) {
      continuations++;
      continue;
    }
    // A repeat of the header, printed at the top of each page.
    if (fold(cells[mapping.ndc11 as number] ?? "") && ALIASES.ndc11.test(fold(cells[mapping.ndc11 as number]))) continue;

    /*
     * A wide line that is still not a record.
     *
     * The width test above catches a tail that wrapped onto a short line. It cannot catch one that
     * wrapped wide — a manufacturer carrying enough separators to split into half the header's
     * columns — and such a line reaches here, is counted as a record, and is then dropped as a
     * product whose NDC is missing. Two of them are why the 8 September count read 1,774 lines
     * against the 1,772 records the report claims, with exactly two rows skipped for "no NDC".
     *
     * That is the false alarm this reader's own comment warns about, in the direction nobody looked
     * for: not products lost, but products invented and then mourned. The shelf was never short —
     * the count of what was read was long, and the skip list named two losses that never happened,
     * which is the worse half, because somebody would go looking for them.
     *
     * A record has a code or a quantity. Neither means it is not one, whatever its width, so it is
     * a tail like the others rather than a record with a hole in it. Both must be absent: a genuine
     * product line whose NDC cell is empty still carries a quantity, and that is a real loss and is
     * still counted and reported as one.
     */
    const rawNdc = at(cells, "ndc11");
    const identified = rawNdc ? codeOf(rawNdc) : null;
    const qty = parseQuantityThousandths(at(cells, "quantityThousandths"));
    if (!identified && qty === null) {
      /*
       * Which column the wrapped text lands in is not knowable in advance, so it is not asked.
       *
       * The first version of this guard tested for an empty NDC cell, and the manufacturer landed
       * in the NDC cell instead — the line was counted, then dropped as a code that is neither an
       * NDC nor a barcode. Same false alarm, different sentence. Asking whether the line carries a
       * usable code or a quantity settles it wherever the text fell: a record has one or the other,
       * and a line with neither is a tail however wide it is and whatever column it filled.
       */
      continuations++;
      continue;
    }
    rowsRead++;

    if (!rawNdc) {
      skip(ON_HAND_SKIP.noNdc);
      continue;
    }
    /*
     * The same test the four-line report uses, so one shelf does not value differently by export.
     *
     * This asked for an NDC and nothing else, so a front-shop line with a twelve-digit barcode was
     * dropped as unreadable — while parsePioneerOnHand, reading the very same stock out of the
     * other report shape, keeps it as a UPC. Two readers of one thing disagreeing is the fault this
     * project keeps finding, and here it decides whether the inventory is worth what the shelf says.
     *
     * A UPC still carries no NDC, so nothing prices it against NADAC; it is counted and valued at
     * what the report says it cost, which is what a front-shop item can honestly be.
     */
    if (!identified) {
      skip(ON_HAND_SKIP.badCode);
      continue;
    }

    if (qty === null) {
      // Refused rather than defaulted: an unreadable quantity is not an empty shelf.
      skip(ON_HAND_SKIP.noQuantity);
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
      code: identified.code,
      codeKind: identified.codeKind,
      ndc11: identified.ndc11,
      description: at(cells, "description") || null,
      itemNumber: at(cells, "itemNumber") || null,
      quantityThousandths: qty,
      unit: at(cells, "unit") || null,
      inventoryGroup: at(cells, "inventoryGroup") || null,
      packQty: wholeUnits(at(cells, "packQty")),
      // -1 is the file's "no order point set", and it must never read as a shelf one unit short.
      orderPointUnits: wholeUnits(at(cells, "orderPointUnits"), true),
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
      if (!prev.inventoryGroup && row.inventoryGroup) prev.inventoryGroup = row.inventoryGroup;
      continue;
    }
    seen.set(row.code, rows.length);
    rows.push(row);
  }

  if (rows.length === 0 && rowsRead > 0) problems.push("The header was read but no row held a usable NDC and quantity.");

  /*
   * Our count against the report's own, where it prints one.
   *
   * Nothing inside our own arithmetic can answer "did we read all of it"; the report's last line
   * can. Where they disagree the difference is named rather than smoothed over — a load that is
   * quietly short looks exactly like a load that is complete, and on this file it was sixty-eight
   * products.
   */
  const reported = reportedRecordCount(lines);
  if (reported !== null) {
    const skippedTotal = Object.values(skipped).reduce((n, x) => n + x, 0);
    const accounted = rows.length + skippedTotal;
    if (accounted !== reported) {
      problems.push(
        `The report says it holds ${reported.toLocaleString("en-US")} records; ${rows.length.toLocaleString("en-US")} were read and ` +
          `${skippedTotal.toLocaleString("en-US")} skipped, which is ${accounted.toLocaleString("en-US")}. ` +
          `${Math.abs(reported - accounted).toLocaleString("en-US")} row${Math.abs(reported - accounted) === 1 ? " is" : "s are"} unaccounted for.`,
      );
    }
  }


  return { rows, countedOn: dated.date, countedOnSource: dated.source, unmappedColumns: header.unmapped, rowsRead, skipped, continuations, reportedCount: reported, problems };
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
      skip(ON_HAND_SKIP.noQuantity);
      continue;
    }

    const pack = packFrom(b.get("package info") ?? "");
    if (pack.countsPackages && pack.packQty === null) {
      // "2" of an unknown package is not a number of anything.
      skip(ON_HAND_SKIP.noPackSize);
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
  /*
   * The four-line report has no wrapped tails and prints no record count of its own: it is a
   * screen scrape rather than a paged report. Both are stated rather than left off, so the two
   * paths return the same shape and a caller never has to know which one read the file.
   */
  const dated = readCountDate(text);
  return { rows, countedOn: dated.date, countedOnSource: dated.source, unmappedColumns: [], rowsRead, skipped, continuations: 0, reportedCount: null, problems };
}

/** Reads whichever shape the file is. */
export function readOnHand(text: string): OnHandParse {
  return looksLikePioneerOnHand(text) ? parsePioneerOnHand(text) : parseOnHand(text);
}
