/**
 * The ProviderPay sweep account, which is the only thing that ties a payment to the bank.
 *
 * The owner: *"we should be able to track this all the way through from claim to 835 to cash in
 * account"*, and *"when paid into our account should be what matters to cash accounting"*.
 *
 * Payers do not deposit into the pharmacy's own account. They deposit into a Wells Fargo account
 * McKesson holds, and McKesson then sweeps it across. The bank statement shows only the sweep —
 * one line, one lump, no payer named. So `ProviderPay Transfer $13,726.21` on a Tuesday is the
 * entire trace a bank statement offers for what may be a dozen payers and hundreds of claims.
 *
 * This file is the missing link. The account history names both halves: each payer's deposit with
 * its payment number, and the transfer that took the day's deposits out again. With it, a lump on
 * the bank statement resolves into payments, and a payment resolves into the 835 behind it.
 *
 * Pure: text in, rows out. Nothing here touches a database or decides what a month contains.
 */

export type AccountLine = {
  /** ISO date, as the file prints it. */
  date: string;
  /** The payer's payment number, which is what joins this to the payment report and the 835. */
  paymentNumber: string | null;
  /** As printed. Carries the payer name and, on a deposit, the payment number again. */
  description: string;
  /** Positive money in, negative money out. */
  amountCents: number;
  /** What this line is. A transfer is money leaving the sweep for the pharmacy's own account. */
  kind: "deposit" | "transfer" | "other";
  /** The payer, read off the description where it is a deposit. */
  payer: string | null;
};

export type AccountMonth = {
  lines: AccountLine[];
  /** Money in from payers. */
  depositedCents: number;
  /** Money swept out to the operating account. Positive: the amount that arrived at the bank. */
  transferredCents: number;
  /**
   * Deposits sitting in the sweep at the end of what was read, not yet transferred.
   *
   * Real and ordinary — a payment landing on the last day of a month is usually swept the next.
   * It is also exactly why cash is dated on the transfer: this money is not in the bank yet.
   */
  awaitingTransferCents: number;
  /** One entry per day, so a transfer can be checked against what it should have swept. */
  byDay: { date: string; depositedCents: number; transferredCents: number; agrees: boolean }[];
  problems: string[];
};

/** "ProviderPay Transfer", however it is spaced or cased. */
const TRANSFER = /providerpay\s*transfer/i;

/**
 * The payer, from a deposit's description.
 *
 * A deposit reads `ARGUS HEALTH SYS  101000017856767  20260831` — the payer, the payment number,
 * then the date. Taking everything before the first long run of digits leaves the name, and leaves
 * it alone when the line is shaped differently rather than guessing at it.
 */
export function payerFrom(description: string): string | null {
  const cut = description.split(/\s{2,}|\s(?=\d{8,})/)[0]?.trim();
  return cut && !/^\d+$/.test(cut) ? cut : null;
}

/** Dollars as printed to integer cents, negatives included. Null when it is not a number. */
function cents(raw: string): number | null {
  const t = (raw ?? "").replace(/[$,"]/g, "").trim();
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}

/**
 * One CSV row into fields, honouring quotes.
 *
 * Written out rather than split on commas: a payer name with a comma in it would otherwise shift
 * every column after it, and the amount would be read from the wrong place — silently, because a
 * date parses as junk and a junk amount is skipped rather than shouted about.
 */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Whether a file is a ProviderPay account history, judged by what is in it.
 *
 * The portal names these by the day they were downloaded rather than the month they cover, so two
 * different months arrive with the same name and the name says nothing at all.
 */
export function looksLikeAccountHistory(text: string): boolean {
  const head = text.slice(0, 2000).toLowerCase();
  return head.includes("payment number") && head.includes("description") && head.includes("amount") && head.includes("date");
}

/**
 * Read an account history.
 *
 * Every line is kept, including ones that are neither a deposit nor a transfer: this file is the
 * bridge to the bank, and a line dropped here is a line that will not reconcile later with nothing
 * to say why.
 */
export function readAccountHistory(text: string): AccountMonth {
  const out: AccountMonth = {
    lines: [],
    depositedCents: 0,
    transferredCents: 0,
    awaitingTransferCents: 0,
    byDay: [],
    problems: [],
  };

  const rows = text.split(/\r?\n/).filter((r) => r.trim().length > 0);
  if (rows.length === 0) {
    out.problems.push("The file is empty.");
    return out;
  }

  const header = splitRow(rows[0]).map((h) => h.toLowerCase().replace(/"/g, ""));
  const at = (name: string) => header.findIndex((h) => h.includes(name));
  const iDate = at("date");
  const iPayment = at("payment number");
  const iDesc = at("description");
  const iAmount = at("amount");

  if (iDate < 0 || iDesc < 0 || iAmount < 0) {
    out.problems.push(
      `This does not look like a ProviderPay account history: its columns are ${header.join(", ")}. ` +
        `Expected a date, a description and an amount.`,
    );
    return out;
  }

  for (let r = 1; r < rows.length; r++) {
    const f = splitRow(rows[r]);
    const date = (f[iDate] ?? "").trim();
    const amountCents = cents(f[iAmount] ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || amountCents === null) {
      /* A trailing total row or a blank is ordinary; anything else is worth naming once. */
      if (f.some((x) => x.length > 0)) out.problems.push(`Row ${r + 1} could not be read: ${rows[r].slice(0, 100)}`);
      continue;
    }
    const description = (f[iDesc] ?? "").trim();
    const paymentNumber = iPayment >= 0 ? (f[iPayment] ?? "").trim() || null : null;
    const kind: AccountLine["kind"] = TRANSFER.test(description) ? "transfer" : amountCents > 0 ? "deposit" : "other";

    out.lines.push({
      date,
      paymentNumber,
      description,
      amountCents,
      kind,
      payer: kind === "deposit" ? payerFrom(description) : null,
    });
  }

  for (const l of out.lines) {
    if (l.kind === "deposit") out.depositedCents += l.amountCents;
    /* A transfer is printed negative — money leaving the sweep. Held positive: it is what arrived. */
    if (l.kind === "transfer") out.transferredCents += -l.amountCents;
  }
  out.awaitingTransferCents = out.depositedCents - out.transferredCents;

  /*
   * Day by day, because that is how the sweep works and how a disagreement shows itself.
   *
   * The transfers net each day's deposits exactly — 04/29's $3,362.24 and $10,363.97 left together
   * as $13,726.21. A day where they do not agree is either a sweep that crossed midnight, which is
   * ordinary at a month end, or something worth looking at.
   */
  const days = new Map<string, { depositedCents: number; transferredCents: number }>();
  for (const l of out.lines) {
    const d = days.get(l.date) ?? { depositedCents: 0, transferredCents: 0 };
    if (l.kind === "deposit") d.depositedCents += l.amountCents;
    if (l.kind === "transfer") d.transferredCents += -l.amountCents;
    days.set(l.date, d);
  }
  out.byDay = [...days.entries()]
    .map(([date, d]) => ({ date, ...d, agrees: d.depositedCents === d.transferredCents }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return out;
}

/**
 * What a bank statement's lump resolves into.
 *
 * Given a transfer as it appears on the bank statement — a date and an amount — find the deposits
 * the sweep account says went into it, and so the payers and payment numbers behind it.
 *
 * Matched on the day, not searched across days: the sweep takes a day's deposits together, and a
 * looser match would happily explain Tuesday's lump with Thursday's payments.
 */
export function whatMadeUpTransfer(
  month: AccountMonth,
  transfer: { date: string; amountCents: number },
): { deposits: AccountLine[]; agrees: boolean; says: string } {
  const deposits = month.lines.filter((l) => l.kind === "deposit" && l.date === transfer.date);
  const total = deposits.reduce((n, d) => n + d.amountCents, 0);
  const agrees = total === Math.abs(transfer.amountCents);
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;

  return {
    deposits,
    agrees,
    says: agrees
      ? deposits.length === 1
        ? `${money(total)} from ${deposits[0].payer ?? "one payer"}.`
        : `${money(total)} from ${deposits.length} payers: ${deposits.map((d) => d.payer ?? "unnamed").join(", ")}.`
      : deposits.length === 0
        ? `Nothing in the ProviderPay account was deposited on ${transfer.date}, so this transfer is not explained by it. A sweep can cross midnight — the day before is worth checking.`
        : `The deposits on ${transfer.date} come to ${money(total)}, and this transfer is ${money(Math.abs(transfer.amountCents))}. A sweep crossing midnight explains most of these.`,
  };
}
