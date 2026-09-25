/**
 * Whether a month is finished — not whether its documents arrived.
 *
 * The owner, 16 September 2026: "it should show month closed only once everything is done, money
 * matches and everything lines up".
 *
 * Those are three different conditions and the difference is the whole point. A month can have every
 * document on file and still not tie: the bank statement is in, the sales summary is in, and eleven
 * lines on the statement are money nothing explains. Calling that month closed is worse than calling
 * it open, because the second is honest and the first is a promise that the books balance.
 *
 * So there are two gates and they are reported apart:
 *
 *   waiting_on_documents   something has not arrived. Nothing can be checked until it does.
 *   money_does_not_tie     everything arrived, and the figures disagree. This is a job, not a wait.
 *   closed                 everything arrived and everything ties.
 *   running                the month has not ended. Nothing is late and nothing is wrong.
 *
 * A month never closes itself early: `running` is checked first, because being told on the 3rd that
 * September is incomplete is how a screen earns the right to be ignored.
 *
 * Pure: `month-close-store.ts` reads the data.
 */

import { SITE_STARTS_ON, monthIsOutOfBooks } from "./books-start";

export type CloseCheck = {
  key: string;
  name: string;
  done: boolean;
  /** What it says either way — the figure where there is one, the reason where there is not. */
  says: string;
  /** "document" gates arrive; "money" gates tie. Reported apart because the answers differ. */
  gate: "document" | "money";
};

export type CloseState = "before_books" | "running" | "waiting_on_documents" | "money_does_not_tie" | "closed";

export type MonthClose = {
  month: string;
  state: CloseState;
  checks: CloseCheck[];
  documentsOutstanding: number;
  moneyOutstanding: number;
  says: string;
};

/** The last day of a month, "2026-09" → "2026-09-30". */
export function endOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export function judgeClose(input: { month: string; today: string; checks: CloseCheck[] }): MonthClose {
  const { month, today, checks } = input;
  const documents = checks.filter((c) => c.gate === "document");
  const money = checks.filter((c) => c.gate === "money");
  const documentsOutstanding = documents.filter((c) => !c.done).length;
  const moneyOutstanding = money.filter((c) => !c.done).length;
  const base = { month, checks, documentsOutstanding, moneyOutstanding };

  /*
   * A month from before the books began cannot be closed, and must not sit red waiting to be.
   *
   * This is the fault the rest of this file exists to avoid, and it very nearly shipped inside it.
   * The month being closed is the one just finished, so on any day in September that is August —
   * and these books begin on 1 September 2026 (`books-start.ts`). August has no statement, no sales
   * month and no count, and never will, so the card would have read "waiting on 5" every day until
   * October: a permanent red mark on a screen whose whole argument is that it does not carry one.
   */
  if (monthIsOutOfBooks(month)) {
    return {
      ...base,
      state: "before_books",
      documentsOutstanding: 0,
      moneyOutstanding: 0,
      says: `${month} is before these books begin (${SITE_STARTS_ON}), so there is nothing to close. The first month this closes is ${SITE_STARTS_ON.slice(0, 7)}.`,
    };
  }
  if (today <= endOf(month)) {
    return {
      ...base,
      state: "running",
      says: `${month} is still running — it closes on ${endOf(month)}. Nothing here is late.`,
    };
  }
  if (documentsOutstanding > 0) {
    const names = documents.filter((c) => !c.done).map((c) => c.name);
    return {
      ...base,
      state: "waiting_on_documents",
      says: `${documentsOutstanding} thing${documentsOutstanding === 1 ? "" : "s"} still to arrive before ${month} can be checked at all: ${names.join(", ")}.`,
    };
  }
  if (moneyOutstanding > 0) {
    const names = money.filter((c) => !c.done).map((c) => c.says);
    return {
      ...base,
      state: "money_does_not_tie",
      says: `Everything for ${month} is on file and the figures do not agree yet: ${names.join(" ")}`,
    };
  }
  return {
    ...base,
    state: "closed",
    says: `${month} is closed. Every document is on file and every figure ties: ${money.map((c) => c.says).join(" ")}`,
  };
}
