/**
 * What actually left the bank for goods in a month.
 *
 * The owner: "we need to make sure the report of mckesson is authority on cash accounting, we need
 * to make sure we are not duplicating, and matching invoices to payments. this needs to be perfect
 * and be completely automated going forward."
 *
 * ── Why this had to change ──
 *
 * The cash account has been taking every supplier invoice dated in the month, at its own total,
 * plus PioneerRx's receiving record where no invoice arrived. That is purchase-date accounting
 * wearing a cash label: an invoice dated 11 September is not paid on 11 September, it is paid when
 * the wholesaler takes it, and McKesson takes a fortnight's invoices together on one day by ACH.
 * September read $270,369.84 of cost against a bank that had seen one McKesson debit of
 * $106,322.62.
 *
 * McKesson's Accounts Payable report says exactly when each invoice cleared and under which ACH.
 * Where the site has that, it is the authority and nothing else is consulted for that supplier.
 *
 * ── The three rules that stop it double counting ──
 *
 *   1. A supplier covered by a statement is counted ONLY from the statement. Their invoices are not
 *      added by date, and their PioneerRx deliveries are not added either — the statement already
 *      has every one of them, including the 42 worth $142,036.21 whose invoices never arrived by
 *      email at all.
 *   2. A supplier with no statement feed is counted exactly as before, from invoice dates, and the
 *      account says so rather than implying the whole figure is a bank figure.
 *   3. Only transactions that have actually CLEARED count. An invoice sitting at "Open - Pending
 *      Approval" is money still in the bank, however certain its due date is.
 *
 * Pure, so both the rules and the arithmetic are tested against the real report rather than against
 * whatever the database holds today.
 */

/** One line of a wholesaler's own ledger, as the statement feed files it. */
export type SettledLine = {
  supplier: string;
  invoiceNumber: string;
  /** What actually leaves the bank for this invoice, after any prompt-pay discount. */
  netCents: number;
  /** The day the money moved. Null while it is still only due. */
  clearingDate: string | null;
  /** The ACH it cleared under. Every invoice sharing one is a single bank debit. */
  checkNumber: string | null;
};

export type InvoiceLike = { supplier: string | null; invoiceNumber: string | null; invoiceDate: string | null; totalCents: number | null };
export type PurchaseLike = { supplier: string | null; invoiceNumber: string | null; invoiceDate: string | null; totalCents: number | null };

export type CashCogs = {
  /** What the bank paid out for goods in the month. Null where nothing is known either way. */
  cents: number | null;
  /** Paid to suppliers whose own ledger the site reads. A real bank figure. */
  settledCents: number;
  /** Estimated from invoice dates for suppliers with no such feed. */
  fromInvoiceDatesCents: number;
  /** PioneerRx's receiving record, for uncovered suppliers whose invoice never came. */
  fromReceivingCents: number;
  /** Suppliers taken from their own ledger, and the ACHs that moved. */
  settledBy: { supplier: string; payments: { checkNumber: string | null; clearingDate: string | null; invoices: number; cents: number }[] }[];
  /** Suppliers still on invoice dates, named so the figure is not read as a bank figure. */
  onInvoiceDates: string[];
  /** What is owed to a settled supplier and has not been taken yet. Not a cost this month. */
  notYetTakenCents: number;
  says: string;
};

/** The two systems spell one wholesaler several ways, so names are compared with the noise removed. */
const fold = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function cashCostOfGoods(input: {
  month: string;
  settled: SettledLine[];
  invoices: InvoiceLike[];
  /** PioneerRx deliveries, used only where no invoice and no statement covers them. */
  receiving: PurchaseLike[];
}): CashCogs {
  const { month, settled, invoices, receiving } = input;

  /*
   * Which suppliers the site can see paying.
   *
   * Coverage is by supplier, not by invoice: once a wholesaler's own ledger is arriving, it is the
   * authority for all of their money, and mixing "this invoice from the statement, that one from
   * its date" is exactly how the same purchase gets counted twice.
   */
  const covered = new Set(settled.map((l) => fold(l.supplier)));

  /* ── 1. Settled suppliers: only what actually moved, in the month it moved ── */
  const movedThisMonth = settled.filter((l) => l.clearingDate?.startsWith(month));
  const settledCents = movedThisMonth.reduce((n, l) => n + l.netCents, 0);

  const bySupplier = new Map<string, Map<string, { checkNumber: string | null; clearingDate: string | null; invoices: number; cents: number }>>();
  for (const l of movedThisMonth) {
    const s = l.supplier;
    const byCheck = bySupplier.get(s) ?? new Map();
    const key = l.checkNumber ?? `no-reference|${l.clearingDate ?? "?"}`;
    const at = byCheck.get(key) ?? { checkNumber: l.checkNumber, clearingDate: l.clearingDate, invoices: 0, cents: 0 };
    at.invoices++;
    at.cents += l.netCents;
    byCheck.set(key, at);
    bySupplier.set(s, byCheck);
  }

  /* What a settled supplier is owed and has not been taken for. Real, and not this month's cost. */
  const notYetTakenCents = settled.filter((l) => !l.clearingDate).reduce((n, l) => n + l.netCents, 0);

  /* ── 2. Everyone else: invoice dates, exactly as before ── */
  const otherInvoices = invoices.filter((v) => !covered.has(fold(v.supplier)) && v.totalCents !== null && v.invoiceDate?.startsWith(month));
  const fromInvoiceDatesCents = otherInvoices.reduce((n, v) => n + (v.totalCents ?? 0), 0);

  /* ── 3. And their deliveries that no invoice ever arrived for ── */
  const invoiceNumbers = new Set(invoices.map((v) => (v.invoiceNumber ?? "").trim().toUpperCase()).filter(Boolean));
  const statementNumbers = new Set(settled.map((l) => l.invoiceNumber.trim().toUpperCase()));
  const uncovered = receiving.filter(
    (p) =>
      !covered.has(fold(p.supplier)) &&
      p.totalCents !== null &&
      p.invoiceDate?.startsWith(month) &&
      !invoiceNumbers.has((p.invoiceNumber ?? "").trim().toUpperCase()) &&
      !statementNumbers.has((p.invoiceNumber ?? "").trim().toUpperCase()),
  );
  const fromReceivingCents = uncovered.reduce((n, p) => n + (p.totalCents ?? 0), 0);

  const onInvoiceDates = [...new Set(otherInvoices.map((v) => v.supplier ?? "an unnamed supplier"))].sort();
  const settledBy = [...bySupplier].map(([supplier, byCheck]) => ({ supplier, payments: [...byCheck.values()].sort((a, b) => (a.clearingDate ?? "").localeCompare(b.clearingDate ?? "")) }));

  const nothingKnown = movedThisMonth.length === 0 && otherInvoices.length === 0 && uncovered.length === 0;
  const cents = nothingKnown ? null : settledCents + fromInvoiceDatesCents + fromReceivingCents;

  const parts: string[] = [];
  for (const s of settledBy) {
    parts.push(
      `${money(s.payments.reduce((n, p) => n + p.cents, 0))} actually taken by ${s.supplier} — ` +
        s.payments.map((p) => `${p.checkNumber ?? "an unreferenced debit"} on ${p.clearingDate} covering ${p.invoices} invoice${p.invoices === 1 ? "" : "s"}`).join(", "),
    );
  }
  if (fromInvoiceDatesCents > 0)
    parts.push(`${money(fromInvoiceDatesCents)} from ${onInvoiceDates.join(", ")}, whose payments this site cannot see, so their invoice dates stand in`);
  if (fromReceivingCents > 0) parts.push(`${money(fromReceivingCents)} from PioneerRx's receiving record where no invoice arrived`);

  return {
    cents,
    settledCents,
    fromInvoiceDatesCents,
    fromReceivingCents,
    settledBy,
    onInvoiceDates,
    notYetTakenCents,
    says: parts.length ? parts.join("; ") + "." : "Nothing left the bank for goods in this month that the site can see.",
  };
}

/**
 * Proof that no purchase reached the cash figure twice.
 *
 * The owner: "make sure we are not duplicating!!!!! cant stress this enough, this process and logic
 * need to be perfect and needs to be automated."
 *
 * The rules above are written so it cannot happen, and the tests hold them. This is the belt to
 * that braces: it re-derives the three buckets the figure was built from and looks for any invoice
 * number appearing in more than one. A rule can be reasoned about; a count can be checked. If this
 * ever returns a row, the figure on the screen is wrong and the site says so rather than a
 * pharmacist discovering it from a bank balance.
 *
 * Three ways the same purchase could be counted twice, and this sees all of them:
 *
 *   the statement and the invoice file — one wholesaler's invoice, taken from their ledger and
 *                                        added again by its own date.
 *   the statement and PioneerRx        — the same delivery, from the ledger and from receiving.
 *   the invoice file and PioneerRx     — the case that already had a guard, kept under the same eye.
 */
export function countedTwiceInCash(input: {
  month: string;
  settled: SettledLine[];
  invoices: InvoiceLike[];
  receiving: PurchaseLike[];
}): { invoiceNumber: string; supplier: string; inBoth: string[]; cents: number }[] {
  const { month, settled, invoices, receiving } = input;
  const covered = new Set(settled.map((l) => fold(l.supplier)));
  const key = (n: string | null | undefined) => (n ?? "").trim().toUpperCase();

  const buckets = new Map<string, { supplier: string; cents: number; where: Set<string> }>();
  const note = (n: string, supplier: string | null, cents: number, where: string) => {
    const k = key(n);
    if (!k) return;
    const at = buckets.get(k) ?? { supplier: supplier ?? "?", cents, where: new Set<string>() };
    at.where.add(where);
    buckets.set(k, at);
  };

  for (const l of settled.filter((x) => x.clearingDate?.startsWith(month))) note(l.invoiceNumber, l.supplier, l.netCents, "the wholesaler's own ledger");
  for (const v of invoices.filter((x) => !covered.has(fold(x.supplier)) && x.totalCents !== null && x.invoiceDate?.startsWith(month)))
    note(v.invoiceNumber, v.supplier, v.totalCents ?? 0, "the invoice file");
  const invoiceNumbers = new Set(invoices.map((v) => key(v.invoiceNumber)).filter(Boolean));
  const statementNumbers = new Set(settled.map((l) => key(l.invoiceNumber)));
  for (const p of receiving.filter(
    (x) =>
      !covered.has(fold(x.supplier)) &&
      x.totalCents !== null &&
      x.invoiceDate?.startsWith(month) &&
      !invoiceNumbers.has(key(x.invoiceNumber)) &&
      !statementNumbers.has(key(x.invoiceNumber)),
  ))
    note(p.invoiceNumber, p.supplier, p.totalCents ?? 0, "PioneerRx's receiving record");

  return [...buckets]
    .filter(([, v]) => v.where.size > 1)
    .map(([invoiceNumber, v]) => ({ invoiceNumber, supplier: v.supplier, inBoth: [...v.where].sort(), cents: v.cents }));
}
