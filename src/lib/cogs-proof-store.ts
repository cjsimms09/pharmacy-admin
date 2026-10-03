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

  /*
   * Route one has to be the books' own figure, not one that resembles it.
   *
   * The first version of this summed `acquisition_cents` off the claims table by `date_filled`, and
   * both halves of that were wrong. The account counts per FILL, not per transmission — a
   * coordinated claim is one bottle billed to two payers, and summing the rows costs that bottle
   * twice — and it dates a fill by `soldOn`, the day it left the shop, not the day it was filled.
   *
   * Measured: the raw sum for 1–16 September came to $420,327.82 against the account's $269,984.50.
   * A proof of a figure that computes its own version of that figure is not a proof of anything; it
   * is a second opinion about a third number. So it reads `allFills` — the same loader the profit
   * and loss reads — and applies the same two rules, which is the only way a disagreement here can
   * be a disagreement about the books.
   */
  const { allFills } = await import("./claims");
  const fills = await allFills({ from, to: `${to}T23:59:59` });
  const sold = fills.filter((f) => (f.soldOn ?? "").slice(0, 10) >= from && (f.soldOn ?? "").slice(0, 10) <= to && f.acquisitionCents !== null);
  const claimsCogsCents = sold.length ? sold.reduce((n, f) => n + (f.acquisitionCents ?? 0), 0) : null;

  /*
   * What actually arrived, from PioneerRx's own receiving — not from the invoices.
   *
   * The owner, when the first version reported a gap: "we have pioneer receipts". He is right, and
   * it is the better term by a distance. An invoice is in this site only if the mailbox caught it,
   * so the invoice feed measures the mailbox as much as the buying: on file are 41 McKesson invoices
   * starting 9 September, 3 from IPD, none at all from ANDA. PioneerRx books in every delivery as it
   * is received, whoever sent it and whether or not a PDF ever arrived — $362,526.71 for September
   * against $203,727.64 of invoices, and it carries JamsRX, Xymogen and ANDA, which the invoice feed
   * has never seen.
   *
   * Reconciling the shelf against invoices was therefore measuring how good the post is. This
   * measures what was put on the shelf, which is the term the identity actually calls for.
   */
  const purchasesCents = await one(
    sql`select sum(total_cents) as n from pioneer_purchases
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
