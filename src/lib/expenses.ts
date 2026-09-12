import { DEPOSIT_WINDOW_DAYS, gateDeposit, shiftDays } from "./deposit-gate";
import { isOutOfBooks, monthIsOutOfBooks } from "./books-start";
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
  // In-books cash only: this is what the month's books are built from.
  return db.query.cashReceipts.findMany({
    where: and(eq(schema.cashReceipts.month, month), eq(schema.cashReceipts.outOfBooks, false)),
  });
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
}): Promise<{ id: string | null; duplicate: false } | { id: null; duplicate: true; why: string }> {
  const amountCents = Math.round(input.amountCents);
  /*
   * The rule is in `deposit-gate.ts`, pure and tested; this part is only the lookup.
   *
   * Everything inside the window, plus anything already carrying this source key, because a
   * re-read of the same file can be any age at all. Loading less than the gate needs is how a
   * duplicate gets through, so the query is deliberately wider than the comparison.
   */
  const near = input.receivedOn
    ? await db.query.cashReceipts.findMany({
        where: and(
          gte(schema.cashReceipts.receivedOn, shiftDays(input.receivedOn, -DEPOSIT_WINDOW_DAYS)),
          lte(schema.cashReceipts.receivedOn, shiftDays(input.receivedOn, DEPOSIT_WINDOW_DAYS)),
        ),
      })
    : [];
  const sameKey = input.sourceKey ? await db.query.cashReceipts.findMany({ where: eq(schema.cashReceipts.sourceKey, input.sourceKey) }) : [];
  const verdict = gateDeposit([...sameKey, ...near], { ...input, amountCents });
  if (!verdict.bank) return { id: null, duplicate: true, why: verdict.why };

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
    /*
     * Cash that arrived before the books begin is kept as a row and never counted in a total.
     *
     * The owner pulls a real payment report for an old month to test that payments match claims:
     * "these are test only and should not show up on any AR reports or anything." The received
     * date decides it where one is known; where it is not, the month the receipt was filed under
     * does, which is the case for anything carrying only "YYYY-MM".
     */
    outOfBooks: input.receivedOn ? isOutOfBooks(input.receivedOn) : monthIsOutOfBooks(input.month),
  });
  return { id, duplicate: false };
}

/** A receipt entered by mistake is removed; the bank statement is the record, not this row. */
export async function deleteCashReceipt(id: string): Promise<void> {
  await db.delete(schema.cashReceipts).where(eq(schema.cashReceipts.id, id));
}

/** What was banked across a run of months, newest first, for the books page. */
export async function cashReceiptsFor(months: string[]) {
  /*
   * In-books cash only. This is the list on the money page, and a payment report pulled for an
   * old month to test matching is not money this pharmacy is accounting for.
   */
  const rows = await db.query.cashReceipts.findMany({
    where: eq(schema.cashReceipts.outOfBooks, false),
    orderBy: [desc(schema.cashReceipts.month), desc(schema.cashReceipts.createdAt)],
  });
  const set = new Set(months);
  return rows.filter((r) => set.has(r.month));
}

/**
 * Changes a receipt already banked under a known source key.
 *
 * `addCashReceipt` refuses a second receipt for the same key, which is what stops one remittance
 * being banked twice when a file is re-read. That rule has one exception: a wholesaler's corrected
 * rebate statement is not a re-read of the first one — the money that arrived was a different
 * amount, and the receipt has to carry the amount that arrived rather than the one first stated.
 *
 * Only the figure and the note. The key, the month and the kind are the receipt's identity and are
 * not changed here; a correction that moved the money to a different month would be a different
 * receipt, and this is deliberately unable to make that mistake quietly.
 */
export async function updateCashReceipt(sourceKey: string, change: { amountCents: number; notes?: string | null }): Promise<boolean> {
  const held = await db.query.cashReceipts.findFirst({ where: eq(schema.cashReceipts.sourceKey, sourceKey) });
  if (!held) return false;
  await db
    .update(schema.cashReceipts)
    .set({ amountCents: change.amountCents, notes: change.notes ?? held.notes })
    .where(eq(schema.cashReceipts.id, held.id));
  return true;
}

/**
 * Books a postage purchase read out of a confirmation email.
 *
 * The owner: "will get email on mail postage charges" — and they do, with nothing attached, so the
 * mail sweep dropped them. See `postage-email.ts` for the reading; this is the booking.
 *
 * Entered against the vendor's own category where the vendor is on file, and against Postage and
 * shipping otherwise, so a new postage account books correctly before anybody has set it up.
 *
 * Both bases get it on the day the card was charged. On the cash basis that is plainly right — the
 * money left. On the accrual basis it is a simplification worth stating: buying postage tops up a
 * prepaid balance, and strictly the expense falls when the postage is used. Nothing records postage
 * used, so the purchase stands as the expense, which recognises the cost sooner rather than later.
 * The note on every one says so, so an accountant sees the choice rather than inferring it.
 *
 * Keyed on the vendor's own order number, so a message re-read, or arriving twice, books once.
 */
export async function bookPostage(
  p: import("./postage-email").PostagePurchase,
  sourceMessageId: string | null,
): Promise<{ id: string | null; duplicate: boolean; says: string }> {
  const { postageKey } = await import("./postage-email");
  const key = postageKey(p);

  const already = await db.query.expenses.findFirst({ where: eq(schema.expenses.invoiceNumber, key) });
  if (already) {
    return { id: already.id, duplicate: true, says: `${p.says} — already on the books, nothing added.` };
  }

  const vendor = await db.query.vendors.findFirst({ where: eq(schema.vendors.name, p.vendor) });
  const category =
    (vendor?.categoryId ? await db.query.expenseCategories.findFirst({ where: eq(schema.expenseCategories.id, vendor.categoryId) }) : null) ??
    (await db.query.expenseCategories.findFirst({ where: eq(schema.expenseCategories.name, "Postage and shipping") }));
  if (!category) return { id: null, duplicate: false, says: `${p.says} — no Postage and shipping category exists, so it could not be booked.` };

  const id = newId();
  await db.insert(schema.expenses).values({
    id,
    categoryId: category.id,
    vendorId: vendor?.id ?? null,
    invoiceNumber: key,
    invoiceDate: p.purchasedOn,
    /* The card was charged on the day of the confirmation, so the cash account places it there too. */
    paidOn: p.purchasedOn,
    amountCents: p.amountCents,
    description: p.says,
    notes:
      `Read from ${p.vendor}'s purchase confirmation, which carries no attachment. ` +
      (p.surchargeCents ? `Includes a ${(p.surchargeCents / 100).toFixed(2)} card surcharge. ` : "") +
      `Postage bought is a prepaid balance; nothing here records postage used, so the purchase is ` +
      `booked as the expense on the day the card was charged.` +
      (sourceMessageId ? ` Message ${sourceMessageId}.` : ""),
    source: "email",
    /* The vendor stating their own charge, not a reading of a scan, so it stands as confirmed. */
    status: "confirmed",
    createdBy: "the mail sweep",
  });
  return { id, duplicate: false, says: `${p.says} — booked to ${category.name}.` };
}
