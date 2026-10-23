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
  /** A debit memo IPD charged, settled by the same credit as the invoices; not an invoice this site will hold. */
  debitMemo?: boolean;
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
  /** The whole credit memo as printed (negative). Larger than `creditMemo.cents` when the memo is applied in more than one part. */
  memoTotalCents: number;
  /** Which part of its memo this is, from 1; a memo applied once is part 1. */
  part: number;
};

export type IpdStatement = {
  asOf: string | null;
  openInvoices: IpdOpenInvoice[];
  /** Open invoices the page prints that could not be read: counted, so that "none open" is never said of a page that shows some. */
  openUnread: number;
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

  /*
   * Then the settlements, each of which must hold together on its own.
   *
   * A settlement is one credit memo applied against the rows it paid. The statement prints them in order (rows, then the
   * credit, then a net of nought), and two things in it break that order, so the rows are collected first and shared out
   * by arithmetic afterwards: a row that pays a debit memo carries a reference ending DM rather than a bare number, and a
   * credit applied in two parts prints its second credit before the rows that credit paid, under one heading.
   * Which rows belong to which credit is then whatever makes each credit's share equal the rows given to it, to the
   * cent, in the order printed; where no split does, the statement is refused and says which block.
   */
  type Raw = {
    reference: string;
    checkDate: string;
    items: IpdSettledInvoice[];
    credits: { totalCents: number; line: string; id: string; issuedOn: string; appliedCents: number | null; prefix: string | null }[];
    nets: number[];
  };
  const groups: Raw[] = [];
  let g: Raw | null = null;
  let pending: { date: string | null; cents: number } | null = null;
  let awaitingMemo = false;

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
      if (pending) return { ok: false, why: `IPD statement: 1 invoice row has no number against it.` };
      const checkDate = iso(head[2]);
      if (!checkDate) return { ok: false, why: `IPD statement: a settlement's date could not be read: "${line.slice(0, 30)}".` };
      g = { reference: head[1].trim(), checkDate, items: [], credits: [], nets: [] };
      groups.push(g);
      awaitingMemo = false;
      continue;
    }
    if (!g) continue;

    const invoiceRow = /^(\d{2}\/\d{2}\/\d{4})I\s*(-?[\d,]+\.\d{2})$/.exec(line);
    if (invoiceRow) {
      const invoiceDate = iso(invoiceRow[1]);
      const invoiceCents = cents(invoiceRow[2]);
      if (!invoiceDate || invoiceCents === null) return { ok: false, why: `IPD statement: an invoice row could not be read: "${line.slice(0, 30)}".` };
      if (pending) return { ok: false, why: `IPD statement: 1 invoice row has no number against it.` };
      pending = { date: invoiceDate, cents: invoiceCents };
      continue;
    }

    /* The same row when the text layer put its date on a line of its own, below it. */
    const undated = /^I\s*(-?[\d,]+\.\d{2})$/.exec(line);
    if (undated && !pending) {
      const c = cents(undated[1]);
      if (c === null) return { ok: false, why: `IPD statement: an invoice row could not be read: "${line.slice(0, 30)}".` };
      pending = { date: null, cents: c };
      continue;
    }
    const bareDate = /^(\d{2}\/\d{2}\/\d{4})$/.exec(line);
    if (bareDate && pending && pending.date === null) {
      pending.date = iso(bareDate[1]);
      if (!pending.date) return { ok: false, why: `IPD statement: an invoice row's date could not be read: "${line.slice(0, 30)}".` };
      continue;
    }

    const creditRow = /^(\d{2}\/\d{2}\/\d{4})C\s*(-?[\d,]+\.\d{2})$/.exec(line);
    if (creditRow) {
      const c = cents(creditRow[2]);
      if (c === null) return { ok: false, why: `IPD statement: a credit row could not be read: "${line.slice(0, 30)}".` };
      g.credits.push({ totalCents: c, line: "", id: "", issuedOn: "", appliedCents: null, prefix: null });
      awaitingMemo = true;
      continue;
    }

    /*
     * The second half of a credit's row: the memo's number and what this settlement put against it. A credit memo's id
     * carries the day it issued, and that day — not the settlement's — is what banks the credit. When a settlement pays a
     * share of a credit the figure can come out of the text layer cut short ("-16,562."), and is then worked out below
     * rather than read.
     */
    const memoRow = /^(\d{4})(\d{8})CM\s*(-?[\d,]+\.(?:\d{2})?)$/.exec(line);
    if (memoRow && awaitingMemo) {
      const credit = g.credits[g.credits.length - 1];
      const issuedOn = `${memoRow[2].slice(0, 4)}-${memoRow[2].slice(4, 6)}-${memoRow[2].slice(6, 8)}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) || !iso(`${Number(issuedOn.slice(5, 7))}/${Number(issuedOn.slice(8, 10))}/${issuedOn.slice(0, 4)}`)) {
        return { ok: false, why: `IPD statement: a credit memo's id carries no date this site can read.` };
      }
      credit.id = memoRow[1] + memoRow[2];
      credit.issuedOn = issuedOn;
      credit.line = line.slice(0, 30);
      if (/\.\d{2}$/.test(memoRow[3])) credit.appliedCents = cents(memoRow[3]);
      else credit.prefix = memoRow[3].replace(/^-/, "");
      awaitingMemo = false;
      continue;
    }

    /* The second half of an invoice row: its number, or a debit memo's reference, and what was put against it. */
    const payRow = /^(\d{3,12}(?:DM)?)\s+(-?[\d,]+\.\d{2})$/.exec(line);
    if (payRow) {
      const paid = cents(payRow[2]);
      if (paid === null || !pending || !pending.date) return { ok: false, why: `IPD statement: a payment row has no invoice above it: "${line.slice(0, 30)}".` };
      if (Math.abs(paid) > Math.abs(pending.cents)) {
        return { ok: false, why: `IPD statement: ${money(paid)} is put against an invoice of ${money(pending.cents)}, which is more than it is for.` };
      }
      g.items.push({ invoiceNumber: payRow[1], invoiceDate: pending.date, invoiceCents: pending.cents, paidCents: paid, debitMemo: payRow[1].endsWith("DM") });
      pending = null;
      continue;
    }

    const netRow = /^(-?[\d,]+\.\d{2})$/.exec(line);
    if (netRow) g.nets.push(cents(netRow[1]) ?? 0);
  }
  if (pending) return { ok: false, why: `IPD statement: 1 invoice row has no number against it.` };

  const settlements: IpdSettlement[] = [];
  for (const grp of groups) {
    if (grp.credits.length === 0) return { ok: false, why: `IPD statement: the ${grp.checkDate} settlement names no credit memo, so what paid it is not on the statement.` };
    if (grp.credits.some((c) => c.id === "")) return { ok: false, why: `IPD statement: a credit in the ${grp.checkDate} settlement has no memo number under it.` };
    const bad = grp.nets.find((n) => n !== 0);
    if (bad !== undefined) return { ok: false, why: `IPD statement: the ${grp.checkDate} settlement prints a net of ${money(bad)} rather than nought.` };

    /* What each credit put against the rows: printed where the text has it, otherwise the memo's total less its other parts. */
    for (const c of grp.credits) {
      if (c.appliedCents !== null) continue;
      const others = grp.credits.filter((o) => o !== c && o.id === c.id);
      if (others.some((o) => o.appliedCents === null)) return { ok: false, why: `IPD statement: two parts of credit memo ${c.id} print no amount, so neither can be worked out.` };
      const worked = c.totalCents - others.reduce((n, o) => n + (o.appliedCents ?? 0), 0);
      if (c.prefix !== null && !money(worked).replace(/^-?\$/, "").startsWith(c.prefix)) {
        return { ok: false, why: `IPD statement: credit memo ${c.id} prints ${c.prefix} where its total less its other part is ${money(worked)}.` };
      }
      c.appliedCents = worked;
    }
    for (const c of grp.credits) {
      const parts = grp.credits.filter((o) => o.id === c.id);
      if (parts.length === 1 && c.appliedCents !== c.totalCents) {
        return { ok: false, why: `IPD statement: the ${grp.checkDate} credit memo prints ${c.line}, which is not the credit above it.` };
      }
      if (parts.reduce((n, o) => n + (o.appliedCents ?? 0), 0) !== c.totalCents) {
        return { ok: false, why: `IPD statement: the parts of credit memo ${c.id} do not come to the credit printed above it.` };
      }
    }

    /* Then the rows, in the order printed, shared out so that each credit's share is exactly what its rows come to. */
    let at = 0;
    const partOf = new Map<string, number>();
    for (const c of grp.credits) {
      const applied = c.appliedCents ?? 0;
      const taken: IpdSettledInvoice[] = [];
      let sum = 0;
      while (at < grp.items.length && sum + applied < 0) {
        taken.push(grp.items[at]);
        sum += grp.items[at].paidCents;
        at++;
      }
      if (sum + applied !== 0) {
        return { ok: false, why: `IPD statement: the ${grp.checkDate} settlement pays ${money(sum)} against a credit of ${money(applied)}, which is not nought.` };
      }
      const part = (partOf.get(c.id) ?? 0) + 1;
      partOf.set(c.id, part);
      settlements.push({
        reference: grp.reference,
        checkDate: grp.checkDate,
        invoices: taken,
        creditMemo: { id: c.id, issuedOn: c.issuedOn, cents: applied },
        memoTotalCents: c.totalCents,
        part,
        paidCents: sum,
      });
    }
    if (at < grp.items.length) {
      const n = grp.items.length - at;
      return { ok: false, why: `IPD statement: ${n} row${n === 1 ? "" : "s"} in the ${grp.checkDate} settlement ${n === 1 ? "is" : "are"} paid by no credit.` };
    }
  }

  /*
   * A statement with no settlements is a statement, not a failure: a month paid entirely by ACH applies no credit and
   * prints no "Credits used" section. Its open invoices and their due dates are still worth having. Only a page that
   * prints the section and yields nothing from it is wrong.
   */
  if (settlements.length === 0 && /credits\s+used\s+since/i.test(text)) {
    return { ok: false, why: "IPD statement: it prints a credits section and no settlement could be read from it." };
  }
  if (settlements.length === 0 && openInvoices.length === 0) return { ok: false, why: "IPD statement: neither a settlement nor an open invoice could be read from it." };

  const openCents = openInvoices.reduce((n, v) => n + v.remainingCents, 0);
  /*
   * Open invoices the page prints but whose due date and balance the text layer dropped (October 2026 printed two as a reference, one date
   * and the original amount). They are counted rather than left out, because "0 invoices still open" would be false.
   */
  const printedOpen = lines.filter((l) => /^\d{3,12}\d{2}\/\d{2}\/\d{4}.*Invoice\s+-?[\d,]+\.\d{2}/.test(l.trim())).length;
  const openUnread = Math.max(0, printedOpen - openInvoices.length);
  const says =
    `IPD statement${asOf ? ` as of ${asOf}` : ""}: ${settlements.length} settlement${settlements.length === 1 ? "" : "s"} ` +
    `(${settlements.map((s) => `${money(s.paidCents)} on ${s.checkDate}`).join(", ")}), each netting to nought against its credit memo; ` +
    (openUnread > 0
      ? `${openInvoices.length} invoice${openInvoices.length === 1 ? "" : "s"} still open that could be read, ${money(openCents)}, and ${openUnread} more printed without a due date or balance, so what is still owed is not taken from this page.`
      : `${openInvoices.length} invoice${openInvoices.length === 1 ? "" : "s"} still open, ${money(openCents)}.`);
  return { ok: true, statement: { asOf, openInvoices, openUnread, settlements, says } };
}
