/**
 * The delivery round as a cost of the month.
 *
 * The pharmacy pays its own driver; the site raises his invoice from the days entered. So on the
 * accrual account the month carries what the round has cost so far — the draft invoice is the
 * running total of days already driven, the same way payroll is carried by the day — and a
 * finished month carries the issued invoice. On the cash account an invoice is money out on the
 * day it was sent, which is the nearest record the site holds of when he was paid; a draft is
 * not cash. A superseded invoice was replaced and never counts. Where the clinic pays the driver
 * directly (the setting), the round is nothing on either basis. Pure.
 */
export type DriverInvoiceLike = { month: string; status: string; totalCents: number; sentAt: string | null };

export type DriverPaidBy = "pharmacy" | "clinic";

/** The pharmacy pays unless the setting says the clinic does. */
export function driverPaidBy(setting: string | null | undefined): DriverPaidBy {
  return setting === "clinic" ? "clinic" : "pharmacy";
}

export function driverCostOf(invoices: DriverInvoiceLike[], month: string, basis: "accrual" | "cash", paidBy: DriverPaidBy): number {
  if (paidBy !== "pharmacy") return 0;
  if (basis === "accrual") return invoices.filter((i) => i.month === month && i.status !== "superseded").reduce((n, i) => n + i.totalCents, 0);
  return invoices.filter((i) => i.status === "sent" && (i.sentAt ?? "").startsWith(month)).reduce((n, i) => n + i.totalCents, 0);
}
