import { sql } from "drizzle-orm";
import { db } from "@/db";
import { SITE_STARTS_ON } from "../books-start";
import { payerNamer } from "./payers";

/**
 * How long each payer takes to pay, measured on the payments the site has tied to their claims.
 *
 * One computation, read by the month's AR figures, the Today list, Cash ahead and the Claims screen, so none of
 * them can disagree about what "due" means. p50 is the typical wait; p90 is the slowest one in ten, which is what a
 * claim must be older than before it is called due. Under 25 tied payments there is no cycle: the claims are
 * "never measured", not "late".
 *
 * Measured per plan group (payer + PCN/BIN) as well as per payer, because one payer name hides several contracts
 * paying on different clocks. Measured 1 October 2026: OptumRx's pooled p90 was 17 days, but its IRX/610011 claims
 * pay in 28–29 and its 9999/610097 claims in 13 — so the pool called 85 IRX claims ($25,193.18) late at 18 days
 * when that group had never paid faster than 28. Caremark (ADV 29 against MEDDAET 14) and Prime (BCBSKS 27 against
 * KSPARTD 13) do the same. A group with 25 tied payments is judged by its own p90. A group with fewer is judged by
 * the payer's p90, stretched to the group's own p90 where the group has shown at least five payments — stretched,
 * never shortened, because a claim called due is a claim he may chase, and a wrong chase costs the payer
 * relationship while a late one costs only days.
 *
 * A payment event is one claim on one day: the same money recorded from the 835 and again from the payment report
 * (752 such pairs on 1 October) counts once.
 */
export type Cycle = { p50: number; p90: number; n: number };

export const CYCLE_MIN_PAYMENTS = 25;
/** Below this a group has shown nothing worth stretching the payer's cycle by. */
export const GROUP_HINT_MIN = 5;

/** By payer, as a Map; by plan group under `groups`; `name` folds a payer's spellings to the one the keys use. */
export class Cycles extends Map<string, Cycle> {
  groups = new Map<string, Cycle>();
  name: (payer: string | null | undefined) => string = (p) => p ?? "";
}

/** What the judging functions accept: a Cycles, or a plain by-payer Map with no groups (a test, an older caller). */
export type CycleSource = Map<string, Cycle> & { groups?: Map<string, Cycle>; name?: (payer: string | null | undefined) => string };

export const groupKey = (payer: string, pcn: string | null | undefined, bin: string | null | undefined) => `${payer}|${pcn ?? "-"}/${bin ?? "-"}`;

export function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function summarise(by: Map<string, number[]>): Map<string, Cycle> {
  const out = new Map<string, Cycle>();
  for (const [k, xs] of by) out.set(k, { p50: percentile(xs, 0.5), p90: percentile(xs, 0.9), n: xs.length });
  return out;
}

export async function payerCycles(since = SITE_STARTS_ON): Promise<Cycles> {
  const name = await payerNamer();
  const rows = (await db.all(
    sql`select coalesce(c.pbm_name, c.payer_label) payer, c.pcn pcn, c.bin bin, julianday(p.received_on) - julianday(c.date_filled) days from claim_payments p join claims c on c.id = p.claim_id where p.source = 'plan' and c.date_filled >= ${since} and p.received_on is not null group by c.id, p.received_on`,
  )) as { payer: string; pcn: string | null; bin: string | null; days: number }[];
  const byPayer = new Map<string, number[]>();
  const byGroup = new Map<string, number[]>();
  for (const r of rows) {
    const payer = name(r.payer);
    byPayer.set(payer, [...(byPayer.get(payer) ?? []), r.days]);
    const g = groupKey(payer, r.pcn, r.bin);
    byGroup.set(g, [...(byGroup.get(g) ?? []), r.days]);
  }
  const out = new Cycles();
  out.name = name;
  for (const [k, v] of summarise(byPayer)) out.set(k, v);
  out.groups = summarise(byGroup);
  return out;
}

/** The cycle a claim is judged by, or null where neither its plan group nor its payer is measured. */
export function cycleDays(cycles: CycleSource, rawPayer: string, pcn?: string | null, bin?: string | null): number | null {
  const payer = cycles.name ? cycles.name(rawPayer) : rawPayer;
  const g = pcn !== undefined || bin !== undefined ? cycles.groups?.get(groupKey(payer, pcn, bin)) : undefined;
  if (g && g.n >= CYCLE_MIN_PAYMENTS) return g.p90;
  const p = cycles.get(payer);
  if (!p || p.n < CYCLE_MIN_PAYMENTS) return null;
  return g && g.n >= GROUP_HINT_MIN ? Math.max(p.p90, g.p90) : p.p90;
}

/** The typical wait, for projecting when money lands: the group's p50 where the group is measured, else the payer's where it has shown five. */
export function typicalDays(cycles: CycleSource, rawPayer: string, pcn?: string | null, bin?: string | null): number | null {
  const payer = cycles.name ? cycles.name(rawPayer) : rawPayer;
  const g = pcn !== undefined || bin !== undefined ? cycles.groups?.get(groupKey(payer, pcn, bin)) : undefined;
  if (g && g.n >= CYCLE_MIN_PAYMENTS) return g.p50;
  const p = cycles.get(payer);
  return p && p.n >= GROUP_HINT_MIN ? p.p50 : null;
}
