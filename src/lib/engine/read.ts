import { desc, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { compareLines } from "./rank";
import type { Answer } from "./needs-you";

/**
 * What a screen reads. Lookups only: the engine wrote these; nothing here computes.
 *
 * Today is four reads — the open list, the feed states, the latest run of each proof, the months — and nothing
 * else, whatever the day holds. The old home page ran thirty modules' queries on every open.
 */

export type TodayLine = {
  id: string;
  kind: string;
  rank: number;
  title: string;
  detail: string | null;
  amountCents: number | null;
  href: string | null;
  answers: Answer[];
  rows: unknown;
  firstSeen: string;
};

export type TodayView = {
  lines: TodayLine[];
  feeds: { key: string; name: string; state: string; says: string | null; lastDue: string | null; nextDue: string | null }[];
  proofs: { proof: string; scope: string | null; runAt: string; passed: boolean; says: string }[];
  months: (typeof schema.monthStatus.$inferSelect)[];
  engine: { lastRun: string | null; lastRebuild: string | null; error: string | null };
};

export async function todayView(): Promise<TodayView> {
  const [open, feeds, proofs, months, runs] = await Promise.all([
    db.query.needsYou.findMany({ where: isNull(schema.needsYou.resolvedAt) }),
    db.query.feedState.findMany(),
    db.all(sql`select proof, scope, run_at, passed, says from proof_run p where run_at = (select max(run_at) from proof_run q where q.proof = p.proof and coalesce(q.scope, '') = coalesce(p.scope, '')) order by proof, scope`) as Promise<{ proof: string; scope: string | null; run_at: string; passed: number; says: string }[]>,
    db.query.monthStatus.findMany({ orderBy: [desc(schema.monthStatus.month)], limit: 3 }),
    db.query.engineRun.findMany({ orderBy: [desc(schema.engineRun.startedAt)], limit: 6 }),
  ]);
  const lines: TodayLine[] = open
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      rank: r.rank,
      title: r.title,
      detail: r.detail,
      amountCents: r.amountCents,
      href: r.href,
      answers: r.answers ? (JSON.parse(r.answers) as Answer[]) : [],
      rows: r.rowsJson ? JSON.parse(r.rowsJson) : null,
      firstSeen: r.firstSeen,
    }))
    .sort(compareLines);
  const lastRebuild = runs.find((r) => r.kind === "rebuild")?.startedAt ?? null;
  return {
    lines,
    feeds: feeds.map((f) => ({ key: f.key, name: f.name, state: f.state, says: f.says, lastDue: f.lastDue, nextDue: f.nextDue })),
    proofs: proofs.map((p) => ({ proof: p.proof, scope: p.scope, runAt: p.run_at, passed: Boolean(p.passed), says: p.says })),
    months,
    engine: { lastRun: runs[0]?.finishedAt ?? runs[0]?.startedAt ?? null, lastRebuild, error: runs[0]?.error ?? null },
  };
}

export type MoneyView = {
  month: typeof schema.monthStatus.$inferSelect | null;
  months: string[];
  lines: { id: string; on: string; description: string; amountCents: number; placedAs: string; why: string | null; state: "booked" | "confirmed" | "needs_you" }[];
  proofs: { proof: string; scope: string | null; runAt: string; passed: boolean; says: string }[];
  cashAhead: (typeof schema.cashAhead.$inferSelect)[];
  cashAssumptions: { computedAt: string; from: string; openingCents: number | null; openingFrom: string | null; assumptions: string[] } | null;
  standing: { name: string; amountCents: number }[];
};

/** Money: the month's figures, its bank lines as the matcher left them, its proofs, and the four weeks ahead. */
export async function moneyView(month: string): Promise<MoneyView> {
  const { bankReview } = await import("../bank-review-store");
  const [status, all, review, proofs, cash, assumptionRows, standing] = await Promise.all([
    db.query.monthStatus.findFirst({ where: (t, { eq }) => eq(t.month, month) }),
    db.query.monthStatus.findMany({ columns: { month: true }, orderBy: [desc(schema.monthStatus.month)] }),
    bankReview(month),
    db.all(sql`select proof, scope, run_at, passed, says from proof_run p where coalesce(scope, '') = ${month} and run_at = (select max(run_at) from proof_run q where q.proof = p.proof and coalesce(q.scope, '') = coalesce(p.scope, '')) order by proof`) as Promise<{ proof: string; scope: string | null; run_at: string; passed: number; says: string }[]>,
    db.query.cashAhead.findMany({ orderBy: (t, { asc }) => [asc(t.day)] }),
    db.all(sql`select value from settings where key = 'cash_ahead_assumptions'`) as Promise<{ value: string | null }[]>,
    db.query.standingCosts.findMany({ columns: { name: true, amountCents: true } }),
  ]);
  let cashAssumptions: MoneyView["cashAssumptions"] = null;
  try {
    cashAssumptions = assumptionRows[0]?.value ? JSON.parse(assumptionRows[0].value) : null;
  } catch {
    cashAssumptions = null;
  }
  return {
    month: status ?? null,
    months: all.map((m) => m.month),
    lines: review.lines.map((l) => ({ id: l.id, on: l.on, description: l.description, amountCents: l.amountCents, placedAs: l.placedAs, why: l.why, state: l.state })),
    proofs: proofs.map((p) => ({ proof: p.proof, scope: p.scope, runAt: p.run_at, passed: Boolean(p.passed), says: p.says })),
    cashAhead: cash,
    cashAssumptions,
    standing: standing.map((s) => ({ name: s.name, amountCents: s.amountCents })),
  };
}

export type SuppliersView = {
  suppliers: { supplier: string; invoices: number; totalCents: number; openInvoices: number; openCents: number; oldestOpen: string | null; lastInvoice: string | null; controlled: number; nextDraw: { dueOn: string; cents: number; statementDate: string; invoices: number } | null; statements: number; lastStatement: string | null }[];
  draws: { supplier: string; dueOn: string; cents: number; statementDate: string; invoices: number }[];
};

/** Suppliers: the month's invoices by wholesaler, what is still open, the next draw each statement names, the statements on file. */
export async function suppliersView(month: string): Promise<SuppliersView> {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const { openStatementDebits } = await import("./statement-debits");
  const [invoices, debits, statements] = await Promise.all([
    db.all(sql`select supplier, count(*) n, coalesce(sum(total_cents), 0) total, sum(case when paid_on is null then 1 else 0 end) open_n, coalesce(sum(case when paid_on is null then total_cents else 0 end), 0) open_c, min(case when paid_on is null then invoice_date end) oldest_open, max(invoice_date) last_invoice, sum(case when schedule = 'schedule_2' then 1 else 0 end) controlled from supplier_invoices where invoice_date >= ${from} and invoice_date <= ${to} group by supplier order by total desc`) as Promise<{ supplier: string; n: number; total: number; open_n: number; open_c: number; oldest_open: string | null; last_invoice: string | null; controlled: number }[]>,
    openStatementDebits(),
    db.all(sql`select supplier, count(distinct statement_date) n, max(statement_date) last from supplier_statement_lines where statement_date is not null group by supplier`) as Promise<{ supplier: string; n: number; last: string | null }[]>,
  ]);
  const fold = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    suppliers: invoices.map((r) => {
      const next = debits.filter((d) => fold(d.supplier) === fold(r.supplier)).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] ?? null;
      const mine = statements.find((d) => fold(d.supplier) === fold(r.supplier)) ?? null;
      return {
        supplier: r.supplier,
        invoices: r.n,
        totalCents: r.total,
        openInvoices: r.open_n,
        openCents: r.open_c,
        oldestOpen: r.oldest_open,
        lastInvoice: r.last_invoice,
        controlled: r.controlled,
        nextDraw: next ? { dueOn: next.dueOn, cents: next.netCents, statementDate: next.statementDate, invoices: next.invoices.length } : null,
        statements: mine?.n ?? 0,
        lastStatement: mine?.last ?? null,
      };
    }),
    draws: debits.map((d) => ({ supplier: d.supplier, dueOn: d.dueOn, cents: d.netCents, statementDate: d.statementDate, invoices: d.invoices.length })),
  };
}

export type RemitsView = {
  remits: { id: string; payer: string; remitOn: string | null; amountCents: number; paymentNumber: string | null; source: string | null; banked: string | null }[];
  totalCents: number;
  bankedCents: number;
  mtf: { day: string; cents: number; payments: number }[];
};

/** Remits: the month's remittances in the register, each with what stands for it at the bank, and the facilitator's days. */
export async function remitsView(month: string): Promise<RemitsView> {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const { remitStanding } = await import("./remit-standing");
  const [standing, mtf] = await Promise.all([
    remitStanding(),
    db.all(sql`select received_on day, sum(amount_cents) cents, count(*) n from claim_payments where source = 'mtf' and received_on >= ${from} and received_on <= ${to} group by received_on order by received_on`) as Promise<{ day: string; cents: number; n: number }[]>,
  ]);
  const rows = standing.filter(({ row }) => row.remitOn && row.remitOn >= from && row.remitOn <= to).sort((a, b) => (a.row.remitOn ?? "").localeCompare(b.row.remitOn ?? ""));
  return {
    remits: rows.map(({ row, banked }) => ({ id: row.id, payer: row.payerName ?? "payer", remitOn: row.remitOn, amountCents: row.amountCents, paymentNumber: row.paymentNumber, source: row.source, banked })),
    totalCents: rows.reduce((n, r) => n + r.row.amountCents, 0),
    bankedCents: rows.filter((r) => r.banked).reduce((n, r) => n + r.row.amountCents, 0),
    mtf: mtf.map((m) => ({ day: m.day, cents: m.cents, payments: m.n })),
  };
}

export type SpendingView = {
  categories: { category: string; kind: string | null; cents: number; bills: number }[];
  bills: { id: string; invoiceDate: string; paidOn: string | null; vendor: string | null; category: string | null; amountCents: number; description: string | null; source: string | null }[];
  standing: { name: string; amountCents: number; paidDay: number | null; category: string | null }[];
  totalCents: number;
};

/** Spending: the month's bills by category, each bill, and the standing costs. Wholesaler invoices are not here: they are cost of goods, on Suppliers. */
export async function spendingView(month: string): Promise<SpendingView> {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [bills, standing] = await Promise.all([
    db.all(sql`select e.id, e.invoice_date, e.paid_on, e.amount_cents, e.description, e.source, v.name vendor, c.name category, c.kind kind from expenses e left join vendors v on v.id = e.vendor_id left join expense_categories c on c.id = e.category_id where e.status <> 'void' and e.invoice_date >= ${from} and e.invoice_date <= ${to} order by e.invoice_date desc`) as Promise<{ id: string; invoice_date: string; paid_on: string | null; amount_cents: number; description: string | null; source: string | null; vendor: string | null; category: string | null; kind: string | null }[]>,
    db.all(sql`select s.name, s.amount_cents, s.paid_day, c.name category from standing_costs s left join expense_categories c on c.id = s.category_id where (s.from_month is null or s.from_month <= ${month}) and (s.to_month is null or s.to_month >= ${month}) order by s.amount_cents desc`) as Promise<{ name: string; amount_cents: number; paid_day: number | null; category: string | null }[]>,
  ]);
  const byCat = new Map<string, { category: string; kind: string | null; cents: number; bills: number }>();
  for (const b of bills) {
    const k = b.category ?? "Uncategorised";
    const e = byCat.get(k) ?? { category: k, kind: b.kind, cents: 0, bills: 0 };
    e.cents += b.amount_cents;
    e.bills++;
    byCat.set(k, e);
  }
  for (const s of standing) {
    const k = s.category ?? "Standing costs";
    const e = byCat.get(k) ?? { category: k, kind: "standing", cents: 0, bills: 0 };
    e.cents += s.amount_cents;
    e.bills++;
    byCat.set(k, e);
  }
  const categories = [...byCat.values()].sort((a, b) => b.cents - a.cents);
  return {
    categories,
    bills: bills.map((b) => ({ id: b.id, invoiceDate: b.invoice_date, paidOn: b.paid_on, vendor: b.vendor, category: b.category, amountCents: b.amount_cents, description: b.description, source: b.source })),
    standing: standing.map((s) => ({ name: s.name, amountCents: s.amount_cents, paidDay: s.paid_day, category: s.category })),
    totalCents: categories.reduce((n, c) => n + c.cents, 0),
  };
}

export type DeliveriesView = { month: string; weekdays: number; entered: number; missing: string[]; deliveries: number; mailTrips: number; trips: number; totalCents: number; rateCents: number; complete: boolean; invoice: { number: string | null; status: string; sentAt: string | null; sentTo: string | null; totalCents: number } | null; changedSinceSent: boolean };

/** Deliveries: the month's trips as entered, and the driver invoice's state. */
export async function deliveriesView(month: string): Promise<DeliveriesView> {
  const { monthState } = await import("../deliveries");
  const m = await monthState(month);
  return {
    month: m.month,
    weekdays: m.weekdays,
    entered: m.entered,
    missing: m.missing,
    deliveries: m.deliveries,
    mailTrips: m.mailTrips,
    trips: m.trips,
    totalCents: m.totalCents,
    rateCents: m.rateCents,
    complete: m.complete,
    invoice: m.invoice ? { number: m.invoice.invoiceNumber, status: m.invoice.status, sentAt: m.invoice.sentAt, sentTo: m.invoice.sentTo, totalCents: m.invoice.totalCents } : null,
    changedSinceSent: m.changedSinceSent,
  };
}

/* ───────────────────────────── Claims ───────────────────────────── */

export type Leg = {
  claimId: string;
  legKey: string;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  soldOn: string | null;
  itemName: string | null;
  payer: string;
  pcn: string | null;
  bin: string | null;
  route: string | null;
  programme: boolean;
  state: string;
  expectedCents: number;
  paidCents: number;
  shortCents: number;
  ageDays: number;
  cycleDays: number | null;
  dueOn: string | null;
  lastPaidOn: string | null;
  reasons: { group: string; reason: string; cents: number }[];
  decision: string | null;
  decisionNote: string | null;
};

export type PayerLine = {
  payer: string;
  legs: number;
  openLegs: number;
  owedCents: number;
  dueCents: number;
  dueLegs: number;
  bands: [number, number, number, number, number];
  oldestOpen: string | null;
  cycle: string;
  measured: boolean;
  programme: boolean;
  routes: string | null;
  paidLegs: number;
  paidCents: number;
  shortLegs: number;
  shortCents: number;
  overLegs: number;
  reversedPaidLegs: number;
  lastPaidOn: string | null;
};

export type UnmatchedPayment = { id: string; receivedOn: string | null; payer: string | null; source: string; amountCents: number; rxNumber: string; fillNumber: number | null; dateFilled: string | null; reference: string | null; onRxAndDate: number; onRx: number };

export type ClaimsView = {
  computedAt: string | null;
  figures: { legs: number; owedCents: number; owedLegs: number; dueCents: number; dueLegs: number; paidThisMonthCents: number; shortCents: number; shortLegs: number; unmatchedCents: number; unmatchedLegs: number; reversedPaidCents: number; reversedPaidLegs: number };
  byPayer: PayerLine[];
  unpaid: Leg[];
  short: Leg[];
  shortByReason: { reason: string; legs: number; cents: number }[];
  unmatched: UnmatchedPayment[];
  preBooks: { payments: number; cents: number };
  decided: Leg[];
  payer: string | null;
};

const LEG_SQL = sql`claim_id, leg_key, rx_number, fill_number, date_filled, sold_on, item_name, payer, pcn, bin, route, programme, state, expected_cents, paid_cents, short_cents, age_days, cycle_days, due_on, last_paid_on, reasons, decision, decision_note`;
type LegRow = { claim_id: string; leg_key: string; rx_number: string; fill_number: number | null; date_filled: string; sold_on: string | null; item_name: string | null; payer: string; pcn: string | null; bin: string | null; route: string | null; programme: number; state: string; expected_cents: number; paid_cents: number; short_cents: number; age_days: number; cycle_days: number | null; due_on: string | null; last_paid_on: string | null; reasons: string | null; decision: string | null; decision_note: string | null };
const leg = (r: LegRow): Leg => ({
  claimId: r.claim_id,
  legKey: r.leg_key,
  rxNumber: r.rx_number,
  fillNumber: r.fill_number,
  dateFilled: r.date_filled,
  soldOn: r.sold_on,
  itemName: r.item_name,
  payer: r.payer,
  pcn: r.pcn,
  bin: r.bin,
  route: r.route,
  programme: !!r.programme,
  state: r.state,
  expectedCents: r.expected_cents,
  paidCents: r.paid_cents,
  shortCents: r.short_cents,
  ageDays: r.age_days,
  cycleDays: r.cycle_days,
  dueOn: r.due_on,
  lastPaidOn: r.last_paid_on,
  reasons: r.reasons ? (JSON.parse(r.reasons) as { group: string; reason: string; cents: number }[]) : [],
  decision: r.decision,
  decisionNote: r.decision_note,
});

/**
 * Claims: the standing of every leg in the books (engine/claims.ts), as six figures, a line per payer, and the
 * lists — what is unpaid, what was paid short and why, the payments that found no claim, and what a person has
 * decided. A payer narrows the lists and the figures to that payer.
 */
export async function claimsView(today: string, filter: { payer?: string | null } = {}): Promise<ClaimsView> {
  const { OPEN_STATES, TERMINAL_DECISIONS } = await import("./claims");
  const { SITE_STARTS_ON } = await import("../books-start");
  const payer = filter.payer?.trim() || null;
  const month = today.slice(0, 7);
  const [rows, paidMonth, unmatchedRows, preBooks, computed] = await Promise.all([
    db.all(payer ? sql`select ${LEG_SQL} from claim_standing where payer = ${payer} order by date_filled, rx_number` : sql`select ${LEG_SQL} from claim_standing order by date_filled, rx_number`) as Promise<LegRow[]>,
    db.all(sql`select coalesce(sum(p.amount_cents), 0) c from claim_payments p join claim_standing s on s.claim_id = p.claim_id where p.source <> 'mtf' and p.out_of_books = 0 and p.received_on >= ${month + "-01"} and p.received_on <= ${today}${payer ? sql` and s.payer = ${payer}` : sql``}`) as Promise<{ c: number }[]>,
    db.all(
      sql`select p.id, p.received_on, p.payer, p.source, p.amount_cents, p.rx_number, p.fill_number, p.date_filled, p.reference,
        (select count(*) from claims c where c.rx_number = p.rx_number and c.date_filled = p.date_filled) on_rx_date,
        (select count(*) from claims c where c.rx_number = p.rx_number) on_rx
        from claim_payments p where p.claim_id is null and p.out_of_books = 0 and (p.date_filled is null or p.date_filled >= ${SITE_STARTS_ON}) order by p.received_on desc, p.amount_cents desc limit 400`,
    ) as Promise<{ id: string; received_on: string | null; payer: string | null; source: string; amount_cents: number; rx_number: string; fill_number: number | null; date_filled: string | null; reference: string | null; on_rx_date: number; on_rx: number }[]>,
    db.all(sql`select count(*) n, coalesce(sum(amount_cents), 0) c from claim_payments where claim_id is null and out_of_books = 0 and date_filled < ${SITE_STARTS_ON}`) as Promise<{ n: number; c: number }[]>,
    db.all(sql`select max(computed_at) at from claim_standing`) as Promise<{ at: string | null }[]>,
  ]);
  const legs = rows.map(leg);
  const open = (l: Leg) => OPEN_STATES.has(l.state as never) && !TERMINAL_DECISIONS.has(l.decision ?? "");
  const band = (age: number) => (age <= 7 ? 0 : age <= 14 ? 1 : age <= 30 ? 2 : age <= 60 ? 3 : 4);
  const byPayer = new Map<string, PayerLine>();
  const f = { legs: legs.length, owedCents: 0, owedLegs: 0, dueCents: 0, dueLegs: 0, paidThisMonthCents: paidMonth[0]?.c ?? 0, shortCents: 0, shortLegs: 0, unmatchedCents: 0, unmatchedLegs: 0, reversedPaidCents: 0, reversedPaidLegs: 0 };
  for (const l of legs) {
    const e = byPayer.get(l.payer) ?? { payer: l.payer, legs: 0, openLegs: 0, owedCents: 0, dueCents: 0, dueLegs: 0, bands: [0, 0, 0, 0, 0] as [number, number, number, number, number], oldestOpen: null, cycle: "", measured: false, programme: l.programme, routes: null, paidLegs: 0, paidCents: 0, shortLegs: 0, shortCents: 0, overLegs: 0, reversedPaidLegs: 0, lastPaidOn: null };
    e.legs++;
    if (l.cycleDays !== null && !l.programme) e.measured = true;
    if (l.route) e.routes = [...new Set([...(e.routes ?? "").split(", ").filter(Boolean), ...l.route.split(", ")])].join(", ");
    if (l.lastPaidOn && (!e.lastPaidOn || l.lastPaidOn > e.lastPaidOn)) e.lastPaidOn = l.lastPaidOn;
    if (open(l)) {
      e.openLegs++;
      e.owedCents += l.shortCents;
      e.bands[band(l.ageDays)] += l.shortCents;
      if (!e.oldestOpen || l.dateFilled < e.oldestOpen) e.oldestOpen = l.dateFilled;
      f.owedCents += l.shortCents;
      f.owedLegs++;
      if (l.state === "due") {
        e.dueCents += l.shortCents;
        e.dueLegs++;
        f.dueCents += l.shortCents;
        f.dueLegs++;
      }
      if (l.state === "short") {
        e.shortLegs++;
        e.shortCents += l.shortCents;
        f.shortCents += l.shortCents;
        f.shortLegs++;
      }
    }
    if (l.state === "paid" || l.state === "short" || l.state === "over") {
      e.paidLegs++;
      e.paidCents += l.paidCents;
    }
    if (l.state === "over") e.overLegs++;
    if (l.state === "reversed_paid") {
      e.reversedPaidLegs++;
      f.reversedPaidLegs++;
      f.reversedPaidCents += l.paidCents;
    }
    byPayer.set(l.payer, e);
  }
  const cyclesByPayer = new Map<string, Set<number>>();
  for (const l of legs) if (l.cycleDays !== null) cyclesByPayer.set(l.payer, (cyclesByPayer.get(l.payer) ?? new Set()).add(l.cycleDays));
  for (const e of byPayer.values()) {
    const cs = [...(cyclesByPayer.get(e.payer) ?? [])].sort((a, b) => a - b);
    e.cycle = cs.length === 0 ? (e.programme ? "programme" : "not measured") : cs.length === 1 ? `${cs[0]} days` : `${cs[0]}–${cs[cs.length - 1]} days by plan`;
  }
  const unmatched: UnmatchedPayment[] = unmatchedRows.map((r) => ({ id: r.id, receivedOn: r.received_on, payer: r.payer, source: r.source, amountCents: r.amount_cents, rxNumber: r.rx_number, fillNumber: r.fill_number, dateFilled: r.date_filled, reference: r.reference, onRxAndDate: r.on_rx_date, onRx: r.on_rx }));
  f.unmatchedLegs = unmatched.length;
  f.unmatchedCents = unmatched.reduce((n, u) => n + u.amountCents, 0);
  const short = legs.filter((l) => l.state === "short" && !TERMINAL_DECISIONS.has(l.decision ?? ""));
  const reasonTally = new Map<string, { legs: number; cents: number }>();
  for (const l of short) {
    const keys = l.reasons.filter((r) => r.group !== "PR").map((r) => `${r.group}-${r.reason}`);
    for (const k of keys.length ? keys : ["no reasons on file"]) {
      const t = reasonTally.get(k) ?? { legs: 0, cents: 0 };
      t.legs++;
      t.cents += keys.length ? l.reasons.filter((r) => `${r.group}-${r.reason}` === k).reduce((n, r) => n + r.cents, 0) : l.shortCents;
      reasonTally.set(k, t);
    }
  }
  return {
    computedAt: computed[0]?.at ?? null,
    figures: f,
    byPayer: [...byPayer.values()].sort((a, b) => b.owedCents - a.owedCents || b.legs - a.legs),
    unpaid: legs.filter((l) => open(l) && l.state !== "short").sort((a, b) => a.dateFilled.localeCompare(b.dateFilled)),
    short,
    shortByReason: [...reasonTally].map(([reason, t]) => ({ reason, ...t })).sort((a, b) => b.cents - a.cents),
    unmatched: payer ? unmatched.filter((u) => (u.payer ?? "").toLowerCase().includes(payer.toLowerCase())) : unmatched,
    preBooks: { payments: preBooks[0]?.n ?? 0, cents: preBooks[0]?.c ?? 0 },
    decided: legs.filter((l) => l.decision).sort((a, b) => b.dateFilled.localeCompare(a.dateFilled)),
    payer,
  };
}

/* ───────────────────────────── Compliance ───────────────────────────── */

export type ComplianceView = {
  today: string;
  figures: { missed: number; partial: number; dueSoon: number; unsignedMonths: number; cqiDays: number | null; csDays: number | null; staffGaps: number; unanswered: number };
  register: { missed: import("../compliance-status").OpenItem[]; partial: import("../compliance-status").OpenItem[]; openNow: import("../compliance-status").OpenItem[]; unanswered: import("../compliance-status").Unanswered[]; minutesOutstanding: number };
  due: import("../due").DueItem[];
  temps: {
    sensors: { id: string; name: string; kind: string; tracked: boolean; minTenthsF: number; maxTenthsF: number; lastReadingAt: string | null; calibration: { state: string; daysLeft: number | null; says: string } }[];
    awaiting: { sensorId: string; sensorName: string; periodKey: string; readings: number; unexplained: number }[];
    unexplained: { id: string; sensorId: string; sensorName: string; takenAt: string; valueTenthsF: number; rangeMin: number; rangeMax: number; note: string | null }[];
    readingsLast24h: number;
    connected: boolean;
  };
  cqi: { snapshot: import("../compliance").CqiSnapshot; stages: { id: string; incidentNumber: number; type: string; reportCreatedOn: string; stage: { key: string; label: string; next: string; dueOn: string | null; level: string; automatic: boolean } }[]; carried: { openReviews: number; thin: number; ineffective: number; capMissing: number; any: boolean } };
  controlled: { inventory: { last: string | null; dueOn: string | null; count: number }; discrepancies: { id: string; discoveredOn: string; drugName: string; schedule: string; expectedThousandths: number | null; countedThousandths: number | null; unit: string | null; resolution: string | null; resolvedOn: string | null; reportedToDea: boolean }[]; requirements: { key: string; title: string; state: string; says: string }[]; perpetual: import("./perpetual").PerpetualReport | null };
  staff: import("../staff-matrix").StaffMatrix;
  manual: { standing: import("../manual-store").ManualStanding; audit: import("../manual-audit").AuditProgress; ack: { superseded: number; missing: number; changedOn: string | null }; decisionsOutstanding: number };
  inspection: { report: import("../inspection").InspectionReport; progress: import("../self-inspection").InspectionProgress | null; findings: import("../self-inspection").OpenFinding[]; lastCompleted: string | null; baas: { total: number; live: number; problems: number; ok: boolean; summary: string } };
};

/**
 * Compliance: every duty the site tracks, as the libraries that already judge them say it — the register's periods,
 * the renewal and training list, the temperature months, the CQI period and its incidents, the controlled-substance
 * inventory and discrepancies with the perpetual Schedule II count beside them, the staff matrix, the manual's
 * standing, the inspection report. One view, so the figures at the top and the tabs below cannot disagree.
 */
export async function complianceView(today: string): Promise<ComplianceView> {
  const [cs, due, cqiLib, compliance, imonnit, calibrationLib, staffMatrixLib, manualStore, manualAudit, manualAck, decisions, inspectionLib, selfInspection, baaLib, invoiceCompliance, perpetualLib] = await Promise.all([
    import("../compliance-status"),
    import("../due"),
    import("../cqi"),
    import("../compliance"),
    import("../imonnit"),
    import("../calibration"),
    import("../staff-matrix"),
    import("../manual-store"),
    import("../manual-audit"),
    import("../manual-acknowledgement"),
    import("../practice-decisions"),
    import("../inspection"),
    import("../self-inspection"),
    import("../business-associates"),
    import("../invoice-compliance"),
    import("./perpetual"),
  ]);
  const quiet = async <T,>(f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return fallback;
    }
  };
  const [summary, dueList, snapshot, stages, carried, csStatus, sensors, awaiting, unexplained, recent, connected, matrix, standing, audit, ack, outstanding, report, current, findings, history, baas, requirements, perpetual, discrepancies] = await Promise.all([
    cs.complianceSummary(),
    due.dueList({ horizonDays: 90 }),
    compliance.cqiSnapshot(),
    cqiLib.incidentsWithStage(),
    quiet(
      async () => {
        const c = await cqiLib.carriedForward((await cqiLib.currentCqiObligation()).period.periodStart);
        return { openReviews: c.openReviews.length, thin: c.thin.length, ineffective: c.ineffective.length, capMissing: c.capMissing.length, any: c.any };
      },
      { openReviews: 0, thin: 0, ineffective: 0, capMissing: 0, any: false },
    ),
    compliance.csInventoryStatus(),
    imonnit.trackedSensors(),
    imonnit.monthsAwaitingSignOff(),
    imonnit.unexplainedExcursions(50),
    imonnit.recentReadings(500),
    imonnit.hasCredentials(),
    staffMatrixLib.staffMatrix(),
    manualStore.manualStanding(),
    manualAudit.auditProgress(),
    manualAck.acknowledgementGap(),
    decisions.decisionsOutstanding(),
    inspectionLib.inspectionReport(),
    selfInspection.currentInspection(),
    selfInspection.openFindings(),
    selfInspection.history(),
    baaLib.registerStatus(),
    invoiceCompliance.invoiceCompliance(),
    quiet(() => perpetualLib.perpetualReport(today), null),
    db.query.csDiscrepancies.findMany({ orderBy: (d, { desc }) => [desc(d.discoveredOn)] }),
  ]);
  const progress = current ? await selfInspection.progress(current.id) : null;
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const cqiDays = snapshot.dueOn ? Math.round((Date.parse(`${snapshot.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5) : null;
  const csDays = csStatus.dueOn ? Math.round((Date.parse(`${csStatus.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5) : null;
  return {
    today,
    figures: {
      missed: summary.missed.length,
      partial: summary.partial.length,
      dueSoon: dueList.filter((d) => d.severity === "overdue" || d.severity === "due_soon" || d.severity === "no_date").length,
      unsignedMonths: awaiting.length,
      cqiDays,
      csDays,
      staffGaps: matrix.gaps,
      unanswered: summary.unanswered.length,
    },
    register: { missed: summary.missed, partial: summary.partial, openNow: summary.openNow, unanswered: summary.unanswered, minutesOutstanding: summary.minutesOutstanding },
    due: dueList,
    temps: {
      sensors: sensors.map((s) => {
        const c = calibrationLib.calibration(s, today);
        return { id: s.id, name: s.name, kind: s.kind, tracked: s.tracked, minTenthsF: s.minTenthsF, maxTenthsF: s.maxTenthsF, lastReadingAt: s.lastReadingAt, calibration: { state: c.state, daysLeft: c.daysLeft, says: c.says } };
      }),
      awaiting,
      unexplained: unexplained.map((r) => ({ id: r.id, sensorId: r.sensorId, sensorName: r.sensorName, takenAt: r.takenAt, valueTenthsF: r.valueTenthsF, rangeMin: r.rangeMin, rangeMax: r.rangeMax, note: r.note })),
      readingsLast24h: recent.filter((r) => r.takenAt >= dayAgo).length,
      connected,
    },
    cqi: {
      snapshot,
      stages: stages.map(({ incident, stage }) => ({ id: incident.id, incidentNumber: incident.incidentNumber, type: incident.type, reportCreatedOn: incident.reportCreatedOn, stage: { key: stage.key, label: stage.label, next: stage.next, dueOn: stage.dueOn, level: stage.level, automatic: stage.automatic } })),
      carried,
    },
    controlled: {
      inventory: csStatus,
      discrepancies: discrepancies.map((d) => ({ id: d.id, discoveredOn: d.discoveredOn, drugName: d.drugName, schedule: d.schedule, expectedThousandths: d.expectedThousandths, countedThousandths: d.countedThousandths, unit: d.unit, resolution: d.resolution, resolvedOn: d.resolvedOn, reportedToDea: !!d.reportedToDea })),
      requirements: requirements.map((r) => ({ key: r.key, title: r.requires, state: r.state, says: `${r.how}${r.state !== "ok" && r.fix ? ` ${r.fix}` : ""} (${r.citation})` })),
      perpetual,
    },
    staff: matrix,
    manual: { standing, audit, ack, decisionsOutstanding: outstanding },
    inspection: { report, progress, findings, lastCompleted: history.find((h) => h.completedOn)?.completedOn ?? null, baas },
  };
}

/* ───────────────────────────── Documents ───────────────────────────── */

export type DocumentsView = {
  arrived: { id: string; receivedAt: string; source: string; from: string | null; subject: string | null; fileName: string | null; documentId: string | null; routedAs: string | null; story: import("../inbox-line").LineStory; settledBy: string | null; needsAttention: boolean }[];
  held: number;
  retention: { kinds: { kind: string; documents: number; mayDestroy: number; keep: number; never: number; rule: string | null }[]; mayDestroy: { id: string; title: string | null; category: string | null; from: string | null; since: string; rule: string }[]; awaiting: { question: string; documents: number; categories: string[] }[]; undated: number };
  forms: { name: string; purpose: string; href: string; cadence: string; where: string; authority: string }[];
  appendixVersion: string | null;
  counts: { documents: number; categories: number; last30: number };
};

/**
 * Documents: what arrived and what the site did with it, what still needs a person, the retention clock over every
 * document on file, the forms the manual's appendix produces. Search is its own call (findAnything) because it takes
 * a query.
 */
export async function documentsView(today: string): Promise<DocumentsView> {
  const [inboxLine, settledLib, manual, retention] = await Promise.all([import("../inbox-line"), import("../inbox-settled"), import("../manual"), import("./retention")]);
  const [items, settled, docs, settings] = await Promise.all([
    db.query.inboxItems.findMany({ orderBy: (i, { desc }) => [desc(i.receivedAt)], limit: 200 }),
    settledLib.settledDocuments(),
    db.query.documents.findMany({ columns: { id: true, title: true, category: true, effectiveOn: true, uploadedAt: true, expiresOn: true, noExpiry: true } }),
    import("../settings").then((m) => m.getSettings()).catch(() => null),
  ]);
  const pharmacy = (settings as { pharmacy_name?: string | null } | null)?.pharmacy_name || "This pharmacy";
  const arrived = items.map((i) => {
    const story = inboxLine.storyOf(i);
    const settledBy = i.documentId ? (settled.get(i.documentId) ?? null) : null;
    const needsAttention = !settledBy && ["not_recognised", "rejected", "held"].includes(story.outcome);
    return { id: i.id, receivedAt: i.receivedAt, source: inboxLine.sourceOf(i).label, from: i.fromAddress ? i.fromAddress.replace(/^[^@]*@/, "@") : null, subject: i.subject, fileName: i.fileName, documentId: i.documentId, routedAs: i.routedAs, story, settledBy, needsAttention };
  });
  const kinds = new Map<string, { kind: string; documents: number; mayDestroy: number; keep: number; never: number; rule: string | null }>();
  const mayDestroy: DocumentsView["retention"]["mayDestroy"] = [];
  const awaiting = new Map<string, { question: string; documents: number; categories: Set<string> }>();
  let undated = 0;
  for (const d of docs) {
    const from = d.effectiveOn ?? d.uploadedAt?.slice(0, 10) ?? null;
    const v = retention.retentionOf(d.category, from, today);
    const kind = retention.kindOfCategory(d.category) ?? "unknown";
    const k = kinds.get(kind) ?? { kind, documents: 0, mayDestroy: 0, keep: 0, never: 0, rule: null };
    k.documents++;
    if (v.state === "keep") {
      k.keep++;
      k.rule = `${v.rule.years} years · ${v.rule.cite}`;
    } else if (v.state === "may_destroy") {
      k.mayDestroy++;
      k.rule = `${v.rule.years} years · ${v.rule.cite}`;
      mayDestroy.push({ id: d.id, title: d.title, category: d.category, from, since: v.since, rule: v.rule.cite });
    } else if (v.state === "never") {
      k.never++;
      k.rule = `never · ${v.rule.cite}`;
    } else {
      if (!from) undated++;
      const a = awaiting.get(v.question) ?? { question: v.question, documents: 0, categories: new Set<string>() };
      a.documents++;
      a.categories.add(d.category ?? "uncategorised");
      awaiting.set(v.question, a);
    }
    kinds.set(kind, k);
  }
  const forms = manual.FORMS.map((f) => ({ name: f.name, purpose: f.purpose, href: f.href, cadence: f.cadence, where: f.where, authority: f.authority }));
  let appendixVersion: string | null = null;
  try {
    appendixVersion = manual.appendixVersion(manual.policies(pharmacy));
  } catch {
    appendixVersion = null;
  }
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
  return {
    arrived,
    held: arrived.filter((a) => a.needsAttention).length,
    retention: {
      kinds: [...kinds.values()].sort((a, b) => b.documents - a.documents),
      mayDestroy: mayDestroy.sort((a, b) => a.since.localeCompare(b.since)),
      awaiting: [...awaiting.values()].map((a) => ({ question: a.question, documents: a.documents, categories: [...a.categories] })).sort((a, b) => b.documents - a.documents),
      undated,
    },
    forms,
    appendixVersion,
    counts: { documents: docs.length, categories: new Set(docs.map((d) => d.category ?? "")).size, last30: docs.filter((d) => (d.uploadedAt ?? "") >= monthAgo).length },
  };
}

/* ───────────────────────────── Month-end pack ───────────────────────────── */

export type PackView = {
  month: string;
  figures: Awaited<ReturnType<typeof moneyView>>["month"];
  proofs: { proof: string; passed: boolean; says: string }[];
  accrual: import("../profit-and-loss").MonthlyPL | null;
  cash: import("../profit-and-loss").MonthlyPL | null;
  salesTax: import("./sales-tax").TaxMonth;
  rebates: import("./rebates").RebateMonth[];
  claims: { legs: number; owedCents: number; dueCents: number; paidLegs: number; shortLegs: number; shortCents: number };
  compliance: { missed: number; partial: number; cqi: string; cs: string };
  open: { bankLines: number; questions: number };
  closedAt: string | null;
  /** Why the cash account and the bank are not the same figure: what the bank paid that the books, by his rule, count nowhere. */
  bridge: { bankChangeCents: number | null; cashChangeCents: number | null; beforeBooksPaidCents: number; beforeBooksReceivedCents: number; unplacedCents: number; notedCents: number; receiptsGapCents: number | null };
};

/**
 * The month-end pack: one page he can print, never sent anywhere. The month's bank to the cent and the receipts gap
 * named; the two accounts, accrual and cash; what the payers still owe on the month's fills; sales tax collected
 * against remitted; the wholesaler rebates expected, stated and received; where compliance stood; and what is still
 * open. Everything on it is a lookup of what the engine already proved; nothing is computed here.
 */
export async function packView(month: string, today: string): Promise<PackView> {
  const [m, pl, tax, reb, cs, compliance, standing, openLines, held] = await Promise.all([
    moneyView(month),
    import("../profit-and-loss"),
    import("./sales-tax").then((x) => x.salesTaxMonths(today, [month])),
    import("./rebates").then((x) => x.rebateMonths(today, [month])),
    import("../compliance-status").then((x) => x.complianceSummary()).catch(() => null),
    import("../compliance"),
    db.all(sql`select state, short_cents cents, decision from claim_standing where date_filled >= ${month + "-01"} and date_filled <= ${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)}`) as Promise<{ state: string; cents: number; decision: string | null }[]>,
    db.all(sql`select count(*) n from needs_you where resolved_at is null`) as Promise<{ n: number }[]>,
    db.query.monthStatus.findFirst({ where: (t, { eq }) => eq(t.month, month) }),
  ]);
  const kinds = (await db.all(sql`select placed_as || case when amount_cents < 0 then ':out' else ':in' end kind, coalesce(sum(amount_cents), 0) cents from bank_lines where "on" >= ${month + "-01"} and "on" <= ${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)} and placed_as in ('before_books', 'unplaced', 'noted') group by 1`)) as { kind: string; cents: number }[];
  const kind = (k: string) => kinds.filter((x) => x.kind.startsWith(k)).reduce((n, x) => n + x.cents, 0);
  const quiet = async <T,>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  const [accrual, cash, cqi, csInv] = await Promise.all([quiet(() => pl.monthlyAccount(month, "accrual")), quiet(() => pl.monthlyAccount(month, "cash")), quiet(() => compliance.cqiSnapshot()), quiet(() => compliance.csInventoryStatus())]);
  const { OPEN_STATES, TERMINAL_DECISIONS } = await import("./claims");
  const claims = { legs: standing.length, owedCents: 0, dueCents: 0, paidLegs: 0, shortLegs: 0, shortCents: 0 };
  for (const r of standing) {
    const terminal = TERMINAL_DECISIONS.has(r.decision ?? "");
    if (OPEN_STATES.has(r.state as never) && !terminal) claims.owedCents += r.cents;
    if (r.state === "due" && !terminal) claims.dueCents += r.cents;
    if (r.state === "paid" || r.state === "short" || r.state === "over") claims.paidLegs++;
    if (r.state === "short" && !terminal) {
      claims.shortLegs++;
      claims.shortCents += r.cents;
    }
  }
  return {
    month,
    figures: m.month,
    proofs: m.proofs.map((p) => ({ proof: p.proof, passed: p.passed, says: p.says })),
    accrual,
    cash,
    salesTax: tax[0],
    rebates: reb,
    claims,
    compliance: {
      missed: cs?.missed.length ?? 0,
      partial: cs?.partial.length ?? 0,
      cqi: cqi ? `${cqi.label}: ${cqi.status ?? "not started"}, due ${cqi.dueOn ?? "—"}` : "not read",
      cs: csInv ? (csInv.last ? `last inventory ${csInv.last}, next due ${csInv.dueOn}` : "no inventory on file") : "not read",
    },
    open: { bankLines: m.month?.bankOpenLines ?? 0, questions: openLines[0]?.n ?? 0 },
    closedAt: held?.closedAt ?? null,
    bridge: {
      bankChangeCents: m.month && m.month.bankOpeningCents !== null && m.month.bankClosingCents !== null ? m.month.bankClosingCents - m.month.bankOpeningCents : null,
      cashChangeCents: cash?.cashChangeCents ?? null,
      beforeBooksPaidCents: kind("before_books:out"),
      beforeBooksReceivedCents: kind("before_books:in"),
      unplacedCents: kind("unplaced"),
      notedCents: kind("noted"),
      receiptsGapCents: m.month?.receiptsGapCents ?? null,
    },
  };
}
