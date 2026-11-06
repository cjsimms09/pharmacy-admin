import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { digits, loadSweepDeposits, type SweepDeposit } from "./remit-sweep";

/**
 * Which remittances in the register a receipt already stands for.
 *
 * A receipt stands for a remittance where it carries the remittance's payment number (the payment report and the
 * 835 share it: 25 of September's 25), where ProviderPay's account history shows the deposit under that payment
 * number swept to a bank line the receipt confirmed (engine/remit-sweep.ts: the receipt may be keyed to a different
 * remittance of the same amount, which is what a $2,008.00 deposit was on 24 September 2026), where its key names the
 * remittance number, or where it is the same amount within the remittance window — the fortnight the bank matcher
 * allows a remittance to take to land, because a PBM's advice can run twelve days ahead of its money (SS&C's did,
 * 3 → 15 September, and the money came under the name of its platform, DomaniRx, so only the amount could tie them).
 * Each receipt stands for one remittance only: the account history is read first, because it alone names the deposit,
 * and then the rest strongest first. Two $2,008.00 remittances a week apart do not share the one $2,008.00 that arrived.
 * One computation, read by the bank matcher (which offers only the remittances nothing has banked), by the morning
 * check and by the Remits tab (which shows each remittance with its standing).
 */
export type RegisterRow = { id: string; payerName: string | null; remitOn: string | null; amountCents: number; paymentNumber: string | null; remitNumber: string; source: string | null };
export type ReceiptRow = { id?: string; amountCents: number; receivedOn: string | null; reference: string | null; sourceKey: string | null };
export type Standing = "payment number" | "sweep deposit" | "remittance number" | "amount in window" | null;

/** Days a remittance may take to reach the bank: the bank matcher's own window (REMIT_WINDOW_DAYS in bank-statement.ts). */
export const STANDING_WINDOW_DAYS = 14;

const daysApart = (a: string | null, b: string | null) => (a && b ? Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5 : Infinity);

/** The key a receipt banked for a register row carries, in the 835 feed's own shape, so a second receipt for the same row is refused as the same money. */
export const remitReceiptKey = (r: { payer: string; paymentNumber: string | null; remitNumber: string; remitOn: string }) =>
  `835|${r.payer.trim().toLowerCase()}|${r.paymentNumber ?? r.remitNumber}|${r.remitOn}`;

/**
 * Pure: for each register row, why a receipt stands for it, or null. A receipt is spent on the first row it stands for.
 *
 * The account history goes first. It is the one evidence that names the deposit itself, so a row it proves takes its receipt before
 * any other row's weaker claim can: two remittances of one amount can share one receipt only until the history says whose money it was.
 */
export function standings(rows: RegisterRow[], receipts: ReceiptRow[], deposits: SweepDeposit[] = []): Standing[] {
  const out: Standing[] = rows.map(() => null);
  const used = new Set<number>();
  const byReference = new Map<string, number[]>();
  receipts.forEach((x, i) => {
    const d = digits(x.reference);
    if (d.length >= 6) byReference.set(d, [...(byReference.get(d) ?? []), i]);
  });
  const take = (candidates: number[]) => {
    const i = candidates.find((c) => !used.has(c));
    if (i === undefined) return false;
    used.add(i);
    return true;
  };
  /*
   * 1. The deposit under the remittance's payment number in ProviderPay's account history, swept to a bank line of the same amount.
   * Where a receipt carries that payment number it is the one spent, and the row stands by the payment number: the receipt is the
   * stronger witness and the history only agrees with it. Otherwise the receipt that bank line made is spent, and it may be keyed to a
   * different remittance of the same amount, which is what a $2,008.00 deposit was on 24 September 2026; the row stands by the history alone.
   */
  const spent = new Set<number>();
  rows.forEach((r, k) => {
    const pn = digits(r.paymentNumber);
    const at = pn.length >= 6 ? deposits.findIndex((d, i) => !spent.has(i) && d.paymentNumber === pn && d.amountCents === r.amountCents) : -1;
    if (at < 0) return;
    spent.add(at);
    if (take(byReference.get(pn) ?? [])) {
      out[k] = "payment number";
      return;
    }
    out[k] = "sweep deposit";
    const line = deposits[at].lineReceiptIds;
    take(receipts.map((x, i) => (x.id && line.includes(x.id) && x.amountCents === r.amountCents ? i : -1)).filter((i) => i >= 0));
  });
  /* 2. The payment number, shared by the payment report and the 835. */
  rows.forEach((r, k) => {
    if (out[k]) return;
    const pn = digits(r.paymentNumber);
    if (pn.length >= 6 && take(byReference.get(pn) ?? [])) out[k] = "payment number";
  });
  /* 3. The remittance number inside a receipt's key. */
  rows.forEach((r, k) => {
    if (out[k] || !r.remitNumber) return;
    const needle = `|${r.remitNumber}|`;
    if (take(receipts.map((x, i) => ((x.sourceKey ?? "").includes(needle) ? i : -1)).filter((i) => i >= 0))) out[k] = "remittance number";
  });
  /* 4. The same amount inside the window, the nearest day first. */
  rows.forEach((r, k) => {
    if (out[k]) return;
    const cands = receipts
      .map((x, i) => ({ i, d: daysApart(x.receivedOn, r.remitOn), same: x.amountCents === r.amountCents }))
      .filter((c) => c.same && c.d <= STANDING_WINDOW_DAYS)
      .sort((a, b) => a.d - b.d)
      .map((c) => c.i);
    if (take(cands)) out[k] = "amount in window";
  });
  return out;
}

/**
 * `booksOnly` leaves out the receipts the books do not count (the owner: payments from before 1 September "are test only and should not
 * show up on any AR reports or anything"). The morning check asks it, because its question is whether money reached the cash account, and
 * a receipt outside the books is not in the cash account. The bank matcher and the Remits tab leave it off: they ask which remittances a
 * bank line has been matched to, and a remittance advised in August may have been matched by a receipt that is out of the books.
 */
export async function remitStanding(opts: { booksOnly?: boolean } = {}): Promise<{ row: RegisterRow; banked: Standing }[]> {
  const receipts = await db.query.cashReceipts.findMany({
    columns: { id: true, amountCents: true, receivedOn: true, reference: true, sourceKey: true },
    ...(opts.booksOnly ? { where: eq(schema.cashReceipts.outOfBooks, false) } : {}),
  });
  const register = await db.query.remittanceRegister.findMany({ columns: { id: true, payerName: true, remitOn: true, amountCents: true, paymentNumber: true, remitNumber: true, source: true } });
  /* Oldest advice first, so where two remittances could claim one receipt the earlier one takes it. */
  const rows = [...register].sort((a, b) => (a.remitOn ?? "").localeCompare(b.remitOn ?? ""));
  const s = standings(rows, receipts, await loadSweepDeposits());
  return rows.map((row, i) => ({ row, banked: s[i] }));
}
