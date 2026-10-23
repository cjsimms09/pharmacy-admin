import "server-only";
import { db, schema } from "@/db";
import { allPayerLinks, linkFor } from "./payer-links";

/**
 * The claims nobody can put a payer's name to, gathered into the decisions they actually are.
 *
 * The owner, 16 September 2026, of the 63 claims carrying $1,725.59 that have no settled payer name:
 * **"I don't know how to fix this"**. That is the right reaction to how it was presented, and the
 * presentation was mine. Sixty-three unnamed claims is not sixty-three problems and it is not
 * something a pharmacist can work through; it reads as a mess with no handle on it.
 *
 * Measured, it is **24 decisions**, and four of them carry most of the money. Each one is a BIN with
 * its PCN and group — the identifiers the claim was billed under — and a pharmacist reads those the
 * way the rest of us read a name. 004336 is Caremark. 003858 is Express Scripts. 610014 is
 * MedImpact. The site cannot know that and he does, which is the whole reason this is a screen and
 * not another inference: what the learner nearly did was guess, and a wrong name that looks settled
 * is worse than a blank.
 *
 * So the job of this module is to turn a number he cannot act on into a list he can, and to put the
 * expensive ones at the top. Naming one writes a payer link, which fixes every claim already on file
 * carrying those identifiers and every one that arrives afterwards.
 *
 * ── What is deliberately separated ──
 *
 * A claim with no money on it is its own group and sits at the bottom. Twenty-one of the sixty-three
 * carry $0.00 — the voucher BIN, a cash fill, a claim with no BIN at all — and no name on earth
 * makes any of them collectable. Mixing them in makes the list a fifth longer and not one dollar
 * more answerable.
 */

export type UnnamedKey = {
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  claims: number;
  cents: number;
  firstFill: string;
  lastFill: string;
  /** What the claims themselves printed, where they printed anything: a hint, never an answer. */
  printed: string | null;
  /** The drugs on them, a few, because a pharmacist often recognises a plan by what it covers. */
  drugs: string[];
};

export type UnnamedPayers = {
  keys: UnnamedKey[];
  /** Keys whose claims carry no money at all: real, and not worth his afternoon. */
  noMoney: UnnamedKey[];
  claims: number;
  cents: number;
};

export async function unnamedPayerKeys(from: string): Promise<UnnamedPayers> {
  const rows = await db.query.claims.findMany({
    where: (c, { and, gte, eq: is }) => and(gte(c.dateFilled, from), is(c.status, "paid")),
    columns: {
      bin: true,
      pcn: true,
      groupNumber: true,
      networkId: true,
      pbmName: true,
      payerLabel: true,
      matchMethod: true,
      remitCents: true,
      dateFilled: true,
      itemName: true,
    },
  });
  const links = await allPayerLinks();

  const by = new Map<string, UnnamedKey>();
  for (const c of rows) {
    const named = (c.pbmName ?? "").trim() !== "" && c.matchMethod !== "unresolved" && c.matchMethod !== "none";
    if (named) continue;
    /* Already answered by a link somebody wrote; the claim simply has not been re-stamped yet. */
    if (linkFor(links, { bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber, contractId: c.networkId })) continue;

    const id = `${c.bin ?? ""}|${c.pcn ?? ""}|${c.groupNumber ?? ""}`;
    const cur =
      by.get(id) ??
      ({ bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber, claims: 0, cents: 0, firstFill: c.dateFilled, lastFill: c.dateFilled, printed: null, drugs: [] } as UnnamedKey);
    cur.claims++;
    cur.cents += c.remitCents ?? 0;
    if (c.dateFilled < cur.firstFill) cur.firstFill = c.dateFilled;
    if (c.dateFilled > cur.lastFill) cur.lastFill = c.dateFilled;
    /* Whatever the claim itself printed for a payer — often blank, sometimes a plan's own wording. */
    const printed = (c.payerLabel ?? "").trim();
    if (printed && !cur.printed) cur.printed = printed;
    const drug = (c.itemName ?? "").trim();
    if (drug && cur.drugs.length < 4 && !cur.drugs.includes(drug)) cur.drugs.push(drug);
    by.set(id, cur);
  }

  const all = [...by.values()];
  const keys = all.filter((k) => k.cents > 0).sort((a, b) => b.cents - a.cents);
  const noMoney = all.filter((k) => k.cents <= 0).sort((a, b) => b.claims - a.claims);
  return {
    keys,
    noMoney,
    claims: all.reduce((n, k) => n + k.claims, 0),
    cents: all.reduce((n, k) => n + k.cents, 0),
  };
}

/** A BIN's identifiers as one line, for a heading. */
export function keyWords(k: Pick<UnnamedKey, "bin" | "pcn" | "groupNumber">): string {
  const parts = [k.bin ? `BIN ${k.bin}` : "no BIN", k.pcn ? `PCN ${k.pcn}` : null, k.groupNumber ? `group ${k.groupNumber}` : null];
  return parts.filter(Boolean).join(" · ");
}

void schema;
