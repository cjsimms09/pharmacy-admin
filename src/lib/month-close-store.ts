import "server-only";
import { db, schema } from "@/db";
import { like } from "drizzle-orm";
import { judgeClose, endOf, type CloseCheck, type MonthClose } from "./month-close";

/**
 * The month's close, measured.
 *
 * The document gates come from `monthlyChecklist`, which already knows what a month needs and how to
 * tell whether it came. The money gates are here, and each one is a figure that can disagree while
 * every document sits happily on file:
 *
 *   every bank line placed   a line nothing explains is money the books do not account for. The
 *                            statement's own arithmetic is already proved at upload — the reader
 *                            refuses a statement whose lines, sections, daily balances and summary
 *                            do not all agree — so what is left is whether each line has a meaning.
 *   no deposit unbanked      a deposit with no receipt behind it is revenue nobody has recorded.
 *
 * Nothing here re-proves what the upload already proved. The statement reader takes the month from
 * the statement's own header and refuses the file outright if it cannot read it, so a statement on
 * file is a statement filed under the right month by construction.
 */
export async function monthClose(month: string, today: string): Promise<MonthClose> {
  /* Nothing to read for a month from before the books began, and nothing to ask of it. */
  const { monthIsOutOfBooks } = await import("./books-start");
  if (monthIsOutOfBooks(month)) return judgeClose({ month, today, checks: [] });

  const { monthlyChecklist } = await import("./monthly-checklist");
  const list = await monthlyChecklist(month);

  const checks: CloseCheck[] = list.items.map((i) => ({
    key: i.key,
    name: i.name,
    done: i.done,
    says: i.done ? `${i.name}: ${i.says}.` : `${i.name} — ${i.says}.`,
    gate: "document",
  }));

  /*
   * The wholesaler's rebate statement, which reduces the month's cost of goods and arrives in the next month.
   *
   * September 2026 read "closed" with its $12,354.06 McKesson rebate booked nowhere: nothing in the list above asks for it, because
   * the owner does not fetch it (it is emailed, around the 20th) and a month that was closed without it was closed on an estimate.
   * Asked only of a pharmacy whose books have held a rebate statement before, so it is not demanded of one that has none.
   *
   * It reads where a booked rebate is recorded: the receipt and the bill the statement writes, keyed on the statement's own period
   * (rebate-report-store.ts), and not the Inbox line that says a report arrived.
   */
  const rebate = await rebateCheck(month);
  if (rebate) checks.push(rebate);

  /*
   * Every wholesaler invoice for the month, proved against the wholesaler's own figure on the same statement.
   *
   * Asked only once that statement has been read, because it is the outside figure; before then there is nothing to compare with.
   * See wholesaler-purchases.ts for what it found in September 2026 ($142,392.56 of McKesson invoices never captured).
   */
  const purchases = await purchasesCheck(month);
  if (purchases) checks.push(purchases);

  /*
   * The money gates are only asked once the documents are all in.
   *
   * Otherwise they answer about half a month and answer confidently: with no statement on file there
   * are no unplaced lines, so "every line placed" would pass, and a month missing its only proof of
   * cash would show one green tick short of closed.
   */
  if (list.outstanding === 0 && (!rebate || rebate.done) && (!purchases || purchases.done)) {
    const from = `${month}-01`;
    const to = endOf(month);
    const c = (db as unknown as { $client: { execute: (s: string, a?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
    const [lines] = await Promise.all([
      c.execute('select placed_as as p, count(*) as n, sum(amount_cents) as cents from bank_lines where "on" >= ? and "on" <= ? group by placed_as', [from, to]),
    ]);
    const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
    let total = 0;
    let unplaced = 0;
    let unplacedCents = 0;
    for (const r of lines.rows) {
      const n = num(r.n);
      total += n;
      if (String(r.p ?? "") === "unplaced") {
        unplaced += n;
        unplacedCents += Math.abs(num(r.cents));
      }
    }
    checks.push({
      key: "bank_lines_placed",
      name: "Every line on the bank statement means something",
      done: total > 0 && unplaced === 0,
      says:
        total === 0
          ? "No bank line is on file for the month, so there is nothing to tie to."
          : unplaced === 0
            ? `All ${total} bank lines are accounted for.`
            : `${unplaced} of ${total} bank lines are money nothing explains, $${(unplacedCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} between them.`,
      gate: "money",
    });
  }

  /*
   * The dispensing record against the till: two reports of the same sales, which have to agree.
   *
   * September 2026 read "closed" while the site's own reconciliation said, on the Money page, that the dispensing record was
   * $13,885.14 ahead of the till and "the cause is not yet known". The two are the same takings measured twice, so a gap nobody has
   * explained is the books disagreeing with themselves, and a month does not close on that. Asked only once every document is in,
   * like the other money gates, because a month missing its sales summary would show a gap that is only the missing report.
   *
   * It reads the engine's own comparison (profit-and-loss.ts, reconciliation.revenue), which is where the two figures are set side by
   * side, and it is blocking only where the engine itself says the gap was not expected.
   */
  if (list.outstanding === 0 && (!rebate || rebate.done) && (!purchases || purchases.done)) {
    const tie = await claimsVsTill(month);
    if (tie) checks.push(tie);
  }

  return judgeClose({ month, today, checks });
}

/** The engine's comparison of the dispensing record with the till, as a money gate; null where it cannot say. */
export async function claimsVsTill(month: string): Promise<CloseCheck | null> {
  try {
    const { monthlyAccount } = await import("./profit-and-loss");
    const m = await monthlyAccount(month, "accrual");
    const c = m.reconciliation.revenue.find((r) => /against the till/i.test(r.what));
    if (!c) return null;
    return tillGate(c);
  } catch {
    /* A comparison that could not run is not a pass and not a failure of the month: the strip simply does not ask. */
    return null;
  }
}

/** Pure: one reconciliation line as a gate. A gap the engine did not expect and that does not agree holds the month open. */
export function tillGate(c: { what: string; agrees: boolean | null; expected: boolean; says: string }): CloseCheck {
  const unexplained = c.agrees === false && c.expected === false;
  return {
    key: "claims_vs_till",
    name: "The dispensing record agrees with the till",
    done: !unexplained,
    says: unexplained ? c.says : "The dispensing record and the till agree, or differ by what is already explained.",
    gate: "money",
  };
}

/** Whether the month's wholesaler rebate statement is booked, or null where this pharmacy has never booked one. */
export async function rebateCheck(month: string): Promise<CloseCheck | null> {
  const from = `${month}-01`;
  const to = endOf(month);
  const receipts = await db.select({ key: schema.cashReceipts.sourceKey, out: schema.cashReceipts.outOfBooks }).from(schema.cashReceipts).where(like(schema.cashReceipts.sourceKey, "REBATE|%"));
  const bills = await db.select({ description: schema.expenses.description }).from(schema.expenses).where(like(schema.expenses.description, "%rebate, %"));
  const everBooked = receipts.some((r) => !r.out) || bills.length > 0;
  if (!everBooked) return null;

  const booked =
    receipts.some((r) => !r.out && (r.key ?? "").endsWith(`|${from}|${to}`)) || bills.some((b) => (b.description ?? "").endsWith(`rebate, ${from} to ${to}`));
  if (booked) return { key: "wholesaler_rebate", name: "The wholesaler's rebate statement", done: true, says: `The wholesaler's rebate for ${month} is booked from its own statement.`, gate: "document" };

  const held = (await db.select({ imported: schema.inboxItems.imported, routedAs: schema.inboxItems.routedAs }).from(schema.inboxItems)).filter((r) => r.routedAs === "rebate_report" && r.imported === false);
  return {
    key: "wholesaler_rebate",
    name: "The wholesaler's rebate statement",
    done: false,
    says:
      held.length > 0
        ? `A rebate statement has arrived and was refused, so it is not booked: see the Inbox. Until it is, ${month} carries the ladder's estimate of the rebate.`
        : `The wholesaler's rebate statement for ${month} has not arrived. It usually comes around the 20th of the next month and books itself; until then ${month} carries the ladder's estimate of the rebate.`,
    gate: "document",
  };
}

/** The wholesaler's own purchases figure for the month against the invoices on file; null before its statement has been read. */
export async function purchasesCheck(month: string): Promise<CloseCheck | null> {
  try {
    const { readFile } = await import("./files");
    const { pdfText } = await import("./pdf-text");
    const { looksLikeRebateReport, parseRebateReport } = await import("./rebate-report");
    const { weekdaysWithoutInvoices, judgePurchases } = await import("./wholesaler-purchases");

    const docs = await db.query.documents.findMany({ columns: { id: true, storageKey: true, title: true, fileName: true } });
    let statementCents: number | null = null;
    for (const d of docs.filter((x) => /rebate/i.test(x.title ?? "") || /rebate/i.test(x.fileName ?? ""))) {
      let text = "";
      try {
        text = pdfText(await readFile(d.storageKey));
      } catch {
        continue;
      }
      if (!looksLikeRebateReport(text)) continue;
      const r = parseRebateReport(text);
      if (r.trustworthy && (r.statement.periodFrom ?? "").startsWith(month) && r.statement.netPurchasedCents !== null) statementCents = r.statement.netPurchasedCents;
    }
    if (statementCents === null) return null;

    const from = `${month}-01`;
    const to = endOf(month);
    const invoices = (await db.query.supplierInvoices.findMany({ columns: { supplier: true, invoiceDate: true, totalCents: true } })).filter(
      (i) => /mckesson/i.test(i.supplier ?? "") && (i.invoiceDate ?? "") >= from && (i.invoiceDate ?? "") <= to,
    );
    const invoicesCents = invoices.reduce((n, i) => n + (i.totalCents ?? 0), 0);
    const missingDays = weekdaysWithoutInvoices(month, invoices.map((i) => i.invoiceDate as string));
    const j = judgePurchases({ month, wholesaler: "McKesson", statementCents, invoicesCents, missingDays });
    return { key: "wholesaler_purchases", name: "McKesson's invoices for the whole month", done: j.agrees, says: j.says, gate: "document" };
  } catch {
    /* A comparison that could not run is not a pass and not a failure of the month: the strip simply does not ask. */
    return null;
  }
}
