import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { readFile } from "@/lib/files";
import { looksLikeAccountHistory, readAccountHistory, type AccountLine, type AccountMonth, type Sweep } from "@/lib/providerpay-account";
import { readBankDescriptor } from "@/lib/bank-descriptors";

/**
 * Which payer payments ProviderPay's own account history proves reached the bank.
 *
 * A receipt can be the right money under the wrong remittance. A $2,008.00 deposit reached the bank on 24 September 2026 and the site
 * labelled it with the remittance advised on the 23rd, the nearer of two advised for that amount; ProviderPay's account history shows
 * that same deposit under the payment number of the one advised on the 15th. Nothing the receipts held could tell the two $2,008.00
 * remittances apart, so the morning check flagged the 15th while its money sat in the cash account. The history can tell them apart: each
 * deposit carries the payer's payment number, the deposits leave in one sweep, and the sweep is a bank line.
 *
 * Which links of that chain are exact. Payment number to deposit: printed on the deposit. Deposit to sweep: arithmetic, because a
 * sweep takes everything deposited since the last one, and only sweeps whose deposits add up to their transfer are used. Sweep to
 * bank line: the one inexact link, an amount and a few days, so it is used only where the bank names the line as ProviderPay's own
 * transfer and it has been placed as payer money, each line is used once, and a payment number that appears under more than one
 * deposit proves nothing.
 *
 * Pure in `sweepDepositsFrom`, so each rule is tested by handing it a history and some lines; `loadSweepDeposits` only gathers.
 */
export type SweepDeposit = { paymentNumber: string; amountCents: number; lineReceiptIds: string[] };
export type BankLineRow = { id: string; on: string; amountCents: number; placedAs: string; description: string };

/** How long after ProviderPay moves money out the bank may show it: a transfer sent on a Friday is posted on Monday, and a holiday adds a day. */
export const SWEEP_TO_BANK_DAYS = 3;

/** A report this large is a drug or claims export, not a month of one account; it is never opened to look. */
const MAX_HISTORY_BYTES = 1_000_000;

/** The placements that say a bank line is payer money. A line nobody has placed is an amount and nothing else. */
const PAYER_MONEY = new Set(["banks_remits", "confirms_deposit", "deposit"]);

/*
 * ProviderPay's own transfer, and nothing else the bank calls a PSAO. An Access Health line is Health Mart Atlas's remittance paid
 * direct: no account history on file holds a Health Mart Atlas deposit, so no sweep makes it, and one that happened to share a sweep's
 * amount a day or two after it would otherwise be taken for the transfer and prove deposits it never carried.
 */
const isProviderPayTransfer = (l: BankLineRow) => {
  const meaning = readBankDescriptor(l.description, l.amountCents);
  return meaning.kind === "psao_remittance" && /providerpay/i.test(meaning.counterparty);
};

export const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
const daysAfter = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5;
const identity = (d: AccountLine) => `${d.date}|${d.paymentNumber ?? ""}|${d.amountCents}|${d.description}`;

export function sweepDepositsFrom(histories: AccountMonth[], lines: BankLineRow[], links: Map<string, string[]>): SweepDeposit[] {
  /* Every deposit once however many files hold it; a file that holds it twice is two deposits. */
  const held = new Map<string, { line: AccountLine; times: number }>();
  for (const m of histories) {
    const here = new Map<string, { line: AccountLine; times: number }>();
    for (const l of m.lines) {
      if (l.kind !== "deposit") continue;
      const k = identity(l);
      here.set(k, { line: l, times: (here.get(k)?.times ?? 0) + 1 });
    }
    for (const [k, h] of here) held.set(k, { line: h.line, times: Math.max(held.get(k)?.times ?? 0, h.times) });
  }
  const depositsUnder = new Map<string, number>();
  for (const { line, times } of held.values()) {
    const pn = digits(line.paymentNumber);
    depositsUnder.set(pn, (depositsUnder.get(pn) ?? 0) + times);
  }

  /* Sweeps that balance, once however many files hold them. One that does not balance was cut off by the file's edge or is wrong. */
  const seen = new Set<string>();
  const sweeps: Sweep[] = [];
  for (const m of histories) {
    for (const s of m.sweeps) {
      if (!s.agrees) continue;
      const k = [s.on, s.transferredCents, ...s.deposits.map(identity).sort()].join("#");
      if (seen.has(k)) continue;
      seen.add(k);
      sweeps.push(s);
    }
  }

  /* Each sweep to the bank line it became: the same amount, the nearest day on or after it, a line used once. */
  const pairs: { sweep: Sweep; line: BankLineRow; gap: number }[] = [];
  for (const sweep of sweeps) {
    for (const line of lines) {
      if (!PAYER_MONEY.has(line.placedAs) || line.amountCents !== sweep.transferredCents || !isProviderPayTransfer(line)) continue;
      const gap = daysAfter(sweep.on, line.on);
      if (gap >= 0 && gap <= SWEEP_TO_BANK_DAYS) pairs.push({ sweep, line, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.sweep.on.localeCompare(b.sweep.on) || a.line.id.localeCompare(b.line.id));
  const sweepDone = new Set<Sweep>();
  const lineDone = new Set<string>();
  const out: SweepDeposit[] = [];
  for (const { sweep, line } of pairs) {
    if (sweepDone.has(sweep) || lineDone.has(line.id)) continue;
    sweepDone.add(sweep);
    lineDone.add(line.id);
    for (const d of sweep.deposits) {
      const pn = digits(d.paymentNumber);
      if (pn.length < 6 || depositsUnder.get(pn) !== 1) continue;
      out.push({ paymentNumber: pn, amountCents: d.amountCents, lineReceiptIds: links.get(line.id) ?? [] });
    }
  }
  return out;
}

/*
 * Parsed once per file for the life of the process. A stored file never changes, so its content hash is a safe key; a file that cannot
 * be read is not remembered, so one that turns up later is still found.
 */
const parsed = new Map<string, AccountMonth | null>();

async function accountHistories(): Promise<AccountMonth[]> {
  const docs = await db.query.documents.findMany({
    where: and(eq(schema.documents.category, "report"), lte(schema.documents.sizeBytes, MAX_HISTORY_BYTES)),
    columns: { sha256: true, storageKey: true },
  });
  const out: AccountMonth[] = [];
  for (const d of docs) {
    const key = d.sha256 || d.storageKey;
    let month = parsed.get(key);
    if (month === undefined) {
      try {
        const buf = await readFile(d.storageKey);
        month = looksLikeAccountHistory(buf.subarray(0, 4096).toString("utf8")) ? readAccountHistory(buf.toString("utf8")) : null;
        parsed.set(key, month);
      } catch {
        continue;
      }
    }
    if (month) out.push(month);
  }
  return out;
}

/**
 * How far the account histories on file can see: the newest day any of them reaches (null where none is on file), the months in which
 * any of them holds a dated line, and, for each payment number, the latest day it appears as a deposit. The morning check says five
 * different things of a remittance it finds no bank line for, and which is true turns on this: no history to look in, one that stops too
 * soon to show it, none that covers the month it would fall in, one that covers it and holds nothing under the number, or one that holds
 * the deposit and not the bank line it should have reached. `through` alone is a high-water mark and says nothing of the months below
 * it: a September file and an October file with no August file reach past an August advice and still cannot show its deposit.
 */
export type HistoryReach = { through: string | null; months: Set<string>; depositDays: Map<string, string> };

export function historyReachOf(histories: AccountMonth[]): HistoryReach {
  let through: string | null = null;
  const months = new Set<string>();
  const depositDays = new Map<string, string>();
  for (const month of histories) {
    for (const l of month.lines) {
      if (through === null || l.date > through) through = l.date;
      months.add(l.date.slice(0, 7));
      const pn = l.kind === "deposit" ? digits(l.paymentNumber) : "";
      if (pn.length >= 6 && l.date > (depositDays.get(pn) ?? "")) depositDays.set(pn, l.date);
    }
  }
  return { through, months, depositDays };
}

export const loadHistoryReach = async (): Promise<HistoryReach> => historyReachOf(await accountHistories());

export async function loadSweepDeposits(): Promise<SweepDeposit[]> {
  const histories = (await accountHistories()).filter((m) => m.sweeps.length > 0);
  if (histories.length === 0) return [];
  const lines = await db.query.bankLines.findMany({ columns: { id: true, on: true, amountCents: true, placedAs: true, description: true, receiptId: true } });
  const links = new Map<string, string[]>();
  const link = (lineId: string, receiptId: string) => links.set(lineId, [...(links.get(lineId) ?? []), receiptId]);
  for (const l of lines) if (l.receiptId) link(l.id, l.receiptId);
  for (const x of await db.query.bankLineReceipts.findMany({ columns: { lineId: true, receiptId: true } })) {
    if (!(links.get(x.lineId) ?? []).includes(x.receiptId)) link(x.lineId, x.receiptId);
  }
  return sweepDepositsFrom(histories, lines, links);
}
