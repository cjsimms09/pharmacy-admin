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
  /** One entry per transfer, so each can be checked against what it should have swept. */
  sweeps: Sweep[];
  problems: string[];
};

/**
 * One transfer and the deposits it actually took.
 *
 * A sweep empties the account, so what it moves is everything deposited since the previous sweep —
 * not everything sharing its calendar date. Usually those are the same set and the distinction
 * never shows. It shows when a deposit lands on a day no sweep runs: on 20 July a $2.85 LucyRx
 * payment arrived and nothing swept that day, so it left on the 22nd inside a $14,885.16 transfer
 * against $14,882.31 deposited on the 22nd itself. Checked per day that transfer is wrong by
 * $2.85; checked per sweep it is exact.
 *
 * Measured across the pharmacy's own history — 117 lines, 41 transfers, 24 June to 17 September —
 * all 41 balance under this rule and 39 under the per-day one.
 */
export type Sweep = {
  /** The day the money left for the pharmacy's own account, and so the day it becomes cash. */
  on: string;
  /** What the transfer moved, held positive. */
  transferredCents: number;
  /** Every deposit it carried, oldest first. May span more than one day. */
  deposits: AccountLine[];
  depositedCents: number;
  agrees: boolean;
};

/** "ProviderPay Transfer", however it is spaced or cased. */
const TRANSFER = /providerpay\s*transfer/i;

/**
 * The payer, from a deposit's description.
 *
 * A deposit reads `ARGUS HEALTH SYS  999000000000001  20260831` — the payer, the payment number,
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
    sweeps: [],
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

  out.sweeps = sweepsFrom(chronological(out.lines));

  return out;
}

/**
 * The lines oldest-first, with each day's own sequence left alone.
 *
 * The portal exports newest day first and, within a day, the deposits before the transfer that
 * took them. Reversing the file line by line would put every transfer ahead of its own deposits
 * and make all 41 of them look unexplained — which is exactly what happened when this was first
 * measured. So the days are reordered and the order inside a day is not touched: a sweep cannot
 * carry money that has not landed, and the file already prints them in the order they happened.
 */
function chronological(lines: AccountLine[]): AccountLine[] {
  const days: { date: string; rows: AccountLine[] }[] = [];
  for (const l of lines) {
    const last = days[days.length - 1];
    if (last && last.date === l.date) last.rows.push(l);
    else days.push({ date: l.date, rows: [l] });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days.flatMap((d) => d.rows);
}

/**
 * Split the history into sweeps: deposits accumulate, a transfer takes them all and closes one.
 *
 * Anything deposited after the last transfer is left out — it is still in the account, and
 * `awaitingTransferCents` is where it is reported rather than being folded into a sweep it did
 * not go out in.
 */
function sweepsFrom(lines: AccountLine[]): Sweep[] {
  const out: Sweep[] = [];
  let pending: AccountLine[] = [];
  for (const l of lines) {
    if (l.kind === "deposit") pending.push(l);
    else if (l.kind === "transfer") {
      const depositedCents = pending.reduce((n, d) => n + d.amountCents, 0);
      const transferredCents = -l.amountCents;
      out.push({ on: l.date, transferredCents, deposits: pending, depositedCents, agrees: depositedCents === transferredCents });
      pending = [];
    }
  }
  return out;
}

/**
 * What a bank statement's lump resolves into.
 *
 * Given a transfer as it appears on the bank statement — a date and an amount — find the deposits
 * the sweep account says went into it, and so the payers and payment numbers behind it.
 *
 * Found by the sweep that went out on that day, which carries everything deposited since the
 * previous sweep. Still never searched forwards: money that landed after this transfer left is not
 * allowed to explain it, so Tuesday's lump is never explained with Thursday's payments.
 */
export function whatMadeUpTransfer(
  month: AccountMonth,
  transfer: { date: string; amountCents: number },
): { deposits: AccountLine[]; agrees: boolean; says: string } {
  const want = Math.abs(transfer.amountCents);
  const onDay = month.sweeps.filter((s) => s.on === transfer.date);
  /*
   * More than one sweep can share a date. Prefer the one whose amount is the one asked about;
   * otherwise take the first, so the message can still say what the day did hold.
   */
  const sweep = onDay.find((s) => s.transferredCents === want) ?? onDay[0];
  const deposits = sweep?.deposits ?? [];
  const total = sweep?.depositedCents ?? 0;
  const agrees = sweep !== undefined && sweep.transferredCents === want && sweep.agrees;
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const spans = new Set(deposits.map((d) => d.date));
  const carried = spans.size > 1 ? ` Deposited over ${[...spans].sort().join(" and ")}, swept together on ${transfer.date}.` : "";

  return {
    deposits,
    agrees,
    says: agrees
      ? (deposits.length === 1
          ? `${money(total)} from ${deposits[0].payer ?? "one payer"}.`
          : `${money(total)} from ${deposits.length} payers: ${deposits.map((d) => d.payer ?? "unnamed").join(", ")}.`) + carried
      : sweep === undefined
        ? `The ProviderPay account shows no transfer out on ${transfer.date}, so this deposit is not explained by it. A sweep can cross midnight — the day before is worth checking.`
        : `The sweep on ${transfer.date} moved ${money(sweep.transferredCents)}, and this bank line is ${money(want)}. They are not the same transfer.`,
  };
}
