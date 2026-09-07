/**
 * Periods, pace and counts: the arithmetic that turns one month's account into a set of books.
 *
 * `profit-and-loss.ts` decides what belongs on each line of one month. This file never touches
 * that decision. It adds months into quarters and years line by line, scales a part-month to a
 * whole one and says so, counts the scripts, and compares the two bases. Pure, so every figure on
 * the Money dashboard can be checked against the months it was added from.
 *
 * The specification is `docs/reference/money-ledger.md`.
 */
import type { MonthlyPL, PLLine } from "./profit-and-loss";

export type PeriodKind = "month" | "quarter" | "year";

export type Period = {
  kind: PeriodKind;
  /** `2026-09`, `2026-Q3` or `2026`. The one string a URL carries. */
  key: string;
  label: string;
  /** Every month in the period, oldest first. */
  months: string[];
  from: string;
  to: string;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number) => String(n).padStart(2, "0");

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** The period a key names, or null where the key is not one. */
export function parsePeriod(key: string): Period | null {
  const k = key.trim();
  let m: RegExpMatchArray | null;
  if ((m = k.match(/^(\d{4})-(\d{2})$/))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    const month = `${y}-${pad(mo)}`;
    return { kind: "month", key: month, label: monthLabel(month), months: [month], from: `${month}-01`, to: `${month}-${pad(daysInMonth(month))}` };
  }
  if ((m = k.match(/^(\d{4})-Q([1-4])$/i))) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const months = [0, 1, 2].map((i) => `${y}-${pad((q - 1) * 3 + i + 1)}`);
    return { kind: "quarter", key: `${y}-Q${q}`, label: `Q${q} ${y}`, months, from: `${months[0]}-01`, to: `${months[2]}-${pad(daysInMonth(months[2]))}` };
  }
  if ((m = k.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    const months = Array.from({ length: 12 }, (_, i) => `${y}-${pad(i + 1)}`);
    return { kind: "year", key: String(y), label: String(y), months, from: `${y}-01-01`, to: `${y}-12-31` };
  }
  return null;
}

/** The period of a kind that contains a month. */
export function periodOf(kind: PeriodKind, month: string): Period {
  const [y, m] = month.split("-").map(Number);
  const key = kind === "month" ? month : kind === "quarter" ? `${y}-Q${Math.floor((m - 1) / 3) + 1}` : String(y);
  const p = parsePeriod(key);
  if (!p) throw new Error(`Not a month: ${month}`);
  return p;
}

/** The n periods of a kind ending with the one containing `month`, oldest first. */
export function periodsBack(kind: PeriodKind, month: string, n: number): Period[] {
  const out: Period[] = [];
  let p = periodOf(kind, month);
  for (let i = 0; i < n; i++) {
    out.unshift(p);
    p = periodOf(kind, previousMonth(p.months[0]));
  }
  return out;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** The period one step earlier and one later, for the page's arrows. */
export function neighbours(p: Period): { before: Period; after: Period } {
  return { before: periodOf(p.kind, previousMonth(p.months[0])), after: periodOf(p.kind, nextMonth(p.months[p.months.length - 1])) };
}

export type PeriodPL = {
  period: Period;
  basis: "accrual" | "cash";
  revenue: PLLine[];
  revenueCents: number;
  offsets: PLLine[];
  netRevenueCents: number;
  costOfGoods: PLLine[];
  costOfGoodsCents: number;
  grossProfitCents: number;
  grossMarginPercent: number | null;
  operating: PLLine[];
  operatingCents: number;
  netProfitCents: number;
  /** Cash basis only: what left the bank and is not a cost, and the change after it. */
  otherCashOut: PLLine[];
  otherCashOutCents: number;
  cashChangeCents: number | null;
  /** Null unless every month in the period could say. */
  stockMovementCents: number | null;
  /** Each month's account, so the period can be taken apart again. */
  months: MonthlyPL[];
  /** What is missing, named with the month it is missing from. */
  missing: string[];
  /**
   * What was computed and is known to lean, named with its month. Separate from `missing` because
   * the two call for different things: a missing line means the bottom line cannot be read, a
   * caveat means it can be read and is too high. A screen that shouts equally about both teaches
   * the reader to ignore it.
   */
  caveats: string[];
  usable: boolean;
};

/** Adds lines with the same label together, keeping the first note; order by size. */
function mergeLines(lists: PLLine[][]): PLLine[] {
  const by = new Map<string, PLLine>();
  for (const lines of lists) {
    for (const l of lines) {
      const have = by.get(l.label);
      if (have) have.amountCents += l.amountCents;
      else by.set(l.label, { label: l.label, amountCents: l.amountCents, ...(l.note ? { note: l.note } : {}) });
    }
  }
  return [...by.values()].sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
}

/**
 * A period is its months added line by line.
 *
 * The margin is recomputed on the sums rather than averaged: three months at 20%, 25% and 30% are
 * not a quarter at 25% unless they took the same money. What is missing stays named per month,
 * because "wages are missing" for a quarter is not actionable and "wages are missing for August" is.
 */
export function combineMonths(period: Period, months: MonthlyPL[]): PeriodPL {
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const basis = sorted[0]?.basis ?? "accrual";
  if (sorted.some((m) => m.basis !== basis)) throw new Error("A period is one basis or the other, never both.");
  const revenue = mergeLines(sorted.map((m) => m.revenue));
  const offsets = mergeLines(sorted.map((m) => m.offsets));
  const costOfGoods = mergeLines(sorted.map((m) => m.costOfGoods));
  const operating = mergeLines(sorted.map((m) => m.operating));
  const revenueCents = sorted.reduce((n, m) => n + m.revenueCents, 0);
  const netRevenueCents = sorted.reduce((n, m) => n + m.netRevenueCents, 0);
  const costOfGoodsCents = sorted.reduce((n, m) => n + m.costOfGoodsCents, 0);
  const grossProfitCents = netRevenueCents - costOfGoodsCents;
  const operatingCents = sorted.reduce((n, m) => n + m.operatingCents, 0);
  const otherCashOut = mergeLines(sorted.map((m) => m.otherCashOut ?? []));
  const otherCashOutCents = sorted.reduce((n, m) => n + (m.otherCashOutCents ?? 0), 0);
  const stock = sorted.map((m) => m.stockMovementCents);
  return {
    period,
    basis,
    revenue,
    revenueCents,
    offsets,
    netRevenueCents,
    costOfGoods,
    costOfGoodsCents,
    grossProfitCents,
    grossMarginPercent: netRevenueCents > 0 ? Math.round((grossProfitCents / netRevenueCents) * 1000) / 10 : null,
    operating,
    operatingCents,
    netProfitCents: grossProfitCents - operatingCents,
    otherCashOut,
    otherCashOutCents,
    cashChangeCents: basis === "cash" ? grossProfitCents - operatingCents - otherCashOutCents : null,
    stockMovementCents: stock.length > 0 && stock.every((s) => s !== null) ? stock.reduce((n, s) => n + (s ?? 0), 0) : null,
    months: sorted,
    missing: sorted.flatMap((m) => m.missing.map((s) => (sorted.length > 1 ? `${monthLabel(m.month)}: ${s}` : s))),
    caveats: sorted.flatMap((m) => (m.caveats ?? []).map((s) => (sorted.length > 1 ? `${monthLabel(m.month)}: ${s}` : s))),
    usable: sorted.length > 0 && sorted.every((m) => m.usable),
  };
}

export type Pace = {
  /** Days of the month with a claim in them, over the days the month has. */
  daysElapsed: number;
  daysInMonth: number;
  share: number;
  /** Dispensing figures scaled to the whole month. Null under three days: too little to call a pace. */
  netRevenueCents: number | null;
  grossProfitCents: number | null;
  /** Paced gross profit less the bills already in. Not a forecast of the bills. */
  netAfterBillsSoFarCents: number | null;
  says: string;
};

/**
 * Month to date, scaled to the whole month and said as such.
 *
 * Only the dispensing side is paced: revenue and cost of goods arrive every day the pharmacy is
 * open, so what the month has done so far says what it is doing. Bills do not — rent lands on the
 * first and payroll twice — so operating costs are shown as they stand and never multiplied.
 */
export function pace(pl: Pick<MonthlyPL, "month" | "netRevenueCents" | "grossProfitCents" | "operatingCents">, daysElapsed: number): Pace {
  const days = daysInMonth(pl.month);
  const elapsed = Math.max(0, Math.min(days, daysElapsed));
  const share = elapsed / days;
  if (elapsed < 3) {
    return { daysElapsed: elapsed, daysInMonth: days, share, netRevenueCents: null, grossProfitCents: null, netAfterBillsSoFarCents: null, says: "Too early in the month to call a pace." };
  }
  const scale = (c: number) => Math.round((c * days) / elapsed);
  const netRevenueCents = scale(pl.netRevenueCents);
  const grossProfitCents = scale(pl.grossProfitCents);
  return {
    daysElapsed: elapsed,
    daysInMonth: days,
    share,
    netRevenueCents,
    grossProfitCents,
    netAfterBillsSoFarCents: grossProfitCents - pl.operatingCents,
    says: `${elapsed} of ${days} days in. At this pace the month takes ${dollars(netRevenueCents)} and makes ${dollars(grossProfitCents)} before bills.`,
  };
}

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type FillForCount = { dateFilled: string; cashPlan: boolean; revenueCents: number };

export type ScriptCounts = {
  scripts: number;
  thirdParty: number;
  cash: number;
  /** Days with at least one fill. */
  daysWithFills: number;
  perDay: number | null;
  averageRevenueCents: number | null;
  /** One entry per month in the period, for the chart. */
  byMonth: { month: string; scripts: number; revenueCents: number }[];
};

/** Scripts are fills, one per bottle: a claim billed to two plans is one script. */
export function scriptCounts(fills: FillForCount[], period: Period): ScriptCounts {
  const inPeriod = fills.filter((f) => f.dateFilled >= period.from && f.dateFilled <= period.to);
  const days = new Set(inPeriod.map((f) => f.dateFilled));
  const byMonth = period.months.map((month) => {
    const mine = inPeriod.filter((f) => f.dateFilled.startsWith(month));
    return { month, scripts: mine.length, revenueCents: mine.reduce((n, f) => n + f.revenueCents, 0) };
  });
  const revenue = inPeriod.reduce((n, f) => n + f.revenueCents, 0);
  return {
    scripts: inPeriod.length,
    thirdParty: inPeriod.filter((f) => !f.cashPlan).length,
    cash: inPeriod.filter((f) => f.cashPlan).length,
    daysWithFills: days.size,
    perDay: days.size > 0 ? Math.round((inPeriod.length / days.size) * 10) / 10 : null,
    averageRevenueCents: inPeriod.length > 0 ? Math.round(revenue / inPeriod.length) : null,
    byMonth,
  };
}

export type BasisGap = {
  /** Earned less banked: what is still owed to the pharmacy on the period's sales. */
  receivableCents: number | null;
  /** Dispensed cost less paid: what the pharmacy still owes the wholesalers, or has prepaid. */
  payableCents: number | null;
  says: string;
};

/**
 * The two bases side by side, and the gap named for what it is.
 *
 * Accrual revenue less cash revenue is the receivable; accrual cost less cash cost is the
 * payable. Both are only meaningful when both accounts actually have the line — a cash account
 * with no receipts entered has no revenue, and a gap against nothing is not a receivable.
 */
export function basisGap(accrual: Pick<PeriodPL, "revenueCents" | "costOfGoodsCents" | "revenue" | "costOfGoods">, cash: Pick<PeriodPL, "revenueCents" | "costOfGoodsCents" | "revenue" | "costOfGoods">): BasisGap {
  const receivableCents = accrual.revenue.length > 0 && cash.revenue.length > 0 ? accrual.revenueCents - cash.revenueCents : null;
  const payableCents = accrual.costOfGoods.length > 0 && cash.costOfGoods.length > 0 ? accrual.costOfGoodsCents - cash.costOfGoodsCents : null;
  const parts: string[] = [];
  if (receivableCents !== null) parts.push(receivableCents >= 0 ? `${dollars(receivableCents)} earned and not yet banked` : `${dollars(-receivableCents)} banked beyond what was earned in the period`);
  if (payableCents !== null) parts.push(payableCents >= 0 ? `${dollars(payableCents)} of goods dispensed and not yet paid for` : `${dollars(-payableCents)} paid to the wholesalers beyond what was dispensed`);
  return { receivableCents, payableCents, says: parts.length ? parts.join("; ") + "." : "One of the two accounts has no figure to compare, so the gap cannot be named." };
}

/** A statement as rows for a CSV: group, label, cents, note. */
export function statementRows(pl: PeriodPL): { group: string; label: string; cents: number; note: string }[] {
  const rows: { group: string; label: string; cents: number; note: string }[] = [];
  const push = (group: string, lines: PLLine[]) => {
    for (const l of lines) rows.push({ group, label: l.label, cents: l.amountCents, note: l.note ?? "" });
  };
  push("Revenue", pl.revenue);
  push("Taken back out of revenue", pl.offsets.map((l) => ({ ...l, amountCents: -l.amountCents })));
  rows.push({ group: "Net revenue", label: "Net revenue", cents: pl.netRevenueCents, note: "" });
  push("Cost of goods", pl.costOfGoods);
  rows.push({ group: "Gross profit", label: "Gross profit", cents: pl.grossProfitCents, note: pl.grossMarginPercent !== null ? `${pl.grossMarginPercent}% of net revenue` : "" });
  push("Operating", pl.operating);
  const bottom = pl.basis === "cash" ? "Net cash from operations" : pl.netProfitCents < 0 ? "Net loss" : "Net profit";
  rows.push({ group: "Net", label: bottom, cents: pl.netProfitCents, note: pl.usable ? "" : "Not a complete account: " + pl.missing.join(" | ") });
  if (pl.basis === "cash") {
    push("Other cash out, not a cost", pl.otherCashOut);
    rows.push({ group: "Cash change", label: "Cash change", cents: pl.cashChangeCents ?? pl.netProfitCents, note: "Net cash from operations less loan principal, draws, equipment and tax" });
  }
  return rows;
}

/** RFC 4180 enough for a spreadsheet: quotes doubled, every cell quoted. */
export function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c] ?? "")).join(","))].join("\r\n") + "\r\n";
}
