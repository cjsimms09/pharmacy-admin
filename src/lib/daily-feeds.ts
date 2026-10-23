import { wholesalerHolidays, listDays } from "./wholesaler-purchases";

/**
 * Whether each day of a month has the daily reports the books are proved against.
 *
 * Two daily reports prove the till and the cards: PioneerRx's payment-type report (what each day took, by how it was paid) and the
 * processor's card batch (what the cards will deposit). In September 2026 the payment-type report was on file for 16 days and absent
 * for nine weekdays (1, 2, 3, 4, 8, 9, 10, 11, 14), the card batch was on file for 8 and absent for 14, and nothing said so: the
 * month-close strip read "closed". Revenue and cards for those days were unproved, and the claims-against-till comparison could not
 * be made for the first half of the month.
 *
 * Pure. A report that covers a range (PioneerRx can be asked for 1 to 14 September in one report) covers every day in it.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Every day from the first to the last, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) out.push(iso(d));
  return out;
}

/** The days of a month the pharmacy is open to sell: weekdays that are not holidays. Saturdays are checked only where a report exists, below. */
export function sellingWeekdays(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const holidays = wholesalerHolidays(y);
  const out: string[] = [];
  for (let day = 1; day <= last; day++) {
    const d = new Date(Date.UTC(y, m - 1, day));
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const key = iso(d);
    if (!holidays.has(key)) out.push(key);
  }
  return out;
}

/** Weekdays of the month that no payment-type report covers. */
export function daysWithoutPaymentReport(month: string, reports: { periodFrom: string; periodTo: string }[]): string[] {
  const covered = new Set(reports.flatMap((r) => eachDay(r.periodFrom, r.periodTo)));
  return sellingWeekdays(month).filter((d) => !covered.has(d));
}

/** Days the till says cards were taken and no card batch is on file for. */
export function cardDaysWithoutBatch(reports: { periodFrom: string; periodTo: string; cardNetCents: number }[], batchDays: Iterable<string>, month: string): string[] {
  const have = new Set(batchDays);
  return reports
    .filter((r) => r.periodFrom === r.periodTo && r.periodFrom.startsWith(month) && r.cardNetCents > 0 && !have.has(r.periodFrom))
    .map((r) => r.periodFrom)
    .sort();
}

/** "9 weekdays, 1 to 4 and 8 to 11 and 14", written plainly: the days as a list. */
export function sayDays(month: string, days: string[]): string {
  const name = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${listDays(days)} ${name}`;
}

export type FeedGap = { key: "payment_type_daily" | "card_batches"; name: string; days: string[]; says: string };

export function judgeDailyFeeds(input: { month: string; payment: string[]; cards: string[] }): FeedGap[] {
  const { month, payment, cards } = input;
  const out: FeedGap[] = [];
  if (payment.length > 0) {
    const first = payment[0];
    const last = payment[payment.length - 1];
    out.push({
      key: "payment_type_daily",
      name: "PioneerRx's payment-type report for every day",
      days: payment,
      says:
        `No payment-type report is on file for ${sayDays(month, payment)}, so what the till took on those days is unproved. ` +
        `In PioneerRx run System Sales Totals By Payment Type for ${first} to ${last} and send it to the mailbox: one report can cover the whole range.`,
    });
  }
  if (cards.length > 0) {
    out.push({
      key: "card_batches",
      name: "The card batch for every day cards were taken",
      days: cards,
      says: `The till took cards on ${sayDays(month, cards)} and no card batch report is on file for ${cards.length === 1 ? "it" : "them"}, so those card takings cannot be checked against what the processor deposits.`,
    });
  }
  return out;
}
