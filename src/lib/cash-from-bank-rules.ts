/**
 * The cash account is the bank statement, categorised.
 *
 * The owner, 2 October 2026, shown a September cash account that differed from the bank by $15,494.78 with $8,190.95
 * of it unnamed: "cash accounting should match the bank, this is how cash accounting works.." He is right. Until
 * then the cash account counted a receipt on the payer's notice date, left out bank lines nothing had placed, kept
 * receipts for pre-books days out by a rule of 11 September, and counted credit memos that never reach the bank.
 *
 * So every bank line is one of six things — revenue, an offset against revenue, cost of goods, an operating cost,
 * a flow that is neither (loan principal, an owner draw, a transfer to the pharmacy's other account), or not yet
 * named — and the account is the sum of them, which equals the bank's movement to the cent by construction. A line
 * not yet named stays inside the account, under its own heading, until he names it on the bank page: naming lines
 * is the reconciliation. Receipts the bank has not confirmed sit beside the account, never in it.
 *
 * Pure. The loader in cash-from-bank.ts reads the month and builds the context; this decides each line and can be
 * tested on invented lines.
 */

export type BankLineIn = {
  id: string;
  on: string;
  description: string;
  amountCents: number;
  placedAs: string;
  why: string | null;
  receiptId: string | null;
  expenseId: string | null;
  invoiceId: string | null;
};

export type Side = "revenue" | "offset" | "cost_of_goods" | "operating" | "flow" | "unnamed";

export type Classified = {
  line: BankLineIn;
  side: Side;
  /** The account line it belongs on: a receipt kind, a supplier, an expense category, a flow's name, or "Not yet named". */
  label: string;
  /** The counterparty where one is known: the payer, the supplier, the vendor. */
  who: string | null;
  /** Which rule decided, in a few words, so the page can say why. */
  how: string;
};

export type Context = {
  suppliers: { name: string; aliases?: string | null }[];
  standing: { name: string; categoryName: string | null }[];
  vendors: { name: string; categoryName: string | null; categoryKind: string | null }[];
  categories: { name: string; kind: string }[];
  receipts: Map<string, { kind: string; payer: string | null }>;
  invoices: Map<string, { supplier: string | null }>;
  expenses: Map<string, { categoryName: string | null; categoryKind: string | null }>;
};

/**
 * The pharmacy's own other account, by the owner's word (15 September 2026): *6728 is West Wichita Family
 * Physicians; the pharmacy pays payroll through them ("Sept PSA", $45,000, which is the Payroll standing cost to
 * the cent); "Medications" transfers out are "must be meds we bought from them"; "Prescription/TRANSFER" credits
 * are WWFP paying for drugs sold to it at cost.
 */
export const OWN_ACCOUNTS: { suffix: string; name: string }[] = [{ suffix: "6728", name: "West Wichita Family Physicians" }];

const RECEIPT_LABEL: Record<string, string> = {
  third_party: "Third-party remittances",
  patient: "Patient payments",
  facilitator: "Facilitator payments",
  retail: "Retail takings",
  rebate: "Wholesaler rebates received",
  other: "Other receipts",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** For a name against a name: "Alert 360" and "Alert360" are one vendor. */
const tight = (s: string) => norm(s).replace(/ /g, "");
const sameName = (a: string, b: string) => tight(a) === tight(b) || (tight(b).length >= 4 && tight(a).includes(tight(b))) || (tight(a).length >= 4 && tight(b).includes(tight(a)));

/** Whether a supplier's name or any alias is in the text: "Independent Phar/WAREHOUSE" is IPC by its alias. */
export function supplierIn(text: string, suppliers: Context["suppliers"]): string | null {
  const t = norm(text);
  if (!t) return null;
  let best: { name: string; len: number } | null = null;
  for (const s of suppliers) {
    const names = [s.name, ...(s.aliases ?? "").split(/\r?\n|,/)].map((n) => norm(n)).filter((n) => n.length >= 3);
    for (const n of names) {
      /* A short name must stand as a word (IPC, API); a long one may be cut by the bank's column width ("Independent Phar"). */
      const hit = n.length <= 4 ? new RegExp(`(^| )${n}( |$)`).test(t) : t.includes(n) || (n.length >= 10 && t.includes(n.slice(0, 10)));
      if (hit && (!best || n.length > best.len)) best = { name: s.name, len: n.length };
    }
  }
  return best?.name ?? null;
}

/** The counterparty the placement engine named in its own sentence, where it did. */
export function nameFromWhy(why: string | null): string | null {
  if (!why) return null;
  const m =
    /^Out to ([^.]+?)\./.exec(why) ??
    /^([A-Za-z][\w &'.-]*?), paid within/.exec(why) ??
    /covers \d+ ([A-Za-z][\w&'.-]*) invoices/.exec(why) ??
    /^([A-Za-z][\w&'.-]*)'s (?:payment|statement|draw|EFT)/.exec(why) ??
    /^([A-Za-z][\w &'.-]*?), paid by cheque/.exec(why) ??
    /^([A-Za-z][\w&'.-]*): \$/.exec(why);
  return m ? m[1].trim() : null;
}

function categoryByName(name: string | null, categories: Context["categories"]): { name: string; kind: string } | null {
  if (!name) return null;
  const n = norm(name);
  return categories.find((c) => norm(c.name) === n) ?? categories.find((c) => norm(c.name).startsWith(n) || n.startsWith(norm(c.name))) ?? null;
}

function sideOfKind(kind: string | null): Side {
  if (kind === "balance_sheet") return "flow";
  if (kind === "revenue_offset") return "offset";
  if (kind === "cost_of_goods") return "cost_of_goods";
  return "operating";
}

export function classifyBankLine(line: BankLineIn, ctx: Context): Classified {
  const debit = line.amountCents < 0;
  const text = `${line.description} ${line.why ?? ""}`;

  // 1. Tied to a receipt: the receipt's kind says what the money is.
  if (line.receiptId && ctx.receipts.has(line.receiptId)) {
    const r = ctx.receipts.get(line.receiptId)!;
    if (r.kind === "rebate") return { line, side: "cost_of_goods", label: RECEIPT_LABEL.rebate, who: r.payer, how: "a rebate the bank received" };
    return { line, side: "revenue", label: RECEIPT_LABEL[r.kind] ?? "Other receipts", who: r.payer, how: "tied to a receipt" };
  }
  // 2. Tied to a supplier invoice.
  if (line.invoiceId && ctx.invoices.has(line.invoiceId)) {
    const inv = ctx.invoices.get(line.invoiceId)!;
    return { line, side: "cost_of_goods", label: inv.supplier ?? "Drug purchases", who: inv.supplier, how: "pays an invoice on file" };
  }
  // 2b. Paying invoices that have since been purged or re-filed: the placement's own sentence still names the supplier.
  if (/^pays_invoice/.test(line.placedAs)) {
    const who = supplierIn(nameFromWhy(line.why) ?? "", ctx.suppliers) ?? supplierIn(text, ctx.suppliers);
    if (who) return { line, side: "cost_of_goods", label: who, who, how: "pays invoices the placement named; the invoice rows have since been re-filed" };
  }
  // 3. Tied to an expense: its category's kind decides.
  if (line.expenseId && ctx.expenses.has(line.expenseId)) {
    const e = ctx.expenses.get(line.expenseId)!;
    return { line, side: sideOfKind(e.categoryKind), label: e.categoryName ?? "Other", who: null, how: "booked as a bill" };
  }
  // 4. The pharmacy's own other account, by what the transfer was for.
  for (const own of OWN_ACCOUNTS) {
    if (!new RegExp(`\\*${own.suffix}\\b`).test(line.description) && line.placedAs !== "own_transfer") continue;
    if (/\bPSA\b|payroll|wages/i.test(line.description)) return { line, side: "operating", label: "Wages and salaries", who: own.name, how: `payroll, paid through ${own.name}` };
    if (/\bmed/i.test(line.description) && debit) return { line, side: "cost_of_goods", label: own.name, who: own.name, how: "drugs bought from the practice, by his word" };
    if (!debit && /prescription|transfer/i.test(line.description)) return { line, side: "revenue", label: `Drugs sold at cost to ${own.name}`, who: own.name, how: "the practice paying for drugs sold to it at cost" };
    return { line, side: "flow", label: `Transfer ${debit ? "to" : "from"} ${own.name}`, who: own.name, how: "a transfer between the pharmacy's own accounts" };
  }
  // 5. A wholesaler's draw settling a statement.
  if (line.placedAs === "settles_ach") {
    const who = supplierIn(nameFromWhy(line.why) ?? "", ctx.suppliers) ?? supplierIn(text, ctx.suppliers);
    return { line, side: "cost_of_goods", label: who ?? "Drug purchases", who, how: "a wholesaler's draw against its statement" };
  }
  // 6. Before the books: by the owner's decision of 1 October, what the bank paid is cost; what it received is revenue.
  if (line.placedAs === "before_books") {
    if (debit) {
      const who = supplierIn(nameFromWhy(line.why) ?? "", ctx.suppliers) ?? supplierIn(text, ctx.suppliers);
      return { line, side: "cost_of_goods", label: who ?? "Drug purchases, before the books", who, how: "goods bought before the books, paid this month" };
    }
    const patient = /card|HRTLAND|PMT SYS|deposit|counter|register|drawer/i.test(text);
    return { line, side: "revenue", label: patient ? RECEIPT_LABEL.patient : RECEIPT_LABEL.third_party, who: null, how: "received this month for days before the books" };
  }
  // 7. Money the feeds had already booked: the placement's own sentence names the counterparty.
  if (line.placedAs === "already_counted" || line.placedAs === "card_deposit" || line.placedAs === "psao_deposit") {
    if (!debit && (/\bMTF\b|facilitator/i.test(text))) return { line, side: "revenue", label: RECEIPT_LABEL.facilitator, who: "MTF", how: "the Medicare facilitator paying" };
    if (!debit && /card|HRTLAND|PMT SYS/i.test(text)) return { line, side: "revenue", label: RECEIPT_LABEL.patient, who: null, how: "card takings" };
    if (!debit && line.placedAs === "psao_deposit") return { line, side: "revenue", label: RECEIPT_LABEL.third_party, who: null, how: "the PSAO paying in" };
    const named = nameFromWhy(line.why);
    const supplier = supplierIn(named ?? "", ctx.suppliers) ?? supplierIn(line.description, ctx.suppliers);
    if (supplier && debit) return { line, side: "cost_of_goods", label: supplier, who: supplier, how: "a purchase the invoice feed already carries" };
    const st = named ? ctx.standing.find((s) => sameName(named, s.name)) : null;
    if (st && debit) return { line, side: "operating", label: st.categoryName ?? st.name, who: st.name, how: "a standing cost, paid" };
    const v = named ? ctx.vendors.find((x) => sameName(named, x.name)) : null;
    if (v) return { line, side: sideOfKind(v.categoryKind), label: v.categoryName ?? v.name, who: v.name, how: "a vendor on file" };
    if (debit && /stamps\.com|postage|usps|endicia|pitney/i.test(text)) return { line, side: "operating", label: "Postage and shipping", who: named, how: "postage, by card" };
    if (debit) return { line, side: "operating", label: "Other, by card", who: named, how: "paid by card; the feed that carries it names no category" };
    return { line, side: "revenue", label: RECEIPT_LABEL.other, who: named, how: "received; the feed that carries it names no kind" };
  }
  // 8. A standing cost paid by cheque.
  if (line.placedAs === "confirms_standing") {
    const named = nameFromWhy(line.why);
    const st = named ? ctx.standing.find((s) => sameName(named, s.name)) : null;
    return { line, side: "operating", label: st?.categoryName ?? st?.name ?? named ?? "Standing cost", who: st?.name ?? named, how: "a standing cost, paid by cheque" };
  }
  // 9. Noted with a category: the category's kind decides.
  if (line.placedAs === "noted") {
    const cat = categoryByName((line.why ?? "").split(":")[0], ctx.categories);
    if (cat) return { line, side: sideOfKind(cat.kind), label: cat.name, who: supplierIn(text, ctx.suppliers), how: "noted under a category" };
  }
  // 10. Nothing has named it: it stays in the account, under its own heading, until he does.
  return { line, side: "unnamed", label: "Not yet named", who: null, how: line.placedAs === "unplaced" ? "nothing could place it" : `placed as ${line.placedAs}, which names no category` };
}

export type AccountLine = { label: string; amountCents: number; note?: string };

/** The classified lines gathered into the account's sections; every section is positive money, out or in as its heading says. */
export function gatherCashAccount(classified: Classified[]): {
  revenue: AccountLine[];
  offsets: AccountLine[];
  costOfGoods: AccountLine[];
  operating: AccountLine[];
  flows: AccountLine[];
  unnamed: AccountLine[];
  inCents: number;
  outCents: number;
  changeCents: number;
} {
  const sum = (side: Side, sign: 1 | -1) => {
    const by = new Map<string, { cents: number; n: number }>();
    for (const c of classified) {
      if (c.side !== side) continue;
      const e = by.get(c.label) ?? { cents: 0, n: 0 };
      e.cents += sign * c.line.amountCents;
      e.n++;
      by.set(c.label, e);
    }
    return [...by.entries()].sort((a, b) => Math.abs(b[1].cents) - Math.abs(a[1].cents)).map(([label, v]) => ({ label, amountCents: v.cents, note: `${v.n} line${v.n === 1 ? "" : "s"}` }));
  };
  const inCents = classified.filter((c) => c.line.amountCents > 0).reduce((n, c) => n + c.line.amountCents, 0);
  const outCents = classified.filter((c) => c.line.amountCents < 0).reduce((n, c) => n + c.line.amountCents, 0);
  return {
    revenue: sum("revenue", 1),
    offsets: sum("offset", -1),
    costOfGoods: sum("cost_of_goods", -1),
    operating: sum("operating", -1),
    flows: sum("flow", -1),
    unnamed: sum("unnamed", -1),
    inCents,
    outCents,
    changeCents: inCents + outCents,
  };
}
