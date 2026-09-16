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

export type CloseCheck = {
  key: string;
  name: string;
  done: boolean;
  /** What it says either way — the figure where there is one, the reason where there is not. */
  says: string;
  /** "document" gates arrive; "money" gates tie. Reported apart because the answers differ. */
  gate: "document" | "money";
};

export type CloseState = "running" | "waiting_on_documents" | "money_does_not_tie" | "closed";

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
