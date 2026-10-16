import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { readBankDescriptor } from "../bank-descriptors";
import { SITE_STARTS_ON } from "../books-start";
import { payerCycles, cycleDays, typicalDays, type CycleSource } from "./cycles";
import { openStatementDebits } from "./statement-debits";

/**
 * Cash ahead: the next four weeks of the bank account, by day, from what the site already holds.
 *
 * ── What is known, what is projected, and how each is said ──
 *
 *   statement   McKesson's statement of account names the draw and its day: an exact outflow.
 *   standing    rent, payroll, the accountant, the PSAO fee: the same figure on the same day each month.
 *   fixed       the debits booked from the bank line last month (loan, tax, CPESN, PioneerRx, fees): the same day
 *               next month, the same amount, until a document says otherwise.
 *   supplier    IPC, ParMed, ANDA, RRC: the last eight weeks' debits, averaged by weekday and repeated.
 *   claims      every unpaid claim, on the day its payer's typical cycle (p50) says it arrives; a claim already past
 *               that day arrives "tomorrow" — overdue money is counted once, soonest, never spread.
 *   programme   a manufacturer programme with a known route (rules: programme_route) on fill + its cycle.
 *   takings     card and counter takings and the facilitator, at the last four weeks' daily averages on open days.
 *
 * Nothing here invents a figure: a flow with no history behind it is left out and the assumptions are listed on
 * the screen. The projection starts from the last proven bank balance, so every day between that statement's end
 * and today is projected too — the site has no bank lines for them yet — and says so.
 *
 * The pure parts take plain rows and are tested; `computeCashAhead` only loads and writes.
 */

export type Flow = { day: string; cents: number; kind: "in" | "out"; label: string; basis: "statement" | "standing" | "fixed" | "supplier" | "claims" | "programme" | "takings" };
export type Day = { day: string; inflowCents: number; outflowCents: number; balanceCents: number; items: { kind: "in" | "out"; cents: number; label: string; basis: Flow["basis"] }[]; basis: "statement" | "projected" };

const DAY_MS = 864e5;
/* Five weeks, so the month-end payroll is always in view. */
export const HORIZON_DAYS = 35;

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}
/** 0 Sunday … 6 Saturday, in UTC, which is what an ISO date is. */
export function weekday(iso: string): number {
  return new Date(Date.parse(`${iso}T00:00:00Z`)).getUTCDay();
}
export function isOpenDay(iso: string): boolean {
  const w = weekday(iso);
  return w >= 1 && w <= 6;
}
/** The nth of the month on or after `from`, clamped to the month's length, for every month that touches [from, to]. */
export function monthlyDays(paidDay: number, from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = new Date(Date.parse(`${from.slice(0, 7)}-01T00:00:00Z`));
  while (true) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const d = new Date(Date.UTC(y, m, Math.min(paidDay, last))).toISOString().slice(0, 10);
    if (d > to) break;
    if (d >= from) out.push(d);
    cursor = new Date(Date.UTC(y, m + 1, 1));
  }
  return out;
}

export function projectStanding(standing: { name: string; amountCents: number; paidDay: number | null; fromMonth?: string | null; toMonth?: string | null }[], from: string, to: string): Flow[] {
  const out: Flow[] = [];
  for (const s of standing) {
    if (!s.paidDay || s.amountCents <= 0) continue;
    for (const day of monthlyDays(s.paidDay, from, to)) {
      const month = day.slice(0, 7);
      if (s.fromMonth && month < s.fromMonth) continue;
      if (s.toMonth && month > s.toMonth) continue;
      out.push({ day, cents: s.amountCents, kind: "out", label: s.name, basis: "standing" });
    }
  }
  return out;
}

/** Last month's debits booked from the bank line, repeated on the same day of the month at the same amount. */
export function projectFixed(lastMonth: { on: string; amountCents: number; label: string }[], from: string, to: string): Flow[] {
  const out: Flow[] = [];
  for (const b of lastMonth) {
    const paidDay = Number(b.on.slice(8, 10));
    for (const day of monthlyDays(paidDay, from, to)) out.push({ day, cents: Math.abs(b.amountCents), kind: "out", label: b.label, basis: "fixed" });
  }
  return out;
}

/** How many times a weekday falls inside [from, to]. */
export function weekdayCount(wd: number, from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (weekday(d) === wd) n++;
  return n;
}

/**
 * A wholesaler's debits over the window, as an average per occurrence of each weekday, repeated on that weekday.
 *
 * Per occurrence of the weekday in the window, not per draw seen: McKesson drew on all five Tuesdays of September
 * and its Tuesday is the average draw; ANDA drew once on a Friday and its Friday is a quarter of that draw. A quiet
 * week counts as a week.
 */
export function projectSuppliers(history: { on: string; amountCents: number; counterparty: string }[], window: { from: string; to: string }, from: string, to: string): Flow[] {
  const byParty = new Map<string, Map<number, number>>();
  for (const h of history) {
    if (h.on < window.from || h.on > window.to) continue;
    const wd = weekday(h.on);
    const m = byParty.get(h.counterparty) ?? new Map<number, number>();
    m.set(wd, (m.get(wd) ?? 0) + Math.abs(h.amountCents));
    byParty.set(h.counterparty, m);
  }
  const out: Flow[] = [];
  for (const [party, m] of byParty) {
    for (const [wd, total] of m) {
      const per = total / Math.max(1, weekdayCount(wd, window.from, window.to));
      if (per < 100) continue;
      for (let d = from; d <= to; d = addDays(d, 1)) if (weekday(d) === wd) out.push({ day: d, cents: Math.round(per), kind: "out", label: `${party} (average)`, basis: "supplier" });
    }
  }
  return out;
}

export function projectClaims(unpaid: { payer: string; pcn?: string | null; bin?: string | null; cents: number; filled: string; programmeCycleDays?: number | null }[], cycles: CycleSource, from: string, to: string): Flow[] {
  const byDay = new Map<string, Map<string, number>>();
  for (const u of unpaid) {
    const wait = u.programmeCycleDays ?? typicalDays(cycles, u.payer, u.pcn, u.bin);
    if (wait === null) continue;
    let day = addDays(u.filled, wait);
    /* Past its typical day: expected by the slowest one in ten of its plan group; past that too: counted tomorrow, once. */
    if (day < from && !u.programmeCycleDays) {
      const slow = cycleDays(cycles, u.payer, u.pcn, u.bin);
      if (slow !== null) day = addDays(u.filled, slow);
    }
    if (day < from) day = from;
    if (day > to) continue;
    const m = byDay.get(day) ?? new Map<string, number>();
    m.set(u.payer, (m.get(u.payer) ?? 0) + u.cents);
    byDay.set(day, m);
  }
  const out: Flow[] = [];
  for (const [day, m] of byDay) for (const [payer, cents] of m) out.push({ day, cents, kind: "in", label: payer, basis: unpaid.find((u) => u.payer === payer)?.programmeCycleDays ? "programme" : "claims" });
  return out;
}

/**
 * The fills not yet dispensed. Every open day ahead dispenses what the last four weeks averaged, and its payers pay
 * it their typical number of days later. Without this the projection runs dry two weeks out — the claims already
 * on file are paid by then and nothing new has been counted — and a balance that falls to nothing in week four
 * would be a statement about the horizon, not about the business.
 */
export function projectFutureFills(dailyRemitCents: number, typicalWaitDays: number, firstDay: string, to: string): Flow[] {
  const out: Flow[] = [];
  if (dailyRemitCents <= 0) return out;
  for (let d = firstDay; d <= to; d = addDays(d, 1)) {
    if (!isOpenDay(d)) continue;
    const paid = addDays(d, typicalWaitDays);
    if (paid > to) continue;
    out.push({ day: paid, cents: dailyRemitCents, kind: "in", label: "fills still to be dispensed (average)", basis: "claims" });
  }
  return out;
}

export function projectTakings(daily: { label: string; cents: number }[], from: string, to: string): Flow[] {
  const out: Flow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isOpenDay(d)) continue;
    for (const t of daily) if (t.cents > 0) out.push({ day: d, cents: t.cents, kind: "in", label: t.label, basis: "takings" });
  }
  return out;
}

export function buildDays(openingCents: number, flows: Flow[], from: string, to: string, statementThrough: string | null): Day[] {
  const out: Day[] = [];
  let balance = openingCents;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const items = flows.filter((f) => f.day === d).sort((a, b) => b.cents - a.cents);
    const inflow = items.filter((i) => i.kind === "in").reduce((n, i) => n + i.cents, 0);
    const outflow = items.filter((i) => i.kind === "out").reduce((n, i) => n + i.cents, 0);
    balance += inflow - outflow;
    out.push({ day: d, inflowCents: inflow, outflowCents: outflow, balanceCents: balance, items: items.map((i) => ({ kind: i.kind, cents: i.cents, label: i.label, basis: i.basis })), basis: statementThrough && d <= statementThrough ? "statement" : "projected" });
  }
  return out;
}

export async function computeCashAhead(today: string): Promise<{ days: Day[]; from: string; openingCents: number | null; openingFrom: string | null; assumptions: string[] }> {
  const months = await db.query.monthStatus.findMany();
  const proven = months.filter((m) => m.bankClosingCents !== null && m.bankLines > 0).sort((a, b) => b.month.localeCompare(a.month))[0] ?? null;
  const assumptions: string[] = [];
  if (!proven) return { days: [], from: today, openingCents: null, openingFrom: null, assumptions: ["No proven bank balance yet: a bank statement has to be placed before the account can be projected."] };
  const lastDay = new Date(Date.UTC(Number(proven.month.slice(0, 4)), Number(proven.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const from = addDays(lastDay, 1);
  const to = addDays(today, HORIZON_DAYS);
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  assumptions.push(`Starts from the bank's proven closing balance of ${money(proven.bankClosingCents!)} on ${lastDay}; every day after it is projected until the next statement is placed.`);

  const flows: Flow[] = [];
  const debits = await openStatementDebits();

  /* Standing costs. */
  const standing = await db.query.standingCosts.findMany();
  flows.push(...projectStanding(standing.map((s) => ({ name: s.name, amountCents: s.amountCents, paidDay: s.paidDay, fromMonth: s.fromMonth, toMonth: s.toMonth })), from, to));
  if (standing.length) assumptions.push(`${standing.length} standing costs on their paid day each month: ${standing.map((s) => s.name).join(", ")}.`);

  /* Fixed monthly debits: what was booked from the bank line last month. */
  const prevFrom = addDays(`${proven.month}-01`, 0);
  const fixed = await db.query.bankLines.findMany({ where: and(eq(schema.bankLines.placedAs, "books_bill"), gte(schema.bankLines.on, prevFrom), lte(schema.bankLines.on, lastDay)) });
  const fixedRows = fixed
    .filter((b) => !/stamps|endicia|uline|anthropic|wholescripts|segundo|^check/i.test(b.description.trim()))
    .map((b) => ({ on: b.on, amountCents: b.amountCents, label: readBankDescriptor(b.description, b.amountCents).counterparty }))
    .filter((b) => !/does not know|unknown/i.test(b.label));
  flows.push(...projectFixed(fixedRows, from, to));
  if (fixedRows.length) assumptions.push(`${fixedRows.length} fixed debits repeat on last month's day at last month's amount: ${[...new Set(fixedRows.map((r) => r.label))].join(", ")}.`);

  /*
   * The wholesalers, by weekday average over the window the bank lines cover (up to eight weeks). Where a statement
   * of account names a draw, the larger of the statement's figure and the average is taken: a statement smaller
   * than the average has not seen the whole week's billing yet (the Transaction History of 1 October named five
   * invoices against a draw that is usually forty).
   */
  const since = addDays(today, -56);
  const all = (await db.query.bankLines.findMany({ where: and(gte(schema.bankLines.on, since), lte(schema.bankLines.on, lastDay)), columns: { on: true, amountCents: true, description: true } }));
  const windowFrom = all.map((b) => b.on).sort()[0] ?? since;
  const history = all
    .filter((b) => b.amountCents < 0)
    .map((b) => ({ on: b.on, amountCents: b.amountCents, meaning: readBankDescriptor(b.description, b.amountCents) }))
    .filter((b) => b.meaning.kind === "wholesaler_ach" || b.meaning.kind === "wholesaler_payment" || b.meaning.kind === "supplier_card")
    .map((b) => ({ on: b.on, amountCents: b.amountCents, counterparty: b.meaning.counterparty }));
  const supplierFlows = projectSuppliers(history, { from: windowFrom, to: lastDay }, from, to);
  const named = new Map<string, { cents: number; statementDate: string }>();
  for (const d of debits) if (d.dueOn >= from && d.dueOn <= to) named.set(`${d.supplier.toLowerCase()}|${d.dueOn}`, { cents: d.netCents, statementDate: d.statementDate });
  for (const f of supplierFlows) {
    const party = f.label.replace(" (average)", "");
    const known = named.get(`${party.toLowerCase()}|${f.day}`);
    if (known) {
      named.delete(`${party.toLowerCase()}|${f.day}`);
      if (known.cents >= f.cents) flows.push({ day: f.day, cents: known.cents, kind: "out", label: `${party} draw (statement of ${known.statementDate})`, basis: "statement" });
      else flows.push({ day: f.day, cents: f.cents, kind: "out", label: `${party} draw (statement of ${known.statementDate} names ${money(known.cents)} so far; the average is taken)`, basis: "supplier" });
    } else flows.push(f);
  }
  for (const [k, v] of named) flows.push({ day: k.split("|")[1], cents: v.cents, kind: "out", label: `${k.split("|")[0]} draw (statement of ${v.statementDate})`, basis: "statement" });
  assumptions.push(`Wholesalers repeat their weekday averages over ${daysBetween(windowFrom, lastDay) + 1} days of bank lines; a draw a statement of account names is the statement's figure, unless the statement is smaller than the average, which means it has not seen the whole week.`);

  /* Payers: every unpaid claim on the day its plan group typically pays; programmes on their known cycle. From the claim standing (engine/claims.ts), as Today and the month read it. A short-paid leg is not here: what the payer kept is not coming. */
  const cycles = await payerCycles();
  const { TERMINAL_DECISIONS } = await import("./claims");
  const unpaid = (await db.all(sql`select payer, pcn, bin, short_cents cents, date_filled filled, programme, cycle_days cycle, decision from claim_standing where state in ('unpaid', 'due', 'unmeasured', 'programme')`)) as { payer: string; pcn: string | null; bin: string | null; cents: number; filled: string; programme: number; cycle: number | null; decision: string | null }[];
  const withRoutes = unpaid.filter((u) => !TERMINAL_DECISIONS.has(u.decision ?? "")).map((u) => ({ payer: u.payer, pcn: u.pcn, bin: u.bin, cents: u.cents, filled: u.filled, programmeCycleDays: u.programme ? u.cycle : null }));
  flows.push(...projectClaims(withRoutes, cycles, from, to));
  const measured = [...cycles].filter(([, c]) => c.n >= 5).length;
  assumptions.push(`Unpaid claims arrive on their payer's typical day (${measured} payers measured); a claim already past it is counted tomorrow; a payer with no cycle is left out.`);

  /* The fills still to be dispensed: the last four weeks' daily average, paid the typical number of days later. */
  const fillsSince = addDays(today, -28);
  const recent = (await db.all(sql`select coalesce(sum(remit_cents), 0) c from claims where status = 'paid' and cash_plan = 0 and date_filled >= ${fillsSince} and date_filled <= ${today} and date_filled >= ${SITE_STARTS_ON}`)) as { c: number }[];
  const recentOpen = Math.max(1, Array.from({ length: 29 }, (_, i) => addDays(fillsSince, i)).filter(isOpenDay).length);
  const dailyRemit = Math.round((recent[0]?.c ?? 0) / recentOpen);
  const waits = [...cycles.values()].filter((c) => c.n >= 25).map((c) => c.p50);
  const typicalWait = waits.length ? Math.round(waits.reduce((n, w) => n + w, 0) / waits.length) : 14;
  flows.push(...projectFutureFills(dailyRemit, typicalWait, addDays(today, 1), to));
  if (dailyRemit > 0) assumptions.push(`Fills still to be dispensed: ${money(dailyRemit)} of payer money a day, the last four weeks' average, paid ${typicalWait} days later.`);

  /* Takings: the last four weeks' daily averages on open days. */
  const takingsSince = addDays(lastDay, -27);
  const rc = (await db.all(sql`select case when source_key like 'register-card|%' or source_key like 'card-batch|%' then 'card takings' when source_key like 'register|%' then 'counter cash and cheques' else null end k, sum(amount_cents) c, count(distinct received_on) days from cash_receipts where received_on >= ${takingsSince} and received_on <= ${lastDay} and (source_key like 'register%' or source_key like 'card-batch|%') group by k`)) as { k: string | null; c: number; days: number }[];
  const openDays = Math.max(1, Array.from({ length: 28 }, (_, i) => addDays(takingsSince, i)).filter(isOpenDay).length);
  const daily = rc.filter((r) => r.k).map((r) => ({ label: r.k!, cents: Math.round(r.c / openDays) }));
  const mtf = (await db.all(sql`select sum(amount_cents) c from claim_payments where source = 'mtf' and received_on >= ${takingsSince} and received_on <= ${lastDay}`)) as { c: number | null }[];
  if (mtf[0]?.c) daily.push({ label: "Medicare facilitator", cents: Math.round(mtf[0].c / openDays) });
  flows.push(...projectTakings(daily, from, to));
  if (daily.length) assumptions.push(`Takings repeat the last four weeks' daily averages on open days: ${daily.map((d) => `${d.label} ${money(d.cents)}`).join(", ")}.`);

  const days = buildDays(proven.bankClosingCents!, flows, from, to, null);
  return { days, from, openingCents: proven.bankClosingCents!, openingFrom: lastDay, assumptions };
}

export async function writeCashAhead(today: string, now: string): Promise<{ days: number; lowest: { day: string; balanceCents: number } | null }> {
  const r = await computeCashAhead(today);
  await db.delete(schema.cashAhead);
  for (const d of r.days) {
    await db.insert(schema.cashAhead).values({ day: d.day, inflowCents: d.inflowCents, outflowCents: d.outflowCents, balanceCents: d.balanceCents, items: JSON.stringify(d.items.slice(0, 12)), basis: d.basis, computedAt: now });
  }
  /* The assumptions ride on a settings row so the screen can print them beside the figures. */
  const existing = await db.all<{ key: string }>(sql`select key from settings where key = 'cash_ahead_assumptions'`);
  const value = JSON.stringify({ computedAt: now, from: r.from, openingCents: r.openingCents, openingFrom: r.openingFrom, assumptions: r.assumptions });
  if (existing.length) await db.run(sql`update settings set value = ${value} where key = 'cash_ahead_assumptions'`);
  else await db.run(sql`insert into settings (key, value) values ('cash_ahead_assumptions', ${value})`);
  const lowest = r.days.length ? r.days.reduce((a, b) => (b.balanceCents < a.balanceCents ? b : a)) : null;
  return { days: r.days.length, lowest: lowest ? { day: lowest.day, balanceCents: lowest.balanceCents } : null };
}
