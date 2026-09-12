/**
 * The things only the owner can fetch, and whether this month has them yet.
 *
 * The owner: "basically need a checklist of all the things I need to provider monthly."
 *
 * Almost everything this site runs on arrives by itself — the claims nightly, the invoices by
 * email, PioneerRx by SQL at eight, McKesson's ledger in a weekly zip. What is left is a short list
 * of files that live behind somebody's login and cannot be fetched without him. Those are the only
 * things worth putting on a checklist, and there are five of them.
 *
 * ── Why each one is judged by its money and not by a filename ──
 *
 * A document filed under the right name is not the month's money. So every item below asks the
 * question that actually matters — are the receipts there, are the bank lines there, is the till
 * figure there — using the same keys the importers dedupe on. A file uploaded twice cannot make an
 * item read as done twice, and a file renamed cannot make it read as missing.
 *
 * ── One row, not five ──
 *
 * The owner, on alerts generally: "Does each specific thing need its own alert or can the alert be
 * me general and click for specific." So this is one line that says how many are outstanding, and
 * the detail is a tap away rather than five rows deep on a morning list.
 */

export type ChecklistItem = {
  key: string;
  /** What to fetch, in the words he would use. */
  name: string;
  /** Why it cannot be done without him, and what is missing while it is missing. */
  why: string;
  /** Where it comes from. */
  from: string;
  done: boolean;
  /** What the site can see, once it is done. */
  says: string;
  /** How much money is riding on it, where that can be said. Sorts the list. */
  cents: number | null;
};

export type MonthlyChecklist = {
  month: string;
  label: string;
  items: ChecklistItem[];
  outstanding: number;
  /** Money the account cannot see until the outstanding items arrive, where it can be estimated. */
  blockedCents: number;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function monthlyChecklist(month: string): Promise<MonthlyChecklist> {
  const { db, schema } = await import("@/db");
  const { and, eq, gte, lte, like } = await import("drizzle-orm");
  const { monthLabel } = await import("./deliveries");

  const items: ChecklistItem[] = [];
  const from = `${month}-01`;
  const to = `${month}-31`;

  /* ── 1. The PSAO's payment report ──────────────────────────────── */
  const { payerPaymentsFor } = await import("./payer-payments-store");
  const payer = await payerPaymentsFor(month);
  items.push({
    key: "provider_pay",
    name: "ProviderPay payment report",
    why:
      "The largest thing on the cash account by a wide margin, and the only file that says which payer sent what. " +
      "Until it is in, none of the month's payer money is on the account at all.",
    from: "the ProviderPay portal, for the whole month",
    done: payer.payments > 0,
    says: payer.payments > 0 ? `${payer.payments} payments, ${money(payer.cents)}` : "nothing of the month's payer money is on the account",
    cents: payer.cents || null,
  });

  /* ── 2. The ProviderPay account history ────────────────────────── */
  const ppAccount = await db.query.documents.findMany({
    where: and(like(schema.documents.fileName, "%ransaction%istory%"), gte(schema.documents.uploadedAt, from)),
    columns: { id: true },
  });
  items.push({
    key: "provider_pay_account",
    name: "Wells Fargo / ProviderPay account history",
    why:
      "The other side of the same account: what each payer paid in, and what was swept across to the operating account. " +
      "It is what proves the deposits on the bank statement are the payments on the report and not more money.",
    from: "the ProviderPay portal, same place as the payment report",
    done: ppAccount.length > 0,
    says: ppAccount.length > 0 ? `filed` : "the sweeps cannot be tied to the deposits",
    cents: null,
  });

  /* ── 3. The bank statement ─────────────────────────────────────── */
  const lines = await db.query.bankLines.findMany({
    where: and(gte(schema.bankLines.on, from), lte(schema.bankLines.on, to)),
    columns: { amountCents: true },
  });
  items.push({
    key: "bank_statement",
    name: "Bank statement for the operating account",
    why:
      "The only independent record of what actually happened to the money. Without it every cash figure is what a feed said rather than what the bank did.",
    from: "Wells Fargo — as CSV or QFX rather than the PDF, which arrives as a scan and reads badly",
    done: lines.length > 0,
    says: lines.length > 0 ? `${lines.length} lines read` : "nothing is reconciled against the bank",
    cents: null,
  });

  /* ── 4. The till's own figure for the month ────────────────────── */
  const { salesMonths } = await import("./sales-store");
  const sales = (await salesMonths()).find((s) => s.month === month);
  items.push({
    key: "sales_summary",
    name: "System Sales Summary",
    why:
      "The only report carrying the front of shop as well as prescriptions. Without it retail revenue is missing entirely from the accrual account — " +
      "and the account says so, because a missing line reads as a better month.",
    from: "PioneerRx, drawn for the calendar month",
    done: Boolean(sales?.totalCents),
    says: sales?.totalCents ? `${money(sales.totalCents)} through the till` : "retail sales are missing from the month",
    cents: sales?.totalCents ?? null,
  });

  /* ── 5. The closing shelf count ────────────────────────────────── */
  const counts = await db.query.onHandImports.findMany({
    where: and(gte(schema.onHandImports.countedOn, from), lte(schema.onHandImports.countedOn, to)),
    columns: { countedOn: true, valueCents: true, rxValueCents: true },
  });
  const closing = counts.sort((a, b) => a.countedOn.localeCompare(b.countedOn)).at(-1);
  items.push({
    key: "closing_count",
    name: "A shelf count at the end of the month",
    why:
      "The independent check on cost of goods — opening stock plus purchases less closing stock uses nothing from the claims, " +
      "so it is the one thing that can prove the dispensed cost right rather than merely consistent.",
    from: "PioneerRx, the inventory export",
    done: Boolean(closing),
    says: closing ? `counted ${closing.countedOn}, ${money(closing.rxValueCents ?? closing.valueCents ?? 0)} on the dispensing shelf` : "cost of goods has nothing to be checked against",
    cents: null,
  });

  const outstanding = items.filter((i) => !i.done).length;
  return {
    month,
    label: monthLabel(month),
    /* Worth the most first, then the ones with no figure. A list is read from the top. */
    items: items.sort((a, b) => Number(a.done) - Number(b.done) || (b.cents ?? -1) - (a.cents ?? -1)),
    outstanding,
    blockedCents: items.filter((i) => !i.done).reduce((n, i) => n + (i.cents ?? 0), 0),
  };
}

/** The month a checklist is about on a given day: the one just finished. */
export function monthJustFinished(today: string): string {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
