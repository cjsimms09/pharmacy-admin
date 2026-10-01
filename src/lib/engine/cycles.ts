import { sql } from "drizzle-orm";
import { db } from "@/db";
import { SITE_STARTS_ON } from "../books-start";

/**
 * How long each payer takes to pay, measured on the payments the site has tied to their claims.
 *
 * One computation, read by the month's AR figures, the Today list and Cash ahead, so the three can never
 * disagree about what "due" means. p50 is the typical wait; p90 is the slowest one in ten, which is what a claim
 * must be older than before it is called due. Under 25 tied payments a payer has no cycle: its claims are
 * "never measured", not "late".
 */
export type Cycle = { p50: number; p90: number; n: number };

export const CYCLE_MIN_PAYMENTS = 25;

export function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export async function payerCycles(since = SITE_STARTS_ON): Promise<Map<string, Cycle>> {
  const rows = (await db.all(sql`select coalesce(c.pbm_name, c.payer_label) payer, julianday(p.received_on) - julianday(c.date_filled) days from claim_payments p join claims c on c.id = p.claim_id where p.source = 'plan' and c.date_filled >= ${since} and p.received_on is not null`)) as { payer: string; days: number }[];
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.payer, [...(by.get(r.payer) ?? []), r.days]);
  const out = new Map<string, Cycle>();
  for (const [payer, xs] of by) out.set(payer, { p50: percentile(xs, 0.5), p90: percentile(xs, 0.9), n: xs.length });
  return out;
}

/** The cycle a claim is judged by, or null where the payer is not yet measured. */
export function cycleDays(cycles: Map<string, Cycle>, payer: string): number | null {
  const c = cycles.get(payer);
  return c && c.n >= CYCLE_MIN_PAYMENTS ? c.p90 : null;
}
