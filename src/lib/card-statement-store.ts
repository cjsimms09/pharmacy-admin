import "server-only";
import { and, eq, gte, like, lte, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { isOutOfBooks } from "./books-start";
import { shiftDays } from "./deposit-gate";
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
 * statement month (accrual) and paid on the auto-debit date the statement prints (cash). Confirmed, not a
 * draft: unlike a vendor PDF read for a total, every figure here has been checked against the statement's
 * own other figures before it gets this far. Filed under `GP-<merchant>-<period end>`, so a statement
 * forwarded twice books once. When the bank statement is read, its Heartland debit finds this bill by
 * amount and moves the paid date to the day the money actually left — see `placeLine`.
 *
 * ── The deposits ──
 *
 * Never booked. They are the card batch reports' money, already banked as counter takings. Each is
 * looked for among those receipts — same batch date, same amount — and the ones with no batch report on
 * file are named, because the statement is the only independent count of the batches.
 *
 * A statement for a month before the site's books start is kept as a document and books nothing, by the
 * same received-date rule as every other feed (`isOutOfBooks`).
 */
export async function bookCardStatement(
  input: { text: string; documentId: string | null },
  by: { userName: string },
): Promise<{ says: string; booked: boolean; refused: boolean }> {
  const read = readCardStatement(input.text);
  if (!read.ok) return { says: read.why, booked: false, refused: true };
  const s = read.statement;

  if (isOutOfBooks(s.periodTo)) {
    const says = `${s.says} This month is before the site's books start, so the statement is kept as a document and nothing is booked from it.`;
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
  const vendor = (await vendors(true)).find((v) => /global payments|heartland/i.test(v.name));
  /*
   * No sender address on the vendor, on purpose. The statement and the daily card batch reports are
   * both forwarded by the same member of staff, and a vendor claiming that address would turn every
   * batch report into a draft bill before its own reader saw it.
   */
  const vendorId = vendor?.id ?? (await saveVendor({ name: "Global Payments (Heartland)", categoryId: category?.id ?? null, cadence: "monthly", notes: "Card processor. Its monthly statement is read automatically; no sender address, see card-statement-store.ts." }));

  await saveExpense({
    vendorId,
    categoryId: category?.id ?? null,
    invoiceNumber,
    invoiceDate: s.periodTo,
    paidOn: s.feeDebit.on,
    amountCents: s.totalFeesCents,
    description: `Card processing fees, ${s.periodFrom} to ${s.periodTo}`,
    notes:
      `${s.feeSections.map((f) => `${f.name} ${money(f.cents)}`).join("; ")}. ` +
      `${money(s.passThroughCents)} passed through from the card networks, ${money(s.processorCents)} charged by Global Payments. ` +
      `On ${money(s.totalDepositsCents)} of deposits${s.transactions ? ` from ${s.transactions.toLocaleString("en-US")} transactions` : ""}. Paid date is the auto-debit the statement prints until the bank statement confirms it.`,
    documentId: input.documentId,
    status: "confirmed",
    source: "email",
    createdBy: by.userName,
  });
  const says = `${s.says} Booked as bill ${invoiceNumber} under card processing fees. ${batches}`;
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
  const extra = receipts.length - used.size;
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
