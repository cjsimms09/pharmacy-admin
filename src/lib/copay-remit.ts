/**
 * The copay-voucher remittance, read as figures.
 *
 * The owner, uploading one: "this is remit confirmation for copay cards. we need to be reconciling
 * against the claims. we probably dont have these claims in our system but lets make sure this
 * process is set up and correct for future."
 *
 * It is RedSail Technologies' "Remittance Advice — RAS Copay Voucher Reimbursement": the settlement
 * for claims that adjudicate on BIN 028249 / PCN RXLOCAL, which is the copay-assistance secondary
 * and the one BIN the PSAO listing does not name. The claim already carries what the voucher
 * promised at adjudication; this document is that promise arriving, which is why a matched line
 * settles the claim rather than adding to it.
 *
 * ── Three arithmetic gates, and why each one exists ──
 *
 * Nothing here is stored on the strength of having parsed. A remittance that reads plausibly and is
 * wrong is worse than one that fails, because every figure it touches — what a fill actually
 * earned, what is still owed, what went in the bank — looks complete afterwards.
 *
 *   Per line: submitted less what the patient paid is what the voucher pays. It holds on every row
 *   of the statement in hand, to the cent, which makes it the line's own check on itself. A row
 *   that fails it has had a figure misread, and is returned as unreadable rather than as three
 *   numbers that do not agree.
 *
 *   Per statement: the rows net to the printed total. Reversals are the same row negated, so the
 *   sum is over the net rather than the gross — $177.25 on the statement in hand is one $174.31 and
 *   one $2.94, with five other prescriptions paid and reversed in the same period.
 *
 *   Per prescription: a fill and its reversal cancel. Recording either half alone would show money
 *   arriving that was taken back, or a credit with nothing behind it.
 *
 * ── Why the identity fields are read digit by digit ──
 *
 * The page's text layer breaks a twelve-digit prescription number or an eleven-digit NDC across
 * text runs, so "000000330027" can arrive as "0000003 30027" and the same row read by columns comes
 * apart. The head of every row is exactly thirty-one digits — twelve of prescription, eight of
 * date, eleven of NDC — so they are taken as thirty-one digits with the spaces ignored, and
 * whatever follows is the drug name. Then the date is checked for being a date, because a row that
 * yielded thirty-one digits by borrowing one from the drug name yields a date that is not one.
 *
 * Pure. The matching to claims and the writing are in `copay-remit-store.ts`.
 */

/** One row as printed, before reversals are netted. */
export type CopayRemitLine = {
  /** As printed, zero-padded. `splitReference` in the 835 reader turns it into a prescription and a fill. */
  reference: string;
  rxNumber: string;
  fillNumber: number | null;
  /** ISO. The date of service, which is the fill date the claim carries. */
  dateOfService: string;
  ndc11: string;
  drug: string;
  /** Thousandths, so a quantity of 0.5 is not a rounding decision. Negative on a reversal. */
  quantityThousandths: number;
  submittedCents: number;
  patientPaidCents: number;
  /** What the voucher pays. Negative on a reversal. */
  paidCents: number;
};

/** One prescription, fill and NDC, with its reversals netted into it. */
export type CopayRemitNetLine = {
  reference: string;
  rxNumber: string;
  fillNumber: number | null;
  dateOfService: string;
  ndc11: string;
  drug: string;
  quantityThousandths: number;
  submittedCents: number;
  patientPaidCents: number;
  paidCents: number;
  /** How many printed rows went into it, so a netted pair can be told from a single payment. */
  rows: number;
  /** True where the rows cancel exactly: paid and taken back, nothing to record. */
  reversed: boolean;
};

export type CopayRemitTotals = {
  claimsCents: number | null;
  feeCents: number | null;
  balanceForwardCents: number | null;
  paidCents: number | null;
};

export type CopayRemit = {
  payer: string;
  /** ISO. The day the payment was made, which is the day the money is received on. */
  paidOn: string | null;
  /** The check or ACH number: the payment's identity, so it is banked once. */
  reference: string | null;
  paymentAmountCents: number | null;
  npi: string | null;
  lines: CopayRemitLine[];
  net: CopayRemitNetLine[];
  totals: CopayRemitTotals;
  /** What the rows net to, which is what is checked against the printed total. */
  netCents: number;
  /**
   * Whether the rows net to the total printed on the statement.
   *
   * Null where the statement printed no total to check against — not true, and not false. An
   * unverifiable read is a different thing from a read that disagrees, and only one of them is a
   * reason to suspect the reader.
   */
  reconciles: boolean | null;
  /**
   * Whether the footer agrees with itself: amount paid is the claims total give or take the fee.
   *
   * Null where the statement prints only one of the two. A separate question from `reconciles`,
   * which is about the rows: they can be perfect while the footer contradicts itself.
   */
  totalsAgree: boolean | null;
  /** Rows that looked like items and did not hold together, kept verbatim so somebody can look. */
  unreadable: string[];
};

export const COPAY_PAYER = "RedSail Technologies (RAS copay voucher)";

/** The BIN these claims adjudicate on. The PSAO listing does not name it; the claims do. */
export const COPAY_BIN = "028249";
export const COPAY_PCN = "RXLOCAL";

const cents = (s: string): number => Math.round(Number(s.replace(/[$,\s]/g, "")) * 100);
const thousandths = (s: string): number => Math.round(Number(s.replace(/[,\s]/g, "")) * 1000);

/** A figure at the end of a row: optionally negative, with or without a decimal part. */
const AMOUNT = /^-?\d+(?:\.\d+)?$/;

/** "09/01/2026" as the header writes it. */
function isoFromSlashes(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  return isRealDate(iso) ? iso : null;
}

/** "20260821" as the rows write it. */
function isoFromCompact(s: string): string | null {
  if (!/^\d{8}$/.test(s)) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return isRealDate(iso) ? iso : null;
}

/**
 * A date, rather than eight digits.
 *
 * This is the check that catches a row whose thirty-one digits were made up by borrowing one from
 * the drug name or losing one from the NDC: everything shifts, and the eight digits in the middle
 * stop being a month and a day. Cheaper and more certain than any amount of care in the split.
 */
function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number) as unknown as [string, number, number, number];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Takes the first `n` digits of a string, ignoring any spaces between them.
 *
 * Returns the digits and what was left, or null where there were not enough. This is what makes the
 * reader indifferent to where the page's text layer chose to break a number.
 */
function leadingDigits(s: string, n: number): { digits: string; rest: string } | null {
  let digits = "";
  let i = 0;
  while (i < s.length && digits.length < n) {
    const c = s[i];
    if (c >= "0" && c <= "9") digits += c;
    else if (c !== " " && c !== "\t") break;
    i++;
  }
  if (digits.length < n) return null;
  return { digits, rest: s.slice(i) };
}

/** The prescription and fill as the 835 reader splits them, so both paths agree on what a fill is. */
function splitRx(reference: string): { rxNumber: string; fillNumber: number | null } {
  const dash = /^0*(\d+)\s*-\s*(\d+)$/.exec(reference);
  if (dash) return { rxNumber: dash[1], fillNumber: Number(dash[2]) };
  const fill = /^0*(\d+)\s*FILL\s*(\d+)$/i.exec(reference);
  if (fill) return { rxNumber: fill[1], fillNumber: Number(fill[2]) };
  const bare = /^0*(\d+)$/.exec(reference);
  if (bare) return { rxNumber: bare[1], fillNumber: null };
  return { rxNumber: reference, fillNumber: null };
}

/** One printed row, or null with the reason it could not be read as figures. */
export function parseCopayRemitLine(raw: string): { line: CopayRemitLine } | { why: string } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { why: "empty" };

  // The four amounts come off the end first: they are the only unambiguous part of the row.
  const parts = text.split(" ");
  if (parts.length < 5) return { why: "too few fields to be an item row" };
  const tail = parts.slice(-4);
  if (!tail.every((p) => AMOUNT.test(p))) return { why: "the last four fields are not four figures" };
  const head = parts.slice(0, -4).join(" ");

  const rx = leadingDigits(head, 12);
  if (!rx) return { why: "no twelve-digit prescription number at the start" };
  const dos = leadingDigits(rx.rest, 8);
  if (!dos) return { why: "no eight-digit date of service" };
  const ndc = leadingDigits(dos.rest, 11);
  if (!ndc) return { why: "no eleven-digit NDC" };

  const dateOfService = isoFromCompact(dos.digits);
  if (!dateOfService) return { why: `"${dos.digits}" is not a date, so the row's fields are not where they look` };

  const drug = ndc.rest.trim();
  if (!drug) return { why: "no drug name after the NDC" };

  const [q, sub, pat, paid] = tail;
  const line: CopayRemitLine = {
    reference: rx.digits,
    ...splitRx(rx.digits),
    dateOfService,
    ndc11: ndc.digits,
    drug,
    quantityThousandths: thousandths(q),
    submittedCents: cents(sub),
    patientPaidCents: cents(pat),
    paidCents: cents(paid),
  };

  /*
   * The line's own check on itself: submitted, less what the patient paid, is what the voucher pays.
   *
   * It holds to the cent on every row of the statement in hand, in both directions — a reversal
   * negates all three and the identity survives. A row that fails it has had a figure misread, and
   * three numbers that do not agree with each other are worse than none, because each one of them
   * is separately believable.
   */
  if (line.submittedCents - line.patientPaidCents !== line.paidCents) {
    return {
      why: `submitted less patient paid is ${((line.submittedCents - line.patientPaidCents) / 100).toFixed(2)}, but the row pays ${(line.paidCents / 100).toFixed(2)}`,
    };
  }
  return { line };
}

/** Nets a fill and its reversal into one, keyed by prescription, date of service and NDC. */
export function netCopayLines(lines: CopayRemitLine[]): CopayRemitNetLine[] {
  const by = new Map<string, CopayRemitNetLine>();
  for (const l of lines) {
    const key = `${l.rxNumber}|${l.fillNumber ?? ""}|${l.dateOfService}|${l.ndc11}`;
    const held = by.get(key);
    if (!held) {
      by.set(key, { ...l, rows: 1, reversed: false });
      continue;
    }
    held.rows++;
    held.quantityThousandths += l.quantityThousandths;
    held.submittedCents += l.submittedCents;
    held.patientPaidCents += l.patientPaidCents;
    held.paidCents += l.paidCents;
  }
  for (const n of by.values()) {
    // Paid and taken back. Not a payment of nothing — nothing to record at all, and worth counting.
    n.reversed = n.rows > 1 && n.paidCents === 0 && n.submittedCents === 0;
  }
  return [...by.values()];
}

/**
 * Reads the whole statement.
 *
 * The header and footer are taken by label rather than by position, because a scan re-run at a
 * different resolution moves every line on the page and moves not one of the words.
 */
export function parseCopayRemit(text: string): CopayRemit {
  const rows = text.split(/\r?\n/);
  const label = (re: RegExp): string | null => {
    for (const r of rows) {
      const m = re.exec(r);
      if (m) return m[1].trim();
    }
    return null;
  };

  const paidOnRaw = label(/Payment\s*Date\s*:?\s*([\d/]+)/i);
  const amountRaw = label(/Payment\s*Amount\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  const totals: CopayRemitTotals = {
    claimsCents: money(label(/Total\s*Claims\s*:?\s*\$?\s*(-?[\d,]+\.\d{2})/i)),
    feeCents: money(label(/Total\s*Fee\s*:?\s*\$?\s*(-?[\d,]+\.\d{2})/i)),
    balanceForwardCents: money(label(/Balance\s*Forward\s*Amount\s*:?\s*\$?\s*(-?[\d,]+\.\d{2})/i)),
    paidCents: money(label(/Total\s*Amount\s*Paid\s*:?\s*\$?\s*(-?[\d,]+\.\d{2})/i)),
  };

  const lines: CopayRemitLine[] = [];
  const unreadable: string[] = [];
  for (const raw of rows) {
    const text = raw.trim();
    if (!text) continue;
    /*
     * A row is a candidate only if it opens with twelve digits, which is the prescription number.
     *
     * "Begins with a digit" was the first cut and it is not enough: the pharmacy's own street
     * address begins with one, and it went into `unreadable` on every statement — a list of things
     * to look at, with a thing nobody need look at at the top of it. Twelve leading digits is what
     * an item row has and an address, a phone number and a date have not.
     */
    if (!leadingDigits(text, 12)) continue;
    const r = parseCopayRemitLine(text);
    if ("line" in r) lines.push(r.line);
    else unreadable.push(`${text} — ${r.why}`);
  }

  const net = netCopayLines(lines);
  const netCents = lines.reduce((n, l) => n + l.paidCents, 0);
  /*
   * The rows are claims, so they are checked against the claims total and not the amount paid.
   *
   * This preferred "Total Amount Paid" and was right only by luck: on the statement in hand the
   * fee is zero and the two figures are equal. The invoice reader had this exact fault and it cost
   * real money — item lines were checked against the amount due rather than the goods subtotal, so
   * ten dollars of IPC's shipping refused an otherwise perfect reading and $4,878.56 of purchases
   * went unread across three invoices. The moment RedSail prints a fee, the same thing happens
   * here: every row correct, the statement refused, and nothing stored.
   *
   * So the claims subtotal is preferred, and the amount paid is the fallback for a statement that
   * prints one and not the other. `Total Fee` is read and reported for the same reason — a figure
   * on the page that nothing looks at is how the next fault of this shape stays hidden.
   */
  const printed = totals.claimsCents ?? totals.paidCents ?? money(amountRaw);

  /*
   * Whether the statement's own footer hangs together, which is a different question from whether
   * the rows do.
   *
   * Separating the two is the point. The rows can be perfect while the footer is not, and folding
   * that into one verdict would either refuse a statement whose claims are all correct or pass one
   * whose totals contradict each other. The fee is allowed to explain the gap in either direction,
   * because the sign convention is not knowable from a statement whose fee is zero — what is being
   * tested is that the difference is the fee and not something unaccounted for.
   */
  const totalsAgree =
    totals.claimsCents === null || totals.paidCents === null
      ? null
      : totals.paidCents === totals.claimsCents + (totals.feeCents ?? 0) - (totals.balanceForwardCents ?? 0) ||
        totals.paidCents === totals.claimsCents - (totals.feeCents ?? 0) - (totals.balanceForwardCents ?? 0);
  return {
    payer: COPAY_PAYER,
    paidOn: paidOnRaw ? isoFromSlashes(paidOnRaw) : null,
    reference: label(/Check\s*\/?\s*ACH\s*Number\s*:?\s*([A-Za-z0-9-]+)/i),
    paymentAmountCents: money(amountRaw),
    npi: label(/NPI\s*:?\s*(\d{10})/i),
    lines,
    net,
    totals,
    netCents,
    reconciles: printed === null || lines.length === 0 ? null : netCents === printed,
    totalsAgree,
    unreadable,
  };
}

function money(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** What the statement says, in the words the page and the audit line use. */
export function copayRemitSummary(r: CopayRemit): string {
  if (r.lines.length === 0) return "No item row could be read from this statement.";
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const toRecord = r.net.filter((n) => !n.reversed);
  const reversed = r.net.filter((n) => n.reversed);
  const bits = [
    `${r.lines.length} row${r.lines.length === 1 ? "" : "s"} netting to ${toRecord.length} payment${toRecord.length === 1 ? "" : "s"} of ${money(r.netCents)}`,
  ];
  if (reversed.length > 0) bits.push(`${reversed.length} paid and reversed in the same period, which record nothing`);
  if (r.reconciles === false) bits.push(`the rows do not add to the printed total of ${money(r.totals.paidCents ?? 0)}, so nothing was stored`);
  if (r.reconciles === null) bits.push("the statement printed no total to check the rows against");
  if (r.totalsAgree === false) {
    bits.push(
      `the footer does not agree with itself — ${money(r.totals.claimsCents ?? 0)} of claims and a fee of ${money(r.totals.feeCents ?? 0)} do not make the ${money(r.totals.paidCents ?? 0)} it says it paid`,
    );
  }
  if (r.unreadable.length > 0) bits.push(`${r.unreadable.length} row${r.unreadable.length === 1 ? "" : "s"} could not be read`);
  return `${bits.join("; ")}.`;
}

/**
 * The day the site's own records begin.
 *
 * A voucher line for a fill before that date will never match a claim, however long anybody waits,
 * and it is not a failure to match — it is money for a dispensing this site was not keeping records
 * for. Reported apart from the unmatched, which are the ones worth chasing.
 *
 * Re-exported rather than declared: the date now lives in `books-start`, because keeping it in here
 * meant only this reader could see it, and remittance import and payment-report import both went on
 * counting money from before the books began.
 */
export { SITE_STARTS_ON } from "./books-start";

/**
 * Whether a file is one of these statements, judged by what is in it rather than what it is called.
 *
 * RedSail will push these to an SFTP host under whatever name their system chooses, in .txt, .dat
 * or PDF, so the name says nothing. Two things have to hold together:
 *
 *   the shape — at least two lines that read as item rows, each of which has already had to pass
 *   the row's own arithmetic (submitted less patient paid is the voucher's payment), which no
 *   ordinary text does by accident;
 *
 *   and a marker — either the statement naming itself, or the payment header a remittance carries.
 *
 * Either alone is not enough. A covering email mentioning the voucher programme has the marker and
 * no rows; a table of numbers from somewhere else could have rows and nothing saying what they are.
 */
export function looksLikeCopayRemit(text: string): boolean {
  if (!text || text.length < 40) return false;
  const head = text.slice(0, 20_000);
  const named = /RAS\s+Copay\s+Voucher|Copay\s+Voucher\s+Reimbursement/i.test(head) || (/RedSail/i.test(head) && /Remittance\s+Advice/i.test(head));
  const headed = /Check\s*\/?\s*ACH\s*Number/i.test(head) || (/Payment\s*Date/i.test(head) && /Payment\s*Amount/i.test(head));
  if (!named && !headed) return false;

  let rows = 0;
  for (const line of text.split(/\r?\n/)) {
    const r = parseCopayRemitLine(line.trim());
    if ("line" in r && ++rows >= 2) return true;
  }
  return false;
}
