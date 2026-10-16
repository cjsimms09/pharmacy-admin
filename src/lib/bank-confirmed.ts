import { db } from "@/db";

/** Every receipt some bank line stands behind: bank_lines.receipt_id holds a line's first receipt, bank_line_receipts the whole set (0133). */
export async function receiptsConfirmedByBank(): Promise<Set<string>> {
  const first = (await db.query.bankLines.findMany({ columns: { receiptId: true } })).map((r) => r.receiptId).filter((id): id is string => id !== null);
  const all = (await db.query.bankLineReceipts.findMany({ columns: { receiptId: true } })).map((r) => r.receiptId);
  return new Set([...first, ...all]);
}
