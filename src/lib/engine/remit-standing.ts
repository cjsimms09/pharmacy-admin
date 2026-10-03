import { db } from "@/db";

/**
 * Which remittances in the register a receipt already stands for.
 *
 * A receipt stands for a remittance where it carries the remittance's payment number (the payment report and the
 * 835 share it: 25 of September's 25), where its key names the remittance number, or where it is the same amount
 * within the remittance window — the fortnight the bank matcher allows a remittance to take to land, because a
 * PBM's advice can run twelve days ahead of its money (SS&C's did, 3 → 15 September, and the money came under the
 * name of its platform, DomaniRx, so only the amount could tie them). Each receipt stands for one remittance only,
 * strongest evidence first: two $2,008.00 remittances a week apart do not share the one $2,008.00 that arrived.
 * One computation, read by the bank matcher (which offers only the remittances nothing has banked) and by the
 * Remits tab (which shows each remittance with its standing).
 */
export type RegisterRow = { id: string; payerName: string | null; remitOn: string | null; amountCents: number; paymentNumber: string | null; remitNumber: string; source: string | null };
export type ReceiptRow = { amountCents: number; receivedOn: string | null; reference: string | null; sourceKey: string | null };
export type Standing = "payment number" | "remittance number" | "amount in window" | null;

/** Days a remittance may take to reach the bank: the bank matcher's own window (REMIT_WINDOW_DAYS in bank-statement.ts). */
export const STANDING_WINDOW_DAYS = 14;

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
const daysApart = (a: string | null, b: string | null) => (a && b ? Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5 : Infinity);

/** Pure: for each register row, why a receipt stands for it, or null. A receipt is spent on the first row it stands for. */
export function standings(rows: RegisterRow[], receipts: ReceiptRow[]): Standing[] {
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
  /* 1. The payment number, shared by the payment report and the 835. */
  rows.forEach((r, k) => {
    const pn = digits(r.paymentNumber);
    if (pn.length >= 6 && take(byReference.get(pn) ?? [])) out[k] = "payment number";
  });
  /* 2. The remittance number inside a receipt's key. */
  rows.forEach((r, k) => {
    if (out[k] || !r.remitNumber) return;
    const needle = `|${r.remitNumber}|`;
    if (take(receipts.map((x, i) => ((x.sourceKey ?? "").includes(needle) ? i : -1)).filter((i) => i >= 0))) out[k] = "remittance number";
  });
  /* 3. The same amount inside the window, the nearest day first. */
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

export async function remitStanding(): Promise<{ row: RegisterRow; banked: Standing }[]> {
  const receipts = await db.query.cashReceipts.findMany({ columns: { amountCents: true, receivedOn: true, reference: true, sourceKey: true } });
  const register = await db.query.remittanceRegister.findMany({ columns: { id: true, payerName: true, remitOn: true, amountCents: true, paymentNumber: true, remitNumber: true, source: true } });
  /* Oldest advice first, so where two remittances could claim one receipt the earlier one takes it. */
  const rows = [...register].sort((a, b) => (a.remitOn ?? "").localeCompare(b.remitOn ?? ""));
  const s = standings(rows, receipts);
  return rows.map((row, i) => ({ row, banked: s[i] }));
}
