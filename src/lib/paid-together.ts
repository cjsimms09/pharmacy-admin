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

/** What one payment puts against one invoice. */
export type ProposedAllocation = { invoiceId: string; amountCents: number };

export type AllocationCheck =
  | { ok: true; supplier: string; allocatedCents: number; differenceCents: number }
  | { ok: false; why: string };

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

/**
 * The same question for a payment that names its own amounts: a supplier's statement or portal page, where one invoice can
 * be paid in part and finished by a later payment (`supplier-payments.ts` writes them).
 *
 * The rules a document cannot be trusted to keep by itself:
 *   - every invoice named is on file, one supplier's, and has an amount read;
 *   - no payment puts more against an invoice than it still owes, counting what other payments already put there — which
 *     is what stops the same cost being counted twice in two months;
 *   - an invoice already marked paid, by a bank debit matched to it or by hand, is not allocated again;
 *   - the amounts add up to the payment, unless a discount or credit is declared.
 */
/** An invoice as the bank-debit rule needs it: with the day it printed as due, and what payments have already put against it. */
export type DueInvoice = PaidTogetherInvoice & { dueOn: string | null; allocatedCents?: number };

const days = (a: string, b: string) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/**
 * Which invoices a wholesaler's debit paid, when the invoices themselves say the day they are due.
 *
 * Not a search for a subset that adds up — that is the guessing this site refuses. The invoices choose themselves: a
 * supplier paid semi-monthly prints a due date on each invoice (`invoice-due-date.ts`), the bank line says what left and
 * when, and the question is only whether those two agree. Parmed's September invoices all print 10/10/2026, and its
 * portal pages show exactly that set paid as one ACH.
 *
 * So: every open invoice of that supplier due within three days of the debit, and they must come to the debit to the
 * cent. Anything else writes nothing and says what it saw — a credit, a return, or an invoice that never arrived, and
 * the supplier's own payment page settles it. The window is three days because a debit clears the day after the payment
 * is made (the August ParMed payment of the 25th cleared on the 26th), not because a due date is approximate.
 */
export function invoicesDueForDebit(input: { invoices: DueInvoice[]; on: string; amountCents: number; windowDays?: number }):
  | { ok: true; invoices: DueInvoice[]; totalCents: number }
  | { ok: false; why: string } {
  const { invoices, on, amountCents } = input;
  const windowDays = input.windowDays ?? 3;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return { ok: false, why: "The bank line has no date." };
  if (amountCents <= 0) return { ok: false, why: "A debit pays invoices; this is not one." };

  const due = invoices.filter((v) => v.dueOn && v.totalCents !== null && days(v.dueOn, on) <= windowDays);
  if (due.length === 0) {
    return { ok: false, why: `no invoice of theirs prints a due date within ${windowDays} days of it, so which invoices it paid is not on any document the site holds` };
  }

  /*
   * Already paid by something else, so this cannot be the debit that paid them. A second debit for the same amount in
   * the same window would otherwise pay the same invoices twice, and the cash account would count them twice.
   */
  const spoken = due.filter((v) => (v.allocatedCents ?? 0) > 0 || v.paidOn);
  if (spoken.length > 0) {
    return { ok: false, why: `${spoken.length} of the ${due.length} invoices due then ${spoken.length === 1 ? "is" : "are"} already paid, so this is not the payment that paid them` };
  }

  const totalCents = due.reduce((n, v) => n + (v.totalCents ?? 0), 0);
  if (totalCents !== amountCents) {
    return {
      ok: false,
      why: `${due.length} of their invoices are due then and come to ${money(totalCents)}, against a debit of ${money(amountCents)}. Forward the supplier's payment page, which lists what it paid`,
    };
  }
  return { ok: true, invoices: due, totalCents };
}

export function checkAllocations(input: {
  invoices: PaidTogetherInvoice[];
  allocations: ProposedAllocation[];
  /** invoiceId → cents other payments have already put against it. */
  allocatedAlready: Record<string, number>;
  paidOn: string;
  paymentCents: number | null;
  acceptDifference: boolean;
}): AllocationCheck {
  const { invoices, allocations, allocatedAlready, paidOn, paymentCents, acceptDifference } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return { ok: false, why: "Give the day the payment left the bank." };
  if (allocations.length === 0) return { ok: false, why: "The payment names no invoices." };
  if (paymentCents === null) return { ok: false, why: "Give the amount paid, as the bank statement or the supplier's statement shows it." };

  const seen = new Set<string>();
  for (const a of allocations) {
    if (seen.has(a.invoiceId)) return { ok: false, why: "The payment names one invoice twice; each invoice takes one amount per payment." };
    seen.add(a.invoiceId);
    if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) return { ok: false, why: "Each amount put against an invoice must be a whole number of cents above nought." };
  }

  const found = new Map(invoices.map((v) => [v.id, v]));
  const missing = allocations.filter((a) => !found.has(a.invoiceId));
  if (missing.length) return { ok: false, why: `${missing.length} invoice${missing.length === 1 ? "" : "s"} the payment names ${missing.length === 1 ? "is" : "are"} not on file. Nothing was recorded.` };

  const mine = allocations.map((a) => found.get(a.invoiceId)!);
  const suppliers = [...new Map(mine.map((v) => [fold(v.supplier), v.supplier ?? "no supplier"])).values()];
  if (suppliers.length > 1) return { ok: false, why: `The payment names invoices from ${suppliers.join(" and ")}. A payment is to one supplier.` };

  const noAmount = mine.filter((v) => v.totalCents === null);
  if (noAmount.length) {
    return { ok: false, why: `${noAmount.map(named).join(", ")} ${noAmount.length === 1 ? "has" : "have"} no amount read, so what is still owed on ${noAmount.length === 1 ? "it" : "them"} cannot be checked. Enter the amount first.` };
  }

  for (const a of allocations) {
    const v = found.get(a.invoiceId)!;
    const already = allocatedAlready[a.invoiceId] ?? 0;
    const owed = (v.totalCents ?? 0) - already;
    if (a.amountCents > owed) {
      return {
        ok: false,
        why:
          `${named(v)} is ${money(v.totalCents ?? 0)}${already ? `, of which ${money(already)} is already paid` : ""}, and this payment puts ${money(a.amountCents)} against it. ` +
          `A payment cannot pay more than is owed. Nothing was recorded.`,
      };
    }
    if (already === 0 && v.paidOn && v.paidOn !== paidOn) {
      return { ok: false, why: `${named(v)} is already marked paid on ${v.paidOn}, with no payment on file behind it. Clear that date on the row first if this payment is what paid it.` };
    }
  }

  const allocatedCents = allocations.reduce((n, a) => n + a.amountCents, 0);
  const differenceCents = paymentCents - allocatedCents;
  if (differenceCents !== 0 && !acceptDifference) {
    return {
      ok: false,
      why:
        `The payment is ${money(paymentCents)} and what it puts against invoices comes to ${money(allocatedCents)}, ` +
        `${money(Math.abs(differenceCents))} ${differenceCents > 0 ? "more" : "less"}. Nothing was recorded.`,
    };
  }
  return { ok: true, supplier: suppliers[0], allocatedCents, differenceCents };
}
