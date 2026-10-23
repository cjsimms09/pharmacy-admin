/**
 * What a month bought: the invoices on file, and PioneerRx's receiving record for every delivery with no invoice.
 *
 * The owner, 23 October 2026: "lets just use receipts from pioneer for invoices.. that should always be fall back. it shouldnt cause us
 * problems." The invoice is the document; the receipt is the fact that the goods arrived and what they cost. Counting invoices alone read
 * September as $148,076.26 more dispensed than bought, when 118 deliveries ($218,963.37) had no invoice captured and PioneerRx had a
 * receipt for every one. A delivery is matched to its invoice by number, so one purchase is never counted as both.
 *
 * Pure.
 */
export const bareNumber = (x: string | null | undefined): string => String(x ?? "").replace(/\D/g, "").replace(/^0+/, "");

export type MadePurchases = { cents: number | null; invoiceLinesCents: number; receiptsCents: number; receiptsUsed: number };

export function purchasesMade(input: {
  month: string;
  /** The month's invoice lines, extended. */
  invoiceLinesCents: number;
  haveInvoiceLines: boolean;
  /** Every invoice on file, of any month, so a receipt is matched wherever its invoice is dated. */
  invoiceNumbers: (string | null)[];
  receipts: { invoiceNumber: string | null; invoiceDate: string | null; totalCents: number | null }[];
}): MadePurchases {
  const invoiced = new Set(input.invoiceNumbers.map(bareNumber).filter(Boolean));
  const used = input.receipts.filter((r) => (r.invoiceDate ?? "").startsWith(input.month) && r.totalCents !== null && !invoiced.has(bareNumber(r.invoiceNumber)));
  const receiptsCents = used.reduce((n, r) => n + (r.totalCents ?? 0), 0);
  return {
    cents: input.haveInvoiceLines || used.length > 0 ? input.invoiceLinesCents + receiptsCents : null,
    invoiceLinesCents: input.invoiceLinesCents,
    receiptsCents,
    receiptsUsed: used.length,
  };
}
