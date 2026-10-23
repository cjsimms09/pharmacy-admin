/**
 * Whether the wholesaler's invoices for a month are all on file, proved against the wholesaler's own figure.
 *
 * The McKesson rebate statement prints the month's "Net Purchases". For September 2026 that was $594,870.80, and the site held
 * $452,478.24 of McKesson invoices for the month: $142,392.56 short. Nothing said so. The invoices dated 1 to 8 September and the 14th
 * were never captured: the mailbox first received McKesson invoices on 15 September, and the site never asked McKesson for the days
 * before. The consequence reaches three places the owner cares about: purchases are understated, the "bought against dispensed"
 * comparison reports the shelf running down $148,076.26 when it did not, and any controlled-substance invoice among the missing
 * ones is a record the pharmacy is required to keep and does not have.
 *
 * So the outside figure and the invoices are compared, every month, without anybody asking, and the weekdays with no invoice are named,
 * because those are the days to fetch.
 *
 * Pure. `wholesaler-purchases-store.ts` reads the data.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/** The nth given weekday (0 Sunday) of a month, or the last when n is 0. */
function nthWeekday(y: number, m: number, dow: number, n: number): Date {
  if (n === 0) {
    const last = utc(y, m + 1, 0);
    return utc(y, m, last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7));
  }
  const first = utc(y, m, 1);
  return utc(y, m, 1 + ((dow - first.getUTCDay() + 7) % 7) + (n - 1) * 7);
}

/** The days a wholesaler does not deliver: the federal holidays it keeps, the day observed where one falls on a weekend. */
export function wholesalerHolidays(year: number): Set<string> {
  const fixed = [utc(year, 1, 1), utc(year, 7, 4), utc(year, 12, 25)].map((d) => {
    const dow = d.getUTCDay();
    return dow === 6 ? new Date(d.getTime() - 86_400_000) : dow === 0 ? new Date(d.getTime() + 86_400_000) : d;
  });
  return new Set([...fixed, nthWeekday(year, 5, 1, 0), nthWeekday(year, 9, 1, 1), nthWeekday(year, 11, 4, 4)].map(iso));
}

/** Weekdays of a month, as dates, that are not a holiday and have no invoice on file. */
export function weekdaysWithoutInvoices(month: string, invoiceDates: Iterable<string>, until?: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const have = new Set(invoiceDates);
  const holidays = wholesalerHolidays(y);
  const out: string[] = [];
  const last = utc(y, m + 1, 0).getUTCDate();
  for (let day = 1; day <= last; day++) {
    const d = utc(y, m, day);
    const key = iso(d);
    if (until && key > until) break;
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    if (holidays.has(key) || have.has(key)) continue;
    out.push(key);
  }
  return out;
}

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DAY = (k: string) => String(Number(k.slice(8, 10)));

/** A short run of days, "1, 2, 3, 4 and 8". */
export function listDays(days: string[]): string {
  const n = days.map(DAY);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** Anything under this much, or this share, is rounding and returns, not missing invoices. */
export const MATERIAL_SHARE = 0.03;
export const MATERIAL_CENTS = 100_000;

export type PurchasesJudgement = { agrees: boolean; gapCents: number; share: number; says: string };

/**
 * The wholesaler's own purchases figure against what PioneerRx recorded receiving from them, less what went back.
 *
 * PioneerRx's receiving record is the complete one (a receipt for every delivery from 1 September), where the invoice documents are
 * not (118 deliveries had none on file). Net purchases on the statement are after returns, so returns come off the receipts first.
 */
export function judgePurchases(input: { month: string; wholesaler: string; statementCents: number; receivedCents: number; returnsCents: number; missingDays: string[] }): PurchasesJudgement {
  const { month, wholesaler, statementCents, receivedCents, returnsCents, missingDays } = input;
  const recordedCents = receivedCents - returnsCents;
  const gapCents = statementCents - recordedCents;
  const share = statementCents > 0 ? gapCents / statementCents : 0;
  const material = Math.abs(gapCents) >= MATERIAL_CENTS && Math.abs(share) >= MATERIAL_SHARE;
  const basis = `PioneerRx recorded receiving ${money(receivedCents)} from ${wholesaler} in ${month}${returnsCents ? `, less ${money(returnsCents)} returned` : ""}, ${money(recordedCents)}`;
  if (!material) {
    return {
      agrees: true,
      gapCents,
      share,
      says: `${wholesaler}'s own statement puts ${month}'s net purchases at ${money(statementCents)}; ${basis}. The difference, ${money(gapCents)}, is within what rounding and timing explain.`,
    };
  }
  const month3 = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const short = gapCents > 0;
  return {
    agrees: false,
    gapCents,
    share,
    says:
      `${wholesaler}'s own statement puts ${month}'s net purchases at ${money(statementCents)}; ${basis}, ${money(gapCents)} (${Math.round(Math.abs(share) * 100)}%) ${short ? "short" : "over"}. ` +
      (short && missingDays.length > 0
        ? `PioneerRx has no ${wholesaler} receipt on ${listDays(missingDays)} ${month3} (weekdays, holidays left out): receive those deliveries into PioneerRx. `
        : short
          ? "A receipt is recorded for every weekday, so a delivery may be missing from a day that has others, or recorded at a different amount. "
          : "More was received than the statement says was bought, so check for a delivery received twice. ") +
      `Until it agrees, purchases for the month are not proved.`,
  };
}
