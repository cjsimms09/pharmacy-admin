import "server-only";
import { db } from "@/db";
import { judgeClose, endOf, type CloseCheck, type MonthClose } from "./month-close";

/**
 * The month's close, measured.
 *
 * The document gates come from `monthlyChecklist`, which already knows what a month needs and how to
 * tell whether it came. The money gates are here, and each one is a figure that can disagree while
 * every document sits happily on file:
 *
 *   every bank line placed   a line nothing explains is money the books do not account for. The
 *                            statement's own arithmetic is already proved at upload — the reader
 *                            refuses a statement whose lines, sections, daily balances and summary
 *                            do not all agree — so what is left is whether each line has a meaning.
 *   no deposit unbanked      a deposit with no receipt behind it is revenue nobody has recorded.
 *
 * Nothing here re-proves what the upload already proved. The statement reader takes the month from
 * the statement's own header and refuses the file outright if it cannot read it, so a statement on
 * file is a statement filed under the right month by construction.
 */
export async function monthClose(month: string, today: string): Promise<MonthClose> {
  const { monthlyChecklist } = await import("./monthly-checklist");
  const list = await monthlyChecklist(month);

  const checks: CloseCheck[] = list.items.map((i) => ({
    key: i.key,
    name: i.name,
    done: i.done,
    says: i.done ? `${i.name}: ${i.says}.` : `${i.name} — ${i.says}.`,
    gate: "document",
  }));

  /*
   * The money gates are only asked once the documents are all in.
   *
   * Otherwise they answer about half a month and answer confidently: with no statement on file there
   * are no unplaced lines, so "every line placed" would pass, and a month missing its only proof of
   * cash would show one green tick short of closed.
   */
  if (list.outstanding === 0) {
    const from = `${month}-01`;
    const to = endOf(month);
    const c = (db as unknown as { $client: { execute: (s: string, a?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
    const [lines] = await Promise.all([
      c.execute('select placed_as as p, count(*) as n, sum(amount_cents) as cents from bank_lines where "on" >= ? and "on" <= ? group by placed_as', [from, to]),
    ]);
    const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
    let total = 0;
    let unplaced = 0;
    let unplacedCents = 0;
    for (const r of lines.rows) {
      const n = num(r.n);
      total += n;
      if (String(r.p ?? "") === "unplaced") {
        unplaced += n;
        unplacedCents += Math.abs(num(r.cents));
      }
    }
    checks.push({
      key: "bank_lines_placed",
      name: "Every line on the bank statement means something",
      done: total > 0 && unplaced === 0,
      says:
        total === 0
          ? "No bank line is on file for the month, so there is nothing to tie to."
          : unplaced === 0
            ? `All ${total} bank lines are accounted for.`
            : `${unplaced} of ${total} bank lines are money nothing explains, $${(unplacedCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} between them.`,
      gate: "money",
    });
  }

  return judgeClose({ month, today, checks });
}
