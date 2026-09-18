import "server-only";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getSettings } from "./settings";
import { todayIso } from "./dates";
import { runDailyCheck, summarise, type Check, type Facts } from "./daily-check";

/**
 * Gathering what the morning check judges.
 *
 * Deliberately six counts and two dates, all of them cheap, because a check that is expensive gets
 * run less often and a check that is run less often is not a check. Nothing here interprets: every
 * sentence the owner reads is written in daily-check.ts, where the rule it is judged against lives
 * beside it.
 */
async function gather(): Promise<Facts> {
  const one = async (q: ReturnType<typeof sql>): Promise<number> => {
    const rows = await db.all<{ n: number | null }>(q);
    return Number(rows[0]?.n ?? 0);
  };
  const text = async (q: ReturnType<typeof sql>): Promise<string | null> => {
    const rows = await db.all<{ v: string | null }>(q);
    return rows[0]?.v ?? null;
  };

  const [
    inboxRows,
    inboxArrivals,
    invoiceDocumentRows,
    invoiceDocumentFiles,
    invoicesShort,
    invoicesShortCents,
    bookedWithNoDocument,
    lastSweptAt,
    offsetsWithPaymentDates,
    offsetsWithPaymentDatesCents,
    doubledRebateLadders,
    paymentsCountedTwice,
    paymentsCountedTwiceCents,
  ] = await Promise.all([
    one(sql`select count(*) as n from inbox_items`),
    one(sql`select count(distinct message_id) as n from inbox_items`),
    one(sql`select count(*) as n from documents where category like 'invoice%'`),
    one(sql`select count(distinct sha256) as n from documents where category like 'invoice%' and sha256 is not null`),
    one(sql`select count(*) as n from supplier_invoices where lines_short_cents is not null`),
    one(sql`select coalesce(sum(lines_short_cents), 0) as n from supplier_invoices where lines_short_cents is not null`),
    /*
     * Money read off a statement that cannot produce the statement.
     *
     * Only the rows the site booked from a document itself — keyed `REBATE|…` — because an expense
     * somebody typed in by hand has no document to be missing and would make this cry wolf for ever.
     */
    one(sql`select count(*) as n from expenses where invoice_number like 'REBATE|%' and document_id is null`),
    text(sql`select max(swept_at) as v from inbox_items`),
    /*
     * Revenue offsets dated as paid, by the category's kind rather than by name, so a new
     * revenue-offset category is covered the day somebody adds it.
     */
    one(sql`select count(*) as n from expenses e join expense_categories k on k.id = e.category_id
             where k.kind = 'revenue_offset' and e.paid_on is not null and e.status = 'confirmed'`),
    one(sql`select coalesce(sum(abs(e.amount_cents)), 0) as n from expenses e join expense_categories k on k.id = e.category_id
             where k.kind = 'revenue_offset' and e.paid_on is not null and e.status = 'confirmed'`),
    /*
     * Baskets with more than one current ladder on them.
     *
     * Grouped by supplier and by what the terms say the ladder pays on — its eligibility and the
     * ratio it is measured by — read out of the stored JSON, because that is the identity that
     * decides whether two rows are added together. Two ladders on one basket doubles the rate.
     */
    one(sql`select count(*) as n from (
              select supplier_id,
                     json_extract(terms_json, '$.eligibility') as basket,
                     coalesce(json_extract(terms_json, '$.ratioMeasure'), '-') as measure
                from supplier_rebate_programs
               where effective_to is null
               group by supplier_id, basket, measure
              having count(*) > 1)`),
    /*
     * Payments that are the claim's own adjudicated figure and are still being added to it.
     *
     * Joined on the prescription and the day it was dispensed, which is how `laterPayments` reaches
     * a fill, and narrowed to payments whose amount is EXACTLY the claim's `remit_cents`. Exactness
     * is what makes this safe to act on: a payment that merely resembles the claim's figure could
     * be a second payer or a partial, and calling either of those a double count would be its own
     * fault. Only money in the books is judged — one dated before the books begin is recorded and
     * counted nowhere.
     */
    one(sql`select count(*) as n
              from claim_payments cp
              join claims c on c.rx_number = cp.rx_number and c.date_filled = cp.date_filled
             where cp.out_of_books = 0 and cp.revenue_cents <> 0
               and cp.amount_cents = c.remit_cents and cp.amount_cents <> 0`),
    one(sql`select coalesce(sum(cp.revenue_cents), 0) as n
              from claim_payments cp
              join claims c on c.rx_number = cp.rx_number and c.date_filled = cp.date_filled
             where cp.out_of_books = 0 and cp.revenue_cents <> 0
               and cp.amount_cents = c.remit_cents and cp.amount_cents <> 0`),
  ]);

  /*
   * Asked of the register rather than written as SQL here, because the rule for what counts as
   * "not banked" belongs beside the register that answers it — and a second copy of that rule is
   * how two places end up disagreeing about the same money.
   */
  const { remittancesNotBanked: notBankedRows } = await import("./mck-remit-detail-store");
  const notBanked = await notBankedRows();

  const registerRows = await one(sql`select count(*) as n from remittance_register`);
  const remitSourced = await one(sql`select count(*) as n from claim_payments where reference like 'ProviderPay %'`);

  const settings = await getSettings();
  const standingRebatePeriodTo = ((): string | null => {
    try {
      const s = settings.mck_rebate_last_statement;
      return s ? ((JSON.parse(s) as { periodTo?: string }).periodTo ?? null) : null;
    } catch {
      return null;
    }
  })();

  return {
    inboxRows,
    inboxArrivals,
    invoiceDocumentRows,
    invoiceDocumentFiles,
    standingRebatePeriodTo,
    invoicesShort,
    invoicesShortCents,
    lastSweptAt,
    bookedWithNoDocument,
    offsetsWithPaymentDates,
    offsetsWithPaymentDatesCents,
    doubledRebateLadders,
    paymentsCountedTwice,
    paymentsCountedTwiceCents,
    remittancesNotBanked: notBanked.length,
    remittanceRegisterRows: registerRows,
    remittancePaymentsPosted: remitSourced,
    remittancesNotBankedCents: notBanked.reduce((n, r) => n + r.amountCents, 0),
    today: todayIso(),
    now: new Date().toISOString(),
  };
}

export type DailyCheckResult = { checks: Check[]; failing: number; says: string; ranAt: string };

/** Runs the check now and returns it. Reads only — it never changes anything it is judging. */
export async function dailyCheck(): Promise<DailyCheckResult> {
  const checks = runDailyCheck(await gather());
  return {
    checks,
    failing: checks.filter((c) => !c.ok).length,
    says: summarise(checks),
    ranAt: new Date().toISOString(),
  };
}

/**
 * Runs it once a day and writes down what it found.
 *
 * The stored line is the history: a check that has been failing for three days is a different
 * problem from one that failed this morning, and without a record nobody can tell them apart.
 */
export async function dailyCheckTick(): Promise<void> {
  const { setSetting } = await import("./settings");
  const s = await getSettings();
  const today = todayIso();
  if (s.daily_check_on === today) return;
  const r = await dailyCheck();
  await setSetting("daily_check_on", today);
  await setSetting("daily_check_result", `${r.ranAt}: ${r.says}`);
}
