import { parseCsvRows } from "./reference";
import { moneyCents } from "./payer-payments";

/**
 * Reading PioneerRx's "Invoice Summary by Supplier": what was spent, before the invoices arrive.
 *
 * The pharmacy's invoices file themselves as they come in by email, and from now on they will. But
 * a month already half over has invoices that were never emailed anywhere, and until they are the
 * cash account shows nothing bought at the pharmacy's largest supplier — which reads as a very
 * profitable month rather than as a missing feed. This report is the one place that figure exists:
 * every invoice number, its date and its total, for a date range, printed from PioneerRx.
 *
 * What it is not is the invoices. There are no line items in it, so nothing here can say what was
 * bought, what it cost per bottle, or which lines were controlled. It carries the money and says
 * so, and the day the real invoice arrives it takes the placeholder's place.
 *
 * ── The shape ──
 *
 *   Invoice Summary by Supplier          ← title
 *   West Wichita Family Pharmacy         ← the pharmacy, then its address over two lines
 *   Supplier: Invoice Date Between 9/1/2026 and 9/7/2026
 *   McKesson                             ← the supplier, alone on a line
 *   Invoice Date,Invoice Number,Reference Number,Invoice Total,Preferred Cost for Profit,Status
 *   9/1/2026,7655391467,,$6.99,$6.99,Closed Aug 31 2026 11:05PM
 *   …
 *   Printed On: 9/7/2026,Page 1 of 2    ← page furniture, and then the whole header again
 *   …
 *   Total:,"$106,322.62","$105,365.42"  ← the report's own bottom line
 *
 * That last line is why this can be trusted. The reader adds the invoices up itself and refuses
 * the file where its sum and the report's own total disagree: a report split across pages whose
 * second page failed to parse would otherwise file a plausible, wrong, smaller number.
 */

export type SummaryInvoice = {
  supplier: string;
  invoiceDate: string;
  invoiceNumber: string;
  totalCents: number;
  /** The report's "Preferred Cost for Profit" — what the items would have cost on contract. */
  preferredCostCents: number | null;
  status: string | null;
};

export type InvoiceSummaryRead = {
  invoices: SummaryInvoice[];
  /** The range the report says it covers, from its own header. */
  from: string | null;
  to: string | null;
  /** What the invoices add up to here. */
  totalCents: number;
  /** What the report says they add up to. Null where it printed no total. */
  statedTotalCents: number | null;
  suppliers: string[];
  skipped: { line: number; why: string }[];
  /** Set where the two totals disagree: the file is not to be filed on. */
  disagreement: string | null;
};

const TITLE = "Invoice Summary by Supplier";
const HEADER = /^invoice date,invoice number/i;

export function looksLikeInvoiceSummary(text: string, fileName = ""): boolean {
  const head = text.replace(/^﻿/, "").slice(0, 2000);
  return head.includes(TITLE) || /invoice[_ -]*summary[_ -]*by[_ -]*supplier/i.test(fileName);
}

/** "9/1/2026" → "2026-09-01". Null for anything else, never a guess. */
function iso(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

/**
 * Reads the report. Pure: text in, invoices out, and the two totals compared.
 *
 * The supplier is whichever name was last printed alone above a header row — the report groups by
 * supplier and repeats that block on every page, so an invoice belongs to the name above it rather
 * than to the file.
 */
export function parseInvoiceSummary(text: string): InvoiceSummaryRead {
  const rows = parseCsvRows(text.replace(/^﻿/, ""));
  const invoices: SummaryInvoice[] = [];
  const skipped: { line: number; why: string }[] = [];
  const suppliers: string[] = [];
  let supplier: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  let statedTotalCents: number | null = null;
  /* One invoice number can only be filed once however many pages repeat it. */
  const seen = new Set<string>();

  rows.forEach((cells, i) => {
    const line = i + 1;
    const first = (cells[0] ?? "").trim();
    if (!first && cells.every((c) => !c.trim())) return;

    if (/^supplier:/i.test(first)) {
      const m = /between\s+(\S+)\s+and\s+(\S+)/i.exec(first);
      if (m) {
        from = iso(m[1]) ?? from;
        to = iso(m[2]) ?? to;
      }
      return;
    }
    if (HEADER.test(first + "," + (cells[1] ?? ""))) return;
    if (/^printed on:/i.test(first)) return;
    if (/^total:?$/i.test(first)) {
      // "Total:","$106,322.62","$105,365.42" — the report's own bottom line.
      statedTotalCents = moneyCents(cells[1]) ?? statedTotalCents;
      return;
    }

    const date = iso(first);
    if (!date) {
      /*
       * A line that is not a date and not furniture is the supplier's own name, which the report
       * prints alone above its block. Anything longer than a name is the pharmacy's address or the
       * title and is not taken as one.
       */
      const rest = cells.slice(1).filter((c) => c.trim()).length;
      if (rest === 0 && first && first !== TITLE && first.length <= 60 && !/^\d/.test(first)) {
        // The pharmacy's own name and address also sit alone; the supplier is the one directly
        // above a header row, so a candidate is only accepted when a header follows it.
        const next = rows[i + 1] ?? [];
        if (HEADER.test((next[0] ?? "") + "," + (next[1] ?? ""))) {
          supplier = first;
          if (!suppliers.includes(first)) suppliers.push(first);
        }
      }
      return;
    }

    const invoiceNumber = (cells[1] ?? "").trim();
    const totalCents = moneyCents(cells[3]);
    if (!supplier) return void skipped.push({ line, why: "no supplier had been named above this row" });
    if (!invoiceNumber) return void skipped.push({ line, why: "no invoice number" });
    if (totalCents === null) return void skipped.push({ line, why: `no readable invoice total (“${cells[3] ?? ""}”)` });

    const key = `${supplier.toLowerCase()}|${invoiceNumber}`;
    if (seen.has(key)) return;
    seen.add(key);

    invoices.push({
      supplier,
      invoiceDate: date,
      invoiceNumber,
      totalCents,
      preferredCostCents: moneyCents(cells[4]),
      status: (cells[5] ?? "").trim() || null,
    });
  });

  const totalCents = invoices.reduce((n, v) => n + v.totalCents, 0);
  /*
   * The report's own total is the check, and a difference is refused rather than filed.
   *
   * This report pages, and a page that failed to read would produce a smaller total that looks
   * entirely reasonable — which is the worst kind of wrong, because nothing about it invites a
   * second look. A cent of rounding is not a difference; anything more is.
   */
  const disagreement =
    statedTotalCents !== null && Math.abs(statedTotalCents - totalCents) > 1
      ? `The invoices read add up to $${(totalCents / 100).toFixed(2)} but the report's own total says $${(statedTotalCents / 100).toFixed(2)}. ` +
        `That is a difference of $${(Math.abs(statedTotalCents - totalCents) / 100).toFixed(2)}, so part of the report was not read and nothing was filed.`
      : null;

  return { invoices, from, to, totalCents, statedTotalCents, suppliers, skipped, disagreement };
}
