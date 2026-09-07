/**
 * The bank's statement, read in: deposits become receipts, payments mark bills and invoices paid.
 *
 * The cash account is only ever as right as what the bank says, and typing deposits off a
 * statement is the job this replaces. A statement export (CSV from the bank's site) has a date,
 * a description and an amount on every line; that is enough to say which payer a deposit came
 * from, and to find the bill or invoice a payment settled by its amount and the name on it.
 *
 * ── What it will and will not decide ──
 *
 * A deposit is banked when the description names a payer the site knows (a PBM on the claims, a
 * wholesaler, the facilitator) or reads as card and cash takings. A payment marks a bill or a
 * wholesaler invoice paid only where one open item has exactly that amount and the description
 * names its vendor or supplier — one item, exact money, the right name. Anything short of that is
 * listed as not placed rather than guessed: a deposit banked against the wrong payer or a bill
 * marked paid by the wrong line is worse than one left for a person.
 *
 * Every line is remembered by its date, amount and description, so the same statement read twice
 * banks nothing twice. Pure; the store is in the page action.
 */

export type BankLine = {
  /** YYYY-MM-DD. */
  on: string;
  description: string;
  /** Positive is money in, negative is money out. */
  amountCents: number;
  /** A stable key for the line, so it is never applied twice. */
  key: string;
};

export type ParsedStatement = { lines: BankLine[]; skipped: { row: number; why: string }[]; columns: { date: string; description: string; amount: string | null; debit: string | null; credit: string | null } | null };

const DATE_HEADS = [/^(posting|posted|transaction|trans|effective)?\s*date$/i, /^date$/i, /date/i];
const DESC_HEADS = [/^description$/i, /^memo$/i, /^payee$/i, /^details?$/i, /^name$/i, /^narrative$/i, /descr|memo|payee|detail|narrat/i];
const AMOUNT_HEADS = [/^amount$/i, /^transaction amount$/i, /amount/i];
const DEBIT_HEADS = [/^debit(s)?$/i, /^withdrawals?$/i, /^money out$/i, /debit|withdraw|money out|paid out/i];
const CREDIT_HEADS = [/^credit(s)?$/i, /^deposits?$/i, /^money in$/i, /credit|deposit|money in|paid in/i];

function pick(heads: string[], patterns: RegExp[], not: Set<string> = new Set()): string | null {
  for (const p of patterns) {
    const hit = heads.find((h) => !not.has(h) && p.test(h.trim()));
    if (hit) return hit;
  }
  return null;
}

/** "9/5/2026", "09/05/26", "2026-09-05", "5 Sep 2026" → "2026-09-05"; null for anything else. */
export function bankDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = Date.parse(t);
  if (Number.isFinite(d)) return new Date(d).toISOString().slice(0, 10);
  return null;
}

/** "$1,234.56", "(1,234.56)", "-1234.56", "1234.56 CR" → cents, signed. Null where it is not money. */
export function bankCents(s: string): number | null {
  let t = s.trim();
  if (!t) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
  if (/\bDR\b/i.test(t)) sign = -1;
  t = t.replace(/\b(CR|DR)\b/gi, "").replace(/[$,\s]/g, "");
  if (t.startsWith("-")) { sign = -sign; t = t.slice(1); }
  if (t.startsWith("+")) t = t.slice(1);
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return sign * Math.round(Number(t) * 100);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function lineKey(on: string, amountCents: number, description: string): string {
  return `${on}|${amountCents}|${hash(description.trim().toLowerCase().replace(/\s+/g, " "))}`;
}

/** Reads a statement export: header-named columns, one line per row. */
export function parseBankStatement(rows: Record<string, string>[]): ParsedStatement {
  if (rows.length === 0) return { lines: [], skipped: [], columns: null };
  const heads = Object.keys(rows[0]);
  const date = pick(heads, DATE_HEADS);
  const description = pick(heads, DESC_HEADS, new Set([date ?? ""]));
  const amount = pick(heads, AMOUNT_HEADS, new Set([date ?? "", description ?? ""]));
  const debit = amount ? null : pick(heads, DEBIT_HEADS, new Set([date ?? "", description ?? ""]));
  const credit = amount ? null : pick(heads, CREDIT_HEADS, new Set([date ?? "", description ?? "", debit ?? ""]));
  if (!date || !description || (!amount && !debit && !credit)) return { lines: [], skipped: [{ row: 0, why: `Could not find the date, description and amount columns among: ${heads.join(", ")}.` }], columns: null };
  const lines: BankLine[] = [];
  const skipped: ParsedStatement["skipped"] = [];
  rows.forEach((r, i) => {
    const on = bankDate(r[date] ?? "");
    const desc = (r[description] ?? "").trim();
    let cents: number | null = null;
    if (amount) cents = bankCents(r[amount] ?? "");
    else {
      const d = debit ? bankCents(r[debit] ?? "") : null;
      const c = credit ? bankCents(r[credit] ?? "") : null;
      if (d !== null && d !== 0) cents = -Math.abs(d);
      else if (c !== null && c !== 0) cents = Math.abs(c);
      else if (d === 0 || c === 0) cents = 0;
    }
    if (!on) { skipped.push({ row: i + 2, why: `no readable date in "${r[date] ?? ""}"` }); return; }
    if (cents === null) { skipped.push({ row: i + 2, why: "no readable amount" }); return; }
    if (cents === 0) { skipped.push({ row: i + 2, why: "nothing moved" }); return; }
    lines.push({ on, description: desc, amountCents: cents, key: lineKey(on, cents, desc) });
  });
  return { lines, skipped, columns: { date, description, amount, debit, credit } };
}

export type ReceiptKind = "third_party" | "patient" | "retail" | "facilitator" | "rebate" | "other";

export type Placement =
  | { kind: "deposit"; receiptKind: ReceiptKind; payer: string | null; why: string }
  | { kind: "pays_bill"; expenseId: string; vendorName: string; why: string }
  | { kind: "pays_invoice"; invoiceId: string; supplier: string; why: string }
  | { kind: "unplaced"; why: string };

export type MatchContext = {
  /** PBMs and plans seen on the claims, and any payer typed before. */
  payers: string[];
  suppliers: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  unpaidBills: { id: string; vendorId: string | null; vendorName: string | null; amountCents: number; invoiceDate: string }[];
  unpaidInvoices: { id: string; supplierId: string | null; supplier: string | null; totalCents: number | null; invoiceDate: string | null }[];
};

const RETAIL = /\b(square|clover|toast|stripe|merchant|card\s*(services|settlement|deposit)|visa|mastercard|amex|american express|discover|bankcard|worldpay|heartland|elavon|fiserv|cash deposit|counter deposit|mobile deposit|atm deposit)\b/i;
const FACILITATOR = /transaction facilitator|\bmtf\b|\bcms\b|medicare/i;

function names(name: string): string[] {
  const n = name.trim().toLowerCase();
  const words = n.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^(inc|llc|corp|company|the|and|of|pharmacy|health|services|group)$/.test(w));
  return [n, ...words];
}

function mentions(description: string, name: string): boolean {
  const d = description.toLowerCase();
  const [whole, ...words] = names(name);
  if (whole.length >= 4 && d.includes(whole)) return true;
  return words.some((w) => w.length >= 5 && d.includes(w));
}

/** Where each line goes, or why it does not. */
export function placeLine(line: BankLine, ctx: MatchContext): Placement {
  const d = line.description;
  if (line.amountCents > 0) {
    if (FACILITATOR.test(d)) return { kind: "deposit", receiptKind: "facilitator", payer: "Medicare Transaction Facilitator", why: "names the facilitator" };
    const payer = ctx.payers.find((p) => mentions(d, p));
    if (payer) return { kind: "deposit", receiptKind: "third_party", payer, why: `names ${payer}` };
    const supplier = ctx.suppliers.find((s) => mentions(d, s.name));
    if (supplier) return { kind: "deposit", receiptKind: "rebate", payer: supplier.name, why: `names ${supplier.name}: a wholesaler paying in is a rebate or a credit` };
    if (RETAIL.test(d)) return { kind: "deposit", receiptKind: "retail", payer: null, why: "reads as card or cash takings" };
    return { kind: "unplaced", why: "a deposit from nobody the site knows; bank it by hand with the payer" };
  }
  const out = -line.amountCents;
  const bills = ctx.unpaidBills.filter((b) => b.amountCents === out);
  const billByName = bills.filter((b) => b.vendorName && mentions(d, b.vendorName));
  if (billByName.length === 1) return { kind: "pays_bill", expenseId: billByName[0].id, vendorName: billByName[0].vendorName!, why: `the ${billByName[0].vendorName} bill for exactly this amount` };
  if (bills.length === 1 && !bills[0].vendorName) return { kind: "pays_bill", expenseId: bills[0].id, vendorName: "a bill with no vendor", why: "the one open bill for exactly this amount" };
  const invoices = ctx.unpaidInvoices.filter((v) => v.totalCents === out);
  const invByName = invoices.filter((v) => v.supplier && mentions(d, v.supplier));
  if (invByName.length === 1) return { kind: "pays_invoice", invoiceId: invByName[0].id, supplier: invByName[0].supplier!, why: `the ${invByName[0].supplier} invoice for exactly this amount` };
  if (billByName.length > 1 || invByName.length > 1) return { kind: "unplaced", why: "more than one open item has this amount and name; mark the right one paid by hand" };
  const vendor = ctx.vendors.find((v) => mentions(d, v.name));
  const supplier = ctx.suppliers.find((s) => mentions(d, s.name));
  if (vendor) return { kind: "unplaced", why: `names ${vendor.name} but no open bill of theirs is for this amount` };
  if (supplier) return { kind: "unplaced", why: `names ${supplier.name} but no open invoice of theirs is for this amount` };
  return { kind: "unplaced", why: "a payment the site cannot tie to a bill or an invoice" };
}

export function placeLines(lines: BankLine[], ctx: MatchContext): { line: BankLine; placement: Placement }[] {
  /* An open item is settled once: the first line that pays it takes it. */
  const bills = [...ctx.unpaidBills];
  const invoices = [...ctx.unpaidInvoices];
  const out: { line: BankLine; placement: Placement }[] = [];
  for (const line of lines) {
    const placement = placeLine(line, { ...ctx, unpaidBills: bills, unpaidInvoices: invoices });
    if (placement.kind === "pays_bill") bills.splice(bills.findIndex((b) => b.id === placement.expenseId), 1);
    if (placement.kind === "pays_invoice") invoices.splice(invoices.findIndex((v) => v.id === placement.invoiceId), 1);
    out.push({ line, placement });
  }
  return out;
}
