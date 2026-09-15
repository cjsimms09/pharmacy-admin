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
  /**
   * The card processor paying in a day's card takings. Never banked from the statement: the card batch
   * report is the one door for that money, and this line only confirms the batch. See `placeLine`.
   */
  | { kind: "card_deposit"; why: string }
  /** A PSAO deposit (Access Health, ProviderPay). Confirms the receipt its report or EFT notice banked; never banked here. */
  | { kind: "psao_deposit"; why: string }
  /** A cost whose only record is the bank line itself: booked from it, dated and paid on the bank's date. */
  | { kind: "books_bill"; category: string; vendor: string; why: string }
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
  | { kind: "settles_ach"; supplier: string; reference: string; invoices: string[]; agrees: boolean; why: string }
  /** A facilitator credit no remittance on file explains. Never matched to other receipts, never banked. */
  | { kind: "facilitator_unmatched"; why: string }
  /** A piece of a wholesaler rebate paid in several credits. Never matched one at a time, never banked. */
  | { kind: "rebate_part"; why: string }
  | { kind: "unplaced"; why: string };

export type MatchContext = {
  /** PBMs and plans seen on the claims, and any payer typed before. */
  payers: string[];
  suppliers: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  unpaidBills: { id: string; vendorId: string | null; vendorName: string | null; amountCents: number; invoiceDate: string }[];
  unpaidInvoices: { id: string; supplierId: string | null; supplier: string | null; totalCents: number | null; invoiceDate: string | null }[];
  /** Postage bills booked from purchase confirmations: what a Stamps.com debit must find to be already counted. */
  postageBills?: { amountCents: number; on: string }[];
  /** The facilitator's payments summed by the day they were paid, from the MTF remittances. */
  facilitatorPaid?: { on: string; cents: number }[];
  /** Card processing bills no bank line has claimed yet, paid or not — the card statement books its fees already paid. */
  cardFeeBills?: { id: string; vendorName: string | null; amountCents: number; invoiceDate: string }[];
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

/*
 * The pharmacy's own name and address, which the bank prints on nearly every line. A payer label "005377 (10000019)- City
 * of Wichita" was mentioned by every credit that said WEST WICHITA FAMILY PH, and 22 lines, $78,726.92, banked as its
 * money on a rehearsal of August's scan (Session 2, money map G-BANK-1). These words never name a counterparty.
 */
const OWN_WORDS = new Set(["west", "wichita", "family", "fam", "pharmacy", "phcy", "ph", "llc", "central", "ave", "treasury", "mgmt"]);

function mentions(description: string, name: string): boolean {
  const d = description.toLowerCase();
  /* Whole words only: "script" is not in "Prescription". */
  const tokens = new Set(d.split(/[^a-z0-9]+/).filter(Boolean));
  const [whole, ...words] = names(name);
  const distinctive = whole.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !OWN_WORDS.has(w));
  if (whole.length >= 4 && d.includes(whole) && distinctive.some((w) => tokens.has(w))) return true;
  return words.some((w) => w.length >= 5 && !OWN_WORDS.has(w) && tokens.has(w));
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
        agrees,
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
  /*
   * Postage: already counted only where the confirmation that booked it is on file. Every Stamps.com debit used
   * to be taken as counted, and none of August's ten had a bill behind it (Session 2, money map G-POST-1).
   */
  if (meaning.kind === "postage" && ctx.postageBills) {
    if (postageBillFor(ctx.postageBills, line) >= 0) {
      return { kind: "already_counted", what: meaning.counterparty, where: meaning.alreadyCounted ?? "postage", why: meaning.says };
    }
    /*
     * The Stamps.com charge billed from El Segundo — $40.99 on 18 August — is mailing, the owner says, and no confirmation
     * email ever comes for it. The bank line is its only door, so it books the bill itself.
     */
    if (/SEGUNDO/.test(d.toUpperCase().replace(/[^A-Z]/g, ""))) {
      return { kind: "books_bill", category: "Postage and shipping", vendor: "Stamps.com", why: "Stamps.com's own charge from El Segundo, which is mailing and comes with no confirmation email. Booked as postage from this line." };
    }
    return {
      kind: "unplaced",
      why: "A postage charge with no Endicia or Stamps.com purchase confirmation on file for this amount within three days. The confirmation email books it; if it never came, this is a cost the books do not have.",
    };
  }
  if (meaning.alreadyCounted) {
    return { kind: "already_counted", what: meaning.counterparty, where: meaning.alreadyCounted, why: meaning.says };
  }
  if (meaning.lands === "transfer") return { kind: "own_transfer", why: meaning.says };
  if (line.amountCents > 0) {
    /*
     * Card takings, by every spelling the scans produced — before the generic RETAIL rule, which knows
     * only a clean "HEARTLAND" and missed "HRTLAND PMT SYST TXNS".
     *
     * Not a deposit to bank. Banking it here made the cash account depend on which arrived first: read
     * before its batch report, the batch was refused and the money sat on the retail line; read as one
     * deposit of two batches, both batches banked on top of it; banked by hand beside a batch, both
     * counted (Session 2, money map G-CARD-2, -7, -8, reproduced on a snapshot). The batch report banks;
     * this confirms.
     */
    if (meaning.kind === "card_settlement") return { kind: "card_deposit", why: meaning.says };
    /*
     * Pieces of a wholesaler rebate. Not banked, and not offered to the receipt match one at a time: the rebate
     * statement banks the whole, and a piece that happened to equal some other receipt would confirm the wrong one.
     * Until the pieces can be tied to that receipt together, a person sees them with this said.
     */
    if (meaning.kind === "wholesaler_rebate") {
      return {
        kind: "rebate_part",
        why: "Part of McKesson's rebate, which arrives as separate brand, generic and fee credits on one day. The rebate statement banks the whole rebate; do not bank these by hand, or it is counted twice.",
      };
    }
    /*
     * The facilitator's money is counted from its remittances, payment by payment, and a banked facilitator
     * receipt made the cash account drop every MTF payment in that month (profit-and-loss.ts reads the
     * payments only where no facilitator receipt exists) — September's $2,789.08 became $1,232.94 on a
     * snapshot (Session 2, money map G-MTF-1). So the bank line is recognised and left alone.
     */
    if (meaning.kind === "facilitator" || FACILITATOR.test(d)) {
      /* Confirmed only where that day's MTF payments come to exactly this — on August's real files they did, 7 of 7. */
      const paid = ctx.facilitatorPaid?.find((p) => p.on === line.on)?.cents ?? null;
      if (paid === line.amountCents) {
        return {
          kind: "already_counted",
          what: "Medicare Transaction Facilitator",
          where: "facilitator revenue, from the MTF remittances",
          why: "The Medicare facilitator paying. Its remittance for this day comes to exactly this, and already counts it payment by payment.",
        };
      }
      return {
        kind: "facilitator_unmatched",
        why:
          `The Medicare facilitator paying, but ${paid === null ? "no MTF remittance for this day is on file" : `the MTF remittances for this day come to ${(paid / 100).toFixed(2)}`}. ` +
          "Nothing is banked from the line — banking it would drop every MTF payment from the month's cash. The remittance for it is what is missing.",
      };
    }
    /*
     * The PSAO's deposits — Access Health and ProviderPay — are banked by the payer payment report and the EFT notice.
     * The line confirms one of those receipts or waits; it never banks, or a misread amount banks the deposit twice.
     */
    if (meaning.kind === "psao_remittance") return { kind: "psao_deposit", why: meaning.says };
    /* Named receipts nobody has said how to count yet (prescription transfers, Veridian, POC Network): a person decides. */
    if (meaning.kind === "transfer_in" || meaning.kind === "other_receipt") {
      return { kind: "unplaced", why: `${meaning.says} Not banked from the statement until it is agreed what this money is and where it belongs.` };
    }
    /*
     * A credit that only mentions a plan by name is not banked either: every plan's money reaches the bank through the
     * PSAO and has its own door. It is left for a person, named.
     */
    const payer = ctx.payers.find((p) => mentions(d, p));
    if (payer) {
      return { kind: "unplaced", why: `mentions ${payer}, whose money normally arrives through the PSAO and is banked from its report; if this really is a separate payment, bank it with the form` };
    }
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
     * Only the figures this cheque could be paying.
     *
     * Most recurring costs are the same every month and carry no month of their own. The delivery
     * round is not: the owner pays the driver for the trips he actually drove, so his cheque is a
     * different figure every month — 54 trips at $9.00 in one, 47 in the next. A candidate carrying
     * a month is therefore only a candidate for the round it belongs to, or one month's cheque would
     * confirm another month's round and assert a payment that never happened.
     *
     * ── Which months, and why two ──
     *
     * The owner, on how the driver is paid: "at end of month print that invoice and give driver a
     * check", and then plainly on the timing: **"It won't clear on exact day, it will clear early in
     * the next month for same amount as delivery."**
     *
     * So the normal case is a cheque landing in the first days of the month *after* the trips. This
     * filter admitted only the line's own month, which meant the normal case came back unplaced —
     * measured: $522.00 clearing 30 September matched, the same cheque clearing 1 October did not —
     * and left him placing it by hand every month.
     *
     * The line's month and the one before it, then. Not wider: two months is what his workflow can
     * produce, and a third would start matching cheques to rounds nobody was paying that late.
     * `chequeCandidates` offers both rounds; this decides which of them a given line may pay.
     *
     * Where both months came to the same figure the amount cannot say which, and the code below
     * refuses rather than choosing — see the two-exact-matches branch.
     */
    const lineMonth = line.on.slice(0, 7);
    const before = new Date(Date.parse(`${lineMonth}-01T00:00:00Z`));
    before.setUTCMonth(before.getUTCMonth() - 1);
    const payable = new Set([lineMonth, before.toISOString().slice(0, 7)]);
    const candidates = ctx.standing.filter((c) => !c.month || payable.has(c.month));
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
  /*
   * The card processor's monthly fee debit, against the bill its own statement booked.
   *
   * The statement is read by `card-statement-store.ts` and books the fees already paid, on the auto-debit
   * date it prints — so the bill is not in `unpaidBills`, and the bank's description ("HRTLAND PMT SYS")
   * never mentions the vendor by the name it is filed under. Matched by exact amount among card
   * processing bills no bank line has claimed. With none, the fees are not in the books at all, and the
   * line says what is missing rather than inviting somebody to book it by hand beside a statement that
   * may yet arrive.
   */
  if (meaning.kind === "card_fees" && ctx.cardFeeBills) {
    const fee = ctx.cardFeeBills.filter((b) => b.amountCents === out);
    if (fee.length === 1) return { kind: "pays_bill", expenseId: fee[0].id, vendorName: fee[0].vendorName ?? meaning.counterparty, why: `the card processing fees on the ${fee[0].invoiceDate.slice(0, 7)} statement, exactly this amount` };
    if (fee.length > 1) return { kind: "unplaced", why: `${fee.length} card processing statements are for exactly this amount; mark the right one paid by hand` };
    return {
      kind: "unplaced",
      why: "the card processor taking its monthly fees, but no card processing statement for this amount is on file. Forward that month's statement to the inbox rather than booking this by hand, or the fees will be counted twice when it arrives.",
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

/**
 * The postage bill a card charge is, or -1: the same amount, confirmed on the day of the charge or up to three days
 * before it (the card posts after the purchase), the closest first.
 */
export function postageBillFor(bills: { amountCents: number; on: string }[], line: BankLine): number {
  const day = Date.parse(`${line.on}T00:00:00Z`);
  let best = -1;
  let bestGap = Infinity;
  bills.forEach((b, i) => {
    const gap = day - Date.parse(`${b.on}T00:00:00Z`);
    if (b.amountCents === -line.amountCents && gap >= 0 && gap <= 3 * 86_400_000 && gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  });
  return best;
}

export function placeLines(lines: BankLine[], ctx: MatchContext): { line: BankLine; placement: Placement }[] {
  /* An open item is settled once: the first line that pays it takes it. */
  const bills = [...ctx.unpaidBills];
  const invoices = [...ctx.unpaidInvoices];
  /*
   * And a postage confirmation accounts for one charge. It did not: the bill was never used up, so three confirmations
   * covered four $100 top-ups in September, and the one with no confirmation was called counted (Session 2, G-POST-1).
   */
  const postage = ctx.postageBills ? [...ctx.postageBills] : undefined;
  const out: { line: BankLine; placement: Placement }[] = [];
  for (const line of lines) {
    const placement = placeLine(line, { ...ctx, unpaidBills: bills, unpaidInvoices: invoices, postageBills: postage });
    if (postage && placement.kind === "already_counted" && readBankDescriptor(line.description, line.amountCents).kind === "postage") {
      postage.splice(postageBillFor(postage, line), 1);
    }
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
   *
   * ── Two months of rounds, because of when the cheque is written ──
   *
   * The owner, asked how he pays the driver: "We pay driver once monthly, track with the invoice on
   * site then at end of month print that invoice and give driver a check.. so accural should read
   * off invoice and cash will see check. It should know which check is delivery because it will be
   * for exact amount of delivery from previous month."
   *
   * So the cheque for September's trips is written at the end of September and clears on either
   * side of the boundary. Offering only the drawn month's round meant a $522.00 cheque clearing on
   * 30 September matched and the same cheque clearing on 1 October did not — measured, both ways —
   * leaving him to place it by hand twelve times a year.
   *
   * The previous month's round is a candidate too, and each carries its own month so the placement
   * can say *which* round it paid. That is why the month sits on the candidate rather than being
   * inferred from the line: a cheque confirming the wrong month's round asserts a payment that
   * never happened, and naming the month is what makes that visible to him.
   *
   * Only the delivery round gets this. A standing cost carries no month because it is the same
   * every month, and widening those would match a rent cheque against any month's rent.
   */
  const { monthState } = await import("./deliveries");
  const previous = new Date(Date.parse(`${month}-01T00:00:00Z`));
  previous.setUTCMonth(previous.getUTCMonth() - 1);

  for (const m of [month, previous.toISOString().slice(0, 7)]) {
    const round = await monthState(m);
    if (round.totalCents <= 0) continue;
    /*
     * Two consecutive months coming to the same figure would make a cheque ambiguous. Deliberately
     * not resolved here and not hidden: both are offered, `placeLine` finds two exact matches and
     * says it cannot tell them apart from the amount alone — which is the honest answer, and the
     * one he can do something about.
     */
    out.push({ name: `The delivery round for ${round.label}`, amountCents: round.totalCents, paidDay: null, month: m });
  }

  return out;
}
