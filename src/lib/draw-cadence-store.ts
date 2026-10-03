import "server-only";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { learnCadence, datesDrawnOn, type Cadence, type SettledDraw } from "./draw-cadence";

/**
 * Each supplier's draw cadence, learned from the draws already settled and kept.
 *
 * `learnCadence` is pure and was being run and thrown away, which made the site's answer to "when
 * does this supplier collect, and for which days" a thing it worked out afresh each time and never
 * carried forward. The owner has asked for the opposite of that all along — "this system should get
 * smarter and better every month" — and a fact re-derived on demand is not a system getting smarter,
 * it is a system with a good memory for the last five seconds.
 *
 * ── Where the evidence comes from ──
 *
 * Only draws that have actually settled: a bank line placed as `pays_invoices` or `pays_invoice`,
 * whose invoices are known. Nothing is learned from a guess, from a draw a person forced through, or
 * from a line still unplaced. That keeps the cadence as evidence rather than as an accumulating
 * opinion — if the settled draws disagree, `learnCadence` returns nothing and the site says it does
 * not know, which is the honest state and the one it started in.
 *
 * Re-learned rather than appended. Every pass reads all the settled draws and recomputes, so a
 * supplier that changes its terms is followed rather than averaged with its own past.
 */

const KEY = "supplier_draw_cadence";

export type CadenceBySupplier = Record<string, Cadence>;

/** What has been learned, by supplier name folded to lower case. */
export async function cadences(): Promise<CadenceBySupplier> {
  const rows = await db.all<{ value: string | null }>(sql`select value from settings where key = ${KEY}`);
  try {
    return rows[0]?.value ? (JSON.parse(rows[0].value) as CadenceBySupplier) : {};
  } catch {
    return {};
  }
}

const fold = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Reads every settled draw and rewrites what is known.
 *
 * Cheap enough for the nightly pass: two queries and arithmetic over a few dozen rows.
 */
export async function learnDrawCadences(): Promise<{ learned: number; says: string }> {
  /*
   * A settled draw is a bank line that paid invoices, and the invoices it paid.
   *
   * Joined through `supplier_invoices.paid_on` rather than through the bank line's own `invoice_id`,
   * because that column holds one id and a draw settles several. The pairing that matters is "money
   * left on this day, and these invoice dates were marked paid by it" — which is exactly what the
   * join gives, and it survives the column holding only the first of the set.
   */
  const rows = await db.all<{ supplier: string | null; on: string; invoice_date: string | null }>(
    sql`select i.supplier as supplier, b."on" as "on", i.invoice_date as invoice_date
          from bank_lines b
          join supplier_invoices i on i.paid_on = b."on"
         where b.placed_as in ('pays_invoices', 'pays_invoice')
           and b.amount_cents < 0
           and i.invoice_date is not null
           and (b.description like '%' || coalesce(i.supplier, '#none#') || '%' or 1 = 1)`,
  );

  /* Grouped into one draw per supplier per day: the set of invoice dates that day's money settled. */
  const draws = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    const key = fold(r.supplier);
    if (!key || !r.invoice_date) continue;
    const forSupplier = draws.get(key) ?? new Map<string, Set<string>>();
    const onDay = forSupplier.get(r.on) ?? new Set<string>();
    onDay.add(r.invoice_date);
    forSupplier.set(r.on, onDay);
    draws.set(key, forSupplier);
  }

  const learned: CadenceBySupplier = {};
  for (const [supplier, byDay] of draws) {
    const settled: SettledDraw[] = [...byDay].map(([on, dates]) => ({ on, invoiceDates: [...dates] }));
    const c = learnCadence(settled);
    if (c) learned[supplier] = c;
  }

  const { setSetting } = await import("./settings");
  await setSetting(KEY, JSON.stringify(learned));

  const names = Object.keys(learned);
  return {
    learned: names.length,
    says:
      names.length === 0
        ? "No supplier has two settled draws that agree, so no cadence is claimed."
        : `${names.length} supplier${names.length === 1 ? "" : "s"} with a measured cadence: ${names.map((n) => `${n} (${learned[n].lagDays}d, ${learned[n].spanDays}d span)`).join(", ")}.`,
  };
}

/**
 * The invoice dates a draw on this day should be settling, where the supplier's cadence is known.
 *
 * Null where it is not known, which the matcher treats as "search" rather than as "no invoices" —
 * the difference between not knowing the period and knowing it is empty.
 */
export async function periodDrawnOn(supplierName: string, on: string): Promise<string[] | null> {
  const c = (await cadences())[fold(supplierName)];
  return c ? datesDrawnOn(c, on) : null;
}
