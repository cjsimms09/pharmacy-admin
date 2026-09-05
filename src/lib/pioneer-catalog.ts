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
  productKey: string | null;
};

export type CatalogSection = { supplier: string; rows: CatalogRow[] };

export type CatalogParse = {
  sections: CatalogSection[];
  /** The "Printed On" date, ISO, which is when these prices were current. */
  printedOn: string | null;
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
const HEADER_FIELDS = ["Supplier Item Number", "Name", "NDC", "Order By Constant"];
const COST_HEADER = "Cost Per Unit";
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
  for (const sep of [";", ","] as const) {
    if (head.includes(HEADER_FIELDS.join(sep))) return sep;
  }
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
  const headerA = sep ? HEADER_FIELDS.join(sep) : null;
  const headerB = sep ? `${sep}${COST_HEADER}` : null;

  const skip = (why: string) => {
    skipped++;
    reasons[why] = (reasons[why] ?? 0) + 1;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === TITLE || line === headerB || line === headerA) continue;
    const printed = PRINTED.exec(line);
    if (printed) {
      if (!printedOn) printedOn = `${printed[3]}-${printed[1].padStart(2, "0")}-${printed[2].padStart(2, "0")}`;
      continue;
    }
    if (!sep) break; // Without a header there is no way to read a row; the problem is reported below.

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

    if (parts.length !== 5) {
      skip(`${parts.length} fields where 5 were expected`);
      continue;
    }
    if (!current) {
      skip("a price row before any supplier was named");
      continue;
    }

    const [itemNumber, name, ndcRaw, orderBy, cost] = parts.map((p) => p.trim());
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
      productKey: description ? productKey(description).key || null : null,
    });
  }

  if (!sep) {
    problems.push(
      `This does not look like a PioneerRx supplier catalogue export — no header row reading ` +
        `"${HEADER_FIELDS.join(", ")}" was found, with either commas or semicolons between the names.`,
    );
  }
  if (sections.length === 0) problems.push("No supplier sections were found.");

  return { sections, printedOn, skipped, reasons, problems };
}

/** Whether a file is this export, from its first few lines, for the mailbox router. */
export function looksLikePioneerCatalog(text: string): boolean {
  const head = text.replace(/^﻿/, "").slice(0, 4000);
  return head.includes(TITLE) || detectSeparator(text) !== null;
}
