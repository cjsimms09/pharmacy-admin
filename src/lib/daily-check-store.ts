import "server-only";
import { db, schema } from "@/db";
import { sql } from "drizzle-orm";
import { getSettings } from "./settings";
import { addDays, atLocal, todayIso } from "./dates";
import { SITE_STARTS_ON } from "./books-start";
import { runDailyCheck, summarise, type Check, type Facts, type History, type Tie } from "./daily-check";
import { remitStanding, STANDING_WINDOW_DAYS } from "./engine/remit-standing";
import { digits, loadHistoryReach } from "./engine/remit-sweep";

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

  const [
    inboxRows,
    inboxArrivals,
    invoiceDocumentRows,
    invoiceDocumentFiles,
    invoicesShort,
    invoicesShortCents,
    bookedWithNoDocument,
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
   * Which invoices are short, as many as the card can name. The same rows the count above counts, the largest shortfall first, so what he
   * is told to look at is the invoice that costs the most.
   */
  const shortInvoices = (
    await db.all<{ supplier: string | null; invoice_date: string | null; short: number | null }>(
      sql`select supplier, invoice_date, lines_short_cents as short from supplier_invoices
           where lines_short_cents is not null order by lines_short_cents desc limit 5`,
    )
  ).map((r) => ({ supplier: r.supplier, invoiceOn: r.invoice_date, shortCents: Number(r.short ?? 0) }));

  /*
   * What the check is actually able to see.
   *
   * It compares remittances that carry a payment number against banked cash, so the population it covers is those rows advised since the
   * books began and not the whole register, and "of N" and "N not banked" count one population. The rows it cannot compare are not
   * netted out of the sentence: each is said as one of two things, a receipt already stands for it (a cheque payer's, banked at the
   * counter, never gets a payment number) or nothing does yet and it is waiting. And it can only see as far as the last export, because
   * the pull is monthly and by hand: the newest advice it holds and the day it was read are both said, because they are not the same day.
   *
   * Which remittances the cash account is missing the money of is asked of the one computation the bank matcher and the Remits tab
   * already use (engine/remit-standing.ts), and not worked out again here: a second copy of a rule about the same money is how two pages
   * come to disagree about it, and the copy this replaced did. `booksOnly`, because the question is whether money reached the cash
   * account and a receipt the books do not count is not in it.
   */
  const registerRows = await one(sql`select count(*) as n from remittance_register`);
  const standing = registerRows > 0 ? await remitStanding({ booksOnly: true }) : [];
  const inBooks = standing.filter((s) => s.row.remitOn === null || s.row.remitOn >= SITE_STARTS_ON);
  /* An advice of $0.00 or less is not money sent, so no bank line could ever stand for it: it is said apart (notPositiveSaid) and judged by nothing below. */
  const positive = inBooks.filter((s) => s.row.amountCents > 0);
  const notPositive = inBooks.length - positive.length;
  const hasNumber = (s: (typeof standing)[number]) => (s.row.paymentNumber ?? "").trim().length > 0;

  /*
   * A remittance with a payment number is banked when a receipt carries that number, when ProviderPay's own account history shows its
   * deposit swept to a bank line of the same amount (proof by the number, not by a receipt), or when a receipt is keyed to its remittance
   * number. Banked by either of the last two is counted by itself, so that the card can say how it knew. The same amount near the advice
   * date is not enough for a remittance that has a payment number: two remittances of one amount are two deposits, and a receipt of that
   * amount may be the other one's. Where that is all there is the card says so, and where nothing stands for it at all, what ProviderPay's
   * account history can say of it is one of five things (History, in daily-check.ts), worked out here because they turn on the payment
   * number, which stays in this function, and on the fortnight the matcher allows. Where the history reaches past the fortnight it is
   * also asked whether any file on file covers the month or months that fortnight falls in: the newest day on file says nothing of the
   * months below it.
   */
  const reach = registerRows > 0 ? await loadHistoryReach() : null;
  const historyOf = (paymentNumber: string, remitOn: string | null): History => {
    if (reach === null || reach.through === null) return { state: "none" };
    const held = reach.depositDays.get(paymentNumber);
    if (held) return { state: "holds a deposit", on: held };
    /* An advice with no date cannot be said to end too soon after it, or to fall in a month, so it is said by what the history holds. */
    if (remitOn === null) return { state: "reaches past", through: reach.through };
    const fortnightEnds = addDays(remitOn, STANDING_WINDOW_DAYS);
    if (reach.through < fortnightEnds) return { state: "ends too soon", through: reach.through };
    const uncovered = [remitOn.slice(0, 7), fortnightEnds.slice(0, 7)].find((m) => !reach.months.has(m));
    return uncovered ? { state: "has a gap", month: uncovered } : { state: "reaches past", through: reach.through };
  };

  const unbankedRemittances: { payer: string | null; remitOn: string | null; amountCents: number; tie: Tie; history: History }[] = [];
  let unbankedCents = 0;
  let bankedBySweep = 0;
  let bankedByRemitNumber = 0;
  for (const s of positive.filter(hasNumber).sort((a, b) => b.row.amountCents - a.row.amountCents)) {
    if (s.banked === "payment number") continue;
    if (s.banked === "sweep deposit") {
      bankedBySweep++;
      continue;
    }
    if (s.banked === "remittance number") {
      bankedByRemitNumber++;
      continue;
    }
    unbankedRemittances.push({ payer: s.row.payerName, remitOn: s.row.remitOn, amountCents: s.row.amountCents, tie: s.banked, history: historyOf(digits(s.row.paymentNumber), s.row.remitOn) });
    unbankedCents += s.row.amountCents;
  }
  const numbered = positive.filter(hasNumber).length;
  const unnumbered = positive.filter((s) => !hasNumber(s));
  const unnumberedStanding = unnumbered.filter((s) => s.banked !== null).length;
  const waiting = unnumbered
    .filter((s) => s.banked === null)
    .map((s) => ({ payer: s.row.payerName as string | null, remitOn: s.row.remitOn, amountCents: s.row.amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents);
  const seen = await db
    .select({ through: sql<string | null>`max(remit_on)`, readAt: sql<string | null>`max(last_seen_at)` })
    .from(schema.remittanceRegister)
    .then((r) => r[0]);
  const registerThrough = seen?.through ?? null;
  const registerReadOn = seen?.readAt ? atLocal(seen.readAt).slice(0, 10) : null;
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
    shortInvoices,
    lastSweptAt: settings.mail_last_sweep ?? null,
    lastSweepResult: settings.mail_last_result ?? null,
    bookedWithNoDocument,
    offsetsWithPaymentDates,
    offsetsWithPaymentDatesCents,
    doubledRebateLadders,
    paymentsCountedTwice,
    paymentsCountedTwiceCents,
    remittancesNotBanked: unbankedRemittances.length,
    remittancesBankedBySweep: bankedBySweep,
    remittancesBankedByRemitNumber: bankedByRemitNumber,
    unbankedRemittances,
    remittanceRegisterRows: registerRows,
    remittancesNumbered: numbered,
    remittancesNotPositive: notPositive,
    remittancesUnnumberedStanding: unnumberedStanding,
    remittancesWaiting: waiting,
    remittanceRegisterThrough: registerThrough,
    remittanceRegisterReadOn: registerReadOn,
    remittancePaymentsPosted: remitSourced,
    remittancesNotBankedCents: unbankedCents,
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
