/**
 * McKesson's Accounts Payable Open & Closed Transactions report.
 *
 * The owner: "Accounts Payable Open & Closed Transaction just sent this now... set system up to
 * receive these weekly. make sure system knows what to do with it and correctly allocated cash
 * accounting method (no duplicates), and make sure everything matches what we expect based on
 * invoices we have already."
 *
 * It arrives as a zip from era@mckesson.com holding two CSVs, and it is a far better source than
 * the printed statement of account: one row per invoice, with what was billed, what discount was
 * taken, what was actually paid, when it is due, whether it has cleared, and — the part nothing
 * else has — the ACH reference it cleared under.
 *
 * ── It is not a bill ──
 *
 * Every row is an invoice the site already holds or will hold. Booking this report as a cost would
 * count a month's buying twice; the first one carries $253,245.45 across 63 rows. Nothing here
 * reaches an account as a cost. It carries the three facts an invoice cannot:
 *
 *   the due date     — when McKesson will take it.
 *   the check number — every invoice sharing "CKACH07227740" was taken as ONE debit. This is the
 *                      key that makes a bank line matchable: no bank line will ever equal one
 *                      invoice, and until now there was no way to know which invoices made it up.
 *   whether it cleared — "Closed - Cleared" with a clearing date, against "Open - Pending Approval".
 *
 * ── The discount, and a thing worth knowing ──
 *
 * Each row carries a gross, a 2% cash discount, and a net. The net is what leaves the bank — and it
 * is also exactly what the invoice PDF prints as its total. Invoice 7657345037 is $13,263.58 gross,
 * $265.27 discount, $12,998.31 net, and the site has held $12,998.31 for it since it arrived. So
 * the books were already on the net figure and no discount is missing from them. Worth stating
 * plainly, because the printed statement shows the gross first and reads as though the site were
 * overstating what it pays by two per cent.
 */

import { parseCsv } from "./reference";

export type ApTransaction = {
  /** The wholesaler's own invoice number. What ties this to an invoice on file. */
  invoiceNumber: string;
  transactionDate: string;
  dueOn: string | null;
  /** What the invoice was raised at, before the prompt-pay discount. */
  grossCents: number;
  discountCents: number;
  /** What is actually paid, and what the invoice PDF prints as its total. */
  netCents: number;
  /** True once McKesson has taken it. */
  cleared: boolean;
  status: string;
  /** The ACH reference every invoice in one debit shares. The bank-matching key. */
  checkNumber: string | null;
  clearingDate: string | null;
  clearingDocument: string | null;
  transactionType: string;
};

export type ApRead = {
  accountNumber: string | null;
  accountName: string | null;
  rows: ApTransaction[];
  unreadable: string[];
  openCents: number;
  clearedCents: number;
};

/** One ACH debit: every transaction sharing a check number, which is how the bank will show it. */
export type ApPayment = {
  checkNumber: string;
  clearingDate: string | null;
  dueOn: string | null;
  invoices: string[];
  grossCents: number;
  discountCents: number;
  /** The figure to look for on the bank statement. */
  netCents: number;
};

const money = (raw: string | undefined): number | null => {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t) || t.startsWith("-");
  const n = Number(t.replace(/[$,()\-\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (negative ? -1 : 1);
};

const date = (raw: string | undefined): string | null => {
  const t = (raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

export function readApTransactions(csv: string): ApRead {
  const rows = parseCsv(csv);
  const out: ApTransaction[] = [];
  const unreadable: string[] = [];
  let accountNumber: string | null = null;
  let accountName: string | null = null;

  for (const r of rows) {
    const invoiceNumber = (r["Receivable Number"] ?? "").trim();
    if (!invoiceNumber) continue;
    accountNumber = accountNumber ?? ((r["Account Number"] ?? "").trim() || null);
    accountName = accountName ?? ((r["Account Name"] ?? "").trim() || null);

    const grossCents = money(r["Gross Amount ($)"]);
    const discountCents = money(r["Cash Discount ($)"]) ?? 0;
    const netCents = money(r["Net Amount ($)"]);
    const transactionDate = date(r["Transaction Date"]);

    if (grossCents === null || netCents === null || !transactionDate) {
      unreadable.push(`${invoiceNumber}: gross, net or transaction date could not be read.`);
      continue;
    }
    /*
     * The row's own arithmetic, as everywhere else here. These columns are comma-quoted and a
     * shifted column would put a plausible wrong figure against a real invoice number.
     */
    if (grossCents - discountCents !== netCents) {
      unreadable.push(`${invoiceNumber}: ${grossCents} less ${discountCents} is not ${netCents}.`);
      continue;
    }

    const status = (r["Transaction Status"] ?? "").trim();
    out.push({
      invoiceNumber,
      transactionDate,
      dueOn: date(r["Due Date"]),
      grossCents,
      discountCents,
      netCents,
      /* "Closed - Cleared" against "Open - Pending Approval". Only the first has been paid. */
      cleared: /closed/i.test(status) && /clear/i.test(status),
      status,
      checkNumber: (r["Check Number"] ?? "").trim() || null,
      clearingDate: date(r["Clearing Date"]),
      clearingDocument: (r["Clearing Document"] ?? "").trim() || null,
      transactionType: (r["Transaction Type"] ?? "").trim(),
    });
  }

  return {
    accountNumber,
    accountName,
    rows: out,
    unreadable,
    openCents: out.filter((x) => !x.cleared).reduce((n, x) => n + x.netCents, 0),
    clearedCents: out.filter((x) => x.cleared).reduce((n, x) => n + x.netCents, 0),
  };
}

/**
 * The cleared transactions grouped the way the bank will show them: one row per ACH.
 *
 * A bank debit of $124,007.43 matches no invoice and never will — it is dozens of them taken
 * together. Grouped by the check number McKesson clears them under, one figure on the bank
 * statement names every invoice inside it.
 */
export function apPayments(read: ApRead): ApPayment[] {
  const by = new Map<string, ApPayment>();
  for (const r of read.rows) {
    if (!r.cleared || !r.checkNumber) continue;
    const at =
      by.get(r.checkNumber) ??
      ({ checkNumber: r.checkNumber, clearingDate: r.clearingDate, dueOn: r.dueOn, invoices: [], grossCents: 0, discountCents: 0, netCents: 0 } as ApPayment);
    at.invoices.push(r.invoiceNumber);
    at.grossCents += r.grossCents;
    at.discountCents += r.discountCents;
    at.netCents += r.netCents;
    by.set(r.checkNumber, at);
  }
  return [...by.values()].sort((a, b) => (a.clearingDate ?? "").localeCompare(b.clearingDate ?? ""));
}

/**
 * What McKesson is about to take, and when, for money the pharmacy has not paid yet.
 *
 * Grouped by due date rather than check number, because an open transaction has no check number —
 * it has not been paid. This is the forward look: on the 15th, this much leaves.
 */
export function apUpcoming(read: ApRead): { dueOn: string; invoices: string[]; netCents: number }[] {
  const by = new Map<string, { dueOn: string; invoices: string[]; netCents: number }>();
  for (const r of read.rows) {
    if (r.cleared || !r.dueOn) continue;
    const at = by.get(r.dueOn) ?? { dueOn: r.dueOn, invoices: [], netCents: 0 };
    at.invoices.push(r.invoiceNumber);
    at.netCents += r.netCents;
    by.set(r.dueOn, at);
  }
  return [...by.values()].sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

export type ApAgreement = {
  /** Invoices where the report's net and the invoice on file agree to the cent. */
  agree: number;
  /** Where they differ, with both figures, so somebody can look at the document. */
  differ: { invoiceNumber: string; onFileCents: number; reportCents: number; differenceCents: number }[];
  /** On the report and not on file at all — an invoice that never arrived by email. */
  notOnFile: { invoiceNumber: string; netCents: number; transactionDate: string }[];
  says: string;
};

/**
 * Whether the report agrees with the invoices already held.
 *
 * The owner: "make sure everything matches what we expect based on invoices we have already." Two
 * independent records of the same purchase — the PDF the wholesaler emailed, and the wholesaler's
 * own ledger — so where they disagree, one of them is wrong and it is worth knowing which.
 *
 * A row on the report with no invoice on file is the more useful finding: it is a purchase the
 * pharmacy was billed for and has no document of.
 */
export function agreesWithInvoices(read: ApRead, onFile: { invoiceNumber: string | null; totalCents: number | null }[]): ApAgreement {
  const held = new Map<string, number>();
  for (const i of onFile) {
    const n = (i.invoiceNumber ?? "").trim();
    if (n && i.totalCents !== null) held.set(n, i.totalCents);
  }

  const out: ApAgreement = { agree: 0, differ: [], notOnFile: [], says: "" };
  for (const r of read.rows) {
    /* Only invoices. A credit or an adjustment has no PDF of its own to agree with. */
    if (!/inv/i.test(r.transactionType)) continue;
    const onFileCents = held.get(r.invoiceNumber);
    if (onFileCents === undefined) {
      out.notOnFile.push({ invoiceNumber: r.invoiceNumber, netCents: r.netCents, transactionDate: r.transactionDate });
      continue;
    }
    if (onFileCents === r.netCents) out.agree++;
    else out.differ.push({ invoiceNumber: r.invoiceNumber, onFileCents, reportCents: r.netCents, differenceCents: onFileCents - r.netCents });
  }

  const m = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  out.says =
    `${out.agree} invoice${out.agree === 1 ? "" : "s"} on this report agree to the cent with the invoice on file` +
    `${out.differ.length ? `; ${out.differ.length} differ (${out.differ.slice(0, 3).map((d) => `${d.invoiceNumber} ${m(d.onFileCents)} here against ${m(d.reportCents)}`).join(", ")})` : ""}` +
    `${out.notOnFile.length ? `; ${out.notOnFile.length} worth ${m(out.notOnFile.reduce((n, x) => n + x.netCents, 0))} are on the report with no invoice on file` : ""}`;
  return out;
}

/**
 * Files an Accounts Payable report: every row kept, nothing booked as a cost.
 *
 * The owner: "make sure system knows what to do with it and correctly allocated cash accounting
 * method (no duplicates)". The no-duplicates guarantee is the unique index on supplier, invoice
 * number and due date — these reports overlap by design, since each week repeats everything not yet
 * taken, and the same invoice arriving on four consecutive Fridays must be one row.
 *
 * A row already held is updated rather than skipped, because the interesting fields change: an
 * invoice moves from "Open - Pending Approval" to "Closed - Cleared" and gains a check number and a
 * clearing date. That transition is the whole point, and a store that refused the second copy would
 * never see a payment happen.
 */
export async function fileApTransactions(
  read: ApRead,
  supplier: string,
  documentId: string | null,
): Promise<{ written: number; updated: number; cleared: number; says: string }> {
  const { db, schema } = await import("@/db");
  const { and, eq } = await import("drizzle-orm");
  const { newId } = await import("./crypto");

  let written = 0;
  let updated = 0;
  for (const r of read.rows) {
    if (!r.dueOn) continue;
    const where = and(
      eq(schema.supplierStatementLines.supplier, supplier),
      eq(schema.supplierStatementLines.invoiceNumber, r.invoiceNumber),
      eq(schema.supplierStatementLines.dueOn, r.dueOn),
    );
    const held = await db.query.supplierStatementLines.findFirst({ where });
    const values = {
      supplier,
      invoiceNumber: r.invoiceNumber,
      billedOn: r.transactionDate,
      dueOn: r.dueOn,
      grossCents: r.grossCents,
      discountCents: r.discountCents,
      netCents: r.netCents,
      kind: r.transactionType || "Invoice",
      checkNumber: r.checkNumber,
      clearingDate: r.clearingDate,
      clearingDocument: r.clearingDocument,
      status: r.status,
      documentId,
      readAt: new Date().toISOString(),
    };
    if (held) {
      await db.update(schema.supplierStatementLines).set(values).where(where);
      updated++;
    } else {
      await db.insert(schema.supplierStatementLines).values({ id: newId(), ...values });
      written++;
    }
  }

  const payments = apPayments(read);
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const upcoming = apUpcoming(read);
  return {
    written,
    updated,
    cleared: read.rows.filter((r) => r.cleared).length,
    says:
      `${read.rows.length} transactions from ${supplier} — ${written} new, ${updated} already held and brought up to date. ` +
      `${payments.length ? `${payments.map((p) => `${p.checkNumber} took ${money(p.netCents)} on ${p.clearingDate} across ${p.invoices.length} invoices`).join("; ")}. ` : ""}` +
      `${upcoming.length ? `${upcoming.map((u) => `${money(u.netCents)} due ${u.dueOn} across ${u.invoices.length} invoices`).join("; ")}.` : ""}`.trim(),
  };
}

/**
 * Every ACH this pharmacy has been told about, for putting a bank line against.
 *
 * Read back from what the reports have filed rather than recomputed, so the figure on the screen
 * and the figure the report carried are the same one.
 */
export async function achPayments(): Promise<ApPayment[]> {
  const { db, schema } = await import("@/db");
  const { isNotNull } = await import("drizzle-orm");
  const rows = await db.query.supplierStatementLines.findMany({ where: isNotNull(schema.supplierStatementLines.checkNumber) });
  const by = new Map<string, ApPayment>();
  for (const r of rows) {
    const key = r.checkNumber!;
    const at = by.get(key) ?? { checkNumber: key, clearingDate: r.clearingDate, dueOn: r.dueOn, invoices: [], grossCents: 0, discountCents: 0, netCents: 0 };
    at.invoices.push(r.invoiceNumber);
    at.grossCents += r.grossCents;
    at.discountCents += r.discountCents;
    at.netCents += r.netCents;
    by.set(key, at);
  }
  return [...by.values()].sort((a, b) => (b.clearingDate ?? "").localeCompare(a.clearingDate ?? ""));
}

export type ReturnCredit = {
  /** McKesson's credit number. It settles like an invoice and belongs in the same ledger. */
  creditNumber: string;
  creditedOn: string;
  ndc11: string | null;
  description: string | null;
  /** Negative: money coming back. */
  netCents: number;
  handlingCents: number;
  quantity: number;
  reason: string;
  /** The invoice the goods were bought on, where the report names it. */
  originalInvoice: string | null;
};

/**
 * McKesson's Returns Details report — what went back, and what was credited for it.
 *
 * The owner: "i also am having it send a returned items report". It arrives in the same weekly zip
 * family as the accounts payable one, from era@mckesson.com, and it is the other half of the same
 * ledger: the AP report is money going out, this is money coming back.
 *
 * Each row is a credit note with its own number, so it settles exactly as an invoice does and is
 * stored in the same place, negative. The reason matters as well as the money — "Saleable Return"
 * against the non-saleable kinds — because it is the difference between stock that could go back
 * and stock that was written off.
 */
export function readReturnsDetail(csv: string): { credits: ReturnCredit[]; unreadable: string[]; totalCents: number } {
  const rows = parseCsv(csv);
  const credits: ReturnCredit[] = [];
  const unreadable: string[] = [];
  for (const r of rows) {
    const creditNumber = (r["Invoice/Credit Number"] ?? "").trim();
    const creditedOn = date(r["Date Credited Back to Customer"]) ?? date(r["Invoice/Credit Date"]);
    const netCents = money(r["Net Returned Price ($)"]);
    if (!creditNumber || !creditedOn || netCents === null) {
      if (creditNumber) unreadable.push(`${creditNumber}: no credit date or no net price.`);
      continue;
    }
    const digits = (r["NDC/UPC (History)"] ?? r["NDC/UPC (Current)"] ?? "").replace(/\D/g, "");
    credits.push({
      creditNumber,
      creditedOn,
      ndc11: digits.length === 11 ? digits : null,
      description: (r["Item Description"] ?? "").trim() || null,
      netCents,
      handlingCents: money(r["Net Handling Charge Amount ($)"]) ?? 0,
      quantity: Number((r["Returned Quantity"] ?? "0").replace(/[^\d.-]/g, "")) || 0,
      reason: (r["Return Reason Description"] ?? "").trim(),
      originalInvoice: (r["Original Invoice Number"] ?? "").trim() || null,
    });
  }
  return { credits, unreadable, totalCents: credits.reduce((n, c) => n + c.netCents, 0) };
}

/** Whether a CSV is the Returns Details report, by the columns only it carries together. */
export function looksLikeReturnsDetail(head: string): boolean {
  const first = head.split(String.fromCharCode(10))[0] ?? "";
  return /Invoice\/Credit Number/i.test(first) && /Net Returned Price/i.test(first) && /Return(ed)? (Quantity|Reason)/i.test(first);
}

/**
 * Files returns as credits in the same ledger the invoices settle in.
 *
 * A credit is settled money like an invoice is, so it belongs beside them rather than in a table of
 * its own — and the same unique key (supplier, number, date) means a report repeating last week's
 * returns writes each credit once. Negative, because it is money coming back.
 */
export async function fileReturnCredits(
  credits: ReturnCredit[],
  supplier: string,
  documentId: string | null,
): Promise<{ written: number; updated: number; totalCents: number; says: string }> {
  const { db, schema } = await import("@/db");
  const { and, eq } = await import("drizzle-orm");
  const { newId } = await import("./crypto");

  /* One credit note can cover several items. The ledger wants the note, so its lines are added up. */
  const byNote = new Map<string, { cents: number; handling: number; on: string; items: number; reasons: Set<string> }>();
  for (const c of credits) {
    const at = byNote.get(c.creditNumber) ?? { cents: 0, handling: 0, on: c.creditedOn, items: 0, reasons: new Set<string>() };
    at.cents += c.netCents;
    at.handling += c.handlingCents;
    at.items++;
    if (c.reason) at.reasons.add(c.reason);
    byNote.set(c.creditNumber, at);
  }

  let written = 0;
  let updated = 0;
  for (const [creditNumber, v] of byNote) {
    const where = and(
      eq(schema.supplierStatementLines.supplier, supplier),
      eq(schema.supplierStatementLines.invoiceNumber, creditNumber),
      eq(schema.supplierStatementLines.dueOn, v.on),
    );
    const held = await db.query.supplierStatementLines.findFirst({ where });
    const values = {
      supplier,
      invoiceNumber: creditNumber,
      billedOn: v.on,
      dueOn: v.on,
      grossCents: v.cents,
      discountCents: 0,
      netCents: v.cents,
      kind: [...v.reasons][0] || "Credit",
      status: "Credited",
      documentId,
      readAt: new Date().toISOString(),
    };
    if (held) {
      await db.update(schema.supplierStatementLines).set(values).where(where);
      updated++;
    } else {
      await db.insert(schema.supplierStatementLines).values({ id: newId(), ...values });
      written++;
    }
  }

  const total = [...byNote.values()].reduce((n, v) => n + v.cents, 0);
  const m = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    written,
    updated,
    totalCents: total,
    says: `${byNote.size} credit note${byNote.size === 1 ? "" : "s"} from ${supplier} worth ${m(total)} coming back — ${written} new, ${updated} already held.`,
  };
}

/**
 * Whether a CSV is McKesson's Accounts Payable Open & Closed Transactions report.
 *
 * Three columns together, because each alone appears elsewhere: a receivable number is an invoice
 * number, a net amount is on any billing file, and a transaction status is on half of them. All
 * three in one header row is this report and nothing else the pharmacy receives.
 */

export function looksLikeApTransactions(head: string): boolean {
  const first = head.split(String.fromCharCode(10))[0] ?? "";
  return (
    /Receivable Number/i.test(first) &&
    /Transaction Status/i.test(first) &&
    /Net Amount/i.test(first)
  );
}
