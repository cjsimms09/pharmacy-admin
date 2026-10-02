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
