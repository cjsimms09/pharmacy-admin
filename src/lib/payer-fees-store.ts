import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { adjustmentLinesOnFile } from "./adjustment-report";
import { countPayerFees, feesByMonth, type FeeLine, type MonthFees, type PayerFees } from "./payer-fees";

/**
 * Every record of what the payers took off the remittances, read from where it is kept, and counted once (payer-fees.ts).
 *
 * A Health Mart Atlas EFT is covered when its payment report has been read, which leaves either its claim payments
 * (origin "accesshealth:<EFT>") or its fees (expenses keyed "AHADJ|<EFT>|<code>|<reference>"). The fees it booked come
 * with it, so a disagreement with the other records can be seen. An AHADJ expense a person has voided stops counting
 * as a fee but the EFT stays covered: the report is believed over the adjustment report, and the difference is said.
 */
export async function loadPayerFees(): Promise<PayerFees> {
  const eft = new Map<string, number>();
  const booked = (await db.all(sql`select invoice_number n, amount_cents c from expenses where status = 'confirmed' and invoice_number like 'AHADJ|%'`)) as { n: string; c: number }[];
  for (const b of booked) {
    const e = b.n.split("|")[1] ?? "";
    if (e) eft.set(e, (eft.get(e) ?? 0) + Number(b.c));
  }
  const read = (await db.all(sql`select distinct origin o from claim_payments where origin like 'accesshealth:%'`)) as { o: string }[];
  for (const r of read) {
    const e = r.o.replace(/^accesshealth:/, "");
    if (e && !eft.has(e)) eft.set(e, 0);
  }

  const holdbacks = (await db.all(
    sql`select trace_number t, payer p, reason_code c, reference r, amount_cents a, received_on d from remittance_holdbacks where out_of_books = 0`,
  )) as { t: string | null; p: string | null; c: string; r: string | null; a: number; d: string | null }[];
  const from835: FeeLine[] = holdbacks.map((h) => ({
    remittance: h.t ?? "",
    month: (h.d ?? "").slice(0, 7),
    code: h.c,
    reference: h.r ?? "",
    takenCents: Number(h.a),
    payer: h.p ?? "",
  }));

  const { lines } = await adjustmentLinesOnFile();
  const fromAdjustmentReport: FeeLine[] = lines.map((l) => ({
    remittance: l.remittanceNumber,
    month: (l.remitOn ?? l.postedOn ?? "").slice(0, 7),
    code: l.code,
    reference: l.identifier,
    takenCents: -l.amountCents,
    payer: l.payer,
  }));

  return countPayerFees({ paymentReports: [...eft].map(([remittance, feeCents]) => ({ remittance, feeCents })), from835, fromAdjustmentReport });
}

export async function payerFeesByMonth(): Promise<Map<string, MonthFees>> {
  return feesByMonth(await loadPayerFees());
}
