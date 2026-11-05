/**
 * PioneerRx's "Retail Items Gross Profit Report": what the over-the-counter shelf sold and what it cost, item by item.
 *
 * It started arriving every morning on 1 November 2026 and the Inbox called it "not recognised", because no reader existed for it.
 * It is the front of the shop only, no prescription and no patient in it.
 *
 * Read for what it can be proved to say, and nothing is posted from it. The books take their sales from the sales-by-payment report and
 * their cost of goods from the month's purchases; a cost taken from here as well would count the same shelf twice. So it is kept, its
 * totals are shown in the Inbox line, and the line says whether the rows add up to the grand total the page prints.
 *
 * The period is the one printed under the title ("Sale Date Between: 10/1/2026 and 10/31/2026"), because the same report is re-sent each
 * morning for the month so far.
 *
 * Pure.
 */

export type RetailGrossProfit = {
  periodFrom: string | null;
  periodTo: string | null;
  items: number;
  quantity: number;
  paidCents: number;
  costCents: number;
  grossProfitCents: number;
  /** The grand total the page prints, where it printed one. */
  printed: { quantity: number; paidCents: number; costCents: number; grossProfitCents: number | null } | null;
  /** Rows that did not read, kept so a total is never claimed over a gap. */
  unreadable: string[];
  /** True only when every row read, each row's profit is its paid less its cost, and the rows add up to the printed grand total. */
  proved: boolean;
  says: string;
};

const money = (v: number) => `$${(v / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "$1,234.50", "-$3.00" and "($3.00)" to cents; null for anything else. */
function cents(raw: string): number | null {
  const t = raw.trim();
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const m = /^\(?-?\$?\s*(-?[\d,]*\.?\d+)\)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const c = Math.round(Math.abs(n) * 100);
  return neg || n < 0 ? -c : c;
}

/** One CSV line to fields, with quotes honoured. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const iso = (us: string): string | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(us.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

export function looksLikeRetailGrossProfit(text: string): boolean {
  return /^﻿?\s*Retail Items Gross Profit Report/i.test(text.slice(0, 200));
}

export function readRetailGrossProfit(text: string): RetailGrossProfit {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const period = /Sale Date Between:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*and\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text);
  let items = 0;
  let quantity = 0;
  let paidCents = 0;
  let costCents = 0;
  let grossProfitCents = 0;
  let rowsConsistent = true;
  const unreadable: string[] = [];
  let printed: RetailGrossProfit["printed"] = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;

    /* "Grand Total:,389.00,"$6,012.81","$3,821.60",36.44%" with the profit alone on the next line, where the text layer split it. */
    if (/^Grand Total:/i.test(line)) {
      const f = fields(line);
      const q = Number(f[1]);
      const p = cents(f[2] ?? "");
      const c = cents(f[3] ?? "");
      const next = (lines[i + 1] ?? "").trim();
      const gpNext = next ? cents(fields(next)[0] ?? "") : null;
      const gpHere = f.length >= 6 ? cents(f[4] ?? "") : null;
      if (Number.isFinite(q) && p !== null && c !== null) printed = { quantity: q, paidCents: p, costCents: c, grossProfitCents: gpHere ?? gpNext };
      continue;
    }

    const f = fields(line);
    /* An item row: name, quantity, paid, cost, profit, profit per cent. */
    /* A sale below cost prints its profit and its per cent in brackets: "($0.69), (6.63%)". */
    if (f.length === 6 && /^\(?-?[\d.]+%\)?$/.test(f[5].trim())) {
      const q = Number(f[1]);
      const p = cents(f[2]);
      const c = cents(f[3]);
      const g = cents(f[4]);
      if (!f[0].trim() || !Number.isFinite(q) || p === null || c === null || g === null) {
        unreadable.push(line.slice(0, 120));
        continue;
      }
      if (p - c !== g) rowsConsistent = false;
      items++;
      quantity += q;
      paidCents += p;
      costCents += c;
      grossProfitCents += g;
    }
  }

  const sameQty = printed ? Math.abs(printed.quantity - quantity) < 0.005 : false;
  const proved =
    items > 0 &&
    unreadable.length === 0 &&
    rowsConsistent &&
    printed !== null &&
    sameQty &&
    printed.paidCents === paidCents &&
    printed.costCents === costCents &&
    (printed.grossProfitCents === null || printed.grossProfitCents === grossProfitCents);

  const span = period ? `${iso(period[1])} to ${iso(period[2])}` : "an unstated period";
  const base = `Retail items, ${span}: ${items} item${items === 1 ? "" : "s"}, ${money(paidCents)} taken for goods that cost ${money(costCents)}, gross profit ${money(grossProfitCents)}.`;
  const says = proved
    ? `${base} The rows add up to the grand total the page prints. Kept on file; the books take sales from the payment-type report and cost from purchases, so nothing is posted from this.`
    : items === 0
      ? "Retail items gross profit report with no item rows in it."
      : `${base} The rows do not all agree with the page's own total${unreadable.length ? ` (${unreadable.length} row${unreadable.length === 1 ? "" : "s"} could not be read)` : ""}, so the figures are not relied on. Kept on file; nothing is posted from this.`;

  return {
    periodFrom: period ? iso(period[1]) : null,
    periodTo: period ? iso(period[2]) : null,
    items,
    quantity,
    paidCents,
    costCents,
    grossProfitCents,
    printed,
    unreadable,
    proved,
    says,
  };
}
