import "server-only";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { proveCogs, type CogsProof, type CogsTerms } from "./cogs-proof";

/**
 * The three terms of the second route, each read from a document the pharmacy did not compute.
 *
 * Purchases from the wholesalers' own invoices, and the shelf from PioneerRx's Balance on Hand at
 * each end of the window. Nothing here touches the claims except to fetch route one for comparison,
 * which is the whole value of it: two routes that share no arithmetic can disagree, and one that
 * disagrees is the only kind that proves anything.
 *
 * ── Which snapshot counts as the opening one ──
 *
 * The latest count on or before the first day, and the latest on or before the last — never the
 * nearest, and never interpolated. A shelf valuation is a fact about one morning; picking the
 * closest one in either direction would silently reconcile against a shelf that was never there,
 * and interpolating would invent a figure that goes into a cost of goods. Where there is none early
 * enough, `proveCogs` says so rather than reaching forward.
 */
async function terms(from: string, to: string): Promise<CogsTerms> {
  const one = async (q: ReturnType<typeof sql>): Promise<number | null> => {
    const rows = await db.all<{ n: number | null }>(q);
    const v = rows[0]?.n;
    return v === null || v === undefined ? null : Number(v);
  };

  const claimsCogsCents = await one(
    sql`select sum(acquisition_cents) as n from claims
         where date_filled >= ${from} and date_filled <= ${to} and acquisition_cents is not null`,
  );

  /*
   * What the wholesalers billed for GOODS, which is not what they billed.
   *
   * Line extensions rather than invoice totals, because a total carries freight, tax and fees — real
   * money, and not goods that can sit on a shelf. Reconciling the shelf against a figure containing
   * $406 of freight would put the freight into the gap and leave somebody hunting for it.
   */
  const purchasesCents = await one(
    sql`select sum(extended_cents) as n from invoice_lines
         where invoice_date >= ${from} and invoice_date <= ${to}`,
  );

  const shelf = async (on: string) => {
    const rows = await db.all<{ counted_on: string | null; value_cents: number | null; lines: number | null }>(
      sql`select counted_on, sum(value_cents) as value_cents, count(*) as lines
            from on_hand where counted_on <= ${on}
           group by counted_on order by counted_on desc limit 1`,
    );
    const r = rows[0];
    return r?.counted_on
      ? { on: r.counted_on, cents: Number(r.value_cents ?? 0), lines: Number(r.lines ?? 0) }
      : { on: null, cents: null, lines: null };
  };

  /*
   * Opening stock is the shelf at the END of the day before the window, so it is read at `from`
   * minus one: a count taken on the first morning already has that morning's receipts on it.
   */
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const [opening, closing] = await Promise.all([shelf(dayBefore), shelf(to)]);

  /* What a whole count looks like here, so a truncated one can say it is not whole. */
  const typicalLines = await one(
    sql`select cast(round(avg(n)) as integer) as n from (select count(*) as n from on_hand group by counted_on)`,
  );

  return {
    from,
    to,
    claimsCogsCents,
    purchasesCents,
    openingCents: opening.cents,
    openingOn: opening.on,
    closingCents: closing.cents,
    closingOn: closing.on,
    openingLines: opening.lines,
    closingLines: closing.lines,
    typicalLines,
  };
}

/** The proof for a window, read now. Reads only. */
export async function cogsProof(from: string, to: string): Promise<CogsProof & { terms: CogsTerms }> {
  const t = await terms(from, to);
  return { ...proveCogs(t), terms: t };
}

/**
 * The widest window this can actually prove, ending today.
 *
 * Balance on Hand has only arrived daily since 11 September 2026, so a proof of September from the
 * 1st is not available and must not be faked by reaching forward for an opening count. This finds
 * the earliest day there is a shelf valuation for and proves from the day after it.
 */
export async function provableWindow(to: string): Promise<{ from: string; to: string } | null> {
  const rows = await db.all<{ on: string | null }>(sql`select min(counted_on) as "on" from on_hand`);
  const first = rows[0]?.on;
  if (!first) return null;
  const from = new Date(Date.parse(`${first}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return from > to ? null : { from, to };
}
