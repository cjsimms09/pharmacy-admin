import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Cheques the owner has said what they are for, before the bank shows them.
 *
 * A cheque reaches the statement with a number and an amount and nothing else. The standing costs name the ones
 * that repeat; the delivery round and the practice's drugs name the monthly ones. The rest he knows the day he
 * writes them — "check for 274.40 is for invoice …" (1 October 2026) — and there was nowhere to say so until the
 * line arrived weeks later and asked. So this is where he says it: the amount, and what it pays. When the line
 * comes, the matcher reads it here; an invoice named is marked paid if it is on file, and noted by number if not.
 *
 * Kept in the settings table under one key, as the draw cadences are, so no migration stands between an answer
 * and its taking effect.
 */
const KEY = "cheque_expectations";

export type ChequeExpectation = { amountCents: number; invoiceNumber: string | null; note: string; saidOn: string };

export async function chequeExpectations(): Promise<ChequeExpectation[]> {
  const rows = await db.all<{ value: string | null }>(sql`select value from settings where key = ${KEY}`);
  try {
    return rows[0]?.value ? (JSON.parse(rows[0].value) as ChequeExpectation[]) : [];
  } catch {
    return [];
  }
}

export async function expectCheque(e: Omit<ChequeExpectation, "saidOn">): Promise<ChequeExpectation[]> {
  const all = (await chequeExpectations()).filter((x) => !(x.amountCents === e.amountCents && x.invoiceNumber === e.invoiceNumber));
  all.push({ ...e, saidOn: new Date().toISOString().slice(0, 10) });
  const value = JSON.stringify(all);
  const existing = await db.all<{ key: string }>(sql`select key from settings where key = ${KEY}`);
  if (existing.length) await db.run(sql`update settings set value = ${value} where key = ${KEY}`);
  else await db.run(sql`insert into settings (key, value) values (${KEY}, ${value})`);
  return all;
}

/** An expectation met is spent: the next cheque of the same amount is a new question. */
export async function spendChequeExpectation(amountCents: number, invoiceNumber: string | null): Promise<void> {
  const all = (await chequeExpectations()).filter((x) => !(x.amountCents === amountCents && x.invoiceNumber === invoiceNumber));
  await db.run(sql`update settings set value = ${JSON.stringify(all)} where key = ${KEY}`);
}
