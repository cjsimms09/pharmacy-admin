/**
 * The checking account's register, as the bookkeeper's accounting program exports it, read as October's bank record.
 *
 * It arrived by mail on 6 November 2026 as "Oct Bank", `WWFRx Checking(8855)RegisterOCT.csv`, and the Inbox called it "unrecognised": its
 * first lines are the company name, the parent company, the account and the period, not column headings, and each entry takes two lines
 * (date, number, payee, cleared flag, reconciled date, payment, deposit, running balance; then the entry's type, account and memo).
 *
 * ── What it is, and what it is not ──
 *
 * It is the report from the accounting software that is linked to the bank, and the owner, 6 November 2026: "its the same as bank
 * statement. treat it as such." A line the bank has paid is marked cleared (`Clr` Yes) with the day it was reconciled; a line not yet
 * ticked reads "Reconcile" in that place. So:
 *
 *  - every line is a bank line, and the register's opening and closing balances are the month's bank balances;
 *  - the lines not yet marked cleared are still said, with their total, on the result line, because nothing is hidden by treating the two
 *    as one: the bank's own statement would show the difference if there were one;
 *  - the proof is the register's own arithmetic, every line's running balance equal to the one before it plus that line, which says the
 *    file is complete and read without a figure wrong.
 *
 * A deposit the bookkeeper entered as one journal entry ("Insurance Deposit - Pharmacy") is one line here, whatever it was made of at the
 * bank. It is read as it stands and said to be what it is.
 *
 * Pure.
 */
import { bankCents, bankDate, lineKey, type BankLine } from "./bank-statement";

export type RegisterRead =
  | {
      ok: true;
      account: string;
      periodFrom: string;
      periodTo: string;
      /** What the account held before the first line, from the first running balance. */
      openingCents: number;
      /** The register's balance after its last line, outstanding items included. */
      registerClosingCents: number;
      /** The lines the bank has cleared: what the bank record is made of. */
      lines: BankLine[];
      /** Entries not yet cleared at the bank, kept out of the lines and said. */
      outstanding: { on: string; description: string; amountCents: number }[];
      entries: number;
      says: string;
    }
  | { ok: false; why: string };

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One CSV line to fields, quotes honoured. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** The title lines and the heading row that mark this export, within its first lines. */
export function looksLikeBankRegister(text: string): boolean {
  const head = text.replace(/^﻿/, "").split(/\r?\n/).slice(0, 14).join("\n");
  return /\bRegister\b/i.test(head) && /Date\s*,\s*Print\s*,\s*Number\s*,\s*Payee/i.test(head) && /Payment\s*,\s*Deposit\s*,\s*Balance/i.test(head);
}

export function readBankRegister(text: string): RegisterRead {
  if (!looksLikeBankRegister(text)) return { ok: false, why: "This is not a checking register export." };
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).map(fields);
  const titleAt = rows.findIndex((r) => /\bRegister\b/i.test(r[0] ?? ""));
  const account = (rows[titleAt]?.[0] ?? "Checking register").replace(/\s+/g, " ");
  const headAt = rows.findIndex((r) => /^Date$/i.test((r[0] ?? "").trim()) && /^Payee$/i.test((r[3] ?? "").trim()));
  if (headAt < 0) return { ok: false, why: "The register has no heading row (Date, Print, Number, Payee…), so its columns cannot be told apart." };
  const h = rows[headAt].map((x) => x.toLowerCase());
  const col = (name: string) => h.findIndex((x) => x === name);
  const cDate = col("date");
  const cNum = col("number");
  const cPayee = col("payee");
  const cClr = col("clr");
  const cRec = col("reconciled date");
  const cPay = col("payment");
  const cDep = col("deposit");
  const cBal = col("balance");
  if ([cDate, cPayee, cPay, cDep, cBal].some((i) => i < 0)) return { ok: false, why: "The register is missing one of Date, Payee, Payment, Deposit or Balance." };

  type Entry = { on: string; number: string; description: string; cleared: boolean; amountCents: number; balanceCents: number };
  const entries: Entry[] = [];
  const problems: string[] = [];
  for (let i = headAt + 1; i < rows.length; i++) {
    const r = rows[i];
    const on = bankDate(r[cDate] ?? "");
    if (!on) continue; // the second line of an entry, the sub-heading, a blank
    const pay = (r[cPay] ?? "") === "" ? 0 : bankCents(r[cPay]);
    const dep = (r[cDep] ?? "") === "" ? 0 : bankCents(r[cDep]);
    const bal = bankCents(r[cBal] ?? "");
    if (pay === null || dep === null || bal === null) {
      problems.push(`line ${i + 1}: an amount or balance could not be read`);
      continue;
    }
    const second = rows[i + 1] ?? [];
    /* The entry's own memo and account sit on the line below it, beginning "Edit". */
    const below = /^Edit$/i.test(second[0] ?? "") ? second : [];
    const memo = (below[4] ?? "").trim();
    const account2 = (below[3] ?? "").trim();
    const payee = (r[cPayee] ?? "").trim();
    const description = (payee || memo || account2 || "no description").replace(/\s+/g, " ");
    const rec = (r[cRec] ?? "").trim();
    /* Cleared means the bank posted it: the flag says Yes and a reconciled date is there. "Reconcile" is the link for one not yet cleared. */
    const cleared = /^yes$/i.test((r[cClr] ?? "").trim()) && bankDate(rec) !== null;
    entries.push({ on, number: (r[cNum] ?? "").trim(), description, cleared, amountCents: dep - pay, balanceCents: bal });
  }
  if (entries.length === 0) return { ok: false, why: "The register holds no entries." };
  if (problems.length > 0) return { ok: false, why: `The register could not be read in full: ${problems.slice(0, 3).join("; ")}.` };

  /* The proof: each line's balance is the one before plus the line. The first line's own balance gives the opening. */
  const openingCents = entries[0].balanceCents - entries[0].amountCents;
  let running = openingCents;
  for (let i = 0; i < entries.length; i++) {
    running += entries[i].amountCents;
    if (running !== entries[i].balanceCents) {
      return {
        ok: false,
        why:
          `The register's running balance does not hold at line ${i + 1} (${entries[i].on}, ${entries[i].description.slice(0, 40)}): ` +
          `the lines so far make ${money(running)} and the register prints ${money(entries[i].balanceCents)}. A line may be missing, so none of it was used.`,
      };
    }
  }

  const lines: BankLine[] = entries
    .map((e) => ({ on: e.on, description: e.description, amountCents: e.amountCents, key: lineKey(e.on, e.amountCents, e.description) }));
  const outstanding = entries.filter((e) => !e.cleared).map((e) => ({ on: e.on, description: e.description, amountCents: e.amountCents }));
  const dates = entries.map((e) => e.on).sort();
  const registerClosingCents = entries[entries.length - 1].balanceCents;
  const outCents = outstanding.reduce((n, o) => n + o.amountCents, 0);
  const says =
    `${account}: ${entries.length} entries, ${dates[0]} to ${dates[dates.length - 1]}, the running balance holds on every line (${money(openingCents)} to ${money(registerClosingCents)}). ` +
    `${lines.length} lines are taken as the bank record. ` +
    (outstanding.length === 0
      ? "Every one is marked cleared."
      : `${outstanding.length} of them (${money(outCents)} net) are not yet marked cleared in the register: ${outstanding
          .slice(0, 3)
          .map((o) => `${o.on} ${o.description.slice(0, 28)} ${money(o.amountCents)}`)
          .join("; ")}${outstanding.length > 3 ? "…" : ""}.`);
  return { ok: true, account, periodFrom: dates[0], periodTo: dates[dates.length - 1], openingCents, registerClosingCents, lines, outstanding, entries: entries.length, says };
}
