import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * The perpetual Schedule II count, reconciled rather than kept.
 *
 * The practice decision on file (practice-decisions.ts, `perpetual_inventory`) says the pharmacy keeps a running
 * count of every schedule in PioneerRx. PioneerRx's on-hand file arrives daily (on_hand), its receipts arrive with
 * each delivery (pioneer_purchases), and every fill and reversal is in the claims file. So for each Schedule II
 * item, between any two days the site holds a count for:
 *
 *     on hand at the end  =  on hand at the start  +  received  −  filled  +  returned to stock
 *
 * and a difference is a count PioneerRx's own records do not explain — a fill rung up on the wrong NDC, a receipt
 * booked against the wrong item, a bottle that left without a fill. That is what a biennial inventory finds a year
 * late and what K.A.R. 68-20-16 and 21 CFR 1301.74(c) expect a pharmacy to notice at once. Nothing here is a
 * physical count: it is the site checking PioneerRx against itself, every day, so the physical count has something
 * to be compared with.
 *
 * Three things the first readings got wrong, measured 1 October 2026 on seven days of files, and corrected here:
 * - A day's on-hand file does not list every item (2,271 rows one day, 1,793 the next), so an item missing from a
 *   day's file is not zero on hand — it is not measured that day. An item is judged only between days its file
 *   lists it, from the first such day to the last.
 * - A receipt's invoice date and the day PioneerRx booked it into stock differ by a day often enough that twelve
 *   of thirty-one "variances" were exactly one pack. So a variance counts only when it holds on two consecutive
 *   measured days: a receipt or fill booked on the wrong side of a day moves the figure for one day and settles.
 * - A fill is often dispensed from another manufacturer's bottle of the same drug and strength than the NDC the
 *   claim carries, and then one NDC reads short by exactly what the other reads over. So the count is judged per
 *   product — the directory's equivalence key: same substances, strength, form and route — with the NDCs beneath
 *   it; two NDCs of one product that net to nothing are a substitution, not a loss.
 *
 * What the site does not see, and says so: inventory adjustments typed into PioneerRx by hand — a recount, a
 * transfer, a return to stock, a write-off — are in no file the site reads. A difference here may be one of those,
 * which is still worth a look, because an adjustment nobody can explain is what an inspector asks about.
 *
 * Units: the on-hand file counts in dispensing units (EA, ML, GM) unless `counted_in_packages` says packs, in which
 * case the pack's quantity multiplies; a receipt's quantity is packs and its `packSize` the units in one; a claim's
 * quantity is dispensing units in thousandths. Which items are Schedule II comes from the drug directory (DEA
 * schedule "CII" on the eleven-digit NDC) and from any invoice line a supplier printed as Schedule II.
 */
export type Snapshot = { day: string; ndc11: string; units: number };
export type Receipt = { day: string; ndc11: string; units: number };
export type Fill = { ndc11: string; filledOn: string; reversedOn: string | null; units: number };
export type Movement = {
  ndc11: string;
  name: string | null;
  from: string;
  to: string;
  open: number;
  received: number;
  filled: number;
  returned: number;
  expected: number;
  close: number;
  variance: number;
  /** The variance on the measured day before the last, or null where the item was measured on fewer than three days. */
  varianceBefore: number | null;
  /** Days the item was measured on. */
  measured: number;
};
export type Product = {
  key: string;
  name: string | null;
  ndcs: Movement[];
  variance: number;
  varianceBefore: number | null;
  /** Off by the same amount on the two last measured days: not paper and shelf a day apart. */
  stable: boolean;
};
export type PerpetualReport = {
  from: string | null;
  to: string | null;
  days: number;
  items: number;
  products: number;
  agree: number;
  /** Off, and off by the same amount the day before: worth a look at the shelf. */
  off: Product[];
  /** Off on the last day only: most likely paper and shelf a day apart. Settles or becomes real tomorrow. */
  moving: Product[];
  absVariance: number;
  says: string;
  assumptions: string[];
  notSeen: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10 + 0;
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);

/** Pure: one row per Schedule II NDC over the days its on-hand file lists it, variance rounded to a tenth. */
export function reconcile(days: string[], snaps: Snapshot[], receipts: Receipt[], fills: Fill[], names: Map<string, string | null> = new Map()): Movement[] {
  const sorted = [...new Set(days)].sort();
  if (sorted.length < 2) return [];
  const byItem = new Map<string, Map<string, number>>();
  for (const s of snaps) {
    const m = byItem.get(s.ndc11) ?? new Map<string, number>();
    m.set(s.day, (m.get(s.day) ?? 0) + s.units);
    byItem.set(s.ndc11, m);
  }
  const out: Movement[] = [];
  for (const [ndc, counts] of byItem) {
    const measuredDays = sorted.filter((d) => counts.has(d));
    if (measuredDays.length < 2) continue;
    const first = measuredDays[0];
    const last = measuredDays[measuredDays.length - 1];
    const open = counts.get(first)!;
    const at = (day: string) => {
      const received = sum(receipts.filter((r) => r.ndc11 === ndc && r.day > first && r.day <= day).map((r) => r.units));
      const filled = sum(fills.filter((f) => f.ndc11 === ndc && f.filledOn > first && f.filledOn <= day).map((f) => f.units));
      const returned = sum(fills.filter((f) => f.ndc11 === ndc && f.reversedOn !== null && f.reversedOn > first && f.reversedOn <= day).map((f) => f.units));
      const expected = open + received - filled + returned;
      return { received, filled, returned, expected, variance: counts.get(day)! - expected };
    };
    const atLast = at(last);
    const before = measuredDays.length >= 3 ? at(measuredDays[measuredDays.length - 2]) : null;
    out.push({
      ndc11: ndc,
      name: names.get(ndc) ?? null,
      from: first,
      to: last,
      open: round1(open),
      received: round1(atLast.received),
      filled: round1(atLast.filled),
      returned: round1(atLast.returned),
      expected: round1(atLast.expected),
      close: round1(counts.get(last)!),
      variance: round1(atLast.variance),
      varianceBefore: before ? round1(before.variance) : null,
      measured: measuredDays.length,
    });
  }
  return out.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance) || a.ndc11.localeCompare(b.ndc11));
}

/** Pure: the NDCs grouped into products by the key given (the directory's equivalence key); an NDC with no key is its own product. */
export function products(movements: Movement[], keyOf: (ndc11: string) => string | null = () => null, nameOf: (key: string) => string | null = () => null): Product[] {
  const by = new Map<string, Movement[]>();
  for (const m of movements) {
    const k = keyOf(m.ndc11) ?? `ndc:${m.ndc11}`;
    by.set(k, [...(by.get(k) ?? []), m]);
  }
  const out: Product[] = [];
  for (const [key, ndcs] of by) {
    const variance = round1(sum(ndcs.map((m) => m.variance)));
    const befores = ndcs.map((m) => m.varianceBefore);
    const varianceBefore = befores.every((b) => b !== null) ? round1(sum(befores as number[])) : null;
    out.push({ key, name: ndcs.find((m) => m.name)?.name ?? nameOf(key) ?? null, ndcs: [...ndcs].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)), variance, varianceBefore, stable: varianceBefore !== null && Math.abs(varianceBefore - variance) < 0.05 });
  }
  return out.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance) || a.key.localeCompare(b.key));
}

export function summarise(days: string[], movements: Movement[], grouped: Product[] = products(movements)): PerpetualReport {
  const sorted = [...new Set(days)].sort();
  const offAll = grouped.filter((p) => Math.abs(p.variance) >= 0.05);
  const off = offAll.filter((p) => p.stable);
  const moving = offAll.filter((p) => !p.stable);
  const absVariance = round1(sum(off.map((p) => Math.abs(p.variance))));
  const from = sorted[0] ?? null;
  const to = sorted[sorted.length - 1] ?? null;
  const says =
    sorted.length < 2
      ? "Fewer than two days of PioneerRx on-hand files are on hand, so there is nothing to reconcile yet."
      : movements.length === 0
        ? `No Schedule II item appears in two or more of the ${sorted.length} on-hand files from ${from} to ${to}, so nothing can be reconciled yet.`
        : off.length === 0
          ? `Every Schedule II product PioneerRx counts agrees with its own receipts, fills and reversals from ${from} to ${to}: ${grouped.length} products, ${movements.length} NDCs, ${sorted.length} days${moving.length ? `; ${moving.length} moved on the last day only, which is paper and shelf a day apart and settles tomorrow or becomes real` : ""}.`
          : `${off.length} of ${grouped.length} Schedule II products are off against PioneerRx's own receipts, fills and reversals and have stayed off for two days, ${absVariance} units in all${moving.length ? `; ${moving.length} more moved on the last day only` : ""}. Each row says which way.`;
  return {
    from,
    to,
    days: sorted.length,
    items: movements.length,
    products: grouped.length,
    agree: grouped.length - offAll.length,
    off,
    moving,
    absVariance,
    says,
    assumptions: [
      "On hand at the end = on hand at the start + received − filled + returned to stock, per NDC, from the first day its on-hand file lists it to the last; then the NDCs of one product (same substances, strength, form and route) are added, because a fill is often dispensed from another manufacturer's bottle of the same drug.",
      "An item missing from a day's file is not measured that day, not zero: the files do not list every item every day.",
      "A variance counts once it holds on two consecutive measured days. A receipt or fill booked on the wrong side of a day moves the figure for one day and then settles; a bottle that left without a fill stays off.",
      "A receipt counts on its invoice date and a fill on its fill date.",
      "Schedule II is the drug directory's DEA schedule on the eleven-digit NDC, plus any invoice line a supplier printed as Schedule II.",
    ],
    notSeen: "Inventory adjustments typed into PioneerRx by hand — a recount, a transfer, a return to stock, a write-off — are in no file the site reads. A difference here may be one of those; an adjustment nobody can explain is still what an inspector asks about.",
  };
}

/** The last fourteen days of on-hand files, and everything that moved a Schedule II item between them. */
export async function perpetualReport(today: string, windowDays = 14): Promise<PerpetualReport> {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - windowDays * 864e5).toISOString().slice(0, 10);
  const directory = (await db.all(sql`select ndc11, dea_schedule schedule, equivalence_key key, generic_name generic, strength from drug_directory where dea_schedule = 'CII'`)) as { ndc11: string; schedule: string | null; key: string | null; generic: string | null; strength: string | null }[];
  const c2 = new Set(directory.map((d) => d.ndc11));
  const keyOf = new Map(directory.map((d) => [d.ndc11, d.key]));
  const productName = new Map<string, string>();
  for (const d of directory) if (d.key && d.generic && !productName.has(d.key)) productName.set(d.key, `${d.generic} ${d.strength ?? ""}`.trim());
  for (const r of (await db.all(sql`select distinct ndc11 from invoice_lines where dea_schedule = 'schedule_2' and ndc11 is not null`)) as { ndc11: string }[]) c2.add(r.ndc11);
  const onHand = (await db.all(sql`select counted_on day, ndc11, quantity_thousandths q, pack_qty pack, counted_in_packages packs, description from on_hand where counted_on >= ${since} and ndc11 is not null`)) as { day: string; ndc11: string; q: number; pack: number | null; packs: number; description: string | null }[];
  const days = [...new Set(onHand.map((r) => r.day))].sort();
  if (days.length < 2) return summarise(days, []);
  const first = days[0];
  const last = days[days.length - 1];
  const names = new Map<string, string | null>();
  const snaps: Snapshot[] = [];
  for (const r of onHand) {
    if (!c2.has(r.ndc11)) continue;
    snaps.push({ day: r.day, ndc11: r.ndc11, units: (r.q / 1000) * (r.packs ? (r.pack ?? 1) : 1) });
    if (r.description && !names.has(r.ndc11)) names.set(r.ndc11, r.description);
  }
  const receipts: Receipt[] = [];
  for (const p of (await db.all(sql`select invoice_date day, items_json from pioneer_purchases where invoice_date > ${first} and invoice_date <= ${last} and items_json is not null`)) as { day: string; items_json: string }[]) {
    let items: { ndc11?: string; quantity?: number; packSize?: number; description?: string }[] = [];
    try {
      items = JSON.parse(p.items_json) as typeof items;
    } catch {
      items = [];
    }
    for (const it of items) {
      if (!it.ndc11 || !c2.has(it.ndc11)) continue;
      receipts.push({ day: p.day, ndc11: it.ndc11, units: (it.quantity ?? 0) * (it.packSize ?? 1) });
      if (it.description && !names.has(it.ndc11)) names.set(it.ndc11, it.description);
    }
  }
  const fills: Fill[] = [];
  for (const c of (await db.all(sql`select ndc11, date_filled, reversed_on, quantity_thousandths q, item_name from claims where ndc11 is not null and ((date_filled > ${first} and date_filled <= ${last}) or (reversed_on > ${first} and reversed_on <= ${last}))`)) as { ndc11: string; date_filled: string; reversed_on: string | null; q: number | null; item_name: string | null }[]) {
    if (!c2.has(c.ndc11)) continue;
    fills.push({ ndc11: c.ndc11, filledOn: c.date_filled, reversedOn: c.reversed_on, units: (c.q ?? 0) / 1000 });
    if (c.item_name && !names.has(c.ndc11)) names.set(c.ndc11, c.item_name);
  }
  const movements = reconcile(days, snaps, receipts, fills, names);
  return summarise(
    days,
    movements,
    products(
      movements,
      (ndc) => keyOf.get(ndc) ?? null,
      (key) => productName.get(key) ?? null,
    ),
  );
}
