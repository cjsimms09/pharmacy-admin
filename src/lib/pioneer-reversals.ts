/**
 * PioneerRx's last word on a claim it reversed, applied to a paid row the site still holds.
 *
 * The nightly report delivers a reversal some days and not others; a script returned to stock at
 * the counter is reversed in PioneerRx and the site goes on holding it paid and "in the bin". On
 * 2 October 2026 seven September rows stood that way, $2,197.12 with two the copy no longer listed
 * at all. The owner's word for PioneerRx being the record: "take from pioneer".
 *
 * Only on a presence. A row is reversed here when PioneerRx holds, for the same prescription, refill
 * and BIN, a last valid claim whose response is a reversal dated on or after the fill, and no last
 * valid paid claim. A payer PioneerRx no longer lists at all is an absence, not a reversal, and is
 * left alone and counted. A fill dated on or after the copy's newest day is left alone too: the
 * copy is a day old and may simply not have it yet.
 */

import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "@/db";

export type PioneerReversal = { rxNumber: string; fillNumber: number; bin: string | null; reversedOn: string | null };

export type SitePaidRow = { id: string; rxNumber: string; fillNumber: number | null; bin: string | null; dateFilled: string; remitCents: number | null };

export type PlannedReversal = { id: string; rxNumber: string; fillNumber: number; bin: string; dateFilled: string; reversedOn: string; cents: number };

const key = (rx: string, fill: number | null, bin: string | null) => `${rx}|${fill ?? 0}|${bin ?? ""}`;

/** The pure decision: which site rows PioneerRx has reversed. `pioneerPaidKeys` are "rx|fill|bin" of every last valid paid claim. */
export function planReversalsFromPioneer(
  site: SitePaidRow[],
  pioneerPaidKeys: Set<string>,
  reversals: PioneerReversal[],
  coverTo: string | null,
): { planned: PlannedReversal[]; payerGone: number; payerGoneCents: number } {
  const byKey = new Map<string, PioneerReversal[]>();
  for (const r of reversals) {
    const k = key(r.rxNumber, r.fillNumber, r.bin);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const planned: PlannedReversal[] = [];
  let payerGone = 0;
  let payerGoneCents = 0;
  for (const s of site) {
    const k = key(s.rxNumber, s.fillNumber, s.bin);
    if (pioneerPaidKeys.has(k)) continue;
    if (coverTo && s.dateFilled >= coverTo) continue;
    const hit = (byKey.get(k) ?? []).filter((r) => r.reversedOn && r.reversedOn >= s.dateFilled).sort((a, b) => (a.reversedOn! < b.reversedOn! ? 1 : -1))[0];
    if (!hit) {
      payerGone++;
      payerGoneCents += s.remitCents ?? 0;
      continue;
    }
    planned.push({ id: s.id, rxNumber: s.rxNumber, fillNumber: s.fillNumber ?? 0, bin: s.bin ?? "", dateFilled: s.dateFilled, reversedOn: hit.reversedOn!, cents: s.remitCents ?? 0 });
  }
  return { planned, payerGone, payerGoneCents };
}

/** Reads the site's paid rows from `from`, plans, writes, audits. */
export async function reverseFromPioneer(args: {
  reversals: PioneerReversal[];
  pioneerPaidKeys: Set<string>;
  coverTo: string | null;
  from: string;
}): Promise<{ fills: number; cents: number; payerGone: number; payerGoneCents: number; says: string }> {
  const site = await db.query.claims.findMany({
    where: and(eq(schema.claims.status, "paid"), gte(schema.claims.dateFilled, args.from)),
    columns: { id: true, rxNumber: true, fillNumber: true, bin: true, dateFilled: true, remitCents: true },
  });
  const plan = planReversalsFromPioneer(site, args.pioneerPaidKeys, args.reversals, args.coverTo);
  const { audit } = await import("./audit");
  for (const p of plan.planned) {
    await db
      .update(schema.claims)
      .set({ status: "reversed", reversedOn: p.reversedOn, reversalKey: `pioneer:${p.rxNumber}|${p.fillNumber}|${p.bin}|${p.reversedOn}` })
      .where(eq(schema.claims.id, p.id));
    await audit({
      action: "claims.reversed_from_pioneer",
      userId: null,
      userName: "the PioneerRx pull, on his word (take from pioneer)",
      entity: "claim",
      entityId: p.id,
      details: `Rx ${p.rxNumber}-${p.fillNumber} BIN ${p.bin}, filled ${p.dateFilled}: PioneerRx's last valid claim is a reversal of ${p.reversedOn} and it holds no paid claim; the row was paid here. $${(p.cents / 100).toFixed(2)}.`,
    });
  }
  const cents = plan.planned.reduce((n, p) => n + p.cents, 0);
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const says =
    `${plan.planned.length ? `${plan.planned.length} paid row${plan.planned.length === 1 ? "" : "s"} reversed on PioneerRx's word, ${money(cents)}` : ""}` +
    `${plan.payerGone ? `${plan.planned.length ? "; " : ""}${plan.payerGone} paid row${plan.payerGone === 1 ? "" : "s"} whose payer PioneerRx no longer lists, ${money(plan.payerGoneCents)}, left alone` : ""}`;
  return { fills: plan.planned.length, cents, payerGone: plan.payerGone, payerGoneCents: plan.payerGoneCents, says };
}
