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
  ]);

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
