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

export function driverCostOf(
  invoices: DriverInvoiceLike[],
  month: string,
  basis: "accrual" | "cash",
  paidBy: DriverPaidBy,
  /**
   * What the days already entered come to, at the agreed rate — deliveries and mail trips alike.
   *
   * The running total the note above has always described and nothing ever supplied. An invoice
   * is only raised on a finished month, so a month in progress had no invoice, and no invoice
   * meant no cost: September carried $0.00 of delivery on the accrual account with 47 deliveries
   * and 7 mail trips already recorded and $486.00 owed to the driver.
   *
   * Passed in rather than computed here, from `monthState`, which is the same arithmetic the
   * invoice itself is built from. Two ways of adding up one round is how they come to differ.
   */
  accruedCents = 0,
): number {
  if (paidBy !== "pharmacy") return 0;
  if (basis === "accrual") {
    const billed = invoices.filter((i) => i.month === month && i.status !== "superseded").reduce((n, i) => n + i.totalCents, 0);
    /*
     * The invoice where there is one, the days entered where there is not.
     *
     * Never both: once the month is invoiced, that document is the cost, and adding the days to
     * it would count the same round twice. The same rule a standing cost follows when its real
     * bill arrives.
     */
    return billed > 0 ? billed : accruedCents;
  }
  /* Cash is unchanged: an invoice is money out on the day it was sent, and a day driven is not. */
  return invoices.filter((i) => i.status === "sent" && (i.sentAt ?? "").startsWith(month)).reduce((n, i) => n + i.totalCents, 0);
}
