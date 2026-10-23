import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Sales tax collected against sales tax remitted, month by month.
 *
 * The register collects Kansas sales tax on the retail (non-prescription) sales; the monthly System Sales Summary
 * says how much (sales_months.retail_tax_cents), and the daily Sales by Payment Type report says it day by day
 * (sales_by_payment.retail_tax_cents), which is partial where days are missing. The Department of Revenue drafts
 * the account for a month's tax in the month after — a monthly filer's return is due the 25th (K.S.A. 79-3607) —
 * and the draft lands on the bank statement and is booked under "Sales tax remitted" (a balance-sheet category:
 * the money was the customer's, never revenue).
 *
 * So a month's line has four states, never one word: collected and remitted agree; collected and not yet due;
 * due and nothing drafted; drafted and the two differ. And one more thing the first reading showed: on 1 September
 * 2026 the Department drafted $39.01 and $1,127.66 under two account numbers, against roughly $435 of retail tax a
 * month. A draft that far from the tax collected is more likely another tax on the same account (withholding on
 * wages, say) than an over-payment, and the line says so instead of calling it one.
 */
export type TaxMonth = {
  month: string;
  /** From the monthly summary where it is on file, else the sum of the days read. */
  collectedCents: number | null;
  collectedFrom: "monthly summary" | "daily reports" | null;
  /** Days of the daily report on file; said when the monthly summary is absent. */
  daysRead: number;
  /** Drafted in the following month under "Sales tax remitted". */
  remittedCents: number | null;
  remittedOn: string[];
  dueOn: string;
  state: "agrees" | "not_yet_due" | "due_nothing_drafted" | "differs" | "not_measured";
  says: string;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nextMonth = (m: string) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1));
  return d.toISOString().slice(0, 7);
};
export const TOLERANCE_CENTS = 100;

/** Pure: one month's line from what is on file. */
export function compareSalesTax(
  month: string,
  monthly: number | null,
  daily: { day: string; taxCents: number }[],
  remitted: { on: string; cents: number }[],
  today: string,
): TaxMonth {
  const days = daily.filter((d) => d.day.startsWith(month));
  const collected = monthly ?? (days.length ? days.reduce((n, d) => n + d.taxCents, 0) : null);
  const collectedFrom = monthly !== null ? "monthly summary" : days.length ? "daily reports" : null;
  const after = nextMonth(month);
  const dueOn = `${after}-25`;
  const drafts = remitted.filter((r) => r.on.startsWith(after));
  const remittedCents = drafts.length ? drafts.reduce((n, r) => n + r.cents, 0) : null;
  const remittedOn = drafts.map((r) => r.on);
  let state: TaxMonth["state"];
  let says: string;
  const partial = collectedFrom === "daily reports" ? ` (${days.length} days of daily reports; the monthly summary is not on file)` : "";
  if (collected === null) {
    state = "not_measured";
    says = `${month}: no sales report on file says what tax was collected.`;
  } else if (remittedCents === null) {
    state = today > dueOn ? "due_nothing_drafted" : "not_yet_due";
    says =
      state === "not_yet_due"
        ? `${month}: ${money(collected)} collected${partial}; the return is due ${dueOn} and nothing has been drafted yet.`
        : `${month}: ${money(collected)} collected${partial}; the return was due ${dueOn} and no draft is on the bank statement.`;
  } else if (Math.abs(remittedCents - collected) <= TOLERANCE_CENTS) {
    state = "agrees";
    says = `${month}: ${money(collected)} collected${partial}, ${money(remittedCents)} drafted on ${remittedOn.join(" and ")}.`;
  } else {
    state = "differs";
    const far = remittedCents > collected * 2 + 10_000 || remittedCents < collected / 2;
    says = `${month}: ${money(collected)} collected${partial}, ${money(remittedCents)} drafted on ${remittedOn.join(" and ")}${drafts.length > 1 ? ` in ${drafts.length} drafts` : ""}.${
      far ? " That far apart, the draft is more likely another tax on the same account than this month's sales tax: check which account each draft is for." : ` ${money(Math.abs(remittedCents - collected))} ${remittedCents > collected ? "more" : "less"} than collected.`
    }`;
  }
  return { month, collectedCents: collected, collectedFrom, daysRead: days.length, remittedCents, remittedOn, dueOn, state, says };
}

export async function salesTaxMonths(today: string, months: string[]): Promise<TaxMonth[]> {
  const [monthly, daily, remitted] = await Promise.all([
    db.all(sql`select month, retail_tax_cents tax from sales_months`) as Promise<{ month: string; tax: number | null }[]>,
    db.all(sql`select period_from day, retail_tax_cents tax from sales_by_payment where period_from = period_to`) as Promise<{ day: string; tax: number }[]>,
    db.all(sql`select e.invoice_date "on", e.amount_cents cents from expenses e join expense_categories c on c.id = e.category_id where c.name = 'Sales tax remitted' and e.status <> 'void'`) as Promise<{ on: string; cents: number }[]>,
  ]);
  const byMonth = new Map(monthly.map((m) => [m.month, m.tax]));
  return months.map((m) =>
    compareSalesTax(
      m,
      byMonth.get(m) ?? null,
      daily.map((d) => ({ day: d.day, taxCents: d.tax })),
      remitted,
      today,
    ),
  );
}
