import { and, eq, gte, lte, like, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { SITE_STARTS_ON } from "../books-start";
import { OPEN_STATES, TERMINAL_DECISIONS, type ClaimState } from "./claims";

/**
 * The month as the engine last computed it: the bank's figures, the receipts-to-bank gap with every dollar named,
 * accrual revenue at pickup, what the payers still owe, and whether the month can close.
 *
 * ── The receipts-to-bank gap, named ──
 *
 * Receipts dated in the month and the bank's deposits in the month are never equal, and the difference is not an
 * error: register days at the month's end reach the bank in the next month, and an IPD credit memo is a receipt
 * that never touches the bank at all (it nets against IPD's invoices). The old site showed the two totals and left
 * the reader to worry. This names each part of the gap, and only what is left unnamed is a proof failure.
 */

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function lastDayOf(month: string): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

/** The bank statement's own opening and closing, recorded when a statement is placed (bank.ts) or recovered from its scan. */
export async function recordMonthBalances(month: string, openingCents: number, closingCents: number, now = new Date().toISOString()): Promise<void> {
  const held = await db.query.monthStatus.findFirst({ where: eq(schema.monthStatus.month, month), columns: { month: true } });
  if (held) await db.update(schema.monthStatus).set({ bankOpeningCents: openingCents, bankClosingCents: closingCents, computedAt: now }).where(eq(schema.monthStatus.month, month));
  else await db.insert(schema.monthStatus).values({ month, bankOpeningCents: openingCents, bankClosingCents: closingCents, computedAt: now });
}

/**
 * The statement's balances where nothing recorded them: solved again from the filed statement's cached recognition.
 * Costs nothing the second time (ocr.ts caches per document) and nothing at all where no statement is filed.
 */
async function balancesFromStatement(month: string): Promise<{ openingCents: number; closingCents: number } | null> {
  const docs = await db.query.documents.findMany({ where: eq(schema.documents.category, "bank_statement"), columns: { id: true, title: true, fileName: true, storageKey: true } });
  const mm = month.slice(5, 7).replace(/^0/, "");
  const doc = docs.find((d) => (d.title ?? "").includes(month) || new RegExp(`^${mm}-${month.slice(0, 4)}_`).test(d.fileName ?? ""));
  if (!doc) return null;
  try {
    const { readFile } = await import("../files");
    const { pdfItems } = await import("../pdf-text");
    const { readRaw } = await import("../scanned-bank-statement");
    const { solveStatement } = await import("../scanned-bank-solve");
    const buf = await readFile(doc.storageKey);
    let items = pdfItems(buf);
    if (items.length === 0) {
      const { scanItemsForDocument } = await import("../ocr");
      items = await scanItemsForDocument(doc.id, buf);
    }
    const solved = solveStatement(readRaw(items), {});
    if (!solved.ok) return null;
    return { openingCents: solved.openingCents, closingCents: solved.closingCents };
  } catch {
    return null;
  }
}

export type MonthFigures = {
  month: string;
  bankOpeningCents: number | null;
  bankInCents: number;
  bankOutCents: number;
  bankClosingCents: number | null;
  bankLines: number;
  bankOpenLines: number;
  receiptsCents: number;
  receiptsGapCents: number;
  receiptsGapSays: string | null;
  accrualRevenueCents: number;
  cashInCents: number;
  cashOutCents: number | null;
  arUnpaidCents: number;
  arDueCents: number;
  closeState: "open" | "ready" | "closed";
};

export async function computeMonth(month: string, today: string): Promise<MonthFigures> {
  const from = `${month}-01`;
  const to = lastDayOf(month);
  const lines = await db.query.bankLines.findMany({ where: and(gte(schema.bankLines.on, from), lte(schema.bankLines.on, to)), columns: { id: true, amountCents: true, placedAs: true, receiptId: true } });
  const bankIn = lines.filter((l) => l.amountCents > 0).reduce((n, l) => n + l.amountCents, 0);
  const bankOut = -lines.filter((l) => l.amountCents < 0).reduce((n, l) => n + l.amountCents, 0);
  const open = lines.filter((l) => l.placedAs === "unplaced").length;

  /* Receipts dated in the month, and which of them a bank line stands behind. */
  const receipts = await db.query.cashReceipts.findMany({ where: and(gte(schema.cashReceipts.receivedOn, from), lte(schema.cashReceipts.receivedOn, to)), columns: { id: true, amountCents: true, kind: true, sourceKey: true, receivedOn: true } });
  const linked = new Set([
    ...(await db.query.bankLines.findMany({ columns: { receiptId: true } })).map((r) => r.receiptId).filter((x): x is string => x !== null),
    ...(await db.query.bankLineReceipts.findMany({ columns: { receiptId: true } })).map((r) => r.receiptId),
  ]);
  const receiptsCents = receipts.reduce((n, r) => n + r.amountCents, 0);
  const unlinked = receipts.filter((r) => !linked.has(r.id));
  const parts: { label: string; cents: number }[] = [];
  const bucket = (label: string, test: (r: (typeof receipts)[number]) => boolean) => {
    const xs = unlinked.filter(test);
    if (xs.length) parts.push({ label: `${label} ${money(xs.reduce((n, r) => n + r.amountCents, 0))}`, cents: xs.reduce((n, r) => n + r.amountCents, 0) });
  };
  bucket("credit memos that never touch the bank", (r) => (r.sourceKey ?? "").startsWith("rxrescue-memo|"));
  bucket("register days still to reach the bank", (r) => (r.sourceKey ?? "").startsWith("register") && r.receivedOn !== null && r.receivedOn >= new Date(Date.parse(`${to}T00:00:00Z`) - 4 * 864e5).toISOString().slice(0, 10));
  const named = parts.reduce((n, p) => n + p.cents, 0);
  const rest = unlinked.filter((r) => !((r.sourceKey ?? "").startsWith("rxrescue-memo|") || ((r.sourceKey ?? "").startsWith("register") && r.receivedOn !== null && r.receivedOn >= new Date(Date.parse(`${to}T00:00:00Z`) - 4 * 864e5).toISOString().slice(0, 10))));
  const restCents = rest.reduce((n, r) => n + r.amountCents, 0);
  const gap = receiptsCents - bankIn;
  const says = lines.length === 0 ? null : [...parts.map((p) => p.label), restCents ? `${rest.length} receipt${rest.length === 1 ? "" : "s"} with no bank line, ${money(restCents)}` : null].filter(Boolean).join("; ") || "every receipt has its bank line";

  /* Revenue at pickup: what the plan pays plus what the patient paid, on the day the patient collected. */
  const rev = (await db.all(sql`select coalesce(sum(remit_cents + copay_cents), 0) c from claims where status = 'paid' and coalesce(sold_on, date_filled) >= ${from} and coalesce(sold_on, date_filled) <= ${to} and coalesce(sold_on, date_filled) >= ${SITE_STARTS_ON}`)) as { c: number }[];

  /* What the payers owe on the month's fills, and how much of it is past its plan group's own measured cycle: the claim standing (engine/claims.ts), which Today and Cash ahead read too. */
  const standing = (await db.all(sql`select state, short_cents cents, decision from claim_standing where date_filled >= ${from} and date_filled <= ${to}`)) as { state: ClaimState; cents: number; decision: string | null }[];
  let arUnpaid = 0;
  let arDue = 0;
  for (const r of standing) {
    if (TERMINAL_DECISIONS.has(r.decision ?? "")) continue;
    if (OPEN_STATES.has(r.state)) arUnpaid += r.cents;
    if (r.state === "due") arDue += r.cents;
  }

  const held = await db.query.monthStatus.findFirst({ where: eq(schema.monthStatus.month, month) });
  let opening = held?.bankOpeningCents ?? null;
  let closing = held?.bankClosingCents ?? null;
  if ((opening === null || closing === null) && lines.length > 0) {
    const b = await balancesFromStatement(month);
    if (b) { opening = b.openingCents; closing = b.closingCents; }
  }
  const closeState: MonthFigures["closeState"] = held?.closeState === "closed" ? "closed" : lines.length > 0 && open === 0 && restCents === 0 && to < today ? "ready" : "open";
  return {
    month,
    bankOpeningCents: opening,
    bankInCents: bankIn,
    bankOutCents: bankOut,
    bankClosingCents: closing,
    bankLines: lines.length,
    bankOpenLines: open,
    receiptsCents,
    receiptsGapCents: gap,
    receiptsGapSays: says,
    accrualRevenueCents: rev[0]?.c ?? 0,
    cashInCents: receiptsCents,
    cashOutCents: lines.length ? bankOut : null,
    arUnpaidCents: arUnpaid,
    arDueCents: arDue,
    closeState,
  };
}

export async function writeMonth(month: string, today: string, now: string): Promise<MonthFigures> {
  const f = await computeMonth(month, today);
  const held = await db.query.monthStatus.findFirst({ where: eq(schema.monthStatus.month, month), columns: { month: true, closedAt: true } });
  const values = {
    bankOpeningCents: f.bankOpeningCents,
    bankInCents: f.bankInCents,
    bankOutCents: f.bankOutCents,
    bankClosingCents: f.bankClosingCents,
    bankLines: f.bankLines,
    bankOpenLines: f.bankOpenLines,
    receiptsCents: f.receiptsCents,
    receiptsGapCents: f.receiptsGapCents,
    receiptsGapSays: f.receiptsGapSays,
    accrualRevenueCents: f.accrualRevenueCents,
    cashInCents: f.cashInCents,
    cashOutCents: f.cashOutCents,
    arUnpaidCents: f.arUnpaidCents,
    arDueCents: f.arDueCents,
    closeState: f.closeState,
    computedAt: now,
  };
  if (held) await db.update(schema.monthStatus).set(values).where(eq(schema.monthStatus.month, month));
  else await db.insert(schema.monthStatus).values({ month, ...values });
  return f;
}

/** The months the engine keeps current: this one and the two before it, never before the books. */
export function monthsToKeep(today: string): string[] {
  const out: string[] = [];
  let d = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`));
  for (let i = 0; i < 3; i++) {
    const m = d.toISOString().slice(0, 7);
    if (m >= SITE_STARTS_ON.slice(0, 7)) out.push(m);
    d = new Date(d.getTime() - 864e5);
    d = new Date(Date.parse(`${d.toISOString().slice(0, 7)}-01T00:00:00Z`));
  }
  return out;
}

/** Marks a month closed. Only a person does this, and only when the month is ready. */
export async function closeMonth(month: string, now: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const m = await db.query.monthStatus.findFirst({ where: eq(schema.monthStatus.month, month) });
  if (!m) return { ok: false, why: "The engine has not computed that month yet." };
  if (m.closeState === "closed") return { ok: true };
  if (m.closeState !== "ready") return { ok: false, why: `${month} is not ready: ${m.bankOpenLines} bank line${m.bankOpenLines === 1 ? "" : "s"} open${m.receiptsGapSays ? `; ${m.receiptsGapSays}` : ""}.` };
  await db.update(schema.monthStatus).set({ closeState: "closed", closedAt: now }).where(eq(schema.monthStatus.month, month));
  return { ok: true };
}

/** Where a statement document for the month is filed, by title or file name — used by proofs to say "no statement" honestly. */
export async function statementOnFile(month: string): Promise<boolean> {
  const n = await db.query.documents.findMany({ where: and(eq(schema.documents.category, "bank_statement"), like(schema.documents.title, `%${month}%`)), columns: { id: true } });
  return n.length > 0;
}
