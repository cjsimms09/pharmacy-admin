/**
 * Where a line sits on Today, by what it would cost to get wrong.
 *
 * CLAUDE.md, pre-flight 7: worst case ranked — patient harm, then the board and DEA, then a payer relationship,
 * then money, then convenience. The old home page sorted by whichever module produced the line; the CQI summary
 * due in three days sat under a supplies count because supplies came first in the file. The owner, 1 October 2026:
 * "think of all the things Ive had to tell you.. ie CQI report not popping... yet it alerts me on other, less
 * important things."
 *
 * Pure. Alert keys are the old alert machinery's; a key this does not know lands at 4 (money), never below the
 * things that matter more, and never above them.
 */
export type Rank = 1 | 2 | 3 | 4 | 5;

export const RANK_WORDS: Record<Rank, string> = {
  1: "patient",
  2: "board",
  3: "payer",
  4: "money",
  5: "later",
};

export function rankForAlertKey(key: string): Rank {
  const k = key.toLowerCase();
  if (/excursion|temp-out|recall/.test(k)) return 1;
  if (/^cs-|controlled|temps?-|temperature|cqi|manual|training|licen|no-pic|pic-|backup|technician|inspection|poa|discrepanc/.test(k)) return 2;
  if (/payment|remit|835|payer|reports-refused|inbox-refused|card-batch|invoice-price/.test(k)) return 3;
  if (/supplies|updates|ai-cap|nadac|warm|catalog/.test(k)) return 5;
  return 4;
}

/** Money lines rank by size: a five-figure line is a payer or a wholesaler matter before it is a bookkeeping one. */
export function rankForMoney(amountCents: number): Rank {
  return Math.abs(amountCents) >= 10_000_00 ? 3 : 4;
}

/** Lines of equal rank: the dearest first, then the oldest. */
export function compareLines<T extends { rank: number; amountCents?: number | null; firstSeen?: string }>(a: T, b: T): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const am = Math.abs(a.amountCents ?? 0);
  const bm = Math.abs(b.amountCents ?? 0);
  if (am !== bm) return bm - am;
  return (a.firstSeen ?? "").localeCompare(b.firstSeen ?? "");
}
