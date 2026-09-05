import { productKey } from "./product-key";
import { normalizeNdc } from "./ndc";

/**
 * Reading PioneerRx's "Supplier Catalog Item Search Results" export.
 *
 * This is the file that turns the purchasing comparison from an idea into a number. It is
 * PioneerRx's copy of every supplier price feed it holds — for this pharmacy, twenty-four suppliers
 * and thirty thousand NDCs priced by more than one of them — and it will arrive every Monday, one
 * file per supplier, named MCKCatalog_9_5_2026 and so on.
 *
 * ── Why it needs its own parser ──
 *
 * It is not a spreadsheet. It is a printed report saved as text: rows split on a tab, semicolon or
 * comma (it has been all three), a page header and footer every fifty lines ("Printed On: … Page 12
 * of 5479"), the column header split across two lines because "Rebate Pck Cost" did not fit, most
 * items split across two lines for the same reason, and the supplier's name standing alone on a
 * line above its block rather than in a column. The generic catalogue importer reads a header row
 * and maps columns; pointed at this it would take "API" as the header and give up.
 *
 * ── What it is careful about ──
 *
 * The supplier comes from inside the file, not from the filename. The filename says MCK; the
 * section header says McKesson; when they disagree the file is refused, because a McKesson price
 * list stored under IPD is a purchasing recommendation to buy from the wrong place.
 *
 * Short-dated lots are kept but marked. A price of $0.0040 a tablet next to $0.0180 for the same
 * NDC is not a bargain, it is stock expiring in two months with a three-month return window or
 * none — and a comparison that does not know the difference recommends it every time.
 *
 * And the cost here does not include rebates. McKesson's OneStop generics earn the tier rate on
 * the rebate report — twenty-nine percent at this pharmacy's current tier — so their gross price is
 * not the price. That adjustment is the comparison's job, not this file's; this file records what
 * it was given and says so.
 */

export type CatalogRow = {
  supplier: string;
  itemNumber: string;
  description: string | null;
  ndc11: string;
  /** How many packs a single order line buys — "(10)" in "(10) 100.00 EA". Usually 1. */
  orderMultiple: number | null;
  /** Units in a pack — the 100 in "(1) 100.00 EA". */
  packQty: number | null;
  unit: "EA" | "ML" | "GM" | null;
  /** Cost per unit, as printed, in micro-dollars. Does not include rebates. */
  unitCostMicros: number | null;
  /** "07/26" where the description marks the lot as expiring — a short-dated deal, not a price. */
  shortDated: string | null;
  /**
   * Whether this item earns the supplier's rebate.
   *
   * The export carries a "rebate package cost" column whose *value* means nothing to us — the
   * pharmacy's words — but whose presence does: a figure there marks a rebated (OneStop) product,
   * a blank marks one that is not. This is the flag that decides whether a McKesson generic's
   * gross price gets the tier rate taken off it in a comparison, so it is read from the file and
   * never inferred from the description. Null where the file has no such column at all.
   */
  rebated: boolean | null;
  productKey: string | null;
};

export type CatalogSection = { supplier: string; rows: CatalogRow[] };

export type CatalogParse = {
  sections: CatalogSection[];
  /** The "Printed On" date, ISO, which is when these prices were current. */
  printedOn: string | null;
  /** Whether the file carried a rebate column at all. Without it, rebated is null on every row. */
  hasRebateColumn: boolean;
  skipped: number;
  reasons: Record<string, number>;
  problems: string[];
};

/**
 * How suppliers name themselves in the file, and how the pharmacy abbreviates them in filenames.
 *
 * Both map to one canonical name so that a McKesson price stored last Monday and one stored this
 * Monday are the same supplier. Unknown names pass through unchanged rather than being guessed at.
 */
const SUPPLIER_ALIASES: Record<string, string> = {
  mck: "McKesson",
  mckesson: "McKesson",
  abc: "ABC (Cencora)",
  cencora: "ABC (Cencora)",
  amerisourcebergen: "ABC (Cencora)",
  "smith drug": "Smith Drug",
  smithdrug: "Smith Drug",
  smith: "Smith Drug",
  ipd: "IPD",
  ipc: "IPC",
  parmed: "ParMed",
  anda: "ANDA",
  api: "API",
  toprx: "TopRx",
  healthsource: "HealthSource",
  smartsource: "SmartSource",
  cardinal: "Cardinal Health",
  "cardinal health": "Cardinal Health",
  "morris & dickson": "Morris & Dickson",
};

export function canonicalSupplier(name: string): string {
  const k = name.trim().toLowerCase().replace(/\s+/g, " ");
  return SUPPLIER_ALIASES[k] ?? name.trim();
}

/** The supplier codes the pharmacy uses at the front of a scheduled file's name. */
export const FILE_NAME_CODES = ["Mck", "IPD", "IPC", "Parmed"] as const;

/**
 * The supplier a filename claims to be for, or null where it claims nothing.
 *
 * The scheduled export is named Supplier + run date: Mck9_6_2026, IPD_9_6_2026, ParmedCatalog_9_6_2026
 * — the pharmacy's abbreviation first, then whatever PioneerRx puts after it. The abbreviation has
 * to be one this knows (the alias table above); a name that begins with anything else, including
 * the "Supplier_Catalog_Item_Search_Results" the report is called by default, claims nothing, and
 * the supplier named inside the file stands alone. Claiming on an unknown prefix once refused the
 * hand export for being "named for Supplier".
 */
export function supplierFromFileName(fileName: string): string | null {
  const base = fileName.trim().replace(/^.*[\\/]/, "");
  const m = /^([A-Za-z&. ]+?)(?:[-_ ]?catalog(?![a-z])|[-_ ]?\d|[-_ .]|$)/i.exec(base);
  if (!m) return null;
  const key = m[1].trim().toLowerCase().replace(/\s+/g, " ");
  return key in SUPPLIER_ALIASES ? SUPPLIER_ALIASES[key] : null;
}

/**
 * The run date a filename carries, as ISO, or null.
 *
 * PioneerRx's report-run date has been seen as 9_5_2026; it may equally come as 9-5-2026,
 * 2026-09-05, 20260905 or 09052026, so all of those are read. An eight-digit run of numbers is
 * taken as year-first when it begins with 20, month-first otherwise.
 */
export function dateFromFileName(fileName: string): string | null {
  const base = fileName.replace(/^.*[\\/]/, "");
  let m = /(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})/.exec(base);
  if (m && Number(m[2]) <= 12 && Number(m[3]) <= 31) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /(\d{1,2})[-_.](\d{1,2})[-_.](\d{4})/.exec(base);
  if (m && Number(m[1]) <= 12 && Number(m[2]) <= 31) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /(?<!\d)(\d{8})(?!\d)/.exec(base);
  if (m) {
    const d = m[1];
    const yearFirst = d.startsWith("20");
    const [y, mo, da] = yearFirst ? [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8)] : [d.slice(4, 8), d.slice(0, 2), d.slice(2, 4)];
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(da) >= 1 && Number(da) <= 31) return `${y}-${mo}-${da}`;
  }
  return null;
}

/**
 * What a filename told us, in a sentence, for the inbox line — so that on the first Sunday
 * somebody can see how the file came named and whether that name did its job.
 */
export function describeFileName(fileName: string): string {
  const supplier = supplierFromFileName(fileName);
  const date = dateFromFileName(fileName);
  const codes = FILE_NAME_CODES.join(", ");
  if (supplier) return `Named for ${supplier}${date ? `, run ${date}` : ", with no run date in the name"}.`;
  return `The name does not begin with a supplier code (${codes}), so it was not checked against the supplier named inside${date ? `; run ${date}` : ""}.`;
}

const TITLE = "Supplier Catalog Item Search Results";
/*
 * The header is read, not assumed.
 *
 * The first export had five columns. The scheduled one has six — the pharmacy added a rebate
 * column — and the next change will be something else. A parser that knows column *names* and
 * finds their positions survives that; one that knows "field four is the cost" skips every row of
 * the first Monday file as having the wrong count.
 */
const SIGNATURE = "Supplier Item Number";

type Columns = {
  itemNumber: number;
  name: number;
  ndc: number;
  orderBy: number;
  cost: number;
  rebate: number | null;
  count: number;
};

function findColumns(headerFields: string[]): Columns | null {
  const norm = (h: string) => h.trim().toLowerCase();
  const idx = (pred: (h: string) => boolean) => headerFields.findIndex((h) => pred(norm(h)));
  const itemNumber = idx((h) => h === "supplier item number" || h === "item number");
  const name = idx((h) => h === "name" || h === "description");
  const ndc = idx((h) => h === "ndc");
  const orderBy = idx((h) => h.startsWith("order by") || h === "package size" || h === "pack size");
  const cost = idx((h) => h === "cost per unit" || h === "unit cost");
  const rebate = idx((h) => h.includes("rebate"));
  if ([itemNumber, name, ndc, orderBy, cost].some((i) => i < 0)) return null;
  return { itemNumber, name, ndc, orderBy, cost, rebate: rebate < 0 ? null : rebate, count: headerFields.length };
}

const PRINTED = /^Printed On:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i;
const STATUS_LINE = /^Supplier:\s*.+Status:/i;
const REBATE_HEADER = /^rebate\b/i;
const PACK = /^\s*\((\d+)\)\s*([\d.]+)\s+(EA|ML|GM)\s*$/i;
const SHORT_DATED = /\((\d{2}\/\d{2})\s*EXP\)/i;
const NDC = /^(\d{4,5})-(\d{3,4})-(\d{1,2})$/;
const ITEM_NUMBER = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const BARE_NUMBER = /^\d+(\.\d+)?$/;

/** A hyphenated NDC to the eleven-digit billing form. Unambiguous, because the hyphens are present. */
export function ndc11FromHyphenated(s: string): string | null {
  if (!NDC.test(s.trim())) return null;
  const r = normalizeNdc(s);
  return r.ok ? r.ndc11 : null;
}

/**
 * Which separator the header row uses: whichever character follows "Supplier Item Number".
 *
 * Three separators have now been seen from the same report — semicolons in the hand export, tabs
 * in three of the scheduled files, commas in the fourth — so it is read, never assumed.
 */
export function detectSeparator(text: string): "\t" | ";" | "," | null {
  const head = text.replace(/^﻿/, "").slice(0, 6000);
  const line = head.split(/\r?\n/).find((l) => l.trim().startsWith(SIGNATURE));
  if (!line) return null;
  const after = line.slice(line.indexOf(SIGNATURE) + SIGNATURE.length);
  if (after.startsWith("\t")) return "\t";
  if (after.startsWith(";")) return ";";
  if (after.startsWith(",")) return ",";
  return null;
}

/**
 * Splits one row on the separator, honouring double quotes.
 *
 * A comma-separated export has to quote a description that contains a comma, and a naive split
 * would turn that one row into six fields and skip it. Tab and semicolon files never quote, and
 * this handles them identically because there is nothing to honour.
 */
export function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

type Pending = {
  itemNumber: string;
  description: string | null;
  ndc11: string | null;
  /** The reason to count if ndc11 is null. */
  noNdc: string;
  /** True where the item line carried a rebate figure in the pack column (see the comment in the loop). */
  rebated: boolean | null;
};
type Price = { orderMultiple: number; packQty: number; unit: CatalogRow["unit"]; unitCostMicros: number; rebated: boolean | null };

/** Reads "(1) 100.00 EA" plus a cost and, where the file has the column, a rebate cell. */
function readPrice(packText: string, costText: string, rebateText: string | null, hasRebate: boolean): Price | null {
  const m = PACK.exec(packText);
  const cost = Number(costText.trim());
  if (!m || !Number.isFinite(cost)) return null;
  if (cost <= 0) return null;
  const cell = rebateText?.trim() ?? "";
  // Presence, not value: any figure marks the item rebated; a blank does not; a bare zero is
  // treated as blank so a system that fills empty cells with 0.00 cannot mark everything rebated.
  const rebated = !hasRebate ? null : cell !== "" && !/^0+(\.0+)?$/.test(cell);
  return {
    orderMultiple: Number(m[1]),
    packQty: Number(m[2]),
    unit: m[3].toUpperCase() as CatalogRow["unit"],
    unitCostMicros: Math.round(cost * 1_000_000),
    rebated,
  };
}

/**
 * Reads the export in either shape it has arrived in.
 *
 * The hand export put every item on one line. The scheduled export — a report rendered to text —
 * puts most items across two: the item, name and NDC on one line, and "(1) 100.00 EA  3.7706" on a
 * separate line that may come before or after it, with an arbitrary number of other lines in
 * between; a minority of items (the ones with long names, as it happens) still come on one line.
 *
 * The pairing that makes this readable is ordinal: within one supplier's block, the Nth split item
 * goes with the Nth price line, because both streams are written in the same order. That holds
 * across all four real files — 46,431 of each for McKesson, exactly — and it is also the only thing
 * that could go quietly wrong, since one extra or missing price line would shift every price after
 * it onto the wrong item. So the counts must match to the item, or the whole block is refused with
 * the numbers named. A refused supplier is a message on Monday morning; a shifted one is a
 * purchasing recommendation built on the wrong prices.
 */
export function parsePioneerCatalog(text: string): CatalogParse {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/);
  const reasons: Record<string, number> = {};
  const problems: string[] = [];
  let skipped = 0;
  let printedOn: string | null = null;
  const skip = (why: string) => {
    skipped++;
    reasons[why] = (reasons[why] ?? 0) + 1;
  };

  const sep = detectSeparator(clean);
  let columns: Columns | null = null;
  if (sep) {
    const hi = lines.findIndex((l) => l.trim().startsWith(SIGNATURE));
    if (hi >= 0) {
      const main = splitRow(lines[hi], sep).map((x) => x.trim()).filter(Boolean);
      // The header's continuation is the line immediately before or after it: either
      // separator-led (";Cost Per Unit;Rebate Package Cost") or a bare column name on its own
      // line ("Rebate Pck Cost"). Nothing further away counts — a data row with a blank first
      // field starts with the separator too, and taking those as header once built a
      // 118-column header on the real file.
      const extra: string[] = [];
      for (const n of [lines[hi - 1], lines[hi + 1]]) {
        if (typeof n !== "string" || PRINTED.test(n.trim()) || n.trim() === TITLE) continue;
        if (n.startsWith(sep)) extra.push(...splitRow(n, sep).slice(1).map((x) => x.trim()).filter((x) => /[a-z]/i.test(x)));
        else if (REBATE_HEADER.test(n.trim()) || /^cost per unit$/i.test(n.trim())) extra.push(n.trim());
      }
      const seen = new Set(main.map((x) => x.toLowerCase()));
      const fields = [...main, ...extra.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))];
      columns = findColumns(fields);
    }
  }

  type Block = { supplier: string; complete: CatalogRow[]; pending: Pending[]; prices: (Price | null)[] };
  const blocks: Block[] = [];
  let current: Block | null = null;
  const hasRebate = columns?.rebate !== null && columns?.rebate !== undefined;

  /*
   * Where the rebate figure lands, in the scheduled file.
   *
   * The pharmacy added a "Rebate Pck Cost" column to the report. The report engine had no room for
   * it, so its figure — which is present only on rebated items — is rendered wherever it fits: for
   * an item whose pack and cost sit on the item's own line, on a line of its own immediately before
   * or after that item ("41.9900"); for an item whose pack and cost were pushed to a separate line,
   * in the empty pack column of the item line. Neither is a column in any ordinary sense, and a
   * reader that took the lone figure for a supplier's name produced hundreds of sections called
   * "41.9900" before this was understood.
   *
   * On the real file every lone figure sits next to exactly one single-line item and every
   * single-line item has exactly one, so the pairing is: the item on the line before, unless that
   * item already has its figure, in which case the item on the line after. A figure that finds no
   * item either side is counted and reported rather than guessed at.
   */
  let lastCompleteLine = -1;
  let lastCompleteHasLoneRebate = false;
  let rebateForNextLine = -1;
  let orphanRebates = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    // A rebate figure carried to this line's predecessor that nothing there took is an orphan.
    if (rebateForNextLine >= 0 && i > rebateForNextLine) {
      orphanRebates++;
      rebateForNextLine = -1;
    }
    if (!line) continue;
    if (line === TITLE || line.startsWith(SIGNATURE) || STATUS_LINE.test(line) || REBATE_HEADER.test(line)) continue;
    const printed = PRINTED.exec(line);
    if (printed) {
      if (!printedOn) printedOn = `${printed[3]}-${printed[1].padStart(2, "0")}-${printed[2].padStart(2, "0")}`;
      continue;
    }
    if (!sep || !columns) break;

    const parts = splitRow(raw, sep);
    const first = (parts[0] ?? "").trim();

    // A price on its own line: "(1) 100.00 EA <sep> 3.7706". Pairs with the Nth split item in
    // this block, by order — so an unreadable one still takes its place in the sequence, as a
    // placeholder, or every price after it would land on the wrong item.
    if (PACK.test(first)) {
      if (!current) { skip("a price line before any supplier was named"); continue; }
      const price = readPrice(parts[0], parts[1] ?? "", parts[2] ?? null, hasRebate);
      if (!price) skip("zero or negative cost");
      current.prices.push(price);
      continue;
    }

    // A figure standing alone: the rebate column's value, rendered on its own line.
    if (parts.length === 1 && BARE_NUMBER.test(line)) {
      if (!current || !hasRebate) { skip("a number on its own line that belongs to no column"); continue; }
      const prev = lastCompleteLine === i - 1 && !lastCompleteHasLoneRebate ? current.complete[current.complete.length - 1] : null;
      if (prev) {
        prev.rebated = true;
        lastCompleteHasLoneRebate = true;
      } else {
        if (rebateForNextLine >= 0) orphanRebates++;
        rebateForNextLine = i + 1;
      }
      continue;
    }

    // A line with no separators is a supplier's name standing above its block.
    if (parts.length === 1) {
      const supplier = canonicalSupplier(line);
      current = blocks.find((b) => b.supplier === supplier) ?? null;
      if (!current) {
        current = { supplier, complete: [], pending: [], prices: [] };
        blocks.push(current);
      }
      continue;
    }
    if (!current) { skip("a row before any supplier was named"); continue; }

    const at = (n: number) => (parts[n] ?? "").trim();
    const itemNumber = at(columns.itemNumber);
    const ndcRaw = at(columns.ndc);
    const ndc11 = ndc11FromHyphenated(ndcRaw);
    const noNdc = ndcRaw ? "NDC not in 5-4-2 hyphenated form" : "no NDC (supplies and other non-drug items)";
    // The hand export left the item number blank on some five thousand rows that still carried an
    // NDC and a price; the NDC is what a comparison keys on, so those are kept.
    if (itemNumber && !ITEM_NUMBER.test(itemNumber)) { skip("row does not begin with an item number"); continue; }
    if (!itemNumber && !ndc11) { skip("row has neither an item number nor an NDC"); continue; }
    const name = at(columns.name);
    const description = name && !/^[-`.1]$/.test(name) ? name : null;

    const packCell = at(columns.orderBy);
    const costCell = at(columns.cost);

    // Complete on one line: the pack and cost are present in their columns.
    if (PACK.test(packCell) && costCell) {
      const price = readPrice(packCell, costCell, columns.rebate === null ? null : at(columns.rebate), hasRebate);
      if (!price) { skip("zero or negative cost"); continue; }
      if (!ndc11) { skip(noNdc); continue; }
      const row = toRow(current.supplier, { itemNumber, description, ndc11 }, price);
      if (rebateForNextLine === i) {
        row.rebated = true;
        lastCompleteHasLoneRebate = true;
        rebateForNextLine = -1;
      } else {
        lastCompleteHasLoneRebate = false;
      }
      current.complete.push(row);
      lastCompleteLine = i;
      continue;
    }

    // Split across lines: this is the item half, its pack and cost arriving on their own line, by
    // order. Its pack column is empty — or holds the rebate figure, which is how a rebated split
    // item is recognised. Anything else in those cells is a shape this has not seen, and is skipped
    // rather than paired with a price that may not be its own.
    const rebateInPackColumn = hasRebate && BARE_NUMBER.test(packCell);
    if (!costCell && PACK.test(packCell)) { skip("item listed without a price"); continue; }
    if (costCell || (packCell && !rebateInPackColumn)) { skip("pack or cost cell not in a readable form"); continue; }
    current.pending.push({ itemNumber, description, ndc11, noNdc, rebated: hasRebate ? rebateInPackColumn : null });
  }
  if (rebateForNextLine >= 0) orphanRebates++;

  const sections: CatalogSection[] = [];
  const refused: string[] = [];
  for (const b of blocks) {
    const rows = [...b.complete];
    if (b.prices.length === 0) {
      // No price lines at all — the hand export's shape, where an item with empty pack and cost
      // cells is simply one the supplier lists without a price.
      b.pending.forEach(() => skip("item listed without a price"));
    } else if (b.pending.length !== b.prices.length) {
      refused.push(
        `${b.supplier}: ${b.pending.length.toLocaleString()} items were split across lines but ${b.prices.length.toLocaleString()} ` +
          `price lines were found. The two are paired by order, so a mismatch would put prices on the wrong items; ` +
          `this supplier's split items were not loaded${rows.length ? ` (${rows.length.toLocaleString()} single-line items were)` : ""}.`,
      );
    } else {
      b.pending.forEach((p, i) => {
        const price = b.prices[i];
        if (!price) return; // already counted as a zero or unreadable cost
        if (!p.ndc11) { skip(p.noNdc); return; }
        rows.push(toRow(b.supplier, p as Pending & { ndc11: string }, p.rebated === null ? price : { ...price, rebated: p.rebated }));
      });
    }
    if (!rows.length) problems.push(`${b.supplier}: no priced items with an NDC were found in its block.`);
    if (rows.length) sections.push({ supplier: b.supplier, rows });
  }
  if (orphanRebates > 0) {
    problems.push(
      `${orphanRebates.toLocaleString()} rebate figure${orphanRebates === 1 ? "" : "s"} stood on a line of ${orphanRebates === 1 ? "its" : "their"} own ` +
        "next to no single-line item, so the item each belongs to could not be told and may show as not rebated.",
    );
  }

  if (!sep) {
    problems.push(`This does not look like a PioneerRx supplier catalogue export — no header row beginning "${SIGNATURE}" was found.`);
  } else if (!columns) {
    problems.push(
      "The header row was found but not every column this needs was in it: Supplier Item Number, Name, NDC, " +
        "Package Size (or Order By Constant) and Cost Per Unit.",
    );
  }
  problems.push(...refused);
  if (sections.length === 0 && problems.length === 0) problems.push("No supplier sections were found.");

  return { sections, printedOn, hasRebateColumn: hasRebate, skipped, reasons, problems };
}

function toRow(supplier: string, p: { itemNumber: string; description: string | null; ndc11: string }, price: Price): CatalogRow {
  const sd = p.description ? SHORT_DATED.exec(p.description) : null;
  return {
    supplier,
    itemNumber: p.itemNumber,
    description: p.description,
    ndc11: p.ndc11,
    orderMultiple: price.orderMultiple,
    packQty: price.packQty,
    unit: price.unit,
    unitCostMicros: price.unitCostMicros,
    shortDated: sd ? sd[1] : null,
    rebated: price.rebated,
    productKey: p.description ? productKey(p.description).key || null : null,
  };
}

/** Whether a file is this export, from its first few lines, for the mailbox router. */
export function looksLikePioneerCatalog(text: string): boolean {
  const head = text.replace(/^﻿/, "").slice(0, 4000);
  return head.includes(TITLE) || head.includes(SIGNATURE);
}
