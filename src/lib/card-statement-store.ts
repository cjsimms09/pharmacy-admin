import "server-only";
import { and, eq, gte, like, lte, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { isOutOfBooks } from "./books-start";
import { shiftDays } from "./deposit-gate";
import { readBankDescriptor } from "./bank-descriptors";
import { cardStatementBillNumber, readCardStatement, type CardStatement } from "./card-statement";
import { categories, saveExpense, seedCategories, vendors, saveVendor } from "./expenses";

/**
 * Books the monthly card processing statement: its fees as a bill, and its deposits checked against the batches.
 *
 * The reading is `card-statement.ts`; this is the side that touches the database.
 *
 * ── The fees ──
 *
 * One bill in "Card processing and bank fees", vendor Global Payments, dated the last day of the
 * statement month (accrual), and unpaid until the bank's fee debit dates it (cash) — the month after, since the
 * fees are taken then, not on the date the statement prints. Confirmed, not a
 * draft: unlike a vendor PDF read for a total, every figure here has been checked against the statement's
 * own other figures before it gets this far. Filed under `GP-<merchant>-<period end>`, so a statement
 * forwarded twice books once. Its Heartland debit marks it paid, whichever arrives first: a bank statement read
 * later finds the bill (`placeLine`), and a debit already read is found when the statement is booked.
 *
 * ── The deposits ──
 *
 * Never booked. They are the card batch reports' money, already banked as counter takings. Each is
 * looked for among those receipts — same batch date, same amount — and the ones with no batch report on
 * file are named, because the statement is the only independent count of the batches.
 *
 * A statement whose fees leave the bank before the site's books start is kept as a document and books nothing
 * (`isOutOfBooks` on the month after it). August's fees leave in September, so August's statement is booked.
 */
export async function bookCardStatement(
  input: { text: string; documentId: string | null },
  by: { userName: string },
): Promise<{ says: string; booked: boolean; refused: boolean }> {
  const read = readCardStatement(input.text);
  if (!read.ok) return { says: read.why, booked: false, refused: true };
  const s = read.statement;

  /*
   * The fees leave the bank the month after the statement: July's $5,183.71 on 3 August (Session 2, money map
   * G-CSTMT-4). So a statement is booked wherever its debit can fall inside the books — August's is, since its
   * money leaves in September — and kept as a document only where even the month after is before them.
   */
  const monthAfter = (() => {
    const d = new Date(Date.parse(`${s.periodTo}T00:00:00Z`));
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();
  if (isOutOfBooks(monthAfter)) {
    const says = `${s.says} Its fees leave the bank before the site's books start, so the statement is kept as a document and nothing is booked from it.`;
    await audit({ action: "expense.card_statement_read", userName: by.userName, entity: "document", entityId: input.documentId ?? undefined, details: says });
    return { says, booked: false, refused: false };
  }

  const invoiceNumber = cardStatementBillNumber(s);
  const held = await db.query.expenses.findFirst({
    where: and(eq(schema.expenses.invoiceNumber, invoiceNumber), ne(schema.expenses.status, "void")),
    columns: { id: true, amountCents: true },
  });
  const batches = await checkBatches(s);
  if (held) {
    const differs = held.amountCents !== s.totalFeesCents ? ` The bill on file is for ${money(held.amountCents)}, not ${money(s.totalFeesCents)} — look at both before changing either.` : "";
    const says = `${s.says} Already on file as bill ${invoiceNumber}, so not booked again.${differs} ${batches}`;
    await audit({ action: "expense.card_statement_read", userName: by.userName, entity: "document", entityId: input.documentId ?? undefined, details: says });
    return { says, booked: false, refused: false };
  }

  await seedCategories();
  const category = (await categories(true)).find((c) => c.name === "Card processing and bank fees");
  /*
   * Fees somebody already typed on Spending for this month. Booking the statement beside them counted $4,778.73
   * twice on a snapshot (G-CSTMT-1). The same amount in the category, dated from the statement month to six weeks
   * after it, is taken as those fees and the statement books nothing, saying so.
   */
  const until = shiftDays(s.periodTo, 45);
  const typed = category
    ? (await db.query.expenses.findMany({ where: and(eq(schema.expenses.categoryId, category.id), ne(schema.expenses.status, "void"), eq(schema.expenses.amountCents, s.totalFeesCents)) })).filter(
        (e) => !(e.invoiceNumber ?? "").startsWith("GP-") && ((e.invoiceDate >= s.periodFrom && e.invoiceDate <= until) || (e.paidOn !== null && e.paidOn >= s.periodFrom && e.paidOn <= until)),
      )
    : [];
  if (typed.length > 0) {
    const says = `${s.says} A card processing bill for exactly ${money(s.totalFeesCents)} is already on Spending (${typed[0].invoiceDate}), so the statement booked nothing beside it. If that bill is something else, void it and forward the statement again. ${batches}`;
    await audit({ action: "expense.card_statement_read", userName: by.userName, entity: "document", entityId: input.documentId ?? undefined, details: says });
    return { says, booked: false, refused: false };
  }
  const vendor = (await vendors(true)).find((v) => /global payments|heartland/i.test(v.name));
  /*
   * No sender address on the vendor, on purpose. The statement and the daily card batch reports are
   * both forwarded by the same member of staff, and a vendor claiming that address would turn every
   * batch report into a draft bill before its own reader saw it.
   */
  const vendorId = vendor?.id ?? (await saveVendor({ name: "Global Payments (Heartland)", categoryId: category?.id ?? null, cadence: "monthly", notes: "Card processor. Its monthly statement is read automatically; no sender address, see card-statement-store.ts." }));

  const expenseId = await saveExpense({
    vendorId,
    categoryId: category?.id ?? null,
    invoiceNumber,
    invoiceDate: s.periodTo,
    /* Unpaid: the bank's fee debit dates it, the month after (G-CSTMT-3). The date the statement prints is not the debit. */
    paidOn: null,
    amountCents: s.totalFeesCents,
    description: `Card processing fees, ${s.periodFrom} to ${s.periodTo}`,
    notes:
      `${s.feeSections.map((f) => `${f.name} ${money(f.cents)}`).join("; ")}. ` +
      `${money(s.passThroughCents)} passed through from the card networks, ${money(s.processorCents)} charged by Global Payments. ` +
      `On ${money(s.totalDepositsCents)} of deposits${s.transactions ? ` from ${s.transactions.toLocaleString("en-US")} transactions` : ""}. Taken by auto-debit the month after; the bank statement's debit marks it paid.`,
    documentId: input.documentId,
    status: "confirmed",
    source: "email",
    createdBy: by.userName,
  });
  /*
   * A bank statement read before this one arrived left the fee debit unplaced, and nothing re-reads a bank line.
   * So the debit is looked for here: exactly the fees, a Heartland debit, within six weeks after the month.
   */
  let linked = "";
  const waiting = (await db.query.bankLines.findMany({ where: and(eq(schema.bankLines.placedAs, "unplaced"), eq(schema.bankLines.amountCents, -s.totalFeesCents), gte(schema.bankLines.on, s.periodTo), lte(schema.bankLines.on, until)) })).filter(
    (l) => readBankDescriptor(l.description, l.amountCents).kind === "card_fees",
  );
  if (waiting.length === 1) {
    await db.update(schema.expenses).set({ paidOn: waiting[0].on }).where(eq(schema.expenses.id, expenseId));
    await db.update(schema.bankLines).set({ placedAs: "pays_bill", expenseId, why: `the card processing fees on the ${s.periodTo.slice(0, 7)} statement, exactly this amount` }).where(eq(schema.bankLines.id, waiting[0].id));
    linked = ` The bank's fee debit of ${waiting[0].on} was already on file and now marks it paid.`;
  }
  const says = `${s.says} Booked as bill ${invoiceNumber} under card processing fees, unpaid until the bank's fee debit.${linked} ${batches}`;
  await audit({ action: "expense.card_statement_read", userName: by.userName, entity: "document", entityId: input.documentId ?? undefined, details: says });
  return { says, booked: true, refused: false };
}

/** The statement's batches against the card batch reports on file. Said, never booked. */
async function checkBatches(s: CardStatement): Promise<string> {
  const inBooks = s.deposits.filter((d) => !isOutOfBooks(d.batchDate));
  if (inBooks.length === 0) return "None of its batches fall inside the site's books, so none were looked for.";
  const days = inBooks.map((d) => d.batchDate).sort();
  /*
   * By batch date and exact amount. Not by number: the email's Batch ID (779536378) and the statement's
   * sequence number (000177) are different series. A day either way is allowed, same day preferred,
   * because a batch closed near midnight could be dated differently by the two — unmeasured until a
   * statement covering batches already on file arrives, which is the October one.
   */
  const receipts = await db.query.cashReceipts.findMany({
    where: and(like(schema.cashReceipts.sourceKey, "card-batch|%"), gte(schema.cashReceipts.receivedOn, shiftDays(days[0], -1)), lte(schema.cashReceipts.receivedOn, shiftDays(days[days.length - 1], 1))),
    columns: { id: true, receivedOn: true, amountCents: true },
  });
  const used = new Set<string>();
  const missing: CardStatement["deposits"] = [];
  for (const d of inBooks) {
    const near = [d.batchDate, shiftDays(d.batchDate, -1), shiftDays(d.batchDate, 1)];
    const hit = near.map((on) => receipts.find((r) => !used.has(r.id) && r.receivedOn === on && r.amountCents === d.amountCents)).find(Boolean);
    if (hit) used.add(hit.id);
    else missing.push(d);
  }
  /* Only inside the statement's own batch dates: the day either side belongs to the neighbouring statements (G-CSTMT-2). */
  const extra = receipts.filter((r) => !used.has(r.id) && r.receivedOn !== null && r.receivedOn >= days[0] && r.receivedOn <= days[days.length - 1]).length;
  const parts = [`${inBooks.length - missing.length} of its ${inBooks.length} batches match a card batch report on file.`];
  if (missing.length) {
    parts.push(
      `No batch report for ${missing.map((d) => `${d.batchDate} (batch ${d.sequence}, ${money(d.amountCents)})`).join(", ")} — ${money(missing.reduce((n, d) => n + d.amountCents, 0))} of card takings the cash account does not have. Forward those batch reports to the inbox.`,
    );
  }
  if (extra > 0) parts.push(`${extra} batch report${extra === 1 ? "" : "s"} on file for these dates match${extra === 1 ? "es" : ""} no deposit on the statement.`);
  return parts.join(" ");
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
