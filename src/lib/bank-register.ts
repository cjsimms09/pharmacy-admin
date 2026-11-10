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
      /** A week's report rather than a month's: its opening and closing say nothing of the month's own, and it overlaps the monthly one. */
      partial: boolean;
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

/** The weekly report from the same program: "Bank Register", one line to an entry, columns Account, Date, Document Number, Payee, Account, Deposit, Payment, Balance. */
export function looksLikeWeeklyBankRegister(text: string): boolean {
  const head = text.replace(/^﻿/, "").split(/\r?\n/).slice(0, 14).join("\n");
  return /\bBank Register\b/i.test(head) && /Account\s*,\s*Date\s*,\s*Document Number\s*,\s*Payee/i.test(head) && /Deposit\s*,\s*Payment\s*,\s*Balance/i.test(head);
}

/** The title lines and the heading row that mark this export, within its first lines. */
export function looksLikeBankRegister(text: string): boolean {
  if (looksLikeWeeklyBankRegister(text)) return true;
  const head = text.replace(/^﻿/, "").split(/\r?\n/).slice(0, 14).join("\n");
  return /\bRegister\b/i.test(head) && /Date\s*,\s*Print\s*,\s*Number\s*,\s*Payee/i.test(head) && /Payment\s*,\s*Deposit\s*,\s*Balance/i.test(head);
}

/**
 * The weekly "Bank Register": the account's own heading row carries the opening balance, then one line to an entry with its running balance.
 *
 * The proof is the same as the monthly report's: every line's balance is the one before it plus the line. There is no cleared flag in this layout,
 * so every line is taken as the bank record, as the owner said of the register on 6 November 2026. A line with no payee is named by what the
 * report does give: a deposit document (DEP...) reads as a counter deposit, and anything else by its document number and account.
 */
function readWeeklyRegister(text: string): RegisterRead {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).map(fields);
  const titleAt = rows.findIndex((r) => /Parent Company/i.test(r[0] ?? ""));
  const company = (rows[Math.max(0, titleAt - 1)]?.[0] ?? "").replace(/\s+/g, " ");
  const headAt = rows.findIndex((r) => /^Account$/i.test(r[0] ?? "") && /^Date$/i.test(r[1] ?? "") && /^Document Number$/i.test(r[2] ?? ""));
  if (headAt < 0) return { ok: false, why: "The weekly register has no heading row (Account, Date, Document Number, Payee...), so its columns cannot be told apart." };
  const heading = rows
    .slice(headAt + 1)
    .filter((r) => (r[0] ?? "") !== "" && !bankDate(r[1] ?? "") && !/^Cash in Bank$/i.test((r[0] ?? "").replace(/^\d+\s*-\s*/, "")) && !/^Total\b/i.test(r[0] ?? ""));
  if (heading.length !== 1) return { ok: false, why: `The weekly register names ${heading.length} accounts, not one, so which is the bank record cannot be told. Nothing was used.` };
  const account = heading[0][0].replace(/\s+/g, " ");
  const openingCents = bankCents(heading[0][7] ?? "");
  if (openingCents === null) return { ok: false, why: "The weekly register's opening balance could not be read." };
  type E = { on: string; description: string; amountCents: number; balanceCents: number };
  const entries: E[] = [];
  for (let i = headAt + 1; i < rows.length; i++) {
    const r = rows[i];
    const on = bankDate(r[1] ?? "");
    if (!on) continue;
    const dep = (r[5] ?? "") === "" ? 0 : bankCents(r[5]);
    const pay = (r[6] ?? "") === "" ? 0 : bankCents(r[6]);
    const bal = bankCents(r[7] ?? "");
    if (dep === null || pay === null || bal === null) return { ok: false, why: `The weekly register could not be read in full: line ${i + 1} has an amount or balance that is not a figure. Nothing was used.` };
    const doc = (r[2] ?? "").trim();
    const payee = (r[3] ?? "").trim();
    const acct = (r[4] ?? "").trim().replace(/^\d+\s*-\s*/, "");
    const description = (payee || (/^DEP/i.test(doc) ? `Deposit - ${doc}` : `${doc} ${acct}`.trim()) || "no description").replace(/\s+/g, " ");
    entries.push({ on, description, amountCents: dep - pay, balanceCents: bal });
  }
  if (entries.length === 0) return { ok: false, why: "The weekly register holds no entries." };
  let running = openingCents;
  for (let i = 0; i < entries.length; i++) {
    running += entries[i].amountCents;
    if (running !== entries[i].balanceCents) {
      return {
        ok: false,
        why:
          `The weekly register's running balance does not hold at line ${i + 1} (${entries[i].on}, ${entries[i].description.slice(0, 40)}): ` +
          `the lines so far make ${money(running)} and the register prints ${money(entries[i].balanceCents)}. A line may be missing, so none of it was used.`,
      };
    }
  }
  const lines: BankLine[] = entries.map((e) => ({ on: e.on, description: e.description, amountCents: e.amountCents, key: lineKey(e.on, e.amountCents, e.description) }));
  const dates = entries.map((e) => e.on).sort();
  const closing = entries[entries.length - 1].balanceCents;
  const says = `${company ? company + " " : ""}${account} weekly register: ${entries.length} entries, ${dates[0]} to ${dates[dates.length - 1]}, the running balance holds on every line (${money(openingCents)} to ${money(closing)}). Every line is taken as the bank record.`;
  return { ok: true, account, periodFrom: dates[0], periodTo: dates[dates.length - 1], openingCents, registerClosingCents: closing, lines, outstanding: [], entries: entries.length, says, partial: true };
}

/**
 * The lines of a register that the books do not already hold, by day and amount, counted one for one.
 *
 * A week's report overlaps the month's and the bank's own statement and names the same money differently, so the key (day, amount, description)
 * cannot tell them apart; the money can. Two real same-day same-amount lines are both kept when only one is held.
 */
export function dropHeldLines<T extends { on: string; amountCents: number }>(lines: T[], held: { on: string; amountCents: number }[]): { fresh: T[]; already: number } {
  const have = new Map<string, number>();
  for (const h of held) have.set(`${h.on}|${h.amountCents}`, (have.get(`${h.on}|${h.amountCents}`) ?? 0) + 1);
  const fresh = lines.filter((l) => {
    const k = `${l.on}|${l.amountCents}`;
    const n = have.get(k) ?? 0;
    if (n > 0) {
      have.set(k, n - 1);
      return false;
    }
    return true;
  });
  return { fresh, already: lines.length - fresh.length };
}

export function readBankRegister(text: string): RegisterRead {
  if (!looksLikeBankRegister(text)) return { ok: false, why: "This is not a checking register export." };
  if (looksLikeWeeklyBankRegister(text)) return readWeeklyRegister(text);
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
  return { ok: true, account, periodFrom: dates[0], periodTo: dates[dates.length - 1], openingCents, registerClosingCents, lines, outstanding, entries: entries.length, says, partial: false };
}
