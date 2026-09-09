import "server-only";
import { db, schema } from "@/db";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { newId } from "./crypto";
import { SEED_CATEGORIES } from "./expense-categories";
import { todayIso } from "./dates";

/**
 * The bills, the people who send them, and the rules that file them next time.
 *
 * Kept apart from supplier invoices on purpose: a drug purchase has NDCs, quantities, rebate flags
 * and a returns clock, and a bill from Stamps.com has a date and an amount. One shape forced onto
 * both would wreck the half that already works.
 */

export type Category = typeof schema.expenseCategories.$inferSelect;
export type Vendor = typeof schema.vendors.$inferSelect;
export type Expense = typeof schema.expenses.$inferSelect;

/**
 * Puts the standard chart of accounts in place, once.
 *
 * An empty chart gets filled badly — bills go into "other" for three months and the account that
 * comes out cannot answer where the money went. Seeded by name, so a category somebody has since
 * renamed is left alone rather than duplicated.
 */
export async function seedCategories(): Promise<{ added: number }> {
  const held = await db.query.expenseCategories.findMany({ columns: { name: true } });
  const have = new Set(held.map((c) => c.name.trim().toLowerCase()));
  const missing = SEED_CATEGORIES.filter((c) => !have.has(c.name.toLowerCase()));
  if (missing.length === 0) return { added: 0 };
  await db.insert(schema.expenseCategories).values(
    missing.map((c) => ({ id: newId(), name: c.name, kind: c.kind, sortOrder: c.sortOrder, notes: c.notes, builtIn: true })),
  );
  return { added: missing.length };
}

export async function categories(includeArchived = false): Promise<Category[]> {
  const rows = await db.query.expenseCategories.findMany({
    orderBy: [schema.expenseCategories.sortOrder, schema.expenseCategories.name],
  });
  return includeArchived ? rows : rows.filter((c) => !c.archivedAt);
}

export async function addCategory(input: { name: string; kind: Category["kind"]; notes?: string | null }): Promise<Category> {
  const name = input.name.trim();
  if (!name) throw new Error("A category needs a name.");
  const clash = (await categories(true)).find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) return clash;
  const id = newId();
  /* New categories sort after the seeded ones but before "Other", which stays last on purpose. */
  await db.insert(schema.expenseCategories).values({ id, name, kind: input.kind, sortOrder: 500, notes: input.notes ?? null });
  return (await db.query.expenseCategories.findFirst({ where: eq(schema.expenseCategories.id, id) }))!;
}

export async function vendors(includeArchived = false): Promise<Vendor[]> {
  const rows = await db.query.vendors.findMany({ orderBy: [schema.vendors.name] });
  return includeArchived ? rows : rows.filter((v) => !v.archivedAt);
}

export async function saveVendor(input: {
  id?: string | null;
  name: string;
  senderEmails?: string;
  categoryId?: string | null;
  cadence?: Vendor["cadence"];
  typicalCents?: number | null;
  notes?: string | null;
}): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error("A vendor needs a name.");
  const values = {
    name,
    senderEmails: (input.senderEmails ?? "").trim(),
    categoryId: input.categoryId || null,
    cadence: input.cadence ?? "irregular",
    typicalCents: input.typicalCents ?? null,
    notes: input.notes ?? null,
  };
  if (input.id) {
    await db.update(schema.vendors).set(values).where(eq(schema.vendors.id, input.id));
    return input.id;
  }
  const id = newId();
  await db.insert(schema.vendors).values({ id, ...values });
  return id;
}

/**
 * The vendor an email belongs to, by the address it came from.
 *
 * This is the whole rule mechanism, and it lives on the vendor because the thing a person wants to
 * say is "bills from Stamps.com are postage" — which is a fact about Stamps.com, not an entry in a
 * rules screen somebody has to go and find.
 */
export function vendorForSender(from: string, all: Vendor[]): Vendor | null {
  const addr = from.trim().toLowerCase();
  if (!addr) return null;
  for (const v of all) {
    const rules = v.senderEmails
      .split(/[,;\s]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    // A bare domain matches anybody at it; a full address matches only itself.
    if (rules.some((r) => (r.includes("@") ? addr.includes(r) : addr.endsWith(`@${r}`) || addr.includes(r)))) return v;
  }
  return null;
}

export async function saveExpense(input: {
  id?: string | null;
  vendorId?: string | null;
  categoryId?: string | null;
  invoiceNumber?: string | null;
  invoiceDate: string;
  paidOn?: string | null;
  amountCents: number;
  description?: string | null;
  notes?: string | null;
  documentId?: string | null;
  status?: Expense["status"];
  source?: Expense["source"];
  createdBy: string;
}): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate)) throw new Error("A bill needs the date it was invoiced.");
  if (!Number.isFinite(input.amountCents) || input.amountCents === 0) throw new Error("A bill needs an amount.");
  const values = {
    vendorId: input.vendorId || null,
    categoryId: input.categoryId || null,
    invoiceNumber: input.invoiceNumber?.trim() || null,
    invoiceDate: input.invoiceDate,
    paidOn: input.paidOn || null,
    amountCents: Math.round(input.amountCents),
    description: input.description?.trim() || null,
    notes: input.notes?.trim() || null,
    documentId: input.documentId || null,
    status: input.status ?? "confirmed",
    source: input.source ?? "manual",
  };
  if (input.id) {
    await db.update(schema.expenses).set(values).where(eq(schema.expenses.id, input.id));
    return input.id;
  }
  const id = newId();
  await db.insert(schema.expenses).values({ id, ...values, createdBy: input.createdBy });
  return id;
}

export async function setExpenseStatus(id: string, status: Expense["status"]): Promise<void> {
  await db.update(schema.expenses).set({ status }).where(eq(schema.expenses.id, id));
}

export async function expenseById(id: string): Promise<Expense | null> {
  return (await db.query.expenses.findFirst({ where: eq(schema.expenses.id, id) })) ?? null;
}

/**
 * A bill is voided, never deleted.
 *
 * The row stays, marked, so a bill read off an email and voided by mistake can be found again and
 * the audit trail says what was recorded and by whom. A voided bill counts on no month and no
 * total; the screens simply stop showing it.
 */
export async function voidExpense(id: string): Promise<void> {
  await setExpenseStatus(id, "void");
}

/** Bills in a month, by whichever date the basis asks for. */
export async function expensesIn(month: string, basis: "accrual" | "cash" = "accrual"): Promise<Expense[]> {
  const from = `${month}-01`;
  const to = `${month}-31`;
  const col = basis === "cash" ? schema.expenses.paidOn : schema.expenses.invoiceDate;
  return db.query.expenses.findMany({
    where: and(gte(col, from), lte(col, to), eq(schema.expenses.status, "confirmed")),
    orderBy: [desc(schema.expenses.invoiceDate)],
  });
}

/** Everything recent, for the screen. Drafts first, because they are the ones needing a person. */
export async function recentExpenses(limit = 200): Promise<Expense[]> {
  const rows = (await db.query.expenses.findMany({ orderBy: [desc(schema.expenses.invoiceDate)], limit })).filter((r) => r.status !== "void");
  return [...rows.filter((r) => r.status === "draft"), ...rows.filter((r) => r.status !== "draft")];
}

/** Bills owed: incurred and not yet paid. Real money, and easy to lose track of. */
export async function unpaid(): Promise<Expense[]> {
  return db.query.expenses.findMany({
    where: and(isNull(schema.expenses.paidOn), eq(schema.expenses.status, "confirmed")),
    orderBy: [schema.expenses.invoiceDate],
  });
}

/**
 * Vendors that bill on a cycle and have not billed in it.
 *
 * A missing invoice does not announce itself: the month simply looks cheaper than it was, and the
 * profit figure is wrong in the flattering direction — which is the direction nobody questions.
 */
export async function missingThisMonth(month = todayIso().slice(0, 7)): Promise<{ vendor: Vendor; lastSeen: string | null }[]> {
  const [all, allBills] = await Promise.all([vendors(), db.query.expenses.findMany({ columns: { vendorId: true, invoiceDate: true, status: true } })]);
  const bills = allBills.filter((b) => b.status !== "void");
  const out: { vendor: Vendor; lastSeen: string | null }[] = [];
  for (const v of all) {
    if (v.cadence !== "monthly") continue;
    const mine = bills.filter((b) => b.vendorId === v.id).map((b) => b.invoiceDate).sort();
    if (mine.some((d) => d.startsWith(month))) continue;
    out.push({ vendor: v, lastSeen: mine[mine.length - 1] ?? null });
  }
  return out;
}

/** Money banked in a month, entered by hand from the remittance statements. */
export async function cashReceiptsIn(month: string) {
  return db.query.cashReceipts.findMany({ where: eq(schema.cashReceipts.month, month) });
}

/**
 * Banks money once, however many feeds see it.
 *
 * The owner, 9 September: "we need to make sure we are using this data to make our money tracking
 * even more correct but also make sure we arent duplicating things!" He was right to ask, and this
 * function was the hole. It inserted whatever it was given, so re-reading a remittance banked it a
 * second time, and — worse, because nobody would think to look — the same deposit arriving through
 * two feeds was banked twice on purpose.
 *
 * Three of them see the same money. The payer payment report lists every deposit by its payment
 * number. An 835 for one of those deposits carries the same money with the trace number on it. A
 * copay-voucher statement settles a slice of it again. Left alone they would have added to about
 * two hundred thousand dollars of September income that the bank never saw.
 *
 * Two gates, in order.
 *
 * `sourceKey` is exact: the same statement read twice is the same money, and the column is unique
 * so the database enforces it even if this function is bypassed.
 *
 * The second is the one that matters across feeds. A deposit of the same amount, on the same day,
 * from a payer whose name starts the same way, banked by a *different* feed, is the same deposit.
 * That is deliberately narrow — same cent, same day — because two real deposits matching all three
 * is rare and being wrong in that direction only understates income, which somebody notices, while
 * being wrong the other way inflates it, which nobody does.
 */
export async function addCashReceipt(input: {
  month: string;
  kind: typeof schema.cashReceipts.$inferInsert.kind;
  amountCents: number;
  payer?: string | null;
  notes?: string | null;
  /** The document it was read out of, so a deposit banked from a misread file can be found again. */
  documentId?: string | null;
  createdBy: string;
  /** Stable identity for the thing that was read — "835|payer|trace|date". Never banked twice. */
  sourceKey?: string | null;
  /** The day the money landed, which is what the cross-feed check compares. */
  receivedOn?: string | null;
  reference?: string | null;
  documentId?: string | null;
}): Promise<{ id: string | null; duplicate: false } | { id: null; duplicate: true; why: string }> {
  const amountCents = Math.round(input.amountCents);
  if (input.sourceKey) {
    const same = await db.query.cashReceipts.findFirst({ where: eq(schema.cashReceipts.sourceKey, input.sourceKey) });
    if (same) return { id: null, duplicate: true, why: `already banked from ${same.createdBy} on ${same.month}` };
  }
  /*
   * The cross-feed gate applies to feeds and not to people.
   *
   * A `sourceKey` is what an automatic reader supplies, so its presence is how this tells the two
   * apart. Money typed in from a bank statement is trusted outright: the bank is the record, and if
   * it shows two deposits of the same amount on the same day then there were two, and refusing the
   * second would be this function overruling the statement it exists to agree with.
   */
  if (input.sourceKey && input.receivedOn) {
    const sameDay = await db.query.cashReceipts.findMany({ where: eq(schema.cashReceipts.receivedOn, input.receivedOn) });
    const head = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
    const clash = sameDay.find((r) => r.amountCents === amountCents && (!input.payer || !r.payer || head(r.payer) === head(input.payer)));
    if (clash) {
      return {
        id: null,
        duplicate: true,
        why: `${(amountCents / 100).toFixed(2)} from ${input.payer ?? "a payer"} on ${input.receivedOn} is already banked${clash.reference ? ` as ${clash.reference}` : ""}`,
      };
    }
  }
  const id = newId();
  await db.insert(schema.cashReceipts).values({
    id,
    month: input.month,
    kind: input.kind,
    amountCents,
    payer: input.payer ?? null,
    notes: input.notes ?? null,
    documentId: input.documentId ?? null,
    createdBy: input.createdBy,
    sourceKey: input.sourceKey ?? null,
    receivedOn: input.receivedOn ?? null,
    reference: input.reference ?? null,
    documentId: input.documentId ?? null,
  });
  return { id, duplicate: false };
}

/** A receipt entered by mistake is removed; the bank statement is the record, not this row. */
export async function deleteCashReceipt(id: string): Promise<void> {
  await db.delete(schema.cashReceipts).where(eq(schema.cashReceipts.id, id));
}

/** What was banked across a run of months, newest first, for the books page. */
export async function cashReceiptsFor(months: string[]) {
  const rows = await db.query.cashReceipts.findMany({ orderBy: [desc(schema.cashReceipts.month), desc(schema.cashReceipts.createdAt)] });
  const set = new Set(months);
  return rows.filter((r) => set.has(r.month));
}
