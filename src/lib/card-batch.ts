/**
 * A credit card settlement batch, read from the processor's batch summary.
 *
 * The owner, 15 September 2026: *"credit card info doesnt show fees but will give how much we took in
 * in credit cards daily and should match bank statement deposits once we get it"*.
 *
 * One email per batch, forwarded by staff: subject "Credit Card Batch (779536378, 9/3/2026) Report:
 * $2704.35, 101 Transactions", and two HTML attachments. The Summary is a table:
 *
 *     Card Type | Count | Amount | Credit Count | Credit Amount | Debit Count | Debit Amount |
 *                 Sale Count | Sale Amount | Return Count | Return Amount
 *     Amex  1    5.20 ...
 *     Totals 101 2,704.35 ...
 *
 * ── What the total is ──
 *
 * Settled on the one batch in September with returns in it, 780961413 of 8 September: sales
 * $4,262.08 across 121, returns **−$32.81** across 2, total $4,229.27 across 123. Returns print
 * negative and the total already includes them, so the total is the net takings — what the processor
 * settles, and so what a bank deposit is matched against. Three sums have to agree before a batch is
 * taken: the card types to the total, sales plus returns to the total, credit plus debit to the
 * total. A batch where they do not is refused and said, never averaged.
 *
 * ── Where it goes in the books, and where it does not ──
 *
 * Cash: it is money taken at the counter — copays and front-of-shop sales together; the batch does
 * not split them — and it is the first source of counter money the cash account has ever had.
 *
 * Accrual: nowhere. The accrual account already recognises that revenue from the claims (what the
 * patient paid, at pickup) and from the till. Counting the batch there would take the same sale
 * twice, which is why this is banked as a cash receipt and never as sales.
 *
 * Fees are not on it. The owner said so, and the report bears it out — there is no fee column.
 *
 * Pure.
 */

export type CardBatch = {
  batchId: string;
  /** The day the batch closed, ISO. The deposit follows a business day or two later. */
  closedOn: string;
  count: number;
  /** Net takings: sales plus returns (returns are negative). What the bank deposit should equal. */
  totalCents: number;
  salesCents: number;
  returnsCents: number;
  byCard: { card: string; count: number; amountCents: number }[];
  merchant: string | null;
  says: string;
};

export type CardBatchRead = { ok: true; batch: CardBatch } | { ok: false; why: string };

const SUBJECT = /credit card batch \((\d+),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\) report:\s*\$([\d,]+\.\d{2}),\s*(\d+)\s+transactions/i;

/** Whether an email is a card batch report, from its subject alone. Forwarded copies included. */
export function looksLikeCardBatch(subject: string): boolean {
  return SUBJECT.test(subject);
}

/** Table cells in document order, one per `<td>`/`<th>`, whitespace collapsed. */
export function cellsOf(html: string): string[] {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<(br|\/tr|\/p|\/div|\/h\d)[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

const cents = (v: string | undefined): number | null => {
  const t = (v ?? "").replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};
const int = (v: string | undefined): number | null => (/^\d+$/.test((v ?? "").trim()) ? Number(v) : null);
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function readCardBatch(subject: string, summaryHtml: string): CardBatchRead {
  const s = SUBJECT.exec(subject);
  if (!s) return { ok: false, why: "The subject is not a card batch report." };
  const [, subjectId, mo, dy, yr, subjectAmount, subjectCount] = s;

  const c = cellsOf(summaryHtml);
  const at = (label: string) => {
    const i = c.findIndex((x) => x.toLowerCase() === label.toLowerCase());
    return i >= 0 ? c[i + 1] : undefined;
  };

  const batchId = at("Batch ID") ?? subjectId;
  if (batchId !== subjectId) return { ok: false, why: `The subject names batch ${subjectId} and the summary names ${batchId}.` };

  /* The totals row: the last "Totals" cell, followed by its ten figures. The first "Totals" is a heading. */
  const t = c.lastIndexOf("Totals");
  if (t < 0 || t + 10 >= c.length) return { ok: false, why: `Batch ${batchId}: the summary has no totals row.` };
  const [cnt, amt, , creditAmt, , debitAmt, , saleAmt, , returnAmt] = c.slice(t + 1, t + 11);
  const count = int(cnt);
  const total = cents(amt), credit = cents(creditAmt), debit = cents(debitAmt), sales = cents(saleAmt), returns = cents(returnAmt);
  if (count === null || total === null || credit === null || debit === null || sales === null || returns === null) {
    return { ok: false, why: `Batch ${batchId}: a figure in the totals row could not be read.` };
  }

  /* Card types: every row between the header and the totals row that starts with a name and has eleven cells. */
  const header = c.findIndex((x) => x === "Return Amount");
  const byCard: CardBatch["byCard"] = [];
  for (let i = header + 1; header >= 0 && i + 10 < t + 1; i += 11) {
    const name = c[i], n = int(c[i + 1]), a = cents(c[i + 2]);
    if (!name || n === null || a === null) break;
    byCard.push({ card: name, count: n, amountCents: a });
  }

  const cardSum = byCard.reduce((x, r) => x + r.amountCents, 0);
  const problems: string[] = [];
  if (byCard.length === 0) problems.push("no card-type rows were read");
  else if (cardSum !== total) problems.push(`the card types come to ${money(cardSum)}`);
  if (sales + returns !== total) problems.push(`sales ${money(sales)} and returns ${money(returns)} come to ${money(sales + returns)}`);
  if (credit + debit !== total) problems.push(`credit and debit come to ${money(credit + debit)}`);
  if (cents(subjectAmount) !== total) problems.push(`the subject says ${money(cents(subjectAmount) ?? 0)}`);
  if (Number(subjectCount) !== count) problems.push(`the subject says ${subjectCount} transactions and the summary ${count}`);
  if (problems.length) return { ok: false, why: `Batch ${batchId} totals ${money(total)}, but ${problems.join("; ")}. Not banked.` };

  const closedOn = `${yr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}`;
  return {
    ok: true,
    batch: {
      batchId,
      closedOn,
      count,
      totalCents: total,
      salesCents: sales,
      returnsCents: returns,
      byCard,
      merchant: at("Merchant Name") ?? null,
      says:
        `Card batch ${batchId}, closed ${closedOn}: ${money(total)} across ${count} transactions` +
        (returns !== 0 ? ` (${money(sales)} of sales less ${money(-returns)} of returns)` : "") +
        `.`,
    },
  };
}
