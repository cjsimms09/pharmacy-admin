import type { AccountLine, AccountMonth } from "./providerpay-account";

/**
 * Which of the ProviderPay sweep account's deposits the books do not hold.
 *
 * The owner, 15 October 2026, when September would not close because the Payments export stopped on
 * the 18th: the Wells Fargo history "has everything we need". Read against the files it is the better
 * record of the payer money: it names every deposit with the payer's own payment number, and its
 * sweeps add up to their transfers. Of September's 31 payments in the export, 18 are deposits in the
 * history, to the cent; the other 13 are Health Mart Atlas, which pays the bank direct. The deposits
 * after the 18th the export never had were already banked, by their 835s, to the cent.
 *
 * So the question the checklist should ask is not "was the export pulled late enough" but "is each
 * deposit the history proves in the books", whichever document banked it. A deposit is in the books
 * when a receipt carries its payment number, or, where the receipt was filed under another number (a
 * remittance advised twice for one amount), when one of the same amount landed within three days.
 *
 * Pure.
 */
export type HeldReceipt = { reference: string | null; amountCents: number; receivedOn: string | null };

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
const identity = (d: AccountLine) => `${d.date}|${d.paymentNumber ?? ""}|${d.amountCents}|${d.description}`;
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5;

/** Every deposit once however many files hold it; a file that holds it twice is two deposits. */
export function distinctDeposits(histories: AccountMonth[]): AccountLine[] {
  const held = new Map<string, { line: AccountLine; times: number }>();
  for (const m of histories) {
    const here = new Map<string, { line: AccountLine; times: number }>();
    for (const l of m.lines) {
      if (l.kind !== "deposit" || l.amountCents <= 0) continue;
      const k = identity(l);
      here.set(k, { line: l, times: (here.get(k)?.times ?? 0) + 1 });
    }
    for (const [k, h] of here) held.set(k, { line: h.line, times: Math.max(held.get(k)?.times ?? 0, h.times) });
  }
  const out: AccountLine[] = [];
  for (const { line, times } of held.values()) for (let i = 0; i < times; i++) out.push(line);
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function depositsNotInBooks(deposits: AccountLine[], receipts: HeldReceipt[]): AccountLine[] {
  const byNumber = new Set(receipts.map((r) => digits(r.reference)).filter((n) => n.length >= 6));
  /* An amount-and-day match is used once, so two deposits of one amount cannot both lean on a single receipt. */
  const used = new Set<number>();
  const missing: AccountLine[] = [];
  for (const d of deposits) {
    const pn = digits(d.paymentNumber);
    if (pn.length >= 6 && byNumber.has(pn)) continue;
    const i = receipts.findIndex((r, ix) => !used.has(ix) && r.amountCents === d.amountCents && r.receivedOn !== null && daysBetween(r.receivedOn, d.date) <= 3);
    if (i >= 0) {
      used.add(i);
      continue;
    }
    missing.push(d);
  }
  return missing;
}
