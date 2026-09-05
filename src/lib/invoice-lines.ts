import { normalizeNdc } from "./ndc";
import { parseCents } from "./money";

/**
 * Reading the item lines off a supplier invoice as numbers.
 *
 * The invoice reader (invoices.ts) already finds the item lines to decide the schedule and keeps
 * them as text to be searched. This reads the same lines for what was bought: NDC, quantity, unit
 * price, extended amount, the AWP the wholesaler printed, and its one-letter item class. Every
 * purchasing question — what a rebate tier is measured on, whether the invoice price matched the
 * catalogue, what a return is worth — starts from these numbers keyed on the NDC.
 *
 * ── Two layouts, read two ways ──
 *
 * McKesson prints a full row: NDC, item and delivery numbers run together, quantity, unit,
 * description, AWP, item class, unit price, extended amount. That row is read completely, and a
 * line is only taken as one when every column is where the layout puts it.
 *
 * Other wholesalers print an NDC and a price and little the reader can rely on between them. For
 * those a line is read *partially*: the NDC, the text beside it, and the last amount on the line
 * as the extended amount. A partial line says so, and nothing is invented for the columns it
 * lacks — a quantity of one assumed because none was printed would put a wrong number under every
 * total downstream.
 *
 * Lines the reader cannot place are counted, never dropped silently, so the sum of the lines is
 * never mistaken for the total of the invoice.
 */

export type InvoiceLineRead = {
  lineNumber: number;
  kind: "product" | "credit";
  /** Eleven digits, or null when the printed NDC could not be read exactly. */
  ndc11: string | null;
  rawNdc: string;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPriceCents: number | null;
  extendedCents: number | null;
  awpCents: number | null;
  itemClass: string | null;
  /** "full" when every column was read from a known layout; "partial" when only the NDC and an amount were. */
  confidence: "full" | "partial";
};

export type InvoiceLinesParse = {
  lines: InvoiceLineRead[];
  /** Lines that carried an NDC but could not be read even partially. */
  unread: number;
  layout: "mckesson" | "ndc-and-amount" | "none";
};

const NDC_TOKEN = /(\d{4,5}-\d{3,4}-\d{1,2}|\d{11})/;
const AMOUNT = /-?\(?\$?[\d,]+\.\d{2}\)?-?/;

/*
 * McKesson's row, as it comes out of the PDF text: the NDC, then the item number and delivery
 * document number with no space between them, then quantity and unit, the description, the AWP,
 * the item class, the unit price and the extended amount, then optional flag letters. The
 * description is taken lazily so the AWP is the first amount after it.
 */
const MCKESSON = new RegExp(
  "^(\\d{4,5}-\\d{3,4}-\\d{1,2})\\S*\\s+(-?\\d+)\\s+([A-Z]{2})\\s+(.+?)\\s+(" +
    AMOUNT.source +
    ")\\s+([A-Z])\\s+(" +
    AMOUNT.source +
    ")\\s+(" +
    AMOUNT.source +
    ")(?:\\s+[A-Z]{1,3})?\\s*$",
);

export function parseInvoiceLines(text: string): InvoiceLinesParse {
  const lines: InvoiceLineRead[] = [];
  let unread = 0;
  let mckesson = 0;
  let partial = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!NDC_TOKEN.test(line)) continue;
    if (!AMOUNT.test(line)) continue;

    const m = MCKESSON.exec(line);
    if (m) {
      const [, rawNdc, qty, unit, description, awp, cls, price, extended] = m;
      const quantity = Number(qty);
      const extendedCents = parseCents(extended);
      lines.push({
        lineNumber: lines.length + 1,
        kind: quantity < 0 || (extendedCents !== null && extendedCents < 0) ? "credit" : "product",
        ndc11: ndcOf(rawNdc),
        rawNdc,
        description: description.replace(/\s{2,}/g, " ").trim() || null,
        quantity,
        unit,
        unitPriceCents: parseCents(price),
        extendedCents,
        awpCents: parseCents(awp),
        itemClass: cls,
        confidence: "full",
      });
      mckesson++;
      continue;
    }

    // A line with an NDC and at least one amount, in a layout this does not know column by column.
    const ndcMatch = NDC_TOKEN.exec(line);
    const amounts = line.match(new RegExp(AMOUNT.source, "g")) ?? [];
    if (!ndcMatch || amounts.length === 0) {
      unread++;
      continue;
    }
    const extendedCents = parseCents(amounts[amounts.length - 1]);
    const after = line.slice(ndcMatch.index + ndcMatch[0].length);
    const description = after.slice(0, after.search(new RegExp(AMOUNT.source)) >= 0 ? after.search(new RegExp(AMOUNT.source)) : after.length).replace(/\s{2,}/g, " ").trim();
    lines.push({
      lineNumber: lines.length + 1,
      kind: extendedCents !== null && extendedCents < 0 ? "credit" : "product",
      ndc11: ndcOf(ndcMatch[1]),
      rawNdc: ndcMatch[1],
      description: description || null,
      quantity: null,
      unit: null,
      unitPriceCents: null,
      extendedCents,
      awpCents: null,
      itemClass: null,
      confidence: "partial",
    });
    partial++;
  }

  return { lines, unread, layout: mckesson > 0 ? "mckesson" : partial > 0 ? "ndc-and-amount" : "none" };
}

function ndcOf(raw: string): string | null {
  const r = normalizeNdc(raw);
  return r.ok ? r.ndc11 : null;
}

/** What the lines come to, and how many carried no amount, so a page can show a sum that admits its gaps. */
export function sumLines(lines: { extendedCents: number | null }[]): { totalCents: number; missing: number } {
  return {
    totalCents: lines.reduce((n, l) => n + (l.extendedCents ?? 0), 0),
    missing: lines.filter((l) => l.extendedCents === null).length,
  };
}
