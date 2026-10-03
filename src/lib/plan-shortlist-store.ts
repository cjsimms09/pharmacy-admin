import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { allPioneerPlanRows, pioneerRowsFor } from "./pioneer-plans";
import { shortlist, type PlanAggregate, type Shortlist } from "./plan-shortlist";

/**
 * Gathering what each BIN and PCN is worth, so the shortlist can be ranked.
 *
 * Everything here is a lookup; the deciding is in `plan-shortlist.ts`, which is pure and tested.
 * The one judgement made in this file is which claims count, and it is the same judgement
 * `plans.ts` already makes: paid claims only, because a reversal or a rejection is not
 * reimbursement and a plan should not climb the list on claims that paid nothing.
 */

const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/**
 * One drug actually dispensed on each plan.
 *
 * The reason this is on the list at all: "BIN 003858 PCN A4" is not a thing anybody recognises, and
 * "94 claims, Ozempic" is. The most-dispensed item is chosen rather than the first, because the
 * common drug on a plan is the one he will remember filling.
 */
function commonestDrug(items: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const i of items) {
    const n = (i ?? "").trim();
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
}

export async function planAggregates(): Promise<PlanAggregate[]> {
  const [claims, bins, pioneer] = await Promise.all([
    db.query.claims.findMany({
      where: eq(schema.claims.status, "paid"),
      columns: { bin: true, pcn: true, groupNumber: true, payerLabel: true, pbmName: true, remitCents: true, copayCents: true, itemName: true, cashPlan: true },
    }),
    db.query.payerBins.findMany({ columns: { bin: true, pbmName: true, linesOfBusiness: true } }),
    allPioneerPlanRows(),
  ]);

  /*
   * One BIN can be listed under several PBMs, and where the listings disagree about the line of
   * business none of them is taken. A proposal is only worth making when the document speaks with
   * one voice — the same rule the proposals store already applies, kept identical on purpose.
   */
  const lobByBin = new Map<string, string | null>();
  const pbmByBin = new Map<string, string>();
  for (const b of bins) {
    if (!pbmByBin.has(b.bin)) pbmByBin.set(b.bin, b.pbmName);
    const seen = lobByBin.get(b.bin);
    if (seen === undefined) lobByBin.set(b.bin, b.linesOfBusiness);
    else if (seen !== b.linesOfBusiness) lobByBin.set(b.bin, null);
  }

  type Acc = { bin: string | null; pcn: string | null; claims: number; receivedCents: number; labels: Set<string>; groups: Set<string>; items: (string | null)[] };
  const by = new Map<string, Acc>();
  for (const c of claims) {
    /*
     * The pharmacy's own cash plan is not a plan for this purpose.
     *
     * `cashPlan` marks a fill the pharmacy priced itself. There is no payer to owe a floor and no
     * contract to find, so counting those claims into the unclassified backlog would inflate it by
     * 307 and put the pharmacy's own loyalty programme at the top of a list of questions for its
     * owner — which is exactly the kind of nonsense that gets a list closed and never reopened.
     */
    if (c.cashPlan) continue;
    const key = `${norm(c.bin)}|${norm(c.pcn)}`;
    let a = by.get(key);
    if (!a) { a = { bin: c.bin, pcn: c.pcn, claims: 0, receivedCents: 0, labels: new Set(), groups: new Set(), items: [] }; by.set(key, a); }
    a.claims++;
    a.receivedCents += (c.remitCents ?? 0) + (c.copayCents ?? 0);
    if (c.payerLabel) a.labels.add(c.payerLabel.trim());
    if (c.groupNumber) a.groups.add(c.groupNumber.trim());
    a.items.push(c.itemName);
  }

  return [...by.values()].map((a) => {
    const rows = pioneerRowsFor(pioneer, a.bin, a.pcn);
    /*
     * The best name anybody has, in the order of who is likely to be right.
     *
     * PioneerRx's plan file calls BIN 610455 PCN BCBSKS "Bc/bs Kansas"; the claim calls it
     * "610455 (BCBSKS)", which is the BIN typed back at us. An active plan-file row is preferred,
     * then anything else PioneerRx holds, then the claim's own label.
     */
    const named =
      rows.find((r) => r.source === "plan_file" && r.isActive && (r.planName ?? "").trim())?.planName ??
      rows.find((r) => (r.planName ?? "").trim())?.planName ??
      null;
    return {
      bin: a.bin,
      pcn: a.pcn,
      claims: a.claims,
      receivedCents: a.receivedCents,
      payerLabel: [...a.labels][0] ?? null,
      pbmName: a.bin ? (pbmByBin.get(a.bin) ?? null) : null,
      planName: named?.trim() ?? null,
      linesOfBusiness: a.bin ? (lobByBin.get(a.bin) ?? null) : null,
      exampleDrug: commonestDrug(a.items),
      groups: [...a.groups].sort(),
      pioneer: rows,
    };
  });
}

/** What is settled, what is open, and what stopping the list leaves behind. */
export async function planShortlist(): Promise<Shortlist> {
  return shortlist(await planAggregates());
}
