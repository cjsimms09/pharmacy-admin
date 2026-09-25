import "server-only";
import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * A month's bank statement, line by line, with what each line was taken to be.
 *
 * ── Why a page and not a count ──
 *
 * The owner: "I need ability in site to go through bank statements and make sure everything is
 * accounted for and categorized!!" Until now the site showed two numbers — how many lines it placed
 * and a list of the ones it could not — which answers "is there a problem" and not the question he
 * is actually sitting down to answer, which is "is every line right".
 *
 * Those are different jobs. A count tells him whether to worry; this has to let him work. So every
 * line appears, in the bank's order, with what it was tied to and why, and the ones needing him are
 * first rather than filtered.
 *
 * ── The three states, and why "confirmed" is not "placed" ──
 *
 * A line is one of three things, and collapsing them is what made the old count misleading:
 *
 *   **booked**    the site learned about this money HERE. A bill it had no other record of.
 *   **confirmed** the money was already on the books from its own feed — a card batch, an 835, a
 *                 postage confirmation — and the bank line proves it arrived. Nothing was booked
 *                 from it, deliberately, because booking it would count the money twice.
 *   **needs you** nothing tied it, or the tie was ambiguous.
 *
 * Most of a good statement is `confirmed`, and that is the point: it means the feeds are doing the
 * work and the bank is agreeing with them. A page that showed only "placed: 57" hid the distinction
 * between money this site understood and money it had merely seen.
 */

export type ReviewLine = {
  id: string;
  on: string;
  description: string;
  amountCents: number;
  /** The placement kind as the matcher decided it. */
  placedAs: string;
  why: string | null;
  state: "booked" | "confirmed" | "needs_you";
  /** What it was tied to, where it was tied to something. */
  receiptId: string | null;
  expenseId: string | null;
  invoiceId: string | null;
};

export type BankReview = {
  month: string;
  lines: ReviewLine[];
  inCents: number;
  outCents: number;
  counts: { booked: number; confirmed: number; needsYou: number };
  /** Money on lines nobody has accounted for, in and out kept apart: a net figure hides both. */
  unaccountedInCents: number;
  unaccountedOutCents: number;
  says: string;
};

/**
 * Which placements mean the money was already on the books by another route.
 *
 * Kept as data rather than a condition so that a new placement kind has to be classified
 * deliberately — an unlisted kind falls to `booked`, which is the safe direction: it appears as
 * something the site acted on, and a person reading the page will see it and say otherwise.
 */
const CONFIRMS_ONLY = new Set(["card_deposit", "psao_deposit", "already_counted", "confirms_standing", "settles_ach", "own_transfer"]);
const NEEDS_YOU = new Set(["unplaced", "facilitator_unmatched", "rebate_part"]);

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function bankReview(month: string): Promise<BankReview> {
  const rows = await db.all<{
    id: string;
    on: string;
    description: string;
    amount_cents: number;
    placed_as: string;
    why: string | null;
    receipt_id: string | null;
    expense_id: string | null;
    invoice_id: string | null;
  }>(
    sql`select id, "on", description, amount_cents, placed_as, why, receipt_id, expense_id, invoice_id
          from bank_lines where "on" >= ${`${month}-01`} and "on" <= ${`${month}-31`}
         order by "on", amount_cents desc`,
  );

  const lines: ReviewLine[] = rows.map((r) => ({
    id: r.id,
    on: r.on,
    description: r.description,
    amountCents: Number(r.amount_cents),
    placedAs: r.placed_as,
    why: r.why,
    state: NEEDS_YOU.has(r.placed_as) ? "needs_you" : CONFIRMS_ONLY.has(r.placed_as) ? "confirmed" : "booked",
    receiptId: r.receipt_id,
    expenseId: r.expense_id,
    invoiceId: r.invoice_id,
  }));

  const inCents = lines.filter((l) => l.amountCents > 0).reduce((n, l) => n + l.amountCents, 0);
  const outCents = lines.filter((l) => l.amountCents < 0).reduce((n, l) => n + l.amountCents, 0);
  const needs = lines.filter((l) => l.state === "needs_you");
  const unaccountedInCents = needs.filter((l) => l.amountCents > 0).reduce((n, l) => n + l.amountCents, 0);
  const unaccountedOutCents = needs.filter((l) => l.amountCents < 0).reduce((n, l) => n + l.amountCents, 0);

  const counts = {
    booked: lines.filter((l) => l.state === "booked").length,
    confirmed: lines.filter((l) => l.state === "confirmed").length,
    needsYou: needs.length,
  };

  return {
    month,
    lines,
    inCents,
    outCents,
    counts,
    unaccountedInCents,
    unaccountedOutCents,
    says:
      lines.length === 0
        ? `No bank statement has been read for ${month}. Until one is, nothing on the cash account has been checked against the bank.`
        : counts.needsYou === 0
          ? `All ${lines.length} lines are accounted for: ${counts.confirmed} confirm money the feeds had already booked, ${counts.booked} were booked from the statement itself.`
          : `${counts.needsYou} of ${lines.length} lines need you — ${money(unaccountedOutCents)} out and ${money(unaccountedInCents)} in that nothing has accounted for.`,
  };
}

/** Which months have a statement read, newest first, so the page can offer them. */
export async function monthsWithStatements(): Promise<string[]> {
  const rows = await db.all<{ m: string }>(sql`select distinct substr("on", 1, 7) as m from bank_lines order by m desc`);
  return rows.map((r) => r.m);
}
