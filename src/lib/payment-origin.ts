/**
 * Which kind of document a claim payment was read from.
 *
 * A payment reaches this site by more than one road: the payer's 835, ProviderPay's remittance detail, Health Mart
 * Atlas's AccessHealth payment report, the RedSail and Veridikal voucher reports, the RxRescue credit memo, a hand-typed
 * entry. The same money can arrive by two of them. The origin is written on every row from 1 October 2026
 * (`claim_payments.origin`, "<class>:<document key>"); rows written before that are classed from what they carry.
 *
 * No `server-only` here: the scripts that clean and backfill payments read this too.
 */
export type OriginClass = "835" | "accesshealth" | "providerpay-detail" | "copay" | "veridikal" | "rxrescue" | "manual" | "unknown";

export function originClass(origin: string | null | undefined): OriginClass {
  const head = (origin ?? "").split(":")[0];
  switch (head) {
    case "835":
    case "accesshealth":
    case "providerpay-detail":
    case "copay":
    case "veridikal":
    case "rxrescue":
    case "manual":
      return head;
    default:
      return "unknown";
  }
}

/** The origin a row written before origins were recorded must have had, from what it carries. */
export function legacyOrigin(row: { notes: string | null; reference: string | null; source: string; payer: string | null }): string {
  const notes = row.notes ?? "";
  const reference = row.reference ?? "";
  if (/_835\.tx|, trace /i.test(notes)) return `835:${(notes.match(/trace (\S+?)\.?$/) ?? [])[1] ?? "?"}`;
  if (/^From the AccessHealth payment report/i.test(notes)) return `accesshealth:${(notes.match(/for (EFT-\d+)/) ?? [])[1] ?? "?"}`;
  if (/^ProviderPay /.test(reference)) return `providerpay-detail:${reference.split(" ").pop() ?? "?"}`;
  if (row.source === "rxrescue") return `rxrescue:${reference || "?"}`;
  if (/veridikal/i.test(notes) || /veridikal/i.test(row.payer ?? "")) return `veridikal:${reference || "?"}`;
  if (row.source === "copay_card") return `copay:${reference || "?"}`;
  return `manual:${reference || "?"}`;
}
