import { productKey } from "./product-key";

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
 * It is not a spreadsheet. It is a printed report saved as text: semicolon-separated rows, a page
 * header and footer every fifty lines ("Printed On: … Page 12 of 5479"), the column header split
 * across two lines because "Cost Per Unit" did not fit, and the supplier's name standing alone on a
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

/** The supplier a filename like MCKCatalog_9_5_2026.txt claims to be for, or null. */
export function supplierFromFileName(fileName: string): string | null {
  const m = /^([A-Za-z&. ]+?)[-_ ]?catalog/i.exec(fileName.trim());
  return m ? canonicalSupplier(m[1]) : null;
}

/** The date a filename like MCKCatalog_9_5_2026 carries, as ISO, or null. */
export function dateFromFileName(fileName: string): string | null {
  const m = /(\d{1,2})[_-](\d{1,2})[_-](\d{4})/.exec(fileName);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const TITLE = "Supplier Catalog Item Search Results";
/*
 * The header row, with either separator.
 *
 * The first file exported by hand used semicolons; the scheduled weekly one uses commas. Nothing
 * else about the layout differs, so the separator is read off the header row rather than assumed
 * — a parser that hard-codes one of them works on the sample and fails on the first Monday.
 */
/*
 * The header is read, not assumed.
 *
 * The first export had five columns. The scheduled one has six — the pharmacy added a rebate
 * column — and the next change will be something else. A parser that knows column *names* and
 * finds their positions survives that; one that knows "field four is the cost" skips every row of
 * the first Monday file as having the wrong count, which is precisely what the five-column version
 * would have done.
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
  const orderBy = idx((h) => h.startsWith("order by"));
  const cost = idx((h) => h === "cost per unit" || h === "unit cost");
  const rebate = idx((h) => h.includes("rebate"));
  if ([itemNumber, name, ndc, orderBy, cost].some((i) => i < 0)) return null;
  return { itemNumber, name, ndc, orderBy, cost, rebate: rebate < 0 ? null : rebate, count: headerFields.length };
}
const PRINTED = /^Printed On:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i;
const ORDER_BY = /^\s*\((\d+)\)\s*([\d.]+)\s+(EA|ML|GM)\s*$/i;
const SHORT_DATED = /\((\d{2}\/\d{2})\s*EXP\)/i;
const NDC = /^(\d{4,5})-(\d{3,4})-(\d{1,2})$/;

/** A hyphenated NDC to the eleven-digit billing form. Unambiguous, because the hyphens are present. */
export function ndc11FromHyphenated(s: string): string | null {
  const m = NDC.exec(s.trim());
  if (!m) return null;
  return m[1].padStart(5, "0") + m[2].padStart(4, "0") + m[3].padStart(2, "0");
}

/** Which separator the header row uses, or null where no header row is present. */
export function detectSeparator(text: string): ";" | "," | null {
  const head = text.replace(/^﻿/, "").slice(0, 4000);
  const line = head.split(/\r?\n/).find((l) => l.trim().startsWith(SIGNATURE));
  if (!line) return null;
  // Whichever separator follows the signature is the one the file uses.
  const after = line.slice(line.indexOf(SIGNATURE) + SIGNATURE.length).trimStart();
  if (after.startsWith(";")) return ";";
  if (after.startsWith(",")) return ",";
  return null;
}

/**
 * Splits one row on the separator, honouring double quotes.
 *
 * A comma-separated export has to quote a description that contains a comma, and a naive split
 * would turn that one row into six fields and skip it. Semicolon files never quote, and this
 * handles them identically because there is nothing to honour.
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

export function parsePioneerCatalog(text: string): CatalogParse {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/);
  const sections: CatalogSection[] = [];
  const reasons: Record<string, number> = {};
  const problems: string[] = [];
  let skipped = 0;
  let printedOn: string | null = null;
  let current: CatalogSection | null = null;

  const sep = detectSeparator(clean);

  /*
   * The header, reassembled.
   *
   * PioneerRx prints it across two lines when it does not fit: the first four names on one, then a
   * line beginning with the separator carrying the rest (";Cost Per Unit", or with the new column
   * ";Cost Per Unit;Rebate Package Cost"). In the hand export the continuation line came *before*
   * the main one. So every header-looking line and every separator-led fragment near it is
   * collected, and the column map is built from the union, in the order the fields will appear.
   */
  let columns: Columns | null = null;
  if (sep) {
    const headerLine = lines.find((l) => l.trim().startsWith(SIGNATURE));
    const fragments = lines
      .filter((l) => l.startsWith(sep) && !PRINTED.test(l.trim()) && l.trim() !== `${sep}Page`)
      .map((l) => splitRow(l, sep).slice(1))
      .filter((f) => f.some((x) => /[a-z]/i.test(x)));
    if (headerLine) {
      const main = splitRow(headerLine, sep).map((x) => x.trim());
      const extra = fragments.flat().map((x) => x.trim()).filter(Boolean);
      // Fragments that repeat a name already in the main line are page-header echoes, not columns.
      const seen = new Set(main.map((x) => x.toLowerCase()));
      const fields = [...main, ...extra.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))];
      columns = findColumns(fields);
    }
  }

  const skip = (why: string) => {
    skipped++;
    reasons[why] = (reasons[why] ?? 0) + 1;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === TITLE || line.startsWith(SIGNATURE)) continue;
    if (sep && raw.startsWith(sep)) continue; // A header continuation line, already consumed above.
    const printed = PRINTED.exec(line);
    if (printed) {
      if (!printedOn) printedOn = `${printed[3]}-${printed[1].padStart(2, "0")}-${printed[2].padStart(2, "0")}`;
      continue;
    }
    if (!sep || !columns) break; // Without a header there is no way to read a row; reported below.

    const parts = splitRow(raw, sep);

    // A line with no separators is a supplier's name standing above its block.
    if (parts.length === 1) {
      const supplier = canonicalSupplier(line);
      current = sections.find((s) => s.supplier === supplier) ?? null;
      if (!current) {
        current = { supplier, rows: [] };
        sections.push(current);
      }
      continue;
    }

    if (parts.length !== columns.count) {
      skip(`${parts.length} fields where ${columns.count} were expected`);
      continue;
    }
    if (!current) {
      skip("a price row before any supplier was named");
      continue;
    }

    const at = (i: number) => (parts[i] ?? "").trim();
    const itemNumber = at(columns.itemNumber);
    const name = at(columns.name);
    const ndcRaw = at(columns.ndc);
    const orderBy = at(columns.orderBy);
    const cost = at(columns.cost);
    // Presence, not value: any figure marks a rebated product, a blank does not. A bare zero is
    // treated as blank, because a system that fills empty cells with 0.00 would otherwise mark
    // every item rebated — and the import report shows the count so that would be noticed.
    const rebateCell = columns.rebate === null ? null : at(columns.rebate);
    const rebated = rebateCell === null ? null : rebateCell !== "" && !/^0+(\.0+)?$/.test(rebateCell);
    const ndc11 = ndc11FromHyphenated(ndcRaw);
    if (!ndc11) {
      skip("NDC not in 5-4-2 hyphenated form");
      continue;
    }

    const ob = ORDER_BY.exec(orderBy);
    const unitCost = Number(cost);
    if (!Number.isFinite(unitCost)) {
      skip("cost per unit not a number");
      continue;
    }
    // A zero price is a placeholder, not a bargain. Kept out rather than let it win a comparison.
    if (unitCost <= 0) {
      skip("zero or negative cost");
      continue;
    }

    const description = name && !/^[-`.1]$/.test(name) ? name : null;
    const sd = description ? SHORT_DATED.exec(description) : null;

    current.rows.push({
      supplier: current.supplier,
      itemNumber,
      description,
      ndc11,
      orderMultiple: ob ? Number(ob[1]) : null,
      packQty: ob ? Number(ob[2]) : null,
      unit: ob ? (ob[3].toUpperCase() as CatalogRow["unit"]) : null,
      unitCostMicros: Math.round(unitCost * 1_000_000),
      shortDated: sd ? sd[1] : null,
      rebated,
      productKey: description ? productKey(description).key || null : null,
    });
  }

  if (!sep) {
    problems.push(
      `This does not look like a PioneerRx supplier catalogue export — no header row beginning "${SIGNATURE}" was found.`,
    );
  } else if (!columns) {
    problems.push(
      "The header row was found but not every column this needs was in it: Supplier Item Number, Name, NDC, " +
        "Order By Constant and Cost Per Unit.",
    );
  }
  if (sections.length === 0) problems.push("No supplier sections were found.");

  return { sections, printedOn, hasRebateColumn: columns?.rebate !== null && columns?.rebate !== undefined, skipped, reasons, problems };
}

/** Whether a file is this export, from its first few lines, for the mailbox router. */
export function looksLikePioneerCatalog(text: string): boolean {
  const head = text.replace(/^﻿/, "").slice(0, 4000);
  return head.includes(TITLE) || head.includes(SIGNATURE);
}
