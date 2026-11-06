import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Order from: for each secondary wholesaler, what the pharmacy already orders from them today and what it could add
 * — the generics they are the best place to buy, in quantities the next weeks will use — so a minimum is met with
 * stock that moves rather than stock that sits.
 *
 * The owner, 1 October 2026, put this on the first build: "telling me what items I can add onto secondary
 * suppliers (IPD, IPC, ANDA to hit minimums, ie what drugs do we order from that supplier, what drugs are we close
 * to needing that we can add onto an order)". The computation is the old site's minimum filler
 * (minimum-filler.ts, assembled by minimum-store.ts from the buy list, the shelf's movement and the contract
 * rates). It is heavy, so the engine runs it on the nightly pass and keeps the answer; the screen reads it.
 */
export type OrderFromSupplier = {
  supplier: string;
  minimumCents: number | null;
  basketCents: number;
  shortfallCents: number;
  meets: boolean;
  addedCents: number;
  says: string;
  picks: { ndc11: string; name: string | null; packs: number; packQty: number; costCents: number; savingCents: number; daysOfStockAfter: number; why: string }[];
  candidates: number;
  leftOut: { notGeneric: number; controlled: number; unknownClass: number };
};

export type OrderFrom = { computedAt: string; horizonDays: number; evidence: { days: number; from: string | null; to: string | null }; missing: string[]; suppliers: OrderFromSupplier[] };

const KEY = "engine_order_from";

export async function writeOrderFrom(now: string): Promise<{ suppliers: number; picks: number }> {
  const { minimumsNow } = await import("../minimum-store");
  const v = await minimumsNow();
  const out: OrderFrom = {
    computedAt: now,
    horizonDays: v.horizonDays,
    evidence: { days: v.evidence.days, from: v.evidence.from, to: v.evidence.to },
    missing: v.missing,
    suppliers: v.fills.map((f) => ({
      supplier: f.supplier,
      minimumCents: f.minimumCents,
      basketCents: f.basketCents,
      shortfallCents: f.shortfallCents,
      meets: f.meets,
      addedCents: f.addedCents,
      says: f.says,
      picks: f.picks.map((p) => ({ ndc11: p.ndc11, name: p.name, packs: p.packs, packQty: p.packQty, costCents: p.costCents, savingCents: p.savingCents, daysOfStockAfter: p.daysOfStockAfter, why: p.why })),
      candidates: f.candidates.length,
      leftOut: f.leftOut,
    })),
  };
  const value = JSON.stringify(out);
  const existing = await db.all<{ key: string }>(sql`select key from settings where key = ${KEY}`);
  if (existing.length) await db.run(sql`update settings set value = ${value} where key = ${KEY}`);
  else await db.run(sql`insert into settings (key, value) values (${KEY}, ${value})`);
  return { suppliers: out.suppliers.length, picks: out.suppliers.reduce((n, s) => n + s.picks.length, 0) };
}

export async function readOrderFrom(): Promise<OrderFrom | null> {
  const rows = await db.all<{ value: string | null }>(sql`select value from settings where key = ${KEY}`);
  try {
    return rows[0]?.value ? (JSON.parse(rows[0].value) as OrderFrom) : null;
  } catch {
    return null;
  }
}
