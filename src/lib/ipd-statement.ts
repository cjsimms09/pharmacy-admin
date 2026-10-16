/**
 * IPD's statement of account: which invoices were settled, by which credit, and which are still open.
 *
 * IPD is not paid from the bank at all. Its invoices are settled by offsetting an Aytu credit memo against them — the
 * owner: *"the credit should be from the top off amounts from aytu"*, and *"if credit is not enough than we use ACH"*.
 * So no bank line exists for these, and this statement is the only document that says what was paid and when.
 *
 * ── What it prints ──
 *
 *   the open invoices, each with its own due date, original amount and what is left on it;
 *   "Credits used Since <date>", then one block per settlement:
 *     a payment reference and a check date,
 *     each invoice it paid — its date, its own amount, and the amount this settlement put against it,
 *     the credit memo that paid them, negative,
 *     and a net, which is nought when the block holds together.
 *
 * An invoice can be settled across two blocks: the sample pays $2,152.03 of one on 3 September and the remaining
 * $1,125.36 of it on 19 August. That is the case a paid date alone cannot hold, and why a payment carries what it put
 * against each invoice (`supplier-payments.ts`).
 *
 * ── The credit memo's date is not the check date ──
 *
 * The 19 August block is paid by a memo whose id ends 20260818: the memo issued on the 18th and IPD applied it on the
 * 19th. The memo's own date is what banks it (`rxRescueMemoKey`, keyed on day and amount), so the id is where the date
 * comes from and never the block's check date, or the same credit banks twice.
 *
 * Pure. `ipd-statement-store.ts` writes.
 */

export type IpdOpenInvoice = {
  invoiceNumber: string;
  invoiceDate: string;
  /** The day the statement says it is due, which is what says which invoices one payment covers. */
  dueOn: string;
  originalCents: number;
  remainingCents: number;
};

export type IpdSettledInvoice = {
  invoiceNumber: string;
  invoiceDate: string;
  /** What the invoice itself is for. */
  invoiceCents: number;
  /** What this settlement put against it, which can be part of it. */
  paidCents: number;
};

export type IpdSettlement = {
  /** IPD's own name for it: "AutoARO" on an offset. */
  reference: string;
  /** The day IPD applied it. */
  checkDate: string;
  invoices: IpdSettledInvoice[];
  /** The credit memo that paid them, as printed (negative). */
  creditMemo: { id: string; issuedOn: string; cents: number } | null;
  /** What the invoices come to: the money this settlement moved. */
  paidCents: number;
};

export type IpdStatement = {
  asOf: string | null;
  openInvoices: IpdOpenInvoice[];
  settlements: IpdSettlement[];
  says: string;
};

export type IpdRead = { ok: true; statement: IpdStatement } | { ok: false; why: string };

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const cents = (s: string): number | null => {
  const t = s.trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+\.\d{2}$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

const iso = (us: string): string | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(us.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const out = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  const d = new Date(`${out}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.getUTCDate() === Number(dd) ? out : null;
};

/**
 * Whether this is IPD's statement, by its own printing rather than by its sender.
 *
 * Their domain prints on every page, and the columns are the same every month. The credits section is NOT required: a
 * month in which every invoice was paid by ACH and no credit was applied prints none, and keying on it would leave that
 * statement unrecognised — which is the month the site would most want the open invoices and their due dates from.
 */
export function looksLikeIpdStatement(text: string): boolean {
  const theirs = /ipdpharma/i.test(text);
  const columns = /payment\s*ref/i.test(text) || /due\s*date/i.test(text) || /credits\s+used\s+since/i.test(text);
  return theirs && columns && /statement/i.test(text);
}

export function readIpdStatement(text: string): IpdRead {
  if (!looksLikeIpdStatement(text)) return { ok: false, why: "Not an IPD statement of account." };
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());

  const asOfLine = lines.find((l) => /^as of:/i.test(l.trim()));
  const asOf = asOfLine ? iso(asOfLine.replace(/^as of:\s*/i, "").trim()) : null;

  /* The open invoices, each printing the day it is due. */
  const openInvoices: IpdOpenInvoice[] = [];
  for (const line of lines) {
    const m = /^(\d{3,12})(\d{2}\/\d{2}\/\d{4})(\d{2}\/\d{2}\/\d{4})Invoice\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/.exec(line.trim());
    if (!m) continue;
    const invoiceDate = iso(m[2]);
    const dueOn = iso(m[3]);
    const originalCents = cents(m[4]);
    const remainingCents = cents(m[5]);
    if (!invoiceDate || !dueOn || originalCents === null || remainingCents === null) {
      return { ok: false, why: `an open invoice line could not be read: "${line.trim().slice(0, 40)}…"` };
    }
    openInvoices.push({ invoiceNumber: m[1], invoiceDate, dueOn, originalCents, remainingCents });
  }

  /* Then the settlements, each of which must hold together on its own. */
  const settlements: IpdSettlement[] = [];
  let current: IpdSettlement | null = null;
  const finish = (net: number | null): string | null => {
    if (!current) return null;
    const credit = current.creditMemo?.cents ?? 0;
    if (credit === 0) return `the ${current.checkDate} settlement names no credit memo, so what paid it is not on the statement`;
    if (current.paidCents + credit !== 0) {
      return `the ${current.checkDate} settlement pays ${money(current.paidCents)} against a credit of ${money(credit)}, which is not nought`;
    }
    if (net !== null && net !== 0) return `the ${current.checkDate} settlement prints a net of ${money(net)} rather than nought`;
    settlements.push(current);
    current = null;
    return null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;

    /*
     * A settlement's head: its reference and the day IPD applied it, with no space in the reference. The statement's own
     * headings end in a date too — "Credits used Since 08/15/2026" opens the section, "Amount Due as of" closes the page
     * — and reading one as a settlement invents a block with no credit memo in it.
     */
    const head = /^([A-Za-z][A-Za-z0-9.\/-]{0,20})\s*(\d{2}\/\d{2}\/\d{4})$/.exec(line);
    if (head && !/credits\s+used|amount\s+due|as\s+of|statement|check\s+date|inv\.\s*date|payment\s*ref/i.test(line)) {
      const problem = finish(null);
      if (problem) return { ok: false, why: `IPD statement: ${problem}.` };
      const checkDate = iso(head[2]);
      if (!checkDate) return { ok: false, why: `IPD statement: a settlement's date could not be read: "${line.slice(0, 30)}".` };
      current = { reference: head[1].trim(), checkDate, invoices: [], creditMemo: null, paidCents: 0 };
      continue;
    }
    if (!current) continue;

    const invoiceRow = /^(\d{2}\/\d{2}\/\d{4})I\s*(-?[\d,]+\.\d{2})$/.exec(line);
    if (invoiceRow) {
      const invoiceDate = iso(invoiceRow[1]);
      const invoiceCents = cents(invoiceRow[2]);
      if (!invoiceDate || invoiceCents === null) return { ok: false, why: `IPD statement: an invoice row could not be read: "${line.slice(0, 30)}".` };
      current.invoices.push({ invoiceNumber: "", invoiceDate, invoiceCents, paidCents: 0 });
      continue;
    }

    const creditRow = /^(\d{2}\/\d{2}\/\d{4})C\s*(-?[\d,]+\.\d{2})$/.exec(line);
    if (creditRow) {
      const c = cents(creditRow[2]);
      if (c === null) return { ok: false, why: `IPD statement: a credit row could not be read: "${line.slice(0, 30)}".` };
      current.creditMemo = { id: "", issuedOn: "", cents: c };
      continue;
    }

    /*
     * The second half of a row, which the text layer prints as its own line: the number and what was put against it.
     * A credit memo's id carries the day it issued, and that day — not the settlement's — is what banks the credit.
     */
    const memoRow = /^(\d{4})(\d{8})CM\s*(-?[\d,]+\.\d{2})$/.exec(line);
    if (memoRow && current.creditMemo) {
      const c = cents(memoRow[3]);
      const issuedOn = `${memoRow[2].slice(0, 4)}-${memoRow[2].slice(4, 6)}-${memoRow[2].slice(6, 8)}`;
      if (c === null || c !== current.creditMemo.cents) {
        return { ok: false, why: `IPD statement: the ${current.checkDate} credit memo prints ${line.slice(0, 30)}, which is not the credit above it.` };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) || !iso(`${Number(issuedOn.slice(5, 7))}/${Number(issuedOn.slice(8, 10))}/${issuedOn.slice(0, 4)}`)) {
        return { ok: false, why: `IPD statement: a credit memo's id carries no date this site can read.` };
      }
      current.creditMemo = { id: memoRow[1] + memoRow[2], issuedOn, cents: c };
      continue;
    }

    const payRow = /^(\d{3,12})\s+(-?[\d,]+\.\d{2})$/.exec(line);
    if (payRow) {
      const paid = cents(payRow[2]);
      const open = current.invoices.find((v) => v.invoiceNumber === "");
      if (paid === null || !open) return { ok: false, why: `IPD statement: a payment row has no invoice above it: "${line.slice(0, 30)}".` };
      if (Math.abs(paid) > Math.abs(open.invoiceCents)) {
        return { ok: false, why: `IPD statement: ${money(paid)} is put against an invoice of ${money(open.invoiceCents)}, which is more than it is for.` };
      }
      open.invoiceNumber = payRow[1];
      open.paidCents = paid;
      current.paidCents += paid;
      continue;
    }

    const netRow = /^(-?[\d,]+\.\d{2})$/.exec(line);
    if (netRow) {
      const problem = finish(cents(netRow[1]));
      if (problem) return { ok: false, why: `IPD statement: ${problem}.` };
    }
  }
  const problem = finish(null);
  if (problem) return { ok: false, why: `IPD statement: ${problem}.` };

  /*
   * A statement with no settlements is a statement, not a failure: a month paid entirely by ACH applies no credit and
   * prints no "Credits used" section. Its open invoices and their due dates are still worth having. Only a page that
   * prints the section and yields nothing from it is wrong.
   */
  if (settlements.length === 0 && /credits\s+used\s+since/i.test(text)) {
    return { ok: false, why: "IPD statement: it prints a credits section and no settlement could be read from it." };
  }
  if (settlements.length === 0 && openInvoices.length === 0) return { ok: false, why: "IPD statement: neither a settlement nor an open invoice could be read from it." };
  const unnamed = settlements.flatMap((s) => s.invoices).filter((v) => v.invoiceNumber === "");
  if (unnamed.length) return { ok: false, why: `IPD statement: ${unnamed.length} invoice row${unnamed.length === 1 ? " has" : "s have"} no number against them.` };

  const openCents = openInvoices.reduce((n, v) => n + v.remainingCents, 0);
  const says =
    `IPD statement${asOf ? ` as of ${asOf}` : ""}: ${settlements.length} settlement${settlements.length === 1 ? "" : "s"} ` +
    `(${settlements.map((s) => `${money(s.paidCents)} on ${s.checkDate}`).join(", ")}), each netting to nought against its credit memo; ` +
    `${openInvoices.length} invoice${openInvoices.length === 1 ? "" : "s"} still open, ${money(openCents)}.`;
  return { ok: true, statement: { asOf, openInvoices, settlements, says } };
}
