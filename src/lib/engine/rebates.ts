import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Wholesaler rebates: what the contract rates say a month should earn, what the wholesaler's statement then says,
 * and what reached the bank — three figures that arrive weeks apart and used to live on three screens.
 *
 * The estimate is the site's own (rebate-rates.ts: the month's purchases at the contract's generic and brand
 * rates); it is an estimate and is called one. The statement is the wholesaler's word, posted to the books as a
 * negative "Wholesaler rebates" expense keyed REBATE|supplier|from|to (rebate-report-store.ts). The receipt is the
 * credit on the bank statement, keyed REBATE|supplier (bank-match-context.ts). McKesson's statement for a month has
 * arrived around the seventeenth of the next (July's paid 19 August, August's 17 September), so a month without
 * one is "expected" until then and "late" after.
 *
 * Where the estimate and the statement differ, the difference is shown beside the statement's own rates and
 * ratios, because that is where the money is: a generic-compliance ratio a band below the next is the single
 * largest lever on the pharmacy's purchasing, and the statement is the only document that says what it was.
 */
export type RebateMonth = {
  month: string;
  supplierId: string;
  supplier: string;
  estimateCents: number | null;
  estimateSays: string;
  statedCents: number | null;
  statementDocumentId: string | null;
  receivedCents: number | null;
  receivedOn: string | null;
  expectedBy: string;
  state: "no_rate" | "estimated" | "statement_late" | "stated" | "received" | "short";
  says: string;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const nextMonth = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7);
/** The day of the following month by which the statement has arrived, measured on the two on file. */
export const STATEMENT_BY_DAY = 20;

export type Estimate = { supplierId: string; supplier: string; cents: number | null; contractRatePercent: number | null; unmarkedCents: number; totalCents: number };
export type Stated = { supplierId: string; cents: number; documentId: string | null };
export type RebateReceipt = { supplierId: string; cents: number; on: string };

/** Pure: one supplier's month. */
export function rebateMonth(month: string, e: Estimate, stated: Stated | null, receipts: RebateReceipt[], today: string): RebateMonth {
  const expectedBy = `${nextMonth(month)}-${String(STATEMENT_BY_DAY).padStart(2, "0")}`;
  const after = nextMonth(month);
  const received = receipts.filter((r) => r.supplierId === e.supplierId && r.on >= `${after}-01` && r.on <= lastDay(after));
  const got = received.length ? received.reduce((n, r) => n + r.cents, 0) : null;
  const receivedOn = received.length ? received.map((r) => r.on).sort()[0] : null;
  const estimateSays =
    e.cents === null
      ? e.totalCents > 0
        ? `${money(e.totalCents)} bought; no contract rate on file, so nothing can be estimated.`
        : "Nothing bought."
      : `${money(e.cents)} estimated at the contract rates on ${money(e.totalCents)} bought${e.unmarkedCents > 0 ? ` (${money(e.unmarkedCents)} of it on lines the rate sheet does not place)` : ""}.`;
  let state: RebateMonth["state"];
  let says: string;
  if (stated === null) {
    if (e.cents === null && e.totalCents > 0) {
      state = "no_rate";
      says = `${e.supplier}, ${month}: ${estimateSays}`;
    } else if (e.cents === null) {
      state = "no_rate";
      says = `${e.supplier}, ${month}: nothing bought, nothing to earn.`;
    } else {
      state = today > expectedBy ? "statement_late" : "estimated";
      says = state === "estimated" ? `${e.supplier}, ${month}: ${estimateSays} The statement is expected by ${expectedBy}.` : `${e.supplier}, ${month}: ${estimateSays} The statement was expected by ${expectedBy} and is not on file.`;
    }
  } else if (got === null) {
    state = "stated";
    says = `${e.supplier}, ${month}: the statement says ${money(stated.cents)}${e.cents !== null ? ` against ${money(e.cents)} estimated (${money(Math.abs(stated.cents - e.cents))} ${stated.cents >= e.cents ? "more" : "less"})` : ""}; the credit has not reached the bank yet.`;
  } else if (got + 100 < stated.cents) {
    state = "short";
    says = `${e.supplier}, ${month}: the statement says ${money(stated.cents)}, the bank received ${money(got)} on ${receivedOn}: ${money(stated.cents - got)} short.`;
  } else {
    state = "received";
    says = `${e.supplier}, ${month}: ${money(stated.cents)} stated and received on ${receivedOn}${e.cents !== null ? `; the site had estimated ${money(e.cents)} (${money(Math.abs(stated.cents - e.cents))} ${stated.cents >= e.cents ? "more" : "less"} than the statement)` : ""}.`;
  }
  return { month, supplierId: e.supplierId, supplier: e.supplier, estimateCents: e.cents, estimateSays, statedCents: stated?.cents ?? null, statementDocumentId: stated?.documentId ?? null, receivedCents: got, receivedOn, expectedBy, state, says };
}

export async function rebateMonths(today: string, months: string[]): Promise<RebateMonth[]> {
  const { earningForMonth } = await import("../rebate-rates");
  const [stated, receipts] = await Promise.all([
    db.all(sql`select e.invoice_number key, e.amount_cents cents, e.document_id doc from expenses e join expense_categories c on c.id = e.category_id where c.name = 'Wholesaler rebates' and e.status <> 'void' and e.invoice_number like 'REBATE|%'`) as Promise<{ key: string; cents: number; doc: string | null }[]>,
    db.all(sql`select source_key key, amount_cents cents, received_on "on" from cash_receipts where source_key like 'REBATE|%' and received_on is not null`) as Promise<{ key: string; cents: number; on: string }[]>,
  ]);
  const receiptRows: RebateReceipt[] = receipts.map((r) => ({ supplierId: r.key.split("|")[1] ?? "", cents: r.cents, on: r.on }));
  const out: RebateMonth[] = [];
  for (const month of months) {
    const earning = await earningForMonth(month);
    for (const e of earning) {
      if (e.totalPurchasedCents <= 0 && e.estimatedRebateCents === null) continue;
      const key = `REBATE|${e.supplierId}|${month}-01|${lastDay(month)}`;
      const s = stated.find((x) => x.key === key);
      out.push(
        rebateMonth(
          month,
          { supplierId: e.supplierId, supplier: e.supplierName, cents: e.estimatedRebateCents, contractRatePercent: e.contractRatePercent, unmarkedCents: e.unmarkedPurchasedCents, totalCents: e.totalPurchasedCents },
          s ? { supplierId: e.supplierId, cents: Math.abs(s.cents), documentId: s.doc } : null,
          receiptRows,
          today,
        ),
      );
    }
  }
  return out;
}
