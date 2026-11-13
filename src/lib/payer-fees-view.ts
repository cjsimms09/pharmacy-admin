import { atLocal, fmt } from "./dates";
import { feeKey, lineSays, type Decided, type FeeLine, type PayerFees } from "./payer-fees";

/**
 * The payer-fee lines of one period, in the words the Money page prints, so that the words can be tested and read apart from
 * the screen. Where a line stands is payer-fees.ts's (counted, left out, waiting, not a fee, counted already elsewhere); this
 * adds what each state says for itself and which presses are open on it. A press is one of decideFee's three words
 * (payer-fees-store.ts), and the only ones offered are those that would change something.
 */

export type FeePress = { to: "count" | "leave_out" | "reopen"; label: string };

export type FeeRow = {
  /** What a press carries: payer-fees.ts feeKey, which a better record of the same line does not change. */
  key: string;
  says: string;
  /** Which record the line is read from. */
  source: string;
  /** Why it stands where it does, and who said so where a person did. */
  note: string;
  presses: FeePress[];
};

export type FeesView = {
  waiting: FeeRow[];
  counted: FeeRow[];
  leftOut: FeeRow[];
  notFees: FeeRow[];
  keptOut: FeeRow[];
  /** Remittances two records carry with different fee totals, in words. */
  differ: string[];
  countedCents: number;
  /** Nothing of any kind is on file for the period: not the same as none taken, and said so in the headline. */
  empty: boolean;
  headline: string;
};

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const first = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
const day = (iso: string) => fmt(atLocal(iso).slice(0, 10));

const countPress = (l: FeeLine): FeePress => ({ to: "count", label: l.takenCents < 0 ? "Count against the fees" : "Count as a fee" });
const leaveOut: FeePress = { to: "leave_out", label: "Leave out" };
const undo: FeePress = { to: "reopen", label: "Undo" };

export const FEES_ROW_NAME = "Payer fees and recoupments taken on remittances";

/**
 * `months` are the period's. A line with no date belongs to no month, and is shown in every period so that it is not lost:
 * it changes no month's figure, but a person may still have something to say about it.
 */
export function feesView(fees: PayerFees, months: string[], label: string, dayOf: (iso: string) => string = day): FeesView {
  const here = (x: { month: string }) => x.month === "" || months.includes(x.month);
  const row = (l: FeeLine & { from: string }, note: string, presses: FeePress[]): FeeRow => ({ key: feeKey(l), says: lineSays(l), source: first(l.from), note, presses });
  const by = (d: Decided) => `${d.by || "someone"} on ${dayOf(d.on)}`;

  const waiting = fees.held.filter(here).map((l) => row(l, `${first(l.why)}.`, [countPress(l), leaveOut]));
  const counted = fees.counted.filter(here).map((l) => {
    const d = l.decided;
    const note = d
      ? `Counted by ${by(d)}; the rule ${d.ruleCounted ? "counts it too" : "would not have counted it"}.`
      : `Counted by the rule, on its code (${l.code.trim().toUpperCase()}).`;
    return row(l, note, d ? [leaveOut, undo] : [leaveOut]);
  });
  const leftOut = fees.leftOut.filter(here).map((l) => row(l, `Left out by ${by(l.decided)}. The rule said: ${l.ruleSaid}.`, l.decided.ruleCounted ? [undo] : [countPress(l), undo]));
  const notFees = fees.notFees.filter(here).map((l) => row(l, `${first(l.why)}.`, []));
  const keptOut = fees.keptOut.filter(here).map((l) => row(l, `Already counted once, from ${l.alreadyIn}; this copy, from ${l.from}, adds nothing.`, []));
  const differ = fees.disagree.filter(here).map((d) => `${d.remittance}: ${d.believedFrom} says ${money(d.believedCents)} and ${d.otherFrom} says ${money(d.otherCents)}. The account goes by ${d.believedFrom}.`);

  const countedCents = fees.counted.filter(here).reduce((n, l) => n + l.takenCents, 0);
  if (![waiting, counted, leftOut, notFees, keptOut, differ].some((x) => x.length)) {
    const none = `No payer-fee line from an 835 or the adjustment report is on file for ${label}. That means none has been read, not that none was taken.`;
    return { waiting, counted, leftOut, notFees, keptOut, differ, countedCents, empty: true, headline: none };
  }
  const asks = waiting.length
    ? `${lines(waiting.length)} ${waiting.length === 1 ? "waits" : "wait"} for you and ${waiting.length === 1 ? "is" : "are"} on neither account until you decide.`
    : "Nothing waits for you.";
  const total = countedCents < 0 ? `A net credit of ${money(-countedCents)}` : money(countedCents);
  const counts = counted.length
    ? ` ${total} is counted over ${lines(counted.length)}, in the account's "${FEES_ROW_NAME}" row (accrual only).`
    : ` No fee from these records is counted in the account's "${FEES_ROW_NAME}" row.`;
  const also = [
    leftOut.length ? `${lines(leftOut.length)} left out` : "",
    notFees.length ? `${lines(notFees.length)} not ${notFees.length === 1 ? "a fee" : "fees"}` : "",
    keptOut.length ? `${lines(keptOut.length)} already counted once from a better record` : "",
  ].filter(Boolean);
  const headline = `${asks}${counts}${also.length ? ` Also on file: ${also.join("; ")}.` : ""}`;
  return { waiting, counted, leftOut, notFees, keptOut, differ, countedCents, empty: false, headline };
}
