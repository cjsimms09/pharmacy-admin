/**
 * One payment that pays several supplier invoices: whether the ticked invoices can be marked paid by it.
 *
 * The owner, 15 September, of the suppliers without a ledger feed: "ipc is per invoice.. believe parmed and ipd are per
 * statement". A statement payment leaves the bank as one debit or one cheque for several invoices, and no bank rule can
 * tie it to them: the one that marks an invoice paid needs a debit of exactly that invoice's amount. So a person ticks
 * the invoices the statement lists, gives the day and the amount, and the site checks the two agree. It never picks the
 * invoices itself from sums: several sets of invoices can add to one payment, and guessing one is how a cost lands in
 * the wrong month.
 *
 * The paid date is what the cash account counts these invoices on (`cash-cogs.ts`), so the refusals are the point:
 *   - the ticked total must equal the payment, unless the person says the difference is a discount or credit;
 *   - one supplier, since a statement is one supplier's;
 *   - every invoice has an amount read, or the total could not be checked;
 *   - an invoice already marked paid on another day is not moved silently.
 *
 * Not modelled: an invoice paid in part. A paid date is one day per invoice, so an invoice settled across two payments
 * (IPD's statement shows one paid $1,125.36, then $2,152.03, of $3,277.39, by two credit-memo offsets) has to wait for the
 * payment that finishes it. Splitting one invoice's cost across the days it was paid needs a payment record with the
 * amount each payment put against each invoice, which is the next build with the Parmed and IPD readers.
 *
 * Pure.
 */

export type PaidTogetherInvoice = {
  id: string;
  supplier: string | null;
  invoiceNumber: string | null;
  totalCents: number | null;
  paidOn: string | null;
};

export type PaidTogetherCheck =
  | { ok: true; supplier: string; totalCents: number; paymentCents: number; differenceCents: number }
  | { ok: false; why: string };

const fold = (s: string | null) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const named = (v: PaidTogetherInvoice) => (v.invoiceNumber ? `invoice ${v.invoiceNumber}` : "an invoice with no number");

/** Dollars as typed ("1,461.46", "$1461.46") to cents; null where it is not an amount. */
export function paymentCentsFrom(typed: string | null | undefined): number | null {
  const t = String(typed ?? "").trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function checkPaidTogether(input: {
  invoices: PaidTogetherInvoice[];
  paidOn: string;
  paymentCents: number | null;
  acceptDifference: boolean;
}): PaidTogetherCheck {
  const { invoices, paidOn, paymentCents, acceptDifference } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return { ok: false, why: "Give the day the payment left the bank." };
  if (invoices.length === 0) return { ok: false, why: "Tick the invoices this payment covers." };

  const suppliers = [...new Map(invoices.map((v) => [fold(v.supplier), v.supplier ?? "no supplier"])).values()];
  if (suppliers.length > 1) {
    return { ok: false, why: `The ticked invoices are from ${suppliers.join(" and ")}. A statement is one supplier's, so mark each supplier's payment on its own.` };
  }

  const noAmount = invoices.filter((v) => v.totalCents === null);
  if (noAmount.length) {
    return { ok: false, why: `${noAmount.map(named).join(", ")} ${noAmount.length === 1 ? "has" : "have"} no amount read, so the ticked total cannot be checked against the payment. Enter the amount on the row first.` };
  }

  const elsewhere = invoices.filter((v) => v.paidOn && v.paidOn !== paidOn);
  if (elsewhere.length) {
    return { ok: false, why: `${elsewhere.map((v) => `${named(v)} is already marked paid on ${v.paidOn}`).join("; ")}. Nothing was recorded. If that date is wrong, clear it on the row first.` };
  }

  if (paymentCents === null) return { ok: false, why: "Give the amount paid, as the bank statement or the supplier's statement shows it." };

  const totalCents = invoices.reduce((n, v) => n + (v.totalCents ?? 0), 0);
  const differenceCents = paymentCents - totalCents;
  if (differenceCents !== 0 && !acceptDifference) {
    return {
      ok: false,
      why:
        `The ${invoices.length} ticked invoice${invoices.length === 1 ? "" : "s"} come${invoices.length === 1 ? "s" : ""} to ${money(totalCents)}; the payment was ${money(paymentCents)}, ` +
        `${money(Math.abs(differenceCents))} ${differenceCents > 0 ? "more" : "less"}. Nothing was recorded. Tick exactly the invoices the payment covers, or, if the difference is a discount or a credit, tick that box and record it.`,
    };
  }
  return { ok: true, supplier: suppliers[0], totalCents, paymentCents, differenceCents };
}
