import "server-only";
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { classifyBankLine, gatherCashAccount, type Classified, type Context } from "./cash-from-bank-rules";
import type { MonthlyPL, PLLine } from "./profit-and-loss";

/**
 * A month's cash account, built from its bank statement (cash-from-bank-rules.ts for the rule and the owner's words).
 * Null where no statement has been read for the month: a month in progress has no cash account yet, only what the
 * feeds have seen, and the page says which.
 */
export type CashOnBank = {
  month: string;
  lines: Classified[];
  inCents: number;
  outCents: number;
  changeCents: number;
  /** Receipts the site recorded for the month that no bank line confirms: in transit, or never cash at all. */
  unconfirmedReceipts: PLLine[];
};

export async function cashOnBankFor(month: string): Promise<CashOnBank | null> {
  const from = `${month}-01`;
  const to = `${month}-31`;
  const rows = await db.query.bankLines.findMany({ where: and(gte(schema.bankLines.on, from), lte(schema.bankLines.on, to)), orderBy: (t, { asc }) => [asc(t.on)] });
  if (rows.length === 0) return null;

  const ids = (k: "receiptId" | "invoiceId" | "expenseId") => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];
  const [receipts, invoices, expenses, categories, standing, vendors, suppliers] = await Promise.all([
    ids("receiptId").length ? db.query.cashReceipts.findMany({ where: inArray(schema.cashReceipts.id, ids("receiptId")), columns: { id: true, kind: true, payer: true } }) : [],
    ids("invoiceId").length ? db.query.supplierInvoices.findMany({ where: inArray(schema.supplierInvoices.id, ids("invoiceId")), columns: { id: true, supplier: true } }) : [],
    ids("expenseId").length ? db.query.expenses.findMany({ where: inArray(schema.expenses.id, ids("expenseId")), columns: { id: true, categoryId: true } }) : [],
    db.query.expenseCategories.findMany({ columns: { id: true, name: true, kind: true } }),
    db.query.standingCosts.findMany({ columns: { name: true, categoryId: true } }),
    db.query.vendors.findMany({ columns: { name: true, categoryId: true } }),
    db.query.suppliers.findMany({ columns: { name: true, aliases: true } }),
  ]);
  const catById = new Map(categories.map((c) => [c.id, c]));
  const ctx: Context = {
    suppliers,
    standing: standing.map((s) => ({ name: s.name, categoryName: s.categoryId ? (catById.get(s.categoryId)?.name ?? null) : null })),
    vendors: vendors.map((v) => ({ name: v.name, categoryName: v.categoryId ? (catById.get(v.categoryId)?.name ?? null) : null, categoryKind: v.categoryId ? (catById.get(v.categoryId)?.kind ?? null) : null })),
    categories: categories.map((c) => ({ name: c.name, kind: c.kind })),
    receipts: new Map(receipts.map((r) => [r.id, { kind: r.kind, payer: r.payer }])),
    invoices: new Map(invoices.map((i) => [i.id, { supplier: i.supplier }])),
    expenses: new Map(expenses.map((e) => [e.id, { categoryName: e.categoryId ? (catById.get(e.categoryId)?.name ?? null) : null, categoryKind: e.categoryId ? (catById.get(e.categoryId)?.kind ?? null) : null }])),
  };
  const lines = rows.map((r) => classifyBankLine({ id: r.id, on: r.on, description: r.description, amountCents: r.amountCents, placedAs: r.placedAs, why: r.why, receiptId: r.receiptId, expenseId: r.expenseId, invoiceId: r.invoiceId }, ctx));
  const g = gatherCashAccount(lines);

  /* Receipts of the month no bank line confirms: shown beside the account, never inside it. */
  const unconfirmed = await db.all<{ kind: string; src: string | null; n: number; cents: number }>(sql`
    select kind, substr(coalesce(source_key, ''), 1, 14) src, count(*) n, sum(amount_cents) cents from cash_receipts r
    where month = ${month} and id not in (select receipt_id from bank_lines where receipt_id is not null) and id not in (select receipt_id from bank_line_receipts)
    group by kind, substr(coalesce(source_key, ''), 1, 14) order by abs(sum(amount_cents)) desc`);
  const byLabel = new Map<string, { cents: number; n: number }>();
  for (const u of unconfirmed) {
    const label = /rxrescue|memo|credit/i.test(u.src ?? "") ? "Credit memos, never cash" : /register/i.test(u.src ?? "") ? "Register days not yet deposited" : u.kind === "third_party" ? "Payer notices not yet at the bank" : `${u.kind} receipts not yet at the bank`;
    const e = byLabel.get(label) ?? { cents: 0, n: 0 };
    e.cents += u.cents;
    e.n += u.n;
    byLabel.set(label, e);
  }
  const unconfirmedReceipts: PLLine[] = [...byLabel.entries()].map(([label, v]) => ({ label, amountCents: v.cents, note: `${v.n} receipt${v.n === 1 ? "" : "s"}` }));

  return { month, lines, inCents: g.inCents, outCents: g.outCents, changeCents: g.changeCents, unconfirmedReceipts };
}

/**
 * The feed-built cash account for a month, replaced by the bank's where a statement has been read.
 *
 * Everything the month knows that the bank cannot — the scripts count, the stock movement, the reconciliation checks —
 * comes from the feed-built account; the money comes from the bank. The identity the books check still holds:
 * revenue − offsets − cost of goods − operating = net, and net − what is not a cost = the bank's own movement.
 */
export async function cashOnTheBank(month: string, feedBuilt: MonthlyPL): Promise<MonthlyPL | null> {
  const on = await cashOnBankFor(month);
  if (!on) return null;
  const g = gatherCashAccount(on.lines);
  const sum = (ls: PLLine[]) => ls.reduce((n, l) => n + l.amountCents, 0);
  const revenueCents = sum(g.revenue);
  const offsetsCents = sum(g.offsets);
  const netRevenueCents = revenueCents - offsetsCents;
  const costOfGoodsCents = sum(g.costOfGoods);
  const grossProfitCents = netRevenueCents - costOfGoodsCents;
  const operatingCents = sum(g.operating);
  const netProfitCents = grossProfitCents - operatingCents;
  /* What left the bank and is not a cost, and what nobody has named yet: both under the one heading the books already print. */
  const otherCashOut: PLLine[] = [...g.flows, ...g.unnamed.map((l) => ({ ...l, label: `${l.label} — name it on the bank page` }))];
  const otherCashOutCents = sum(otherCashOut);
  const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const unnamedCents = sum(g.unnamed);
  const caveats = [
    `Built from the bank's ${on.lines.length} lines for ${month}: in ${money(on.inCents)}, out ${money(on.outCents)}, so the cash account moves ${on.changeCents < 0 ? "−" : "+"}${money(on.changeCents)}, exactly as the bank did.`,
    ...(g.unnamed.length ? [`${g.unnamed.reduce((n, l) => n + Number((l.note ?? "0").split(" ")[0]), 0)} line${g.unnamed.length === 1 && g.unnamed[0].note?.startsWith("1 ") ? "" : "s"} nobody has named yet, ${money(unnamedCents)} ${unnamedCents >= 0 ? "out" : "in"}, are inside the account under "Not yet named" until you name them on the bank page.`] : []),
    ...(on.unconfirmedReceipts.length ? [`Beside the account, not in it: ${on.unconfirmedReceipts.map((u) => `${u.label.toLowerCase()} ${money(u.amountCents)}`).join("; ")}.`] : []),
    ...feedBuilt.caveats.filter((c) => /standing cost|is on file at/.test(c)),
  ];
  return {
    ...feedBuilt,
    revenue: g.revenue,
    revenueCents,
    offsets: g.offsets,
    netRevenueCents,
    costOfGoods: g.costOfGoods,
    costOfGoodsCents,
    grossProfitCents,
    grossMarginPercent: netRevenueCents > 0 ? Math.round((grossProfitCents / netRevenueCents) * 1000) / 10 : null,
    operating: g.operating,
    operatingCents,
    netProfitCents,
    otherCashOut,
    otherCashOutCents,
    cashChangeCents: on.changeCents,
    missing: [],
    usable: true,
    caveats,
    onBank: { lines: on.lines.length, inCents: on.inCents, outCents: on.outCents, changeCents: on.changeCents, unnamed: g.unnamed, unnamedCents, unconfirmedReceipts: on.unconfirmedReceipts },
  };
}
