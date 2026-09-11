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

import { readBankDescriptor } from "./bank-descriptors";

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
  /**
   * Understood, and deliberately not booked, because the books already have this money.
   *
   * The owner: "make sure we are not duplicating!!!!! cant stress this enough". Three of this
   * pharmacy's regular lines are money the site learns about twice — postage from Endicia's own
   * email, McKesson's ACH from their accounts-payable report, the facilitator from its own
   * remittance. Each is recognised here and left alone, which is a different answer from
   * "unplaced" and has to look different: one is a job for a person, the other is finished.
   */
  | { kind: "already_counted"; what: string; where: string; why: string }
  /** A transfer between the pharmacy's own accounts: neither a cost nor revenue, on either basis. */
  | { kind: "own_transfer"; why: string }
  /**
   * A cheque recognised as one of the standing costs, by its amount.
   *
   * A confirmation rather than a booking: the cash account already carries a standing cost on its
   * paid day, so booking the cheque as well would be rent twice. What this adds is the proof it
   * really was paid, and the day it really left — and, where the figure has moved, that it has.
   */
  | { kind: "confirms_standing"; name: string; exact: boolean; why: string }
  | { kind: "settles_ach"; supplier: string; reference: string; invoices: string[]; why: string }
  | { kind: "unplaced"; why: string };

export type MatchContext = {
  /** PBMs and plans seen on the claims, and any payer typed before. */
  payers: string[];
  suppliers: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  unpaidBills: { id: string; vendorId: string | null; vendorName: string | null; amountCents: number; invoiceDate: string }[];
  unpaidInvoices: { id: string; supplierId: string | null; supplier: string | null; totalCents: number | null; invoiceDate: string | null }[];
  /**
   * What each wholesaler's own ledger says cleared, and under which reference.
   *
   * The one thing that lets a single bank debit be tied to the invoices inside it. McKesson's
   * ACH07172717 is twenty-seven invoices; no amount of matching by value will ever find them.
   */
  settled?: { supplier: string; invoiceNumber: string; checkNumber: string | null; netCents: number }[];
  /**
   * The costs that recur every month at a known figure: rent, payroll, the accountant.
   *
   * A cheque is the one line on a statement with no payee on it — the bank prints the number and
   * the amount and nothing else. So the amount is the only thing that can name it, and the only
   * amounts worth testing against are the ones that repeat.
   */
  /**
   * Every figure this pharmacy pays that the site can work out for itself.
   *
   * The costs that repeat at the same amount — rent, payroll, the accountant — carry no month.
   * The ones that change every month carry the month they belong to, and are only candidates in
   * it: the delivery round is 54 trips in one month and 47 in the next, and the drugs passed to
   * the practice at cost are a different figure again. Matching September's cheque against
   * August's round would confirm a payment that never happened.
   *
   * The owner: "checks should match what they can (ie WWFP meds or delivery driver, or other
   * things it seems like it matches.) the rest of the checks should allow me to categorize."
   */
  standing?: { name: string; amountCents: number; paidDay: number | null; month?: string }[];
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

  /*
   * What this pharmacy's own counterparties look like, before anything generic is tried.
   *
   * The rules below this are sound and answer almost none of these lines: the money does not
   * arrive or leave one invoice at a time. See bank-descriptors.ts for what each one is.
   */
  const meaning = readBankDescriptor(d, line.amountCents);


  /*
   * A wholesaler's ACH, tied to its invoices by their own reference rather than by its amount.
   *
   * This is the line the whole bank reconciliation turns on and the one the generic rule could
   * never place: it looks for a single open invoice of exactly $121,429.15, and there is no such
   * invoice and never will be.
   */
  if (meaning.matchTo?.reference && ctx.settled) {
    const ref = meaning.matchTo.reference;
    const covered = ctx.settled.filter((x) => x.checkNumber === ref);
    if (covered.length > 0) {
      const cents = covered.reduce((n, x) => n + x.netCents, 0);
      const agrees = cents === -line.amountCents;
      return {
        kind: "settles_ach",
        supplier: meaning.counterparty,
        reference: ref,
        invoices: covered.map((x) => x.invoiceNumber),
        why: agrees
          ? `${ref} covers ${covered.length} ${meaning.counterparty} invoices and comes to exactly this debit. The money is already the cash cost of goods, from their own report, so nothing is booked from this line.`
          : `${ref} covers ${covered.length} ${meaning.counterparty} invoices coming to ${(cents / 100).toFixed(2)}, and the bank took ${((-line.amountCents) / 100).toFixed(2)} — worth a look.`,
      };
    }
  }

  /*
   * Then money the books already hold, recognised and left exactly alone.
   *
   * After the ACH rule, not before it. A McKesson debit is both things at once: its money is
   * already the cash cost of goods, AND it is the only line that can say which invoices were paid.
   * Answering "already counted" first threw the second half away and left the largest debit on the
   * statement unreconciled — which is the thing this was built to fix.
   */
  if (meaning.alreadyCounted) {
    return { kind: "already_counted", what: meaning.counterparty, where: meaning.alreadyCounted, why: meaning.says };
  }
  if (meaning.lands === "transfer") return { kind: "own_transfer", why: meaning.says };
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

  /*
   * A cheque, which is the one line that arrives with no payee at all.
   *
   * The bank prints "Check 2451" and the amount. Nothing else — no name, no reference, nothing
   * for any of the rules below to match on. August's six cheques would every one of them have
   * landed unplaced, and two of them were the rent and the accountant.
   *
   * So the amount does the naming, and only against figures that repeat. An exact match is the
   * cost; a near miss is reported as a near miss rather than quietly accepted, because a rent
   * cheque that has changed by forty dollars is worth knowing about and is exactly what a
   * tolerance would hide.
   */
  if (/^(CHECK|CHQ|CHEQUE|DRAFT)\s*#?\s*\d+$/i.test(d.trim()) && ctx.standing?.length) {
    /*
     * Only the figures that could be this month's.
     *
     * Most recurring costs are the same every month and carry no month of their own. The delivery
     * round is not: the owner pays the driver for the trips he actually drove, so his cheque is a
     * different figure every month — 54 trips at $9.00 in one, 47 in the next. A candidate carrying
     * a month is only a candidate in that month, or September's cheque would be matched against
     * August's round and confirm a payment that never happened.
     */
    const candidates = ctx.standing.filter((c) => !c.month || c.month === line.on.slice(0, 7));
    const exact = candidates.filter((c) => c.amountCents === out);
    if (exact.length === 1) {
      return {
        kind: "confirms_standing",
        name: exact[0].name,
        exact: true,
        why: `${exact[0].name}, paid by cheque. The standing cost already carries it, so nothing is booked from this line — what it adds is that the money really left, and on ${line.on}.`,
      };
    }
    if (exact.length > 1) {
      return { kind: "unplaced", why: `${exact.length} standing costs are for exactly this amount, so which cheque this is cannot be told from the amount alone.` };
    }
    /*
     * Exactly, or not at all. There is deliberately no "close enough" here.
     *
     * There was, at a twentieth either way, and a real cheque broke it the day it was written.
     * Cheque 2449 for $1,449.00 sat 3.2% from the accountant's $1,403.40 and would have been
     * reported as the accountant's fee having gone up. It is not the accountant at all — the owner:
     * "the 1449 is for drugs sold to WWFP at cost". The two were never related.
     *
     * No tolerance can separate those, because the thing that distinguishes them is not how far
     * apart the figures are; it is that they are different things. A window wide enough to catch a
     * rent rise is wide enough to swallow an unrelated cheque of similar size, and the wrong answer
     * is worse than none: it would have had somebody change a standing cost that was correct.
     */
    return {
      kind: "unplaced",
      why:
        "A cheque. The bank prints no payee on one, and its amount matches nothing the site can work out for this month, " +
        "so it is yours to categorise — and once you have, the account has it.",
    };
  }
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

/**
 * Every amount this pharmacy pays that the site can work out for itself, for naming a cheque by.
 *
 * A cheque is the only line on a statement with no payee on it — the bank prints its number and its
 * amount and nothing else. So the amount has to do the naming, and the only amounts safe to name it
 * with are ones the site derived rather than guessed.
 *
 * Three sources, and each is exact:
 *
 *   the standing costs   rent, payroll, the accountant. The same every month, so no month is
 *                        attached and they are candidates in all of them.
 *   the delivery round   what the driver is owed for the trips he actually drove, at his own rate.
 *                        A different figure every month, so it carries the month it belongs to.
 *   the practice's drugs what was passed to West Wichita Family Physicians at cost. Also monthly,
 *                        and also exact — it comes from PioneerRx's own report of what was sold to
 *                        them, not from anything inferred.
 */
export async function chequeCandidates(month: string): Promise<{ name: string; amountCents: number; paidDay: number | null; month?: string }[]> {
  const { db, schema } = await import("@/db");
  const out: { name: string; amountCents: number; paidDay: number | null; month?: string }[] = [];

  for (const c of await db.select().from(schema.standingCosts)) {
    if (c.fromMonth > month || (c.toMonth !== null && c.toMonth < month)) continue;
    out.push({ name: c.name, amountCents: c.amountCents, paidDay: c.paidDay ?? null });
  }

  /*
   * The driver's round, from the days entered — the same arithmetic his invoice is built from, so
   * the figure the cheque is tested against is the figure he was actually owed.
   */
  const { monthState } = await import("./deliveries");
  const round = await monthState(month);
  if (round.totalCents > 0) {
    out.push({ name: `The delivery round for ${round.label}`, amountCents: round.totalCents, paidDay: null, month });
  }

  return out;
}
